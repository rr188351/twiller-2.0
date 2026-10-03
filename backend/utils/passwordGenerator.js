/**
 * Password generator for Twiller 2.0 - Internship Feature 6.
 *
 * ASSIGNMENT REQUIREMENT
 * ----------------------
 * The generated password must contain ONLY uppercase and lowercase English
 * letters. No numbers (0-9) and no special characters (!@#$...).
 *
 * This module is the SERVER-SIDE authority for that rule. The browser has a
 * matching generator (`twiller/src/lib/passwordGenerator.ts`) so the user can
 * see and copy the password, but the backend re-validates every password with
 * `validateGeneratedPassword()` before it is accepted - a malicious user could
 * otherwise bypass the rule by posting their own value straight to the API.
 *
 * IMPORTANT: this file NEVER stores or logs the generated password.
 */

import crypto from "node:crypto";

export const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const LETTERS_ONLY = `${UPPERCASE}${LOWERCASE}`;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 24;
export const DEFAULT_PASSWORD_LENGTH = 12;

/**
 * Generates a password containing only English letters.
 *
 * Uses `crypto.randomInt` which is a cryptographically secure random number
 * generator (not Math.random), so the password cannot be guessed from a pattern.
 *
 * @param {number} length between PASSWORD_MIN_LENGTH and PASSWORD_MAX_LENGTH
 * @returns {string}
 */
export function generateLettersOnlyPassword(length = DEFAULT_PASSWORD_LENGTH) {
  const size = Math.min(
    PASSWORD_MAX_LENGTH,
    Math.max(PASSWORD_MIN_LENGTH, Number(length) || DEFAULT_PASSWORD_LENGTH)
  );

  // Guarantee at least one uppercase and one lowercase letter so the password
  // always satisfies the "uppercase AND lowercase" part of the requirement.
  const characters = [
    UPPERCASE[crypto.randomInt(0, UPPERCASE.length)],
    LOWERCASE[crypto.randomInt(0, LOWERCASE.length)],
  ];

  while (characters.length < size) {
    characters.push(LETTERS_ONLY[crypto.randomInt(0, LETTERS_ONLY.length)]);
  }

  // Fisher-Yates shuffle so the guaranteed characters are not always at the
  // start of the password.
  for (let i = characters.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }

  return characters.join("");
}

/**
 * Enforces the "letters only" assignment rule.
 *
 * @param {string} password
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateGeneratedPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    return { valid: false, reason: "Password is required." };
  }

  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return {
      valid: false,
      reason: `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }

  // The single most important check for this assignment.
  if (!/^[A-Za-z]+$/.test(password)) {
    return {
      valid: false,
      reason:
        "Password may only contain uppercase and lowercase English letters - no numbers and no special characters.",
    };
  }

  if (!/[A-Z]/.test(password)) {
    return { valid: false, reason: "Password must contain at least one uppercase letter." };
  }

  if (!/[a-z]/.test(password)) {
    return { valid: false, reason: "Password must contain at least one lowercase letter." };
  }

  return { valid: true };
}

/**
 * Non-reversible fingerprint used to prove that a particular password was
 * applied WITHOUT ever storing the password itself.
 * A per-request random salt means the same password produces a different
 * fingerprint each time, so the collection cannot be used for a dictionary attack.
 *
 * @returns {{hash: string, salt: string}}
 */
export function fingerprintPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return { hash, salt };
}

export default {
  UPPERCASE,
  LOWERCASE,
  LETTERS_ONLY,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  DEFAULT_PASSWORD_LENGTH,
  generateLettersOnlyPassword,
  validateGeneratedPassword,
  fingerprintPassword,
};
