import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "./models/user.js";
import Tweet from "./models/tweet.js";
import PasswordReset from "./models/passwordreset.js";
import { sendMail, exposeDevCode } from "./utils/mailer.js";
import { sendSms } from "./utils/sms.js";
import {
  generateOtp,
  generateSecureToken,
  hashSecret,
  verifySecret,
  isValidOtpShape,
  maskIdentifier,
  MAX_OTP_ATTEMPTS,
} from "./utils/otp.js";
import {
  validateGeneratedPassword,
  fingerprintPassword,
} from "./utils/passwordGenerator.js";
import { getIstParts, getIstTimeString } from "./utils/istTime.js";
import { getPlan, getCurrentPeriod, PLANS } from "./utils/plans.js";
import Subscription from "./models/subscription.js";
import {
  processPayment,
  isPaymentWindowOpen,
  millisUntilPaymentWindow,
  paymentClock,
  PAYMENT_WINDOW_START_HOUR,
  PAYMENT_WINDOW_END_HOUR,
} from "./utils/payment.js";
import { createInvoice } from "./utils/invoice.js";
import { sendInvoiceEmail } from "./utils/mailer.js";
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Twiller backend is running successfully");
});

const port = process.env.PORT || 5000;
const url = process.env.MONOGDB_URL;

mongoose
  .connect(url)
  .then(() => {
    console.log("✅ Connected to MongoDB");
    app.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
  });

//Register
app.post("/register", async (req, res) => {
  try {
    const existinguser = await User.findOne({ email: req.body.email });
    if (existinguser) {
      return res.status(200).send(existinguser);
    }
    const newUser = new User(req.body);
    // Internship Feature 6: store the phone as digits only so that
    // phone-based password recovery can match "+91 98765 43210" against
    // "919876543210". Existing users who never set a phone are unaffected.
    if (newUser.phone) {
      newUser.phone = String(newUser.phone).replace(/\D/g, "");
    }
    await newUser.save();
    return res.status(201).send(newUser);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
// loggedinuser
app.get("/loggedinuser", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).send({ error: "Email required" });
    }
    const user = await User.findOne({ email: email });
    return res.status(200).send(user);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
// update Profile
app.patch("/userupdate/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const updated = await User.findOneAndUpdate(
      { email },
      { $set: req.body },
      { new: true, upsert: false }
    );
    return res.status(200).send(updated);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
// Tweet API

// ===========================================================================
// INTERNSHIP FEATURE 1 (phase 1) - subscription quota guard.
// Runs BEFORE the tweet is created. Resolves the author's plan from
// backend/utils/plans.js (unknown/missing plans fall back to "free"),
// counts tweets the author posted in the current IST month from the existing
// timestamp field, and rejects (429) when the limit is already reached.
// Gold is unlimited. Mongoose validation errors keep their existing 400.
// ===========================================================================
async function enforceTweetQuota(authorId) {
  const author = await User.findById(authorId);
  if (!author) return null; // let Mongoose validation report the missing author
  const plan = getPlan(author.plan);
  // Unlimited plans are never rejected - fall through to tweet creation.
  if (plan.unlimited) return null;
  const period = getCurrentPeriod();
  const used = await Tweet.countDocuments({
    author: author._id,
    timestamp: { $gte: period.start, $lt: period.end },
  });
  if (used >= plan.tweetLimit) return { plan, used, limit: plan.tweetLimit };
  return null;
}

// POST
app.post("/post", async (req, res) => {
  try {
    const quota = await enforceTweetQuota(req.body?.author);
    if (quota) {
      return res.status(429).send({
        error: "Tweet limit reached. Upgrade your plan to post more.",
        quotaExceeded: true,
        plan: quota.plan.id,
        planName: quota.plan.name,
        tweetLimit: quota.limit,
        used: quota.used,
        periodLabel: getCurrentPeriod().label,
      });
    }
    const tweet = new Tweet(req.body);
    await tweet.save();
    return res.status(201).send(tweet);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
// ===========================================================================
// INTERNSHIP FEATURE 1 (phase 2) - mock subscription purchase.
// POST /subscription/payment   { userId, planId, testOutcome?, asOf? }
//
// The backend MUST enforce, in this order:
//   1. the user exists (same user-identification convention as the other
//      routes: a client-supplied userId; see the security note below);
//   2. the plan exists in backend/utils/plans.js - arbitrary strings are
//      rejected and NEVER written to user.plan;
//   3. "free" is not a paid purchase - no fake payment row is created;
//   4. the 10:00-11:00 IST payment window, evaluated on the SERVER clock;
//   5. the mock provider runs and the transaction row tracks every outcome.
// On success only: the transaction becomes `success` and the user's plan is
// updated, so the existing phase-1 quota guard picks the new limit up
// automatically. On failure/cancellation the plan is left unchanged.
//
// SECURITY NOTE (known limitation, inherited from the existing project):
// this codebase identifies callers by client-supplied ids today (no JWT,
// Firebase Admin or trust-proxy). This route reuses that convention instead
// of inventing a parallel auth system, and is written so a later Firebase
// Admin check can be dropped into the `authenticatedUser` step below without
// touching the purchase logic. Documented, not rewritten, in this phase.
// ===========================================================================
app.post("/subscription/payment", async (req, res) => {
  try {
    const { userId, planId, testOutcome, asOf } = req.body || {};

    // 1. User must exist.
    if (!userId) {
      return res.status(400).send({ error: "userId is required." });
    }
    const authenticatedUser = await User.findById(userId);
    if (!authenticatedUser) {
      return res.status(404).send({ error: "User not found." });
    }

    // 2. Plan must be a real, PAID plan from the single source of truth.
    // NOTE: `PLANS[planId]` is checked directly, NOT `getPlan()`, because
    // getPlan() *falls back to free* for typos - which is right for the quota
    // guard but wrong for a purchase (it would happily "sell" a typo).
    const requestedId = typeof planId === "string" ? planId.toLowerCase() : "";
    const requestedPlan = PLANS[requestedId];
    if (!requestedPlan) {
      return res.status(400).send({
        error: `Unknown plan "${planId}". Available plans: bronze, silver, gold.`,
        code: "UNKNOWN_PLAN",
      });
    }

    // 3. Free is the default, not a paid transaction. No payment row, no
    // mock approval, no plan change - an explicit, honest response instead.
    if (requestedPlan.id === "free") {
      return res.status(400).send({
        error: 'The Free plan requires no payment. No transaction was created.',
        code: "FREE_PLAN_NO_PAYMENT",
        plan: authenticatedUser.plan || "free",
      });
    }

    // 4. IST payment window, evaluated on server time. `asOf` is a TEST-ONLY
    // override honoured only outside production; production always uses now.
    let requestTime = new Date();
    if (asOf && process.env.NODE_ENV !== "production") {
      const parsed = new Date(asOf);
      if (!Number.isNaN(parsed.getTime())) requestTime = parsed;
    }
    if (!isPaymentWindowOpen(requestTime)) {
      return res.status(403).send({
        error: "Payments are accepted only between 10:00 AM and 11:00 AM IST.",
        code: "PAYMENT_WINDOW_CLOSED",
        istTime: paymentClock(requestTime),
        windowOpensInMs: millisUntilPaymentWindow(requestTime),
      });
    }

    // 5. Record the attempt as pending BEFORE the provider runs.
    const transaction = await Subscription.create({
      user: authenticatedUser._id,
      plan: requestedPlan.id,
      amountInr: requestedPlan.priceInr,
      status: "pending",
      provider: "mock",
    });

    // 6. Charge through the replaceable provider abstraction. The window was
    // already decided above, so only the outcome is mock-controllable.
    const result = await processPayment({
      plan: requestedPlan,
      amountInr: requestedPlan.priceInr,
      userId: String(authenticatedUser._id),
      testOutcome,
    });

    if (!result.ok) {
      // Failure/cancellation: the plan is left EXACTLY as it was.
      transaction.status = result.status;
      transaction.providerRef = result.providerRef;
      await transaction.save();
      return res.status(402).send({
        error: result.failureReason || "Payment was not completed.",
        code: `PAYMENT_${String(result.status).toUpperCase()}`,
        provider: result.provider,
        status: transaction.status,
        plan: authenticatedUser.plan || "free",
      });
    }

    // 7. Success: persist the new plan FIRST, and only then mark the
    // transaction successful. If the user update throws, the row stays
    // `pending` and the API reports the inconsistency - it NEVER claims a
    // success the database does not reflect.
    authenticatedUser.plan = requestedPlan.id;
    await authenticatedUser.save();

    transaction.status = "success";
    transaction.providerRef = result.providerRef;
    await transaction.save();

    // 8. Phase 3: exactly one invoice per successful transaction. `createInvoice`
    // is idempotent, so even if this block ever ran twice, MongoDB's unique
    // index on `subscription` guarantees no duplicate row is created.
    const { invoice } = await createInvoice({
      userId: authenticatedUser._id,
      subscriptionId: transaction._id,
      plan: requestedPlan,
      provider: result.provider,
      providerRef: result.providerRef,
      paidAt: transaction.updatedAt || new Date(),
    });

    // 9. Phase 3: invoice/plan confirmation through the EXISTING mock mailer
    // abstraction (console in this environment; SMTP later with zero feature
    // changes). Email outcome is recorded ON the invoice only: a mailer
    // failure can never downgrade a successful payment, and the API reports
    // the delivery status honestly instead of claiming "email sent".
    const tweetQuota =
      requestedPlan.unlimited === true
        ? "unlimited"
        : requestedPlan.tweetLimit;
    let emailDelivery = "pending";
    try {
      const mailResult = await sendInvoiceEmail({
        to: authenticatedUser.email,
        invoiceNumber: invoice.invoiceNumber,
        planName: requestedPlan.name,
        amount: requestedPlan.priceInr,
        date: getCurrentPeriod(requestTime).label,
        providerRef: result.providerRef,
        tweetQuota,
      });
      emailDelivery = mailResult && mailResult.delivered === true ? "sent" : "failed";
    } catch (error) {
      console.error("[invoice] confirmation email failed:", error?.message || "unknown error");
      emailDelivery = "failed";
    }
    invoice.emailDelivery = emailDelivery;
    await invoice.save();

    const periodLabel = getCurrentPeriod(requestTime).label;
    return res.status(201).send({
      ok: true,
      status: "success",
      provider: result.provider,
      providerRef: result.providerRef,
      plan: requestedPlan.id,
      planName: requestedPlan.name,
      amountInr: requestedPlan.priceInr,
      transactionId: transaction._id,
      periodLabel,
      invoiceNumber: invoice.invoiceNumber,
      invoiceStatus: invoice.status,
      emailDelivery,
    });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
// get all tweet
app.get("/post", async (req, res) => {
  try {
    const tweet = await Tweet.find().sort({ timestamp: -1 }).populate("author");
    return res.status(200).send(tweet);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
//  LIKE TWEET
app.post("/like/:tweetid", async (req, res) => {
  try {
    const { userId } = req.body;
    const tweet = await Tweet.findById(req.params.tweetid);
    if (!tweet.likedBy.includes(userId)) {
      tweet.likes += 1;
      tweet.likedBy.push(userId);
      await tweet.save();
    }
    res.send(tweet);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
// retweet 
app.post("/retweet/:tweetid", async (req, res) => {
  try {
    const { userId } = req.body;
    const tweet = await Tweet.findById(req.params.tweetid);
    if (!tweet.retweetedBy.includes(userId)) {
      tweet.retweets += 1;
      tweet.retweetedBy.push(userId);
      await tweet.save();
    }
    res.send(tweet);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

// ===========================================================================
// INTERNSHIP FEATURE 6 - FORGOT PASSWORD
// ===========================================================================
// Twiller already authenticates with Firebase, and Firebase ALREADY provides
// `sendPasswordResetEmail`, `verifyPasswordResetCode` and `confirmPasswordReset`.
// We deliberately REUSE those APIs rather than inventing a second password store.
//
// The backend owns the recovery WORKFLOW:
//   1. who is asking            -> find the Twiller user
//   2. are they allowed to      -> maximum one request per day (enforced here,
//      keep asking                  not in the browser)
//   3. did they prove ownership  -> SMS OTP for the phone channel
//   4. is the new password legal -> letters only, no digits, no symbols
//
// The actual password change is performed by Firebase from the browser, so no
// password is ever stored or logged in MongoDB.
// ===========================================================================

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const RECOVERY_TOKEN_TTL_MINUTES = Number(process.env.RECOVERY_TOKEN_TTL_MINUTES || 15);
// Anti-abuse limit for the "request" endpoint, per IP address.
// Configurable so it can be tuned per deployment and so the automated test
// suite can be run repeatedly against a long-lived process.
const REQUEST_RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 5);
const REQUEST_RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);

/** In-memory sliding window counter (simple, no dependency needed). */
const requestRateBuckets = new Map();

function isRequestRateLimited(ip) {
  const now = Date.now();
  const bucket = (requestRateBuckets.get(ip) || []).filter(
    (time) => now - time < REQUEST_RATE_LIMIT_WINDOW_MS
  );
  if (bucket.length >= REQUEST_RATE_LIMIT_MAX) {
    requestRateBuckets.set(ip, bucket);
    return true;
  }
  bucket.push(now);
  requestRateBuckets.set(ip, bucket);
  return false;
}

/** Normalises a phone number to digits only so "+91 98765 43210" matches "919876543210". */
function normalisePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

/** YYYY-MM-DD for the current IST day - used by the one-request-per-day rule. */
function currentIstDay() {
  const { year, month, day } = getIstParts();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * STEP 1 - Request password recovery.
 * POST /auth/forgot-password/request   { identifier }
 *
 * `identifier` is either an email address or a phone number.
 * Email -> Firebase sends the reset code to that address.
 * Phone -> we send a 6-digit SMS OTP that must be verified first.
 */
app.post("/auth/forgot-password/request", async (req, res) => {
  try {
    const rawIdentifier = String(req.body.identifier || "").trim();
    if (!rawIdentifier) {
      return res.status(400).send({ error: "Please enter your email address or phone number." });
    }

    // Anti-abuse: stop one IP from spamming this endpoint.
    if (isRequestRateLimited(req.ip || "unknown")) {
      return res.status(429).send({
        error:
          "Too many recovery attempts from this device. Please wait a few minutes and try again.",
      });
    }

    const isEmail = rawIdentifier.includes("@");
    const identifier = isEmail ? rawIdentifier.toLowerCase() : normalisePhone(rawIdentifier);

    if (!isEmail && identifier.length < 10) {
      return res.status(400).send({ error: "Please enter a valid phone number." });
    }

    const user = isEmail
      ? await User.findOne({ email: identifier })
      : await User.findOne({ phone: identifier });

    // SECURITY - do not reveal whether an account exists. The response is
    // identical either way. In development only, `devHint` tells the
    // developer what actually happened so the flow can be tested locally.
    const genericMessage =
      "If that account exists, recovery instructions have been sent to you.";

    if (!user) {
      return res.status(200).send({
        ok: true,
        message: genericMessage,
        ...(exposeDevCode() ? { devHint: "No Twiller user matches that identifier." } : {}),
      });
    }

    // ---- RULE: maximum one request per day (per user, per IST day) ----
    const today = currentIstDay();
    const alreadyRequestedToday = await PasswordReset.findOne({
      user: user._id,
      dailyRequestDate: today,
    });

    if (alreadyRequestedToday) {
      const nextAllowed = new Date(alreadyRequestedToday.requestedAt.getTime() + 24 * 60 * 60 * 1000);
      return res.status(429).send({
        error:
          "You have already requested a password reset today. You may request again after 24 hours.",
        dailyLimitReached: true,
        nextAllowedAt: nextAllowed.toISOString(),
        lastRequestedAt: alreadyRequestedToday.requestedAt.toISOString(),
      });
    }

    const channel = isEmail ? "email" : "phone";

    if (channel === "email") {
      // Firebase performs the actual reset-email delivery from the browser
      // (sendPasswordResetEmail). Here we only record the request so the daily
      // limit is enforced server-side and the attempt is auditable.
      await PasswordReset.create({
        user: user._id,
        identifier: user.email,
        channel,
        status: "pending",
        dailyRequestDate: today,
      });

      return res.status(200).send({
        ok: true,
        channel,
        message: `We have sent a password reset link to ${user.email}. Check your inbox.`,
        expiresInMinutes: OTP_TTL_MINUTES,
      });
    }

    // ---- PHONE CHANNEL: generate, hash and send a 6-digit OTP ----
    const otp = generateOtp();
    const { hash, salt } = hashSecret(otp);
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await PasswordReset.create({
      user: user._id,
      identifier,
      channel,
      status: "pending",
      dailyRequestDate: today,
      otpHash: hash,
      otpSalt: salt,
      otpExpiresAt,
    });

    const result = await sendSms({
      kind: "password-reset-otp",
      to: identifier,
      body: `Your Twiller verification code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes. Do not share it with anyone.`,
      devCode: otp,
    });

    return res.status(200).send({
      ok: true,
      channel,
      message: `A ${OTP_TTL_MINUTES} minute verification code has been sent to your phone.`,
      expiresInMinutes: OTP_TTL_MINUTES,
      delivered: result.delivered,
      // devCode is attached by sendSms ONLY when NODE_ENV !== "production".
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

/**
 * STEP 2 - Verify the SMS OTP (phone channel only).
 * POST /auth/forgot-password/verify-otp   { identifier, otp }
 *
 * On success the server issues a short-lived, single-use recovery token that
 * the client must present when finalising the reset.
 */
app.post("/auth/forgot-password/verify-otp", async (req, res) => {
  try {
    const rawIdentifier = String(req.body.identifier || "").trim();
    const otp = String(req.body.otp || "").trim();

    if (!rawIdentifier || !otp) {
      return res.status(400).send({ error: "Identifier and verification code are required." });
    }

    if (!isValidOtpShape(otp)) {
      return res.status(400).send({ error: "Please enter a valid 6-digit verification code." });
    }

    const identifier = rawIdentifier.includes("@")
      ? rawIdentifier.toLowerCase()
      : normalisePhone(rawIdentifier);

    const record = await PasswordReset.findOne({
      identifier,
      channel: "phone",
      status: "pending",
    }).sort({ requestedAt: -1 });

    if (!record) {
      return res.status(404).send({ error: "No pending verification was found. Please request a new code." });
    }

    // Expiry is checked on the SERVER, not trusted from the browser.
    if (record.otpExpiresAt && record.otpExpiresAt.getTime() < Date.now()) {
      record.status = "expired";
      await record.save();
      return res.status(410).send({ error: "That verification code has expired. Please request a new one." });
    }

    // Brute-force protection.
    if (record.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).send({
        error: "Too many incorrect attempts. Please request a new verification code.",
      });
    }

    const matches = verifySecret(otp, record.otpHash, record.otpSalt);

    if (!matches) {
      record.otpAttempts += 1;
      await record.save();
      const remaining = Math.max(MAX_OTP_ATTEMPTS - record.otpAttempts, 0);
      return res.status(401).send({
        error: `Incorrect verification code. ${remaining} attempt(s) remaining.`,
      });
    }

    // ---- OTP accepted: issue a single-use recovery token ----
    const recoveryToken = generateSecureToken();
    const tokenSecret = hashSecret(recoveryToken);

    record.status = "verified";
    record.verifiedAt = new Date();
    record.otpHash = null; // one-time use - destroy the stored OTP
    record.otpSalt = null;
    record.recoveryTokenHash = tokenSecret.hash;
    record.recoveryTokenSalt = tokenSecret.salt;
    record.recoveryExpiresAt = new Date(
      Date.now() + RECOVERY_TOKEN_TTL_MINUTES * 60 * 1000
    );
    await record.save();

    // NOTE: the token value itself is deliberately never written to the log.
    return res.status(200).send({
      ok: true,
      message: "Verification successful. You can now set a new password.",
      recoveryToken,
      expiresInMinutes: RECOVERY_TOKEN_TTL_MINUTES,
    });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

/**
 * STEP 3 - Finalise: validate the new password against the assignment rules.
 * POST /auth/forgot-password/complete   { identifier, password, recoveryToken? }
 *
 * The browser applies the password to Firebase via `confirmPasswordReset`.
 * This endpoint is the SERVER-SIDE policy gate: it enforces the
 * "uppercase/lowercase letters only" rule so it cannot be bypassed by posting
 * directly to the API. The password is validated and immediately discarded -
 * only a salted fingerprint is kept for the audit trail.
 */
app.post("/auth/forgot-password/complete", async (req, res) => {
  try {
    const rawIdentifier = String(req.body.identifier || "").trim();
    const password = req.body.password;
    const recoveryToken = req.body.recoveryToken ? String(req.body.recoveryToken) : null;

    if (!rawIdentifier) {
      return res.status(400).send({ error: "Identifier is required." });
    }

    const identifier = rawIdentifier.includes("@")
      ? rawIdentifier.toLowerCase()
      : normalisePhone(rawIdentifier);

    const record = await PasswordReset.findOne({ identifier }).sort({ requestedAt: -1 });

    if (!record) {
      return res.status(404).send({ error: "No recovery request was found for that account." });
    }

    if (record.status === "completed") {
      return res.status(409).send({ error: "This recovery request has already been used." });
    }

    if (record.channel === "phone") {
      // The phone channel MUST present a valid recovery token, which can only
      // be obtained after a successful OTP verification.
      if (record.status !== "verified" || !recoveryToken) {
        return res.status(401).send({ error: "Please verify your phone code before resetting." });
      }
      if (record.recoveryExpiresAt && record.recoveryExpiresAt.getTime() < Date.now()) {
        return res.status(410).send({ error: "Your verification session has expired. Please start again." });
      }
      if (!verifySecret(recoveryToken, record.recoveryTokenHash, record.recoveryTokenSalt)) {
        return res.status(401).send({ error: "Invalid or expired recovery session. Please start again." });
      }
    }

    // ---- THE ASSIGNMENT RULE: letters only, no numbers, no symbols ----
    const validation = validateGeneratedPassword(password);
    if (!validation.valid) {
      return res.status(400).send({ error: validation.reason, policy: "letters-only" });
    }

    // The plaintext password is NEVER stored - only a salted fingerprint.
    const fingerprint = fingerprintPassword(password);
    record.status = "completed";
    record.completedAt = new Date();
    record.appliedPasswordHash = fingerprint.hash;
    record.appliedPasswordSalt = fingerprint.salt;
    record.recoveryTokenHash = null;
    record.recoveryTokenSalt = null;
    await record.save();

    return res.status(200).send({
      ok: true,
      message: "Password reset recorded. You can now sign in with your new password.",
      completedAt: record.completedAt.toISOString(),
      istTime: getIstTimeString(),
    });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

/**
 * Utility - password policy check used by the "Generate password" button so the
 * user gets instant feedback. The authoritative check still happens in
 * /auth/forgot-password/complete, so this is advisory only.
 */
app.post("/auth/forgot-password/validate-password", async (req, res) => {
  try {
    const validation = validateGeneratedPassword(req.body.password);
    return res.status(200).send({ ...validation, policy: "letters-only" });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

/**
 * Utility - recent recovery requests for an account (audit trail).
 * GET /auth/forgot-password/history?email=...
 * Deliberately never returns OTPs, tokens or password fingerprints.
 */
app.get("/auth/forgot-password/history", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).send({ error: "Email required" });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.status(200).send([]);

    const records = await PasswordReset.find({ user: user._id })
      .sort({ requestedAt: -1 })
      .limit(10)
      .select("channel status requestedAt verifiedAt completedAt otpExpiresAt identifier");

    return res.status(200).send(records);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});