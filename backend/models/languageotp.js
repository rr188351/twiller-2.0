import mongoose from "mongoose";

/**
 * LanguageOtp - Internship Feature 4 (phase 2): one-time codes that gate a
 * LOGGED-IN language switch.
 *
 * WHY A SEPARATE COLLECTION?
 * --------------------------
 * Language OTPs have a different owner (the authenticated Firebase user, not
 * a typed identifier), a different payload (the exact target locale), and a
 * different lifecycle (request -> verify, no recovery token) from Feature 6
 * password-reset records. Mixing them into `passwordresets` would let a code
 * issued for one purpose be replayed against another. A dedicated collection
 * with its own indexes makes cross-purpose, cross-user, and cross-locale
 * replay structurally impossible.
 *
 * SECURITY
 * --------
 * - The OTP is NEVER stored. Only `otpHash` + `otpSalt` (SHA-256) are saved.
 * - `otpExpiresAt` is checked EXPLICITLY on every verification; the TTL index
 *   below is hygiene only (disk cleanup), never the security gate.
 * - `otpAttempts` caps brute-force guessing per code.
 * - Partial unique index (user + targetLocale while pending) guarantees at
 *   most one live code per user+locale, even under concurrent requests.
 */

export const LANGUAGE_OTP_CHANNELS = ["email", "sms"];

export const LANGUAGE_OTP_LOCALES = ["en", "hi", "es", "pt", "zh", "fr"];

export const LANGUAGE_OTP_STATUSES = ["pending", "verified", "consumed", "expired"];

const languageOtpSchema = mongoose.Schema(
  {
    // Twiller User document that owns this challenge, resolved server-side
    // from the verified Firebase token email - never from client input.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Firebase UID from the verified ID token (audit + binding).
    firebaseUid: { type: String, required: true, trim: true },

    // Verified token email snapshot (lowercase). Used for lookup and for the
    // French email channel destination. Never trusted from the request body.
    email: { type: String, required: true, trim: true, lowercase: true },

    // "email" for French, "sms" for the other five locales.
    channel: { type: String, enum: LANGUAGE_OTP_CHANNELS, required: true },

    // Exact locale this code authorises. Verification must present the same
    // value or it is rejected (no cross-locale reuse).
    targetLocale: { type: String, enum: LANGUAGE_OTP_LOCALES, required: true },

    // pending  : waiting for the user to type the code
    // verified : code accepted (single-use); locale switch authorised
    // consumed : a newer code superseded this one, or it was used already
    // expired  : passed its server-side expiry without success
    status: {
      type: String,
      enum: LANGUAGE_OTP_STATUSES,
      default: "pending",
    },

    // --- OTP secret (hash only) ---
    otpHash: { type: String, default: null },
    otpSalt: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 },

    requestedAt: { type: Date, default: Date.now },
    // When the last code was actually (re)sent; enforces the resend cooldown.
    lastSentAt: { type: Date, default: Date.now },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Lookup for "the live code for this user + locale".
languageOtpSchema.index({ user: 1, targetLocale: 1, status: 1, requestedAt: -1 });

// Atomicity gate: at most ONE pending code per (user, locale). Concurrent
// requests race on this index; the loser gets a duplicate-key error, which
// the route handler converts into a safe cooldown/in-flight response.
languageOtpSchema.index(
  { user: 1, targetLocale: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

// Hygiene only: physically removes stale documents. Expiry is ALWAYS enforced
// in code before any secret comparison, so late TTL cleanup cannot extend a
// code's usable life.
languageOtpSchema.index({ otpExpiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("LanguageOtp", languageOtpSchema);
