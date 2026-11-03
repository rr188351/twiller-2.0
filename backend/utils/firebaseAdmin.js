/**
 * Firebase Admin SDK initialisation for Twiller 2.0.
 *
 * Internship Feature 4 (phase 2) - server-side proof of WHO is calling.
 * The language-change OTP endpoints must bind each code to the authenticated
 * Firebase user, never to a client-supplied email / phone / user id. This
 * module owns the single Admin SDK app instance used by the
 * `requireFirebaseAuth` middleware to verify
 * `Authorization: Bearer <Firebase ID token>` headers.
 *
 * CREDENTIAL SOURCING (first present wins)
 * ----------------------------------------
 * 1. FIREBASE_SERVICE_ACCOUNT_JSON - whole service-account JSON stringified
 *    on one line, kept ONLY in git-ignored `backend/.env`.
 * 2. FIREBASE_SERVICE_ACCOUNT_PATH - absolute path to a JSON file OUTSIDE
 *    the repository (e.g. C:\secrets\twiller-firebase.json).
 * 3. GOOGLE_APPLICATION_CREDENTIALS - standard ADC path, also outside the repo.
 *
 * SECURITY RULES
 * --------------
 * - Lazy singleton: initialised at most once, on first actual use.
 * - Fail CLOSED: when no credentials are configured, `getAdminAuth()`
 *   returns null and protected endpoints answer `503 auth-unavailable`.
 *   Authentication is never bypassed.
 * - Secrets are never logged. Error messages name the MISSING variable, never
 *   the VALUE of any credential, token, private key, or OTP.
 * - No service-account file is ever created inside the repository.
 */

import fs from "node:fs";

let adminModulePromise = null;
let appInstance = null;
let initAttempted = false;
let initError = null;

/** Read the credential object from env, without ever logging its content. */
function loadServiceAccount() {
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const filePath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (inlineJson && inlineJson.trim()) {
    try {
      const parsed = JSON.parse(inlineJson);
      if (!parsed || typeof parsed !== "object" || !parsed.client_email) {
        return { error: "FIREBASE_SERVICE_ACCOUNT_JSON is not a valid service-account object." };
      }
      return { serviceAccount: parsed, source: "FIREBASE_SERVICE_ACCOUNT_JSON" };
    } catch {
      return { error: "FIREBASE_SERVICE_ACCOUNT_JSON could not be parsed as JSON." };
    }
  }

  if (filePath && String(filePath).trim()) {
    const resolved = String(filePath).trim();
    try {
      const raw = fs.readFileSync(resolved, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.client_email) {
        return { error: "Service-account file did not contain a valid service-account object." };
      }
      return { serviceAccount: parsed, source: "service-account file" };
    } catch {
      // Name the path that failed (configuration fact), never file content.
      return { error: `Could not read a service-account file at the configured path (${resolved}).` };
    }
  }

  return { error: null, missing: true };
}

/**
 * Returns the initialised Admin Auth service, or null when Firebase Admin
 * cannot be configured (caller must then fail closed with 503).
 * Never throws for missing credentials; throws only on unexpected errors.
 */
export async function getAdminAuth() {
  if (appInstance) return appInstance.auth();
  if (initError) return null;

  if (!initAttempted) {
    initAttempted = true;

    const { serviceAccount, source, error, missing } = loadServiceAccount();

    if (missing) {
      initError = new Error(
        "Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON, " +
          "FIREBASE_SERVICE_ACCOUNT_PATH, or GOOGLE_APPLICATION_CREDENTIALS. " +
          "See backend/.env.example."
      );
      return null;
    }

    if (error || !serviceAccount) {
      initError = new Error(error || "Firebase Admin credential configuration is invalid.");
      return null;
    }

    // FIREBASE_PROJECT_ID may pin the project explicitly; when present it must
    // agree with the project inside the service-account credential.
    const explicitProjectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
    const credentialProjectId = String(serviceAccount.project_id || "").trim();
    if (explicitProjectId && credentialProjectId && explicitProjectId !== credentialProjectId) {
      initError = new Error(
        "FIREBASE_PROJECT_ID does not match the project_id inside the service-account credential."
      );
      return null;
    }

    try {
      if (!adminModulePromise) {
        // Dynamic import so the backend still boots (and fails closed) even if
        // the optional dependency is absent.
        adminModulePromise = import("firebase-admin");
      }
      const admin = (await adminModulePromise).default;

      appInstance =
        admin.apps && admin.apps.length
          ? admin.apps[0]
          : admin.initializeApp({
              credential: admin.credential.cert(serviceAccount),
              ...(explicitProjectId || credentialProjectId
                ? { projectId: explicitProjectId || credentialProjectId }
                : {}),
            });

      // Source is a configuration fact (variable/file), never secret content.
      console.log(`[firebase-admin] initialised via ${source}.`);
    } catch (err) {
      initError = new Error("Firebase Admin SDK failed to initialise.");
      // Log only the failure fact, never credential or token material.
      console.error("[firebase-admin] initialisation failed.");
      return null;
    }
  }

  return appInstance ? appInstance.auth() : null;
}

/** True when Admin Auth is usable; used by health reporting, not auth logic. */
export async function isFirebaseAdminAvailable() {
  return (await getAdminAuth()) !== null;
}

/** Last initialisation failure reason (message only, no secrets). */
export function getFirebaseAdminError() {
  return initError ? initError.message : null;
}

export default { getAdminAuth, isFirebaseAdminAvailable, getFirebaseAdminError };
