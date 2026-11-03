/**
 * Language-switch OTP API client - Internship Feature 4 (Stage C).
 *
 * Thin wrapper over the existing axiosInstance (baseURL comes from
 * BACKEND_URL via next.config.ts). Identity comes ONLY from the Firebase ID
 * token in the Authorization header - no email, phone, or user ID is ever
 * sent as identity proof. The request bodies carry ONLY targetLocale / otp,
 * exactly as the backend contracts require.
 *
 * Nothing here logs tokens or OTPs. All backend response fields the UI needs
 * (status, code, retryAfterSeconds, attemptsRemaining, channel,
 * expiresInMinutes, devCode) are preserved verbatim for the dialog.
 */

// `.js` extension on purpose: this module is imported both by the Next.js
// bundler AND directly by the Node-based contract tests (Node's ESM resolver
// does not do extensionless relative imports).
import axiosInstance from "./axiosInstance.js";
import type { Locale } from "./i18n";

/**
 * OTPs are delivered by EMAIL for every locale. The SMS/Twilio channel has been
 * removed from the product, so this type has exactly one member and callers can
 * no longer branch on a mobile channel.
 */
export type LanguageOtpChannel = "email";

export interface LanguageOtpRequestSuccess {
  ok: true;
  channel: LanguageOtpChannel;
  targetLocale: Locale;
  message: string;
  expiresInMinutes: number;
  delivered: boolean;
  /**
   * How the code was actually dispatched. The backend distinguishes a real
   * provider acceptance from the development mock so the UI can never present
   * a mock as a delivered SMS.
   *   "sent"   - the provider ACCEPTED the message
   *   "mock"   - development-only mock; nothing was actually delivered
   *   "failed" - delivery failed (normally surfaced as a 502 instead)
   */
  deliveryStatus?: "sent" | "mock" | "failed";
  /** Non-secret transport name, e.g. "twilio" or "console". */
  provider?: string;
  /** Present ONLY when the backend runs outside production. Hint only. */
  devCode?: string;
}

export interface LanguageOtpVerifySuccess {
  ok: true;
  targetLocale: Locale;
  verified: true;
}

/** Backend error shape: HTTP status + machine code + human message. */
export interface LanguageOtpApiError {
  status: number;
  code?: string;
  error: string;
  retryAfterSeconds?: number;
  attemptsRemaining?: number;
}

export type LanguageOtpResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: LanguageOtpApiError };

/**
 * Human-readable fallback used when the backend did NOT answer with the
 * documented JSON error shape.
 *
 * The backend always answers JSON (the JSON error contract in backend/index.js
 * guarantees it), but the network path is not under our control: a proxy, a
 * misconfigured gateway, or an older backend deployment can still answer with
 * an HTML error page or plain text. In that case the response body is a
 * STRING, and reading `.error` off it would yield `undefined` - the user
 * would see an empty message. So we extract whatever usable text we can and
 * never render raw HTML.
 */
const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

/**
 * Hard client-side budget for one OTP request.
 *
 * Long enough to survive a slow Render cold start (the service can take 30-60s
 * to wake up), short enough that the dialog can never hang forever. The BACKEND
 * already fails a blocked SMTP delivery within ~10-20s, so this is a backstop.
 * Overridable with NEXT_PUBLIC_OTP_TIMEOUT_MS.
 */
const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_OTP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
})();

/** axios reports its own client timeout as ECONNABORTED (or ETIMEDOUT). */
function isTimeoutError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ERR_CANCELED";
}

/** Strip HTML tags / tags-like content so an error page cannot reach the UI. */
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull a usable message out of an unknown response body.
 *
 * - object  -> its `.error` (string) or `.message` (string)
 * - string  -> the text itself, with markup stripped and length-capped
 * - null    -> null (the caller substitutes the generic message)
 */
function extractMessage(body: unknown): string | null {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return null;
    // An HTML error page (from a proxy or gateway) is not a user-facing
    // message. Detect it on the RAW body, before markup is stripped.
    if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      return null;
    }
    const cleaned = stripMarkup(trimmed);
    if (!cleaned) return null;
    return cleaned.length > 300 ? `${cleaned.slice(0, 300)}...` : cleaned;
  }
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string" && b.error.trim()) return b.error.trim();
    if (typeof b.message === "string" && b.message.trim()) return b.message.trim();
  }
  return null;
}

function toApiError(status: number, body: unknown): LanguageOtpApiError {
  const b =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof b.code === "string" ? b.code : undefined;
  const message = extractMessage(body) ?? GENERIC_ERROR_MESSAGE;
  return {
    status,
    code,
    error: message,
    retryAfterSeconds:
      typeof b.retryAfterSeconds === "number" ? b.retryAfterSeconds : undefined,
    attemptsRemaining:
      typeof b.attemptsRemaining === "number" ? b.attemptsRemaining : undefined,
  };
}

/**
 * STEP 1 - ask the backend to issue (or resend) a code for `targetLocale`.
 * Email is the only channel: the backend resolves the destination from the
 * server-side account record.
 */
export async function requestLanguageOtp(
  idToken: string,
  targetLocale: Locale
): Promise<LanguageOtpResult<LanguageOtpRequestSuccess>> {
  try {
    const res = await axiosInstance.post(
      "/auth/language/otp/request",
      { targetLocale },
      // `timeout` bounds the wait so a blocked/hung delivery can never leave the
      // dialog spinning forever; the backend also fails fast on its own.
      { headers: { Authorization: `Bearer ${idToken}` }, timeout: REQUEST_TIMEOUT_MS }
    );
    return { ok: true, status: res.status, data: res.data };
  } catch (err: unknown) {
    const status =
      typeof err === "object" &&
      err !== null &&
      "response" in err &&
      typeof (err as { response?: { status?: unknown } }).response?.status ===
        "number"
        ? ((err as { response: { status: number } }).response.status as number)
        : 0;
    const body =
      typeof err === "object" &&
      err !== null &&
      "response" in err &&
      (err as { response?: { data?: unknown } }).response
        ? (err as { response: { data?: unknown } }).response.data
        : null;
    if (status === 0 && isTimeoutError(err)) {
      return {
        ok: false,
        status: 0,
        error: {
          status: 0,
          code: "timeout",
          error:
            "The Twiller backend took too long to respond. Please try again.",
        },
      };
    }
    if (status === 0) {
      return {
        ok: false,
        status: 0,
        error: {
          status: 0,
          code: "NETWORK",
          error:
            "Cannot reach the Twiller backend. Make sure it is running (port 5000).",
        },
      };
    }
    return { ok: false, status, error: toApiError(status, body) };
  }
}

/**
 * STEP 2 - submit the 6-digit code. Success ({ ok, verified }) is the ONLY
 * signal the UI may act on.
 */
export async function verifyLanguageOtp(
  idToken: string,
  targetLocale: Locale,
  otp: string
): Promise<LanguageOtpResult<LanguageOtpVerifySuccess>> {
  try {
    const res = await axiosInstance.post(
      "/auth/language/otp/verify",
      { targetLocale, otp },
      { headers: { Authorization: `Bearer ${idToken}` }, timeout: REQUEST_TIMEOUT_MS }
    );
    return { ok: true, status: res.status, data: res.data };
  } catch (err: unknown) {
    const status =
      typeof err === "object" &&
      err !== null &&
      "response" in err &&
      typeof (err as { response?: { status?: unknown } }).response?.status ===
        "number"
        ? ((err as { response: { status: number } }).response.status as number)
        : 0;
    const body =
      typeof err === "object" &&
      err !== null &&
      "response" in err &&
      (err as { response?: { data?: unknown } }).response
        ? (err as { response: { data?: unknown } }).response.data
        : null;
    if (status === 0 && isTimeoutError(err)) {
      return {
        ok: false,
        status: 0,
        error: {
          status: 0,
          code: "timeout",
          error:
            "The Twiller backend took too long to respond. Please try again.",
        },
      };
    }
    if (status === 0) {
      return {
        ok: false,
        status: 0,
        error: {
          status: 0,
          code: "NETWORK",
          error:
            "Cannot reach the Twiller backend. Make sure it is running (port 5000).",
        },
      };
    }
    return { ok: false, status, error: toApiError(status, body) };
  }
}
