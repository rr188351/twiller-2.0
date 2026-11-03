import mongoose from "mongoose";

/**
 * LoginHistory - Internship Feature 2: where/when/how the user logged in.
 *
 * WHY A SEPARATE COLLECTION
 * -------------------------
 * Firebase knows the account, but it does not record the browser, operating
 * system, device category or IP address, and the assignment requires showing
 * that to the user. One row per successful login attempt gives an auditable
 * trail without touching the User document.
 *
 * WHAT IS NEVER STORED
 * --------------------
 * No password, no ID token, no refresh token and no OTP value is ever written
 * here. Only non-secret descriptive fields plus the outcome.
 *
 * The User-Agent is descriptive only: it is categorised by utils/userAgent.js
 * and is never used as proof of identity (Firebase still owns authentication).
 */

export const LOGIN_HISTORY_OUTCOMES = [
  "allowed", // session accepted
  "blocked-mobile-window", // mobile device outside 10:00-13:00 IST
  "otp-required", // Chrome: signed in but the emailed code is still pending
];

const loginHistorySchema = mongoose.Schema(
  {
    // Owner, resolved server-side from the VERIFIED Firebase token.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    firebaseUid: { type: String, required: true, trim: true },

    loggedInAt: { type: Date, default: Date.now },

    // Descriptive, parsed from the request User-Agent.
    browser: { type: String, default: "Unknown", trim: true },
    os: { type: String, default: "Unknown", trim: true },
    deviceCategory: {
      type: String,
      enum: ["desktop", "mobile", "tablet", "unknown"],
      default: "unknown",
    },

    // Resolved from Express `req.ip` (trust-proxy aware); never from a raw
    // client-supplied forwarding header.
    ip: { type: String, default: "unknown", trim: true },

    outcome: {
      type: String,
      enum: LOGIN_HISTORY_OUTCOMES,
      default: "allowed",
    },
  },
  { timestamps: true }
);

// A user's own history, newest first.
loginHistorySchema.index({ user: 1, loggedInAt: -1 });

export default mongoose.model("LoginHistory", loginHistorySchema);
