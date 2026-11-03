import mongoose from "mongoose";

/**
 * LoginOtp - Internship Feature 2: the emailed one-time code that Google Chrome
 * must present before its protected session is granted.
 *
 * WHY ITS OWN COLLECTION
 * ----------------------
 * A code issued for a Chrome login must never be replayable against the
 * language switch, the audio upload or password recovery, and vice versa. A
 * dedicated collection with its own indexes makes that cross-purpose replay
 * structurally impossible, exactly like LanguageOtp/AudioOtp/PasswordReset.
 *
 * SECURITY
 * --------
 * - The code is NEVER stored; only `otpHash` + `otpSalt` (SHA-256 with a random
 *   salt, constant-time compared).
 * - `otpExpiresAt` is checked EXPLICITLY on every verification. The TTL index is
 *   hygiene (disk cleanup) only.
 * - `otpAttempts` caps brute-force guessing.
 * - At most ONE pending code per user (partial unique index), so concurrent
 *   requests cannot multiply live codes.
 * - Verification is server-side only. A frontend flag can never mint a
 *   "verified" row.
 */

export const LOGIN_OTP_STATUSES = ["pending", "verified", "consumed", "expired"];

const loginOtpSchema = mongoose.Schema(
  {
    // Owner, resolved server-side from the verified Firebase token.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    firebaseUid: { type: String, required: true, trim: true },

    // Verified token email (lowercase) - the delivery destination. Never taken
    // from the request body.
    email: { type: String, required: true, trim: true, lowercase: true },

    // pending   : waiting for the user to type the code
    // verified  : code accepted (single-use); the login gate may be passed once
    // consumed  : already used (or superseded by a newer code)
    // expired   : passed its server-side expiry without success
    status: {
      type: String,
      enum: LOGIN_OTP_STATUSES,
      default: "pending",
    },

    otpHash: { type: String, default: null },
    otpSalt: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 },

    requestedAt: { type: Date, default: Date.now },
    // When the code was last (re)sent; enforces the resend cooldown.
    lastSentAt: { type: Date, default: Date.now },
    verifiedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

loginOtpSchema.index({ user: 1, status: 1, requestedAt: -1 });

// At most one PENDING code per user, even under concurrent requests.
loginOtpSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

// Hygiene only - expiry is always enforced in code before comparing secrets.
loginOtpSchema.index({ otpExpiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("LoginOtp", loginOtpSchema);
