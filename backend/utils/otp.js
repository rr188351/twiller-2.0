/**
 * OTP generation and verification helpers for Twiller 2.0.
 *
 * WHY HASHING MATTERS
 * -------------------
 * If we stored OTPs as plain text in MongoDB, anyone who could read the
 * database (or any accidental backup/log) would be able to log in as the user.
 * Instead we store a SHA-256 hash of `salt + code`. The plain code only ever
 * exists in memory for the few seconds needed to send it.
 *
 * `timingSafeEqual` is used for comparison so an attacker cannot guess the code
 * one character at a time by measuring how long the comparison took.
 *
 * Built entirely on Node's built-in `node:crypto` - no extra dependency.
 */

import crypto from "node:crypto";

const OTP_LENGTH = 6;
export const MAX_OTP_ATTEMPTS = 5;

/**
 * Creates a numeric one-time code.
 * @returns {string} e.g. "483920"
 */
export function generateOtp(length = OTP_LENGTH) {
  const max = 10 ** length;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(length, "0");
}

/**
 * Creates a cryptographically random token used for recovery sessions.
 * @returns {string} hex string
 */
export function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Hashes a secret (OTP or token) together with a salt.
 * @returns {{hash: string, salt: string}}
 */
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(`${salt}:${secret}`).digest("hex");
  return { hash, salt };
}

/**
 * Constant-time comparison of a plain secret against a stored hash + salt.
 * @returns {boolean}
 */
export function verifySecret(secret, hash, salt) {
  if (!secret || !hash || !salt) return false;
  const candidate = crypto.createHash("sha256").update(`${salt}:${secret}`).digest("hex");

  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/**
 * Basic numeric-OTP shape check (6 digits). Used to reject obvious junk early
 * before hitting the database.
 */
export function isValidOtpShape(code) {
  return typeof code === "string" && new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code.trim());
}

/**
 * Masks an identifier for safe logging, e.g.
 *   "a***@example.com" / "+9*****8123".
 * We never log full emails or phone numbers.
 */
export function maskIdentifier(identifier = "") {
  const value = String(identifier).trim();
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    const head = name.slice(0, 1);
    return `${head}***@${domain}`;
  }
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.max(value.length - 4, 1))}${value.slice(-2)}`;
}

export default {
  OTP_LENGTH,
  MAX_OTP_ATTEMPTS,
  generateOtp,
  generateSecureToken,
  hashSecret,
  verifySecret,
  isValidOtpShape,
  maskIdentifier,
};
