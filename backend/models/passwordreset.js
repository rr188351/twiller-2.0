import mongoose from "mongoose";

/**
 * PasswordReset - Internship Feature 6 (Forgot Password).
 *
 * WHY A SEPARATE COLLECTION?
 * ---------------------------
 * Password reset records are security-sensitive and high-churn. Keeping them
 * inside the `users` document would mean every profile read drags along a
 * growing array of sensitive records. A separate collection also lets MongoDB
 * index them properly and makes them easy to purge automatically with a TTL
 * index (see `passwordResetSchema.index` below).
 *
 * SECURITY
 * --------
 * - The OTP is NEVER stored. Only `otpHash` + `otpSalt` (SHA-256) are saved.
 * - The recovery token is NEVER stored. Only its hash.
 * - The generated password is NEVER stored. `appliedPasswordHash` is a
 *   salted fingerprint used purely for the audit trail.
 * - `expiresAt` gives every OTP a hard lifetime (TTL index auto-deletes it).
 * - `otpAttempts` caps brute-force guessing per request.
 */

const passwordResetSchema = mongoose.Schema(
  {
    // Link back to the Twiller user whose Firebase credentials are being reset.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // What the user typed into the "forgot password" box.
    // Stored so the audit trail shows how the account was addressed.
    identifier: { type: String, required: true, trim: true },

    // "email" -> Firebase password reset email
    // "phone" -> SMS one-time code first, then Firebase email as second factor
    channel: { type: String, enum: ["email", "phone"], required: true },

    // pending   : waiting for the OTP / Firebase email
    // verified  : OTP accepted, recovery token issued
    // completed : password successfully changed in Firebase
    // expired   : too old to be used
    status: {
      type: String,
      enum: ["pending", "verified", "completed", "expired"],
      default: "pending",
    },

    // IST calendar day (YYYY-MM-DD) of the most recent request.
    // Used to enforce "maximum one request per day" per user.
    dailyRequestDate: { type: String, required: true },

    // --- OTP (phone channel only) ---
    otpHash: { type: String, default: null },
    otpSalt: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 },

    // --- Recovery session token issued after a successful verification ---
    recoveryTokenHash: { type: String, default: null },
    recoveryTokenSalt: { type: String, default: null },
    recoveryExpiresAt: { type: Date, default: null },

    // --- Audit trail (never the password itself) ---
    appliedPasswordHash: { type: String, default: null },
    appliedPasswordSalt: { type: String, default: null },

    requestedAt: { type: Date, default: Date.now },
    verifiedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Lookup for the daily-limit check and the "my reset requests" view.
passwordResetSchema.index({ user: 1, requestedAt: -1 });
passwordResetSchema.index({ identifier: 1, requestedAt: -1 });

// MongoDB automatically deletes documents once `otpExpiresAt` passes, so an
// unused OTP physically disappears from the database.
passwordResetSchema.index({ otpExpiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("PasswordReset", passwordResetSchema);
