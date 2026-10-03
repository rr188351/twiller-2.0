/**
 * Client-side password generator - Internship Feature 6.
 *
 * WHY IT EXISTS ON BOTH SIDES
 * ---------------------------
 * The password has to be visible to the user so they can copy it, which means
 * it must be generated in the browser. But the browser cannot be trusted, so
 * the SAME rule is enforced again on the server by
 * `backend/utils/passwordGenerator.js`. Posting a hand-crafted password
 * straight to the API still gets rejected.
 *
 * ASSIGNMENT RULE: uppercase and lowercase English letters ONLY.
 * No numbers, no special characters.
 */

export const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const LETTERS_ONLY = `${UPPERCASE}${LOWERCASE}`;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 24;
export const DEFAULT_PASSWORD_LENGTH = 12;

/**
 * Generates a letters-only password.
 * Uses crypto.getRandomValues so it is still unpredictable.
 */
export function generateLettersOnlyPassword(length: number = DEFAULT_PASSWORD_LENGTH): string {
  const size = Math.min(
    PASSWORD_MAX_LENGTH,
    Math.max(PASSWORD_MIN_LENGTH, length || DEFAULT_PASSWORD_LENGTH)
  );

  const characters: string[] = [
    UPPERCASE[randomInt(UPPERCASE.length)],
    LOWERCASE[randomInt(LOWERCASE.length)],
  ];

  while (characters.length < size) {
    characters.push(LETTERS_ONLY[randomInt(LETTERS_ONLY.length)]);
  }

  // Fisher-Yates shuffle so the guaranteed characters are not always first.
  for (let i = characters.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }

  return characters.join("");
}

/** Cryptographically secure random integer in [0, max). */
function randomInt(max: number): number {
  const limit = Math.floor((0xffffffff / max) * max);
  const array = new Uint32Array(1);
  window.crypto.getRandomValues(array);
  return array[0] % limit;
}

/** Mirrors the server-side validator so the user gets instant feedback. */
export function validateGeneratedPassword(password: string): {
  valid: boolean;
  reason?: string;
} {
  if (!password) return { valid: false, reason: "Password is required." };

  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return {
      valid: false,
      reason: `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }

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
