/**
 * The wedding guest-response viewer's authentication.
 *
 * WHY A SEPARATE MECHANISM
 * ------------------------
 * The viewer is a plain HTML page on GitHub Pages - public hosting - so the page
 * existing at a URL guarantees nothing. The data it shows (names, party sizes,
 * private notes to the couple) is only as private as the API behind it.
 *
 * Twiller's own authentication is Firebase-token based and belongs to Twiller's
 * users; neither fits a two-person wedding administrator, and extending it would
 * mean touching logins, OTP and sessions that have nothing to do with a wedding.
 *
 * So this module implements the smallest thing that is actually secure:
 *
 *   · credentials come from the SERVER environment - never from the page, never
 *     from the repository, never from the browser;
 *   · the password is compared in constant time, so a wrong guess reveals
 *     nothing about the real one, not even its length;
 *   · a successful sign-in mints a short-lived token signed with an HMAC secret
 *     that only the server holds, so the bearer of a token never carries a
 *     password around and a token cannot be forged or edited;
 *   · the token is stateless - nothing is stored - and it simply expires.
 *
 * When the credentials are absent the whole thing fails CLOSED: `adminAccessStatus()`
 * reports false and the routes answer 503 rather than letting anybody in.
 */

import crypto from "node:crypto";

/** Who may sign in. A single administrator is all this invitation needs. */
export const DEFAULT_ADMIN_USER = "admin";

/** How long a signed-in session lasts. Two hours is a comfortable sitting. */
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The minimum lengths that make the two secrets worth having. A one-character
 * password or a four-character signing key would be worse than no viewer at all,
 * so such a configuration is treated as NOT configured.
 */
const MIN_PASSWORD_LENGTH = 8;
const MIN_SECRET_LENGTH = 16;

function text(value) {
  return String(value ?? "").trim();
}

/** The configured administrator's user name (a name, not a secret). */
export function adminUserName() {
  return text(process.env.WEDDING_ADMIN_USER) || DEFAULT_ADMIN_USER;
}

function adminPassword() {
  return String(process.env.WEDDING_ADMIN_PASSWORD ?? "");
}

function tokenSecret() {
  return String(process.env.WEDDING_ADMIN_TOKEN_SECRET ?? "");
}

/** How long an issued token stays valid. */
export function tokenTtlMs() {
  const configured = Number(text(process.env.WEDDING_ADMIN_TOKEN_TTL_MS));
  if (Number.isFinite(configured) && configured >= 60_000) {
    return Math.floor(configured);
  }
  return DEFAULT_TOKEN_TTL_MS;
}

/**
 * Whether the viewer can be used at all.
 *
 * Names only - the values of the secrets are never returned, logged or reported,
 * so this is safe to answer anywhere.
 *
 * @returns {{configured: boolean, missing: string[]}}
 */
export function adminAccessStatus() {
  const missing = [];
  if (adminPassword().length < MIN_PASSWORD_LENGTH) missing.push("WEDDING_ADMIN_PASSWORD");
  if (tokenSecret().length < MIN_SECRET_LENGTH) missing.push("WEDDING_ADMIN_TOKEN_SECRET");
  return { configured: missing.length === 0, missing };
}

/** A constant-time comparison of two strings that never reveals their lengths. */
function secretsMatch(supplied, expected) {
  // Hashing first makes both sides exactly 32 bytes, so `timingSafeEqual` can
  // neither throw on unequal lengths nor leak them through its running time.
  const a = crypto.createHash("sha256").update(String(supplied), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(expected), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Checks one sign-in attempt.
 *
 * Both halves are always evaluated, so neither a wrong user name nor a wrong
 * password can be told apart by how long the answer took.
 *
 * @param {{user?: unknown, password?: unknown}} credentials
 * @returns {boolean}
 */
export function verifyAdminCredentials({ user, password } = {}) {
  if (!adminAccessStatus().configured) return false;
  const userOk = secretsMatch(text(user), adminUserName());
  const passwordOk = secretsMatch(password, adminPassword());
  return userOk && passwordOk;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(payload) {
  return crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
}

/**
 * Mints a signed token for a signed-in administrator.
 *
 * The payload carries only an expiry and a fixed subject: there is nothing in it
 * worth protecting, and the signature is what makes it unforgeable.
 *
 * @returns {{token: string, expiresAt: string, ttlMs: number}}
 */
export function issueAdminToken() {
  const ttlMs = tokenTtlMs();
  const payload = base64url(
    JSON.stringify({ sub: "wedding-admin", exp: Date.now() + ttlMs })
  );
  return {
    token: `${payload}.${sign(payload)}`,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    ttlMs,
  };
}

/**
 * Verifies a token on every protected request.
 *
 * @param {unknown} token the raw bearer value
 * @returns {{valid: boolean, reason?: "unconfigured"|"malformed"|"forged"|"expired"}}
 */
export function verifyAdminToken(token) {
  if (!adminAccessStatus().configured) return { valid: false, reason: "unconfigured" };

  const raw = text(token);
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "malformed" };
  }

  const [payload, signature] = parts;
  if (!secretsMatch(signature, sign(payload))) {
    return { valid: false, reason: "forged" };
  }

  let claims = null;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (claims?.sub !== "wedding-admin" || !Number.isFinite(claims?.exp)) {
    return { valid: false, reason: "malformed" };
  }
  if (Date.now() >= claims.exp) return { valid: false, reason: "expired" };

  return { valid: true };
}

export default {
  DEFAULT_ADMIN_USER,
  adminUserName,
  adminAccessStatus,
  tokenTtlMs,
  verifyAdminCredentials,
  issueAdminToken,
  verifyAdminToken,
};
