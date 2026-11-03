import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import User from "./models/user.js";
import Tweet from "./models/tweet.js";
import PasswordReset from "./models/passwordreset.js";
import LanguageOtp, { LANGUAGE_OTP_LOCALES } from "./models/languageotp.js";
import AudioOtp from "./models/audiootp.js";
import { sendMail, exposeDevCode } from "./utils/mailer.js";
import { sendSms, toE164 } from "./utils/sms.js";
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
import { getIstParts, getIstTimeString, isWithinIstWindow, millisUntilNextIstWindow } from "./utils/istTime.js";
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
import requireFirebaseAuth from "./middleware/requireFirebaseAuth.js";
// Internship Feature 2 - login history + device/browser access rules.
import LoginHistory from "./models/loginhistory.js";
import LoginOtp from "./models/loginotp.js";
import {
  enforceMobileWindow,
  evaluateDevicePolicy,
  requiresEmailOtp,
} from "./middleware/devicePolicy.js";
import fs from "node:fs";
// Internship Feature 4 (phase 1) - path helpers for upload filenames and
// static media mounts. Added only for the new image-upload route below.
import path from "node:path";
import { probeAudioDuration, MAX_AUDIO_DURATION_SECONDS } from "./utils/audioProbe.js";
import multer from "multer";


// Persistent audio storage directory. Configurable via AUDIO_UPLOAD_DIR; falls
// back to server/uploads/ so existing deployments keep working.
// The directory is created on startup so multer never fails with ENOENT.
const AUDIO_UPLOAD_DIR = process.env.AUDIO_UPLOAD_DIR || "uploads/";

// Persistent image storage directory. Configurable via IMAGE_UPLOAD_DIR; falls
// back to server/uploads/images/ so existing deployments keep working.
// The directory is created on startup so multer never fails with ENOENT.
const IMAGE_UPLOAD_DIR = process.env.IMAGE_UPLOAD_DIR || "uploads/images/";
fs.mkdirSync(IMAGE_UPLOAD_DIR, { recursive: true });

// Maximum uploaded image size: 5 MB.
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

// Allowed image MIME types.
const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// Maximum uploaded audio size: 100 MB.
const MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024;
fs.mkdirSync(AUDIO_UPLOAD_DIR, { recursive: true });
const app = express();
// Behind a proxy / Netlify-Render style host, trust the forwarded headers so
// req.protocol reflects the real client scheme (https) when building media URLs.
app.set("trust proxy", 1);
// CORS: permissive by default (unchanged local/dev behaviour and test
// expectations). Set CORS_ORIGINS to a comma-separated allow-list in
// production (e.g. the Netlify site URL) to lock it down.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors(
    ALLOWED_ORIGINS.length
      ? {
          origin: (origin, callback) =>
            !origin || ALLOWED_ORIGINS.includes(origin)
              ? callback(null, true)
              : callback(null, false),
        }
      : {}
  )
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Twiller backend is running successfully");
});

// The subscription page gets its display data from the same plan definitions
// used by quota enforcement and payment processing. This route must be
// registered before the terminal JSON 404 middleware at the end of the file.
app.get("/plans", (req, res) => {
  const plans = Object.values(PLANS).map((plan) => ({
    id: plan.id,
    name: plan.name,
    priceInr: plan.priceInr,
    tweetLimit: plan.tweetLimit,
    unlimited: plan.unlimited,
  }));

  return res.status(200).json({
    plans,
    paymentWindow: {
      startHour: PAYMENT_WINDOW_START_HOUR,
      endHour: PAYMENT_WINDOW_END_HOUR,
      timeZone: "Asia/Kolkata",
    },
  });
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

// ===========================================================================
// SECURE AUTH INTEGRATION - Firebase <-> MongoDB identity mapping.
//
// `req.firebaseUser` is set by `requireFirebaseAuth` from the VERIFIED
// Firebase ID token ONLY (uid, email, emailVerified). Nothing on these routes
// trusts a client-supplied email / user id as identity.
//
// Resolution order (never silently overwrites an existing UID):
//   1. exact match on (firebaseProjectId, firebaseUid)  -> that user, noop
//   2. email match:
//        - user's UID unbound + token email verified    -> bind UID (link)
//        - user's UID unbound + token email UNverified   -> 401, no write
//        - user's UID bound to a DIFFERENT uid          -> 409 conflict, no write
//   3. no user for that email                           -> create, UID bound
// ===========================================================================

const firebaseProjectId = (process.env.FIREBASE_PROJECT_ID || "").trim();

/**
 * Idempotent, non-destructive UID binding. Never overwrites a conflicting
 * UID; leaves legacy (unbound) users untouched until they verify.
 * Returns { ok, conflict, action: "noop" | "linked" }.
 */
async function bindUserToFirebaseIdentity(user, uid, projectId) {
  if (!user) return { ok: false, conflict: false };
  if (user.firebaseUid && user.firebaseUid !== uid) {
    return { ok: false, conflict: true };
  }
  if (user.firebaseUid === uid) {
    return { ok: true, bound: true, action: "noop" };
  }
  user.firebaseUid = uid;
  user.firebaseProjectId = projectId || user.firebaseProjectId || "";
  await user.save();
  console.log(`[auth] linked Firebase identity -> user ${user._id} (uid ...${uid.slice(-6)})`);
  return { ok: true, bound: true, action: "linked" };
}

/**
 * POST /auth/account/link - the single safe account-linking entry point.
 * Secured by requireFirebaseAuth: identity is the verified token, not the body.
 * Body fields are profile data ONLY (used when creating a brand-new profile).
 * Existing profiles, tweets, likes, retweets, subscriptions and invoices are
 * never touched - only the two optional UID fields are written.
 */
app.post("/auth/account/link", requireFirebaseAuth, async (req, res) => {
  try {
    const { uid, email: tokenEmail, emailVerified } = req.firebaseUser;

    // 1) Primary key: exact UID (+ project) match.
    const uidMatch =
      firebaseProjectId
        ? await User.findOne({ firebaseUid: uid, firebaseProjectId: firebaseProjectId })
        : await User.findOne({ firebaseUid: uid });
    if (uidMatch) {
      await bindUserToFirebaseIdentity(uidMatch, uid, firebaseProjectId);
      return res.status(200).json({
        user: uidMatch,
        action: uidMatch.firebaseUid === uid ? "existing" : "linked",
        linked: uidMatch.firebaseUid !== uid,
        created: false,
      });
    }

    // 2) Email match: link ONLY when the token's email is verified.
    if (tokenEmail) {
      const existing = await User.findOne({ email: tokenEmail });
      if (existing) {
        if (existing.firebaseUid && existing.firebaseUid !== uid) {
          // Never silently re-point a bound account.
          return res.status(409).json({
            error: "This email is already linked to a different Firebase account.",
            code: "auth-conflict",
          });
        }
        if (!emailVerified) {
          return res.status(401).json({
            error: "Verify your email address before linking to an existing Twiller profile.",
            code: "email-unverified",
          });
        }
        await bindUserToFirebaseIdentity(existing, uid, firebaseProjectId);
        return res.status(200).json({ user: existing, action: "linked", linked: true, created: false });
      }
    }

    // 3) No user for that email -> create a fresh profile, UID bound.
    const profileBody = {
      username:
        (typeof req.body.username === "string" && req.body.username.trim()) ||
        (tokenEmail ? tokenEmail.split("@")[0] : `user_${uid.slice(-6)}`),
      displayName:
        (typeof req.body.displayName === "string" && req.body.displayName.trim()) ||
        "Twiller User",
      avatar:
        (typeof req.body.avatar === "string" && req.body.avatar.trim()) ||
        "https://images.pexels.com/photos/1139743/pexels-photo-1139743.jpeg?auto=compress&cs=tinysrgb&w=400",
      email: tokenEmail,
      phone:
        typeof req.body.phone === "string" ? req.body.phone.replace(/\D/g, "") : "",
      firebaseUid: uid,
      firebaseProjectId: firebaseProjectId,
    };
    const user = await User.create(profileBody);
    console.log(`[auth] created user ${user._id} for Firebase identity (uid ...${uid.slice(-6)})`);
    return res.status(201).json({ user, action: "created", linked: true, created: true });
  } catch (error) {
    if (error && error.code === 11000) {
      // Race: the profile appeared between our lookups. Resolve by email with
      // the same rules - never create a second document for one email.
      const race = await User.findOne({ email: req.firebaseUser.email });
      if (race) {
        if (race.firebaseUid && race.firebaseUid !== req.firebaseUser.uid) {
          return res.status(409).json({ error: "This email is already linked to a different Firebase account.", code: "auth-conflict" });
        }
        await bindUserToFirebaseIdentity(race, req.firebaseUser.uid, firebaseProjectId);
        return res.status(200).json({ user: race, action: "linked", linked: true, created: false });
      }
    }
    return res.status(400).json({ error: error.message });
  }
});

/**
 * Resolve the acting user from the verified token (used by the secured
 * read/update routes). UID-first; email fallback for legacy accounts only
 * when the token email is verified; a conflicting bound UID always wins.
 */
async function resolveTokenUser(req) {
  const { uid, email: tokenEmail, emailVerified } = req.firebaseUser;
  const exact = firebaseProjectId
    ? await User.findOne({ firebaseUid: uid, firebaseProjectId: firebaseProjectId })
    : await User.findOne({ firebaseUid: uid });
  if (exact) {
    await bindUserToFirebaseIdentity(exact, uid, firebaseProjectId);
    return { user: exact, action: "uid" };
  }
  if (!tokenEmail) return { user: null, action: "none" };
  const byEmail = await User.findOne({ email: tokenEmail });
  if (!byEmail) return { user: null, action: "none" };
  if (byEmail.firebaseUid && byEmail.firebaseUid !== uid) {
    return { user: null, action: "conflict" };
  }
  if (byEmail.firebaseUid !== uid) {
    // Bind legacy (unbound) accounts - only when the address is verified.
    if (!emailVerified) return { user: null, action: "unverified" };
    await bindUserToFirebaseIdentity(byEmail, uid, firebaseProjectId);
  }
  return { user: byEmail, action: "email" };
}

//Register - SECURED. Requires a verified Firebase token; identity (and the
//profile that is created/linked) comes from the token, never from the body.
//An already-mapped Firebase identity returns its existing profile instead of
//creating a duplicate document.
app.post("/register", requireFirebaseAuth, enforceMobileWindow, async (req, res) => {
  try {
    const { uid, email: tokenEmail, emailVerified } = req.firebaseUser;

    // Never create a duplicate: if this Firebase identity already mapped to
    // a profile, hand that profile back instead of a second document.
    const uidMatch =
      firebaseProjectId
        ? await User.findOne({ firebaseUid: uid, firebaseProjectId: firebaseProjectId })
        : await User.findOne({ firebaseUid: uid });
    if (uidMatch) {
      return res.status(200).send(uidMatch);
    }

    if (tokenEmail) {
      const existinguser = await User.findOne({ email: tokenEmail });
      if (existinguser) {
        // An already-bound, DIFFERENT Firebase account owns this email.
        if (existinguser.firebaseUid && existinguser.firebaseUid !== uid) {
          return res.status(409).send({
            error: "This email is already linked to a different Firebase account.",
            code: "auth-conflict",
          });
        }
        // A verified token email links to the existing profile. The original
        // document is returned untouched except the two UID fields, so all
        // tweets, likes, retweets and subscriptions are preserved.
        if (!emailVerified) {
          return res.status(401).send({
            error: "Verify your email address before linking to an existing Twiller profile.",
            code: "email-unverified",
          });
        }
        await bindUserToFirebaseIdentity(existinguser, uid, firebaseProjectId);
        return res.status(200).send(existinguser);
      }
    }

    const newUser = new User(req.body);
    // Internship Feature 6: store the phone as digits only so that
    // phone-based password recovery can match "+91 98765 43210" against
    // "919876543210". Existing users who never set a phone are unaffected.
    if (newUser.phone) {
      newUser.phone = String(newUser.phone).replace(/\D/g, "");
    }
    // Bind the verified identity to the NEW profile up front.
    newUser.firebaseUid = uid;
    newUser.firebaseProjectId = firebaseProjectId;
    if (tokenEmail) newUser.email = tokenEmail;
    await newUser.save();
    return res.status(201).send(newUser);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

// loggedinuser - SECURED. The acting user comes from the verified token, not
// from a client-supplied email. Legacy accounts still resolve through their
// verified email (UID-first), so old profiles keep working unchanged.
app.get("/loggedinuser", requireFirebaseAuth, async (req, res) => {
  try {
    const { user, action } = await resolveTokenUser(req);
    if (action === "conflict") {
      return res.status(409).send({
        error: "This email is linked to a different Firebase account.",
        code: "auth-conflict",
      });
    }
    if (action === "unverified") {
      return res.status(401).send({
        error: "Verify your email address to access this profile.",
        code: "email-unverified",
      });
    }
    if (!user) {
      return res.status(404).send({
        error: "No Twiller profile exists for this account. Register first.",
        code: "no-profile",
      });
    }
    return res.status(200).send(user);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

// update Profile - SECURED. The caller may update only the profile whose
// verified email matches the token; the route param keeps the legacy shape.
app.patch("/userupdate/:email", requireFirebaseAuth, async (req, res) => {
  try {
    const { email: routeEmail } = req.params;
    const { email: tokenEmail } = req.firebaseUser;
    if (!tokenEmail) {
      return res.status(401).send({
        error: "Sign in with an email account to update your profile.",
        code: "auth-required",
      });
    }
    if (tokenEmail !== String(routeEmail).trim().toLowerCase()) {
      return res.status(403).send({
        error: "You can only update your own profile.",
        code: "identity-mismatch",
      });
    }
    const user = await User.findOne({ email: tokenEmail });
    if (!user) {
      return res.status(404).send({ error: "Profile not found.", code: "no-profile" });
    }
    // Never re-point a profile that is bound to a DIFFERENT Firebase account,
    // even through profile updates.
    if (user.firebaseUid && user.firebaseUid !== req.firebaseUser.uid) {
      return res.status(409).send({
        error: "This profile is linked to a different Firebase account.",
        code: "auth-conflict",
      });
    }
    // Only the profile fields are updatable - identity fields are read-only.
    const { firebaseUid, firebaseProjectId, ...profileFields } = req.body || {};

    // Internship Feature 4 (phase 2) - normalise the phone number exactly like
    // /register does (digits only, so "+91 98765 43210" == "919876543210") and
    // refuse a number another account already uses. An empty value clears it,
    // so profiles that never had a phone keep working unchanged.
    if (profileFields.phone !== undefined) {
      const rawPhone = String(profileFields.phone ?? "").trim();
      const normalisedPhone = normalisePhone(rawPhone);
      if (rawPhone && normalisedPhone.length < 7) {
        return res.status(400).send({
          error: "Please enter a valid phone number (at least 7 digits).",
          code: "invalid-phone",
        });
      }
      // Only look for a clash when the number actually changed.
      if (normalisedPhone && normalisedPhone !== normalisePhone(user.phone)) {
        const clash = await User.findOne({
          phone: normalisedPhone,
          _id: { $ne: user._id },
        });
        if (clash) {
          return res.status(409).send({
            error: "That phone number is already used by another account.",
            code: "phone-taken",
          });
        }
      }
      profileFields.phone = normalisedPhone;
    }

    const updated = await User.findOneAndUpdate(
      { _id: user._id },
      { $set: profileFields },
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

// ===========================================================================
// INTERNSHIP FEATURE 5 (phase 3) - Audio Tweets.
// POST /audio/upload   { audio (single file), otp (email code), content? }
// Requires: a verified audio OTP for the authenticated user, and the current
// IST time to be inside 14:00-19:00 (Feature 5 upload window). The uploaded
// file is probed server-side with ffprobe - the client-supplied duration is
// NEVER trusted. Files over 300 seconds (MAX_AUDIO_DURATION_SECONDS) are
// rejected with code "audio-too-long".
// ===========================================================================
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, IMAGE_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = String(file.mimetype || "image/jpeg").split("/").pop() || "jpg";
      cb(null, "image-" + Date.now() + "-" + Math.random().toString(36).slice(2) + "." + ext);
    },
  }),
  limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error("Invalid image type. Only JPEG, PNG, WebP, and GIF are allowed."), false);
    }
    cb(null, true);
  },
});

const audioUpload = multer({ storage: multer.diskStorage({
  // Multer stores each upload in the persistent directory below, where
  // probeAudioDuration() can find it and where the route handler cleans up
  // on failure.
  destination: (req, file, cb) => cb(null, AUDIO_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = String(file.mimetype || "audio/mpeg").split("/").pop() || "mp3";
    cb(null, `audio-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  },
})});

// ===========================================================================
// INTERNSHIP FEATURE 4 (phase 1) - Image uploads (backend endpoint).
//
// The imageUpload multer, IMAGE_UPLOAD_DIR, MAX_IMAGE_SIZE_BYTES (5 MB) and
// ALLOWED_IMAGE_MIME_TYPES already existed but were never wired to a route, so
// the frontend uploaded images straight to a third-party host (imgbb) with a
// hardcoded API key. This route completes that existing design: the SAME
// validation runs server-side and the file is stored under IMAGE_UPLOAD_DIR.
//
// POST /image/upload   { image (single file) }   (Bearer token required)
//   - 401 when unauthenticated (requireFirebaseAuth)
//   - 413 when the file exceeds 5 MB
//   - 400 for a missing file or an unsupported MIME type
//   - 201 with { ok, path, url, contentType, size } on success
//
// No existing route or field is changed. Previously-stored absolute image
// URLs (e.g. imgbb) keep working because the UI renders whatever string is
// stored in tweet.image / user.avatar.
// ===========================================================================
function uploadSingleImage(req, res, next) {
  imageUpload.single("image")(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err && err.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? "Image is too large. Maximum size is 5 MB."
        : err.message || "Invalid image upload.",
      code: tooLarge ? "image-too-large" : "invalid-image",
    });
  });
}

app.post("/image/upload", requireFirebaseAuth, uploadSingleImage, (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file was uploaded.", code: "no-file" });
    }
    const fileName = path.basename(req.file.path);
    const publicPath = `/uploads/images/${fileName}`;
    return res.status(201).json({
      ok: true,
      path: publicPath,
      // Absolute URL, best-effort (used by tests / simple clients). The
      // frontend prefers `path` + its own backend base so the correct
      // https:// host is always used behind Netlify.
      url: `${req.protocol}://${req.get("host")}${publicPath}`,
      contentType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (error) {
    return res.status(500).json({ error: "Image upload failed.", code: "upload-error" });
  }
});

// Static delivery of uploaded media so files are retrievable by URL.
// /uploads/images is mounted BEFORE the broader /uploads so an image request
// can never fall through to the audio directory (and vice versa).
app.use("/uploads/images", express.static(IMAGE_UPLOAD_DIR));
app.use("/uploads", express.static(AUDIO_UPLOAD_DIR));

app.post("/audio/upload", requireFirebaseAuth, audioUpload.single("audio"), async (req, res) => {
  let uploadedPath = null;
  try {
    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({ error: "No Twiller profile found for this account.", code: "no-profile" });
    }

    const otpRecord = await AudioOtp.findOne({ user: user._id, status: "verified" });
    if (!otpRecord) {
      return res.status(403).send({ error: "Audio upload requires a verified email code. Request and verify one first.", code: "otp-required" });
    }

    // Feature 5 upload window: 14:00-19:00 IST.
    // AUDIO_UPLOAD_FORCE_WINDOW_OPEN is a test/dev hatch to bypass the window
    // check without changing the production behaviour.
    if (!isWithinIstWindow(14, 19) && process.env.AUDIO_UPLOAD_FORCE_WINDOW_OPEN !== "true") {
      return res.status(403).send({
        error: "Audio uploads are allowed only from 2:00 PM to 7:00 PM IST.",
        code: "upload-window-closed",
        retryAfterSeconds: Math.ceil(millisUntilNextIstWindow(14, 19) / 1000),
      });
    }

    if (!req.file) {
      return res.status(400).send({ error: "No audio file was uploaded.", code: "no-file" });
    }

    uploadedPath = req.file.path;

    // --- Server-side duration validation (Never trust client-supplied duration) ---
    if (!fs.existsSync(uploadedPath)) {
      return res.status(400).send({ error: "Uploaded audio file could not be found on the server.", code: "audio-file-missing" });
    }

    const probe = await probeAudioDuration(uploadedPath);

    if (probe.unavailable) {
      // Best-effort cleanup on failure.
      try { await fs.promises.unlink(uploadedPath); } catch (e) { /* ignore */ }
      return res.status(503).send({
        error: "Audio duration validation is unavailable because ffprobe is not installed on the server.",
        code: "duration-validation-unavailable",
        hint: "Install ffmpeg (which bundles ffprobe), then restart the server.",
        deploymentNote: "Run: apt-get install -y ffmpeg (Debian/Ubuntu), brew install ffmpeg (macOS), or winget install ggscfiu.ffmpeg",
      });
    }

    if (!probe.ok) {
      // Invalid or corrupt audio file.
      try { await fs.promises.unlink(uploadedPath); } catch (e) { /* ignore */ }
      return res.status(400).send({ error: probe.error || "The uploaded audio file is invalid or corrupt.", code: "invalid-audio-file" });
    }

    if (probe.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
      // Longest allowed duration.
      try { await fs.promises.unlink(uploadedPath); } catch (e) { /* ignore */ }
      return res.status(400).send({
        error: `Audio duration (${probe.durationSeconds}s) exceeds the maximum allowed duration of ${MAX_AUDIO_DURATION_SECONDS}s (5 minutes).`,
        code: "audio-too-long",
        maxDurationSeconds: MAX_AUDIO_DURATION_SECONDS,
        probedDurationSeconds: probe.durationSeconds,
      });
    }

    // Create the Tweet entry; the OTP will be consumed below ONLY if the tweet
    // saves successfully.
    const tweet = new Tweet({
      author: user._id,
      content: req.body.content || "",
      audioUrl: uploadedPath,
      audioDuration: probe.durationSeconds,
      audioSize: req.file.size,
      audioType: req.file.mimetype,
    });

    await tweet.save();

    // Consume the verified OTP only after the upload and Tweet save succeed.
    otpRecord.status = "consumed";
    otpRecord.consumedAt = new Date();
    await otpRecord.save();

    return res.status(201).json({
      ok: true,
      tweetId: tweet._id,
      audioUrl: uploadedPath,
      audioDuration: probe.durationSeconds,
      audioSize: req.file.size,
      audioType: req.file.mimetype,
    });
  } catch (error) {
    // Failure cleanup: remove the uploaded file so no temp audio is left on disk.
    if (uploadedPath) {
      try { await fs.promises.unlink(uploadedPath); } catch (e) { /* already gone */ }
    }
    const status = errorStatus(error) || 500;
    if (status >= 500) {
      console.error("Unhandled audio-upload error:", error && error.stack ? error.stack : error);
    }
    return res.status(status).json({
      error: status < 500 && typeof error?.message === "string" ? error.message : "Something went wrong on our side. Please try again.",
      code: status >= 500 ? "server-error" : "request-error",
    });
  }
});

// ===========================================================================
// Helper: map known errors to HTTP status codes.
// ===========================================================================
function errorStatus(error) {
  if (!error) return 500;
  const code = String(error.code || error.name || "").toLowerCase();
  if (code === "11000" || code === "duplicatekey") return 409;
  if (code === "validationerror" || code === "casterror") return 400;
  if (error.status) return error.status;
  return 500;
}

// ===========================================================================
// INTERNSHIP FEATURE 5 (phase 1) - Audio OTP request & verify.
// POST /audio/otp/request   { }   (Bearer token required)
//   Generates a 6-digit code, hashes it, stores it in AudioOtp, sends it by
//   email (mock console provider in dev). Returns devCode only in non-prod.
// POST /audio/otp/verify    { otp } (Bearer token required)
//   Compares the client code against the stored hash. On success marks the
//   record "verified" (single-use, consumed by /audio/upload). On failure
//   increments attempts; at MAX_OTP_ATTEMPTS the record is marked expired.
// ===========================================================================
app.post("/audio/otp/request", requireFirebaseAuth, async (req, res) => {
  try {
    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({ error: "No Twiller profile found for this account.", code: "no-profile" });
    }

    // Verified token email, lower-cased. BUGFIX: this local value is used by
    // sendMail (`to:`) and the confirmation message below but was never
    // declared, so the route threw `email is not defined` (HTTP 500) for every
    // request. Declaring it once here removes the crash.
    const email = req.firebaseUser.email ? req.firebaseUser.email.toLowerCase() : "";

    // Resend cooldown: at most one request per 60 seconds per user.
    const existing = await AudioOtp.findOne({ user: user._id }).sort({ requestedAt: -1 });
    if (existing && existing.status === "pending") {
      // If the existing pending code has exhausted attempts, replace it.
      if (existing.otpAttempts >= MAX_OTP_ATTEMPTS) {
        existing.status = "expired";
        await existing.save();
      } else {
        const since = Date.now() - new Date(existing.requestedAt).getTime();
        if (since < 60 * 1000) {
          return res.status(429).send({
            error: "A code is already pending. Please wait before requesting another.",
            code: "otp-cooldown",
            retryAfterSeconds: Math.ceil((60 * 1000 - since) / 1000),
          });
        }
      }
    }

    // Generate, hash, and store the OTP.
    const otp = generateOtp();
    const { hash, salt } = hashSecret(otp);
    const otpExpiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    const record = new AudioOtp({
      user: user._id,
      firebaseUid: req.firebaseUser.uid || "",
      email,
      channel: "email",
      status: "pending",
      otpHash: hash,
      otpSalt: salt,
      otpExpiresAt,
      otpAttempts: 0,
    });
    await record.save();

    // Send the code via email (console mock in dev; SMTP when configured).
    const result = await sendMail({
      to: email,
      subject: "Your Twiller audio upload code",
      body: `Your Twiller audio upload verification code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes. Do not share it with anyone.`,
      kind: "audio-upload-otp",
      devCode: otp,
    });

    return res.status(200).send({
      ok: true,
      channel: "email",
      message: `A ${OTP_TTL_MINUTES} minute verification code has been sent to ${email}.`,
      expiresInMinutes: OTP_TTL_MINUTES,
      delivered: result.delivered,
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (error) {
    const status = errorStatus(error) || 500;
    return res.status(status).send({ error: error.message || "Something went wrong." });
  }
});

app.post("/audio/otp/verify", requireFirebaseAuth, async (req, res) => {
  try {
    const { user } = await resolveTokenUser(req);
    const otp = String(req.body.otp || "").trim();

    if (!otp) {
      return res.status(400).send({ error: "Verification code is required.", code: "missing-otp" });
    }
    if (!isValidOtpShape(otp)) {
      return res.status(400).send({ error: "Invalid code format.", code: "invalid-otp-shape" });
    }

    if (!user) {
      return res.status(404).send({ error: "No Twiller profile found for this account.", code: "no-profile" });
    }

    const record = await AudioOtp.findOne({ user: user._id, status: "pending" });
    if (!record) {
      return res.status(404).send({ error: "No pending verification code found.", code: "no-pending-code" });
    }

    // Check expiry explicitly (TTL index is hygiene only).
    if (record.otpExpiresAt && new Date() > record.otpExpiresAt) {
      record.status = "expired";
      await record.save();
      return res.status(401).send({ error: "Verification code has expired.", code: "otp-expired" });
    }

    // Brute-force guard: if attempts already exhausted, reject with 429.
    if (record.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).send({ error: "Too many attempts. Code exhausted.", code: "attempts-exhausted" });
    }

    // Compare against stored hash.
    if (!verifySecret(otp, record.otpHash, record.otpSalt)) {
      record.otpAttempts += 1;
      await record.save();
      const remaining = MAX_OTP_ATTEMPTS - record.otpAttempts;
      if (remaining <= 0) {
        return res.status(429).send({ error: "Too many attempts. Code exhausted.", code: "attempts-exhausted" });
      }
      return res.status(401).send({
        error: "Incorrect verification code.",
        code: "incorrect-code",
        attemptsRemaining: remaining,
      });
    }

    // Success: mark verified (single-use).
    record.status = "verified";
    record.verifiedAt = new Date();
    await record.save();

    return res.status(200).json({ ok: true, verified: true });
  } catch (error) {
    const status = errorStatus(error) || 500;
    return res.status(status).send({ error: error.message || "Something went wrong." });
  }
});

// POST - SECURED. The acting user is the verified token's user; a
// client-supplied `author` is only honoured when it equals the caller's own
// id (legacy compatibility), never a foreign one (no impersonation).
app.post("/post", requireFirebaseAuth, enforceMobileWindow, async (req, res) => {
  try {
    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({
        error: "No Twiller profile for this account. Register first.",
        code: "no-profile",
      });
    }
    const claimedAuthor = req.body.author ? String(req.body.author) : "";
    if (claimedAuthor && claimedAuthor !== String(user._id)) {
      return res.status(403).send({
        error: "You can only post as yourself.",
        code: "identity-mismatch",
      });
    }
    const quota = await enforceTweetQuota(user._id);
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
    const tweet = new Tweet({
      author: user._id,
      content: req.body.content,
      image: req.body.image,
      timestamp: req.body.timestamp || new Date(),
      likes: 0,
      likedBy: [],
      retweets: 0,
      retweetedBy: [],
    });
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
// SECURED: the paying user is the verified token's user - not a
// client-supplied userId. A spoofed userId is only honoured when it equals
// the caller's own id (legacy compatibility), never a foreign one.
// ===========================================================================
app.post("/subscription/payment", requireFirebaseAuth, async (req, res) => {
  try {
    const { planId, testOutcome, asOf } = req.body || {};

    // 1. Resolve the acting user from the verified token.
    const { user: tokenUser } = await resolveTokenUser(req);
    if (!tokenUser) {
      return res.status(404).send({
        error: "No Twiller profile for this account. Register first.",
        code: "no-profile",
      });
    }
    if (req.body.userId && String(req.body.userId) !== String(tokenUser._id)) {
      return res.status(403).send({
        error: "You can only purchase a plan for your own account.",
        code: "identity-mismatch",
      });
    }
    const authenticatedUser = tokenUser;
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
app.get("/post", enforceMobileWindow, async (req, res) => {
  try {
    const tweet = await Tweet.find().sort({ timestamp: -1 }).populate("author");
    return res.status(200).send(tweet);
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
//  LIKE TWEET - SECURED. The liking user is the verified token's user; a
// client-supplied `userId` is only honoured when it equals the caller's own
// id (legacy compatibility), never a foreign one.
app.post("/like/:tweetid", requireFirebaseAuth, async (req, res) => {
  try {
    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({
        error: "No Twiller profile for this account. Register first.",
        code: "no-profile",
      });
    }
    const claimedUserId = req.body.userId ? String(req.body.userId) : "";
    if (claimedUserId && claimedUserId !== String(user._id)) {
      return res.status(403).send({
        error: "You can only like as yourself.",
        code: "identity-mismatch",
      });
    }
    const userId = user._id;
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
// retweet - SECURED. Same rule as likes: the acting user is the token's user;
// a client-supplied `userId` must equal the caller's own id.
app.post("/retweet/:tweetid", requireFirebaseAuth, async (req, res) => {
  try {
    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({
        error: "No Twiller profile for this account. Register first.",
        code: "no-profile",
      });
    }
    const claimedUserId = req.body.userId ? String(req.body.userId) : "";
    if (claimedUserId && claimedUserId !== String(user._id)) {
      return res.status(403).send({
        error: "You can only retweet as yourself.",
        code: "identity-mismatch",
      });
    }
    const userId = user._id;
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
      channel: { $exists: true },
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
// ===========================================================================
// INTERNSHIP FEATURE 4 (phase 2) - Language-switch OTP endpoints
// ===========================================================================
// `requireFirebaseAuth` guards ONLY these new endpoints. Legacy endpoints
// keep exactly the behaviour they had before; nothing else imports this
// middleware.
// POST /auth/language/otp/request   { targetLocale }
//   Requires verified Firebase token. Generates a 6-digit OTP, stores it
//   in LanguageOtp collection (bound to the authenticated user + locale),
//   sends it by email (for French) or SMS (for other locales), and returns
//   a devCode in development mode.
// POST /auth/language/otp/verify    { targetLocale, otp }
//   Requires verified Firebase token. Validates the 6-digit OTP. On success,
//   returns ok:true and marks the code as consumed (single-use). Wrong code
//   returns 401. Expired code returns 410.
//
// --- Per-locale channel ---
//   - French (fr): OTP delivered by email (devCode attached in dev mode)
//   - All other locales (en, hi, es, pt, zh): OTP delivered by SMS
//
// --- Security ---
//   - Partial unique index (user + targetLocale while pending) guarantees at
//     most one live code per user+locale, even under concurrent requests.
//   - OTPAttempts caps brute-force guessing per code.
//   - Code expires after its TTL; late TTL cleanup cannot extend usable life.

const LANGUAGE_OTP_TTL_MINUTES = Number(
  process.env.LANGUAGE_OTP_TTL_MINUTES || process.env.OTP_TTL_MINUTES || 10
);
const LANGUAGE_OTP_MAX_ATTEMPTS = Number(process.env.LANGUAGE_OTP_MAX_ATTEMPTS || 5);
const LANGUAGE_OTP_RESEND_COOLDOWN_SECONDS = Number(
  process.env.LANGUAGE_OTP_RESEND_COOLDOWN_SECONDS || 60
);

/**
 * Verification channel per locale (assignment contract, see DEPLOYMENT.md):
 *   fr                    -> EMAIL
 *   en, hi, es, pt, zh    -> SMS
 *
 * Returning "email" for every locale applied the French-only "verified email"
 * rule to ALL languages, so POST /auth/language/otp/request answered
 * 403 email-unverified for any signed-in user whose email was not verified.
 * This restores the documented per-locale contract (the delivery branch below
 * already supports both channels).
 */
function languageOtpChannel(targetLocale) {
  return targetLocale === "fr" ? "email" : "sms";
}

async function findUserForFirebaseUser(firebaseUser) {
  if (!firebaseUser?.email) return null;
  return User.findOne({ email: String(firebaseUser.email).toLowerCase() });
}

app.post("/auth/language/otp/request", requireFirebaseAuth, async (req, res) => {
  try {
    const targetLocale = String(req.body?.targetLocale || "").trim().toLowerCase();
    if (!LANGUAGE_OTP_LOCALES.includes(targetLocale)) {
      return res.status(400).send({
        error: "Please choose a supported language.",
        code: "unsupported-locale",
      });
    }
    const { email, emailVerified, uid } = req.firebaseUser;
    if (!email) {
      return res.status(401).send({
        error: "Your session has no verified email. Please sign in again.",
        code: "auth-no-email",
      });
    }
    const user = await findUserForFirebaseUser(req.firebaseUser);
    if (!user) return res.status(404).send({ error: "No Twiller profile exists for this account yet.", code: "no-profile" });

    const channel = languageOtpChannel(targetLocale);
    const destination = channel === "email" ? email : normalisePhone(user.phone);

    // French = EMAIL: a verified address is required before a code is sent.
    // Other locales = SMS: a phone number must be on file on the profile.
    if (channel === "email" && !emailVerified) {
      return res.status(403).send({
        error: "Please verify your email address before switching to French.",
        code: "email-unverified",
      });
    }
    if (channel === "sms" && destination.length < 7) {
      return res.status(422).send({
        error:
          "No mobile number is on file. Please add one in your profile before switching languages.",
        code: "phone-setup-required",
      });
    }
    const now = Date.now();
    const existing = await LanguageOtp.findOne({ user: user._id, targetLocale, status: "pending" });
    if (existing) {
      const retryAfterSeconds = Math.ceil(LANGUAGE_OTP_RESEND_COOLDOWN_SECONDS - (now - new Date(existing.lastSentAt).getTime()) / 1000);
      if (retryAfterSeconds > 0) {
        return res.status(429).send({ error: `A code was already sent. Please wait ${retryAfterSeconds} second(s) before requesting another one.`, code: "resend-cooldown", retryAfterSeconds });
      }
      existing.status = "consumed";
      await existing.save();
    }

    const otp = generateOtp();
    const { hash, salt } = hashSecret(otp);
    try {
      const record = await LanguageOtp.create({ user: user._id, firebaseUid: uid, email, channel, targetLocale, status: "pending", otpHash: hash, otpSalt: salt, otpExpiresAt: new Date(now + LANGUAGE_OTP_TTL_MINUTES * 60 * 1000), otpAttempts: 0, requestedAt: new Date(now), lastSentAt: new Date(now) });
      const body = `Your Twiller verification code is ${otp}. It expires in ${LANGUAGE_OTP_TTL_MINUTES} minutes. Do not share it with anyone.`;
      const delivery = channel === "email"
        ? await sendMail({ kind: "language-otp", to: destination, subject: "Your Twiller language verification code", body, devCode: otp })
        : await sendSms({ kind: "language-otp", to: destination, body, devCode: otp });
      if (!delivery.delivered) {
        record.status = "consumed";
        await record.save();
        return res.status(502).send({
          error: "The verification code could not be delivered. Please try again in a moment.",
          code: "delivery-failed",
          deliveryStatus: "failed",
          provider: delivery.provider,
          // Configuration guidance only (env var NAMES) - never a credential.
          reason: delivery.error,
        });
      }
      // Distinguish a REAL provider acceptance from the development mock so the
      // UI can never present a mock as a delivered SMS.
      const isMock = delivery.status === "mock";
      const channelWord = channel === "email" ? "email" : "phone";
      return res.status(200).send({
        ok: true,
        channel,
        targetLocale,
        message: isMock
          ? `Development mock: no real ${channel === "email" ? "email" : "SMS"} was sent.`
          : `A ${LANGUAGE_OTP_TTL_MINUTES} minute verification code has been sent to your ${channelWord}.`,
        expiresInMinutes: LANGUAGE_OTP_TTL_MINUTES,
        delivered: delivery.delivered,
        deliveryStatus: delivery.status,
        provider: delivery.provider,
        ...(delivery.devCode ? { devCode: delivery.devCode } : {}),
      });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).send({ error: "A verification code is already being sent. Please wait a moment and try again.", code: "already-in-flight" });
      throw error;
    }
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

app.post("/auth/language/otp/verify", requireFirebaseAuth, async (req, res) => {
  try {
    const targetLocale = String(req.body?.targetLocale || "").trim().toLowerCase();
    const otp = String(req.body?.otp || "").trim();
    if (!LANGUAGE_OTP_LOCALES.includes(targetLocale)) return res.status(400).send({ error: "Please choose a supported language.", code: "unsupported-locale" });
    if (!isValidOtpShape(otp)) return res.status(400).send({ error: "Please enter a valid 6-digit verification code.", code: "invalid-code-shape" });
    const user = await findUserForFirebaseUser(req.firebaseUser);
    if (!user) return res.status(404).send({ error: "No Twiller profile exists for this account yet.", code: "no-profile" });
    const record = await LanguageOtp.findOne({ user: user._id, targetLocale, status: "pending" }).sort({ requestedAt: -1 });
    if (!record) {
      return res.status(404).send({
        error: "No pending verification was found. Please request a new code.",
        code: "no-pending-code",
      });
    }
    if (record.firebaseUid !== req.firebaseUser.uid || record.email !== req.firebaseUser.email) return res.status(403).send({ error: "This verification code was issued for a different account.", code: "account-mismatch" });
    if (record.otpExpiresAt && record.otpExpiresAt.getTime() < Date.now()) {
      record.status = "expired";
      await record.save();
      return res.status(410).send({
        error: "That verification code has expired. Please request a new one.",
        code: "code-expired",
      });
    }
    if (record.otpAttempts >= LANGUAGE_OTP_MAX_ATTEMPTS) {
      record.status = "expired";
      await record.save();
      return res.status(429).send({ error: "Too many incorrect attempts. Please request a new verification code.", code: "attempts-exhausted" });
    }
    if (!verifySecret(otp, record.otpHash, record.otpSalt)) {
      record.otpAttempts += 1;
      if (record.otpAttempts >= LANGUAGE_OTP_MAX_ATTEMPTS) {
        record.status = "expired";
        await record.save();
        return res.status(429).send({
          error: "Too many incorrect attempts. Please request a new verification code.",
          code: "attempts-exhausted",
        });
      }
      await record.save();
      return res.status(401).send({
        error: `Incorrect verification code. ${LANGUAGE_OTP_MAX_ATTEMPTS - record.otpAttempts} attempt(s) remaining.`,
        code: "incorrect-code",
        attemptsRemaining: LANGUAGE_OTP_MAX_ATTEMPTS - record.otpAttempts,
      });
    }
    const claimed = await LanguageOtp.findOneAndUpdate({ _id: record._id, user: user._id, firebaseUid: req.firebaseUser.uid, email: req.firebaseUser.email, targetLocale, status: "pending", otpAttempts: { $lt: LANGUAGE_OTP_MAX_ATTEMPTS }, otpExpiresAt: { $gt: new Date() } }, { $set: { status: "verified", verifiedAt: new Date(), otpHash: null, otpSalt: null } }, { new: true });
    if (!claimed) return res.status(409).send({ error: "This verification code has already been used. Please request a new one.", code: "already-used" });
    return res.status(200).send({ ok: true, targetLocale, verified: true });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});
//
// ===========================================================================
// INTERNSHIP FEATURE 2 - login history + browser/mobile access rules.
//
//   POST /auth/login-event       (Bearer)          record + gate the session
//   POST /auth/login/otp/request (Bearer)          email a Chrome sign-in code
//   POST /auth/login/otp/verify  (Bearer) { otp }  verify it (single-use)
//   GET  /auth/login-history     (Bearer)          the CALLER'S OWN history
//
// SECURITY
//   - Identity is ALWAYS the verified Firebase token; no route accepts a user
//     id, browser or IP from the client.
//   - The User-Agent is a descriptive hint used only to categorise the session.
//     It is never proof of identity, and an unknown UA is treated as a desktop
//     with no extra OTP (so it can neither lock a user out nor impersonate a
//     mobile device).
//   - The mobile 10:00-13:00 IST rule is evaluated SERVER-SIDE (Asia/Kolkata).
// ===========================================================================

const LOGIN_OTP_TTL_MINUTES = Number(
  process.env.LOGIN_OTP_TTL_MINUTES || OTP_TTL_MINUTES || 10
);
const LOGIN_OTP_RESEND_COOLDOWN_SECONDS = Number(
  process.env.LOGIN_OTP_RESEND_COOLDOWN_SECONDS || 60
);

/**
 * Writes one login-history row. Never stores a password, ID token or OTP.
 * A history failure must never break the login itself, so it is caught here.
 */
async function recordLoginHistory({ user, firebaseUid, device, ip, outcome }) {
  try {
    await LoginHistory.create({
      user: user._id,
      firebaseUid: firebaseUid || "",
      browser: device.browser,
      os: device.os,
      deviceCategory: device.deviceCategory,
      ip,
      outcome,
      loggedInAt: new Date(),
    });
  } catch (error) {
    console.error("[login-history] could not record entry:", error?.message || error);
  }
}

const MOBILE_WINDOW_CLOSED_BODY = (decision) => ({
  error: "Mobile devices can access Twiller only between 10:00 AM and 1:00 PM IST.",
  code: "mobile-window-closed",
  window: { startHour: 10, endHour: 13, timeZone: "Asia/Kolkata" },
  istTime: decision.istTime,
  retryAfterSeconds: decision.retryAfterSeconds,
});

app.post("/auth/login-event", requireFirebaseAuth, async (req, res) => {
  try {
    const { uid } = req.firebaseUser;
    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({
        error: "No Twiller profile for this account. Register first.",
        code: "no-profile",
      });
    }

    const decision = evaluateDevicePolicy(req);
    const device = decision.device;

    // 1) Mobile time window - enforced here AND on the access routes.
    if (!decision.allowed) {
      await recordLoginHistory({
        user,
        firebaseUid: uid,
        device,
        ip: decision.ip,
        outcome: "blocked-mobile-window",
      });
      return res.status(403).send(MOBILE_WINDOW_CLOSED_BODY(decision));
    }

    // 2) Google Chrome must have verified (and not yet used) an emailed code.
    const otpRequired = requiresEmailOtp(device.browser);
    if (otpRequired) {
      const record = await LoginOtp.findOne({ user: user._id, status: "verified" });

      const stale =
        !record ||
        !record.verifiedAt ||
        Date.now() - new Date(record.verifiedAt).getTime() >
          LOGIN_OTP_TTL_MINUTES * 60 * 1000;

      if (stale) {
        if (record) {
          record.status = "expired";
          await record.save();
        }
        await recordLoginHistory({
          user,
          firebaseUid: uid,
          device,
          ip: decision.ip,
          outcome: "otp-required",
        });
        return res.status(428).send({
          ok: false,
          code: "chrome-otp-required",
          requiresOtp: true,
          browser: device.browser,
          message:
            "Google Chrome sign-ins must confirm the code we email you before the session is granted.",
        });
      }

      // Single-use: consume the verified code now that it has been honoured.
      record.status = "consumed";
      record.consumedAt = new Date();
      await record.save();
    }

    await recordLoginHistory({
      user,
      firebaseUid: uid,
      device,
      ip: decision.ip,
      outcome: "allowed",
    });

    return res.status(200).send({
      ok: true,
      allowed: true,
      browser: device.browser,
      os: device.os,
      deviceCategory: device.deviceCategory,
      ip: decision.ip,
      otpRequired,
      istTime: decision.istTime,
    });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

// ===========================================================================
// INTERNSHIP FEATURE 2 - Chrome sign-in code (emailed) + login history.
// ===========================================================================
app.post("/auth/login/otp/request", requireFirebaseAuth, async (req, res) => {
  try {
    const { uid, email } = req.firebaseUser;
    if (!email) {
      return res.status(401).send({
        error: "Your session has no verified email. Please sign in again.",
        code: "auth-no-email",
      });
    }

    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({ error: "No Twiller profile for this account.", code: "no-profile" });
    }

    const decision = evaluateDevicePolicy(req);
    if (!decision.allowed) return res.status(403).send(MOBILE_WINDOW_CLOSED_BODY(decision));

    // The emailed code exists for the Chrome policy only, so Edge (and unknown
    // browsers) cannot mint one.
    if (!requiresEmailOtp(decision.device.browser)) {
      return res.status(400).send({
        error: "This browser does not require an emailed sign-in code.",
        code: "otp-not-required",
      });
    }

    const existing = await LoginOtp.findOne({ user: user._id }).sort({ requestedAt: -1 });
    if (existing && existing.status === "pending") {
      if (existing.otpAttempts >= MAX_OTP_ATTEMPTS) {
        existing.status = "expired";
        await existing.save();
      } else {
        const since = Date.now() - new Date(existing.lastSentAt).getTime();
        if (since < LOGIN_OTP_RESEND_COOLDOWN_SECONDS * 1000) {
          return res.status(429).send({
            error: "A code was already sent. Please wait before requesting another one.",
            code: "resend-cooldown",
            retryAfterSeconds: Math.ceil(
              (LOGIN_OTP_RESEND_COOLDOWN_SECONDS * 1000 - since) / 1000
            ),
          });
        }
      }
    }

    const otp = generateOtp();
    const { hash, salt } = hashSecret(otp);

    let record;
    try {
      record = await LoginOtp.create({
        user: user._id,
        firebaseUid: uid,
        email,
        status: "pending",
        otpHash: hash,
        otpSalt: salt,
        otpExpiresAt: new Date(Date.now() + LOGIN_OTP_TTL_MINUTES * 60 * 1000),
        otpAttempts: 0,
        requestedAt: new Date(),
        lastSentAt: new Date(),
      });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).send({
          error: "A code is already being sent. Please wait a moment and try again.",
          code: "already-in-flight",
        });
      }
      throw error;
    }

    const delivery = await sendMail({
      kind: "login-otp",
      to: email,
      subject: "Your Twiller sign-in code",
      body: `Your Twiller sign-in code is ${otp}. It expires in ${LOGIN_OTP_TTL_MINUTES} minutes. Do not share it with anyone.`,
      devCode: otp,
    });

    if (!delivery.delivered) {
      record.status = "consumed";
      await record.save();
      return res.status(502).send({
        error: "The sign-in code could not be delivered. Please try again in a moment.",
        code: "delivery-failed",
        deliveryStatus: "failed",
        provider: delivery.provider,
        reason: delivery.error,
      });
    }

    const isMock = delivery.status === "mock";
    return res.status(200).send({
      ok: true,
      message: isMock
        ? "Development mock: no real email was sent."
        : `A ${LOGIN_OTP_TTL_MINUTES} minute sign-in code has been sent to your email.`,
      expiresInMinutes: LOGIN_OTP_TTL_MINUTES,
      deliveryStatus: delivery.status,
      provider: delivery.provider,
      ...(delivery.devCode ? { devCode: delivery.devCode } : {}),
    });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

app.post("/auth/login/otp/verify", requireFirebaseAuth, async (req, res) => {
  try {
    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({ error: "No Twiller profile for this account.", code: "no-profile" });
    }

    const otp = String(req.body?.otp || "").trim();
    if (!isValidOtpShape(otp)) {
      return res.status(400).send({
        error: "Please enter a valid 6-digit verification code.",
        code: "invalid-otp-shape",
      });
    }

    // Scoped to the TOKEN's user: a code issued to someone else can never be
    // verified here, even if the value were guessed.
    const record = await LoginOtp.findOne({ user: user._id, status: "pending" });
    if (!record) {
      return res.status(404).send({
        error: "No pending sign-in code was found. Please request a new one.",
        code: "no-pending-code",
      });
    }

    // Server-side expiry (the TTL index is hygiene only).
    if (record.otpExpiresAt && new Date() > record.otpExpiresAt) {
      record.status = "expired";
      await record.save();
      return res.status(410).send({
        error: "That sign-in code has expired. Please request a new one.",
        code: "otp-expired",
      });
    }

    if (record.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).send({
        error: "Too many attempts. Request a new sign-in code.",
        code: "attempts-exhausted",
      });
    }

    if (!verifySecret(otp, record.otpHash, record.otpSalt)) {
      record.otpAttempts += 1;
      await record.save();
      const remaining = MAX_OTP_ATTEMPTS - record.otpAttempts;
      if (remaining <= 0) {
        return res.status(429).send({
          error: "Too many attempts. Request a new sign-in code.",
          code: "attempts-exhausted",
        });
      }
      return res.status(401).send({
        error: "Incorrect sign-in code.",
        code: "incorrect-code",
        attemptsRemaining: remaining,
      });
    }

    // Verified: single-use, and the plaintext code is destroyed immediately.
    record.status = "verified";
    record.verifiedAt = new Date();
    record.otpHash = null;
    record.otpSalt = null;
    await record.save();

    return res.status(200).json({
      ok: true,
      verified: true,
      expiresInMinutes: LOGIN_OTP_TTL_MINUTES,
    });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

/**
 * GET /auth/login-history
 *
 * Returns ONLY the caller's own rows. The user is resolved from the verified
 * Firebase token, and the query is scoped by that user's _id - a client cannot
 * ask for someone else's history and there is no `userId` parameter to abuse.
 */
app.get("/auth/login-history", requireFirebaseAuth, async (req, res) => {
  try {
    const { user } = await resolveTokenUser(req);
    if (!user) {
      return res.status(404).send({ error: "No Twiller profile for this account.", code: "no-profile" });
    }

    const rawLimit = Number(req.query?.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;

    const rows = await LoginHistory.find({ user: user._id })
      .sort({ loggedInAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json(
      rows.map((row) => ({
        id: String(row._id),
        loggedInAt: row.loggedInAt,
        browser: row.browser,
        os: row.os,
        deviceCategory: row.deviceCategory,
        ip: row.ip,
        outcome: row.outcome,
      }))
    );
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

// ===========================================================================
// Express JSON error-handling middleware
// ===========================================================================
// Ensures ALL responses (including 404s and body-parser errors) are JSON.
// Never lets an HTML error page reach the client.
//
// - Unknown routes                          -> 404 with JSON { error, code }
// - Malformed JSON body (body-parser)       -> 400 with JSON { error, code: "invalid-json" }
// - Non-JSON body posted as JSON            -> 400 with JSON { error, code: "invalid-json" }
// - All other errors                        -> 500 with JSON { error: "Internal server error." }
// - Content-Type is always application/json
// - Stack traces are NEVER sent to the client
//

// body-parser error handler for malformed JSON
// This catches errors when body-parser fails to parse JSON and sends
// a default 400 response that may not be JSON. We override it here.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: "Request body is too large.", code: "payload-too-large" })
  }
  if (err.type === 'entity malformed' || err.type === 'entity truncated') {
    return res.status(400).json({ error: "Invalid JSON.", code: "invalid-json" })
  }
  // For non-JSON body or other body-parser errors: return 400 with invalid-json code
  // to match the Feature 4 JSON error contract expectations
  if (err && err.type) {
    return res.status(400).json({ error: "Invalid JSON.", code: "invalid-json" })
  }
  return next()
})

// Generic error handler for any other errors caught by Express
app.use((err, req, res, next) => {
  // Do not log or echo the stack trace; just report a generic message.
  console.error("Express error handler:", err.message || err)
  res.status(500).json({ error: "Internal server error.", code: "internal-error" })
})

// Catch-all 404 ensuring unknown routes return JSON (never HTML).
// This is placed last so it only runs for routes that truly exist but
// return without an explicit status, guaranteeing JSON responses
// for any route not explicitly handled.
app.use((req, res) => {
  res.status(404).json({ error: "Not found.", code: "not-found" })
})

export default {};