/**
 * Firebase authentication middleware for Twiller 2.0.
 *
 * Internship Feature 4 (phase 2) - `requireFirebaseAuth` guards ONLY the new
 * language-change OTP endpoints (`POST /auth/language/otp/*`). Every legacy
 * endpoint keeps exactly the behaviour it had before; nothing else imports
 * this middleware.
 *
 * CONTRACT
 * --------
 * - The browser sends `Authorization: Bearer <Firebase ID token>`, minted by
 *   the Firebase client SDK after login / Google sign-in.
 * - Identity (UID + email) is derived EXCLUSIVELY from the verified token.
 *   Body-supplied user ids, emails, or phone numbers are never treated as
 *   identity - route handlers only read `targetLocale` / `otp` from the body.
 * - French email OTP additionally requires a present, verified token email.
 * - Missing / malformed / invalid / expired token              -> 401
 * - Firebase Admin not configured on the server                -> 503
 *   (fail closed; authentication is NEVER bypassed).
 *
 * No test-bypass header exists here or anywhere on application routes. Tests
 * inject or mock the verifier, never an alternate credential mechanism.
 */

import { getAdminAuth } from "../utils/firebaseAdmin.js";

const projectId = (process.env.FIREBASE_PROJECT_ID || "").trim();

/** Extract the raw ID token from `Authorization: Bearer <token>`. */
function extractBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token || null;
}

export async function requireFirebaseAuth(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).send({
        error: "Authentication required. Please sign in and try again.",
        code: "auth-required",
      });
    }

    const auth = await getAdminAuth();
    if (!auth) {
      // Server misconfiguration - fail closed, never let the request through.
      return res.status(503).send({
        error: "Verification service is temporarily unavailable. Please try again later.",
        code: "auth-unavailable",
      });
    }

    let decoded;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch {
      // Token failures all produce the same non-sensitive response. The token
      // value itself is never logged or echoed.
      return res.status(401).send({
        error: "Your session has expired or is invalid. Please sign in again.",
        code: "auth-invalid",
      });
    }

    // --- Security: reject tokens minted for a different Firebase project ---
    // A Firebase ID token embeds the audience (`aud`) and issuer (`iss`) claims.
    // Any verification middleware that skips those claims lets an attacker who
    // somehow stole an ID token from PROJECT_A verify requests against PROJECT_B.
    // Here we check both claims against the values the app is _actually_ configured
    // to trust. No service-account, no bypass header, no weakening.
    const expectedIssuer = `https://securetoken.google.com/${projectId}`;
    const expectedAudience = projectId;
    const tokenIssuer =
      typeof decoded.iss === "string" ? decoded.iss : "";
    const tokenAudience =
      typeof decoded.aud === "string" ? decoded.aud : "";
    if (
      tokenIssuer !== expectedIssuer ||
      tokenAudience !== expectedAudience
    ) {
      // Fail closed. The user sees a generic "your session has expired" message,
      // exactly like Firebase itself would return for a token that does not belong
      // to this app.
      return res.status(401).send({
        error: "Your session has expired or is invalid. Please sign in again.",
        code: "auth-invalid",
      });
    }

    const uid = typeof decoded.uid === "string" ? decoded.uid : "";
    const email =
      typeof decoded.email === "string" ? decoded.email.trim().toLowerCase() : "";
    // Strict: only an explicit `email_verified === true` claim counts as
    // verified. A missing claim (e.g. custom-token sessions) is UNVERIFIED,
    // so the French email OTP flow cannot be reached without proof of address
    // ownership. Non-French (SMS) flows never gate on this flag, so their
    // behaviour is unchanged; legacy routes do not use this middleware at all.
    const emailVerified = decoded.email_verified === true;

    if (!uid) {
      return res.status(401).send({
        error: "Your session could not be verified. Please sign in again.",
        code: "auth-invalid",
      });
    }

    req.firebaseUser = { uid, email, emailVerified };
    return next();
  } catch {
    return res.status(401).send({
      error: "Your session could not be verified. Please sign in again.",
      code: "auth-invalid",
    });
  }
}

export default requireFirebaseAuth;
