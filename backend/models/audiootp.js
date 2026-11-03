import mongoose from "mongoose";

/**
 * AudioOtp - Internship Feature 5: one-time codes that gate audio-tweet upload.
 *
 * WHY A SEPARATE COLLECTION?
 * --------------------------
 * Audio-upload OTPs have a different owner (the authenticated Firebase user),
 * a different payload (email destination only), and a different lifecycle
 * (request -> verify -> consume on upload) from Feature 4 language OTPs
 * and Feature 6 password resets. A dedicated collection prevents cross-purpose
 * replay: a code issued for audio upload can never authorize a language switch
 * or a password reset.
 *
 * SECURITY
 * --------
 * - The OTP is NEVER stored. Only `otpHash` + `otpSalt` (SHA-256) are saved.
 * - `otpExpiresAt` is checked EXPLICITLY on every verification; the TTL index
 *   below is hygiene only (disk cleanup), never the security gate.
 * - `otpAttempts` caps brute-force guessing per code (max 5).
 * - Partial unique index (user while pending) guarantees at most one live code
 *   per user, even under concurrent requests.
 * - `consumed` status prevents reuse: a verified code authorises exactly one
 *   upload, then is marked consumed.
 */

export const AUDIO_OTP_CHANNELS = ["email"];

export const AUDIO_OTP_STATUSES = ["pending", "verified", "consumed", "expired"];

const audioOtpSchema = mongoose.Schema(
  {
    // Twiller User document that owns this challenge, resolved server-side
    // from the verified Firebase token - never from client input.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Firebase UID from the verified ID token (audit + binding).
    firebaseUid: { type: String, required: true, trim: true },

    // Verified token email snapshot (lowercase). The OTP is sent to this
    // address. Never trusted from the request body.
    email: { type: String, required: true, trim: true, lowercase: true },

    // Always "email" for audio uploads (kept for symmetry with language OTP).
    channel: { type: String, enum: AUDIO_OTP_CHANNELS, required: true },

    // pending : waiting for the user to type the code
    // verified: code accepted (single-use); upload authorised
    // consumed: code used for an upload (or superseded) - cannot verify again
    // expired : passed its server-side expiry without success
    status: {
      type: String,
      enum: AUDIO_OTP_STATUSES,
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
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Lookup for "the live code for this user".
audioOtpSchema.index({ user: 1, status: 1, requestedAt: -1 });

// Atomicity gate: at most ONE pending code per user. Concurrent requests race
// on this index; the loser gets a duplicate-key error, which the route handler
// converts into a safe cooldown/in-flight response.
audioOtpSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

// Hygiene only: physically removes stale documents. Expiry is ALWAYS enforced
// in code before any secret comparison, so late TTL cleanup cannot extend a
// code's usable life.
audioOtpSchema.index({ otpExpiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("AudioOtp", audioOtpSchema);
