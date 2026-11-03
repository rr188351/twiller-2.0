import axios from "axios";

/**
 * The secured backend routes (`/register`, `/loggedinuser`, `/userupdate/*`,
 * `/post`, `/like/*`, `/retweet/*`, `/subscription/payment`) verify the
 * caller's Firebase ID token with the Admin SDK. Every request is therefore
 * sent with `Authorization: Bearer <Firebase ID token>` when a Firebase
 * session exists. The identity is NEVER derived from a client-supplied email
 * or user id - only from the verified token on the server side.
 *
 * The Firebase app is imported lazily inside the interceptor so that this
 * module stays importable in contexts where Firebase is not yet initialised
 * (and so the interceptor never throws before sign-in).
 */
const axiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

/**
 * Decodes ONLY the non-sensitive claims (payload) of a Firebase ID token and
 * reports the project it was minted for. The token value itself is never
 * logged. Used to detect the post-migration misconfiguration where the web
 * SDK still holds config from a DIFFERENT project than the backend verifies
 * against - that mismatch is exactly what produces 401 auth-invalid on
 * every secured route.
 */
export function getTokenProject(token) {
  try {
    const payloadSegment = String(token).split(".")[1] || "";
    const b64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    // A Firebase ID token carries the minting project as `aud` (with the
    // matching `https://securetoken.google.com/<project>` issuer).
    return typeof payload.aud === "string" ? payload.aud : "";
  } catch {
    return ""; // not a JWT / not yet available
  }
}

async function attachToken(config) {
  const { auth } = await import("../context/firebase");
  const currentUser = auth && auth.currentUser;
  if (currentUser) {
    const token = await currentUser.getIdToken();
    const expected = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "";
    if (expected) {
      const mintedFor = getTokenProject(token);
      if (mintedFor && mintedFor !== expected) {
        // Stale / cross-project config: the token will be REJECTED by the
        // backend's issuer/audience check. Tell the developer exactly which
        // file to fix (never print the token itself, only the two project
        // names - both are public identifiers, not secrets).
        // eslint-disable-next-line no-console
        console.error(
          `[twiller] Firebase project mismatch: the current ID token was minted by project ` +
            `"${mintedFor}" but the app is configured for "${expected}". ` +
            `Update the NEXT_PUBLIC_FIREBASE_* values in twiller/.env.local to the ` +
            `Firebase Web App config of project "${expected}" (Firebase Console -> ` +
            `Project settings -> Your apps -> SDK setup and configuration), then ` +
            `restart the dev server. Secured routes will return 401 until then.`
        );
      }
    }
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}

axiosInstance.interceptors.request.use(async (config) => {
  try {
    await attachToken(config);
  } catch {
    // No Firebase session (or Firebase not configured yet): send the request
    // unsigned. The backend answers protected routes with 401/503, which the
    // calling UI already treats as "sign in again".
  }
  return config;
});

/**
 * SAFE 401 RETRY - expired / invalid token recovery WITHOUT loops.
 *
 * When a secured route answers 401 `auth-invalid`, the cached Firebase ID
 * token may be expired (they live ~5 minutes) or, after a project migration,
 * minted by the wrong project. The interceptor force-refreshes the token
 * (`getIdToken(true)`) and retries the SAME request exactly ONCE, marked
 * with `_authRetry`. Every other 401 code (auth-required, email-unverified,
 * auth-conflict) and every second failure propagates to the caller - no
 * infinite retry loops, no silent credential swaps.
 */
axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error?.response?.status;
    const code = error?.response?.data?.code;
    const config = error?.config;
    const retriable =
      status === 401 && code === "auth-invalid" && config && !config._authRetry;
    if (retriable) {
      config._authRetry = true;
      try {
        const { auth } = await import("../context/firebase");
        const currentUser = auth && auth.currentUser;
        if (currentUser) {
          const freshToken = await currentUser.getIdToken(true); // force refresh
          config.headers.Authorization = `Bearer ${freshToken}`;
          const mintedFor = getTokenProject(freshToken);
          const expected = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "";
          if (expected && mintedFor && mintedFor !== expected) {
            // eslint-disable-next-line no-console
            console.error(
              `[twiller] Force-refreshed token is still from project "${mintedFor}", ` +
                `but the backend expects "${expected}". The retry will fail with ` +
                `auth-invalid until twiller/.env.local is updated (see the warning ` +
                `above). No further automatic retries will be attempted.`
            );
          }
          return axiosInstance(config); // single retry, then stop
        }
      } catch {
        // Refresh itself failed (network / Firebase down): propagate the
        // ORIGINAL 401 so the UI can show "sign in again" - no loop.
      }
    }
    return Promise.reject(error);
  }
);

/**
 * Normalises secured-route failures into one readable shape so callers can
 * react without reading raw axios internals. Mirrors `describePaymentError`:
 * expired/missing sessions and cross-account conflicts become explicit codes
 * the UI can translate (re-sign-in, verify email, account conflict...).
 */
export function describeAuthError(error, fallback = "Something went wrong. Please try again.") {
  if (error !== null && typeof error === "object" && "response" in error) {
    const response = error.response;
    const data = response?.data;
    const status = response?.status;
    if (status === 401) {
      const code = typeof data?.code === "string" ? data.code : "";
      if (code === "auth-unavailable") {
        return { message: "Authentication service is temporarily unavailable. Please try again later.", code, status };
      }
      if (code === "auth-conflict") {
        return { message: "This email is linked to a different account. Contact support or sign in with the account that owns it.", code, status };
      }
      if (code === "email-unverified") {
        return { message: "Please verify your email address first, then sign in again.", code, status };
      }
      return { message: "Your session has expired. Please sign in again.", code: code || "auth-invalid", status };
    }
    if (status === 403 && data?.code === "identity-mismatch") {
      return { message: "This action is not allowed for your account.", code: "identity-mismatch", status };
    }
    if (status === 503) {
      return { message: "The service is temporarily unavailable. Please try again later.", code: data?.code || "", status };
    }
    if (data && typeof data.error === "string") {
      return { message: data.error, code: typeof data.code === "string" ? data.code : "", status };
    }
  }
  return { message: fallback, code: "", status: null };
}

export default axiosInstance;
