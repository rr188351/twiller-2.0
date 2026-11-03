/**
 * SMS provider abstraction for Twiller 2.0.
 *
 * Mirrors `mailer.js` for the mobile channel. Feature code calls `sendSms()`
 * and never talks to a vendor directly.
 *
 * WHY A SEPARATE SWITCH EXISTS (bugfix)
 * -------------------------------------
 * `OTP_DELIVERY` used to drive BOTH channels. Setting `OTP_DELIVERY=smtp`
 * (required to send real e-mail) therefore forced SMS into the console mock -
 * "real email + real SMS" was impossible. SMS now has its own switch:
 *
 *   SMS_DELIVERY=console -> development mock (NEVER allowed in production)
 *   SMS_DELIVERY=twilio  -> real SMS through the Twilio REST API
 *
 * Precedence:
 *   1. SMS_DELIVERY              (explicit, preferred)
 *   2. OTP_DELIVERY              (legacy: "sms" => twilio, "console" => console)
 *   3. default                   -> console in development,
 *                                   "unconfigured" in production
 * Production NEVER silently falls back to the mock.
 *
 * EVERY call resolves to an explicit status so a mock can never be reported as
 * a real send:
 *   "sent"   - the provider ACCEPTED the message (real SMS)
 *   "mock"   - development-only mock; no SMS was sent
 *   "failed" - rejected / not configured / transport error
 *
 * SECURITY: the plain OTP is only ever attached to the returned object when
 * NODE_ENV is not "production", and is never written to logs in production.
 *
 * Required environment variables for real delivery (SMS_DELIVERY=twilio):
 *   SMS_ACCOUNT_SID, SMS_AUTH_TOKEN, SMS_FROM
 * Optional: SMS_DEFAULT_COUNTRY_CODE (default 91), TWILIO_API_BASE (tests only).
 */

import { exposeDevCode } from "./mailer.js";

/** Env var names the Twilio adapter requires. */
export const TWILIO_REQUIRED_ENV = ["SMS_ACCOUNT_SID", "SMS_AUTH_TOKEN", "SMS_FROM"];

/**
 * Resolves which SMS transport to use. Read at CALL time (not import time) so
 * tests and hosted environments can change it without a restart.
 *
 * @returns {"console"|"twilio"|"unconfigured"|"unsupported"}
 */
export function resolveSmsMode() {
  const explicit = (process.env.SMS_DELIVERY || "").trim().toLowerCase();
  const legacy = (process.env.OTP_DELIVERY || "").trim().toLowerCase();

  if (explicit) {
    if (explicit === "console" || explicit === "mock") return "console";
    if (explicit === "twilio" || explicit === "sms") return "twilio";
    return "unsupported";
  }
  // Backwards compatibility with existing .env files.
  if (legacy === "console") return "console";
  if (legacy === "sms") return "twilio";
  // Nothing configured: mock only OUTSIDE production.
  return process.env.NODE_ENV === "production" ? "unconfigured" : "console";
}

/** Twilio credentials still missing (names only - never values). */
export function missingTwilioEnv() {
  return TWILIO_REQUIRED_ENV.filter((key) => !String(process.env[key] || "").trim());
}

/** Configured default country code (digits only), used for short local numbers. */
export function defaultCountryCode() {
  const digits = String(process.env.SMS_DEFAULT_COUNTRY_CODE || "91").replace(/\D/g, "");
  return digits || "91";
}

/**
 * Normalises a stored/received phone number to E.164 (`+<country><subscriber>`),
 * which is what SMS providers require. Stored profiles keep digits-only WITH the
 * country code (e.g. "919876543210"); a bare 10-digit local number gets the
 * configured default country code.
 *
 * @returns {string} E.164 number, or "" when there is nothing usable.
 */
export function toE164(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const hadPlus = value.startsWith("+");
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (hadPlus) return `+${digits}`;
  const cc = defaultCountryCode();
  // A number that is already longer than a national number + default CC keeps
  // its own country code (e.g. "14155552671" -> "+14155552671").
  if (digits.length > 10 && cc.length === 2 && digits.length === 12) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return `+${cc}${digits}`;
}

/** Mock provider - prints a clearly-labelled MOCK block. Never used in production. */
function deliverViaConsole({ to, body, kind }) {
  const maskedTo = process.env.NODE_ENV === "production" ? "[redacted]" : to;
  const bodyLine = exposeDevCode() ? body : "[body hidden in production]";

  console.log(
    [
      "",
      " --------------------- MOCK SMS (no SMS was sent) ---------------------",
      `  kind    : ${kind}`,
      `  to      : ${maskedTo}`,
      `  body    : ${bodyLine}`,
      "  NOTE: this is a DEVELOPMENT mock. Configure SMS_DELIVERY=twilio plus",
      "        SMS_ACCOUNT_SID, SMS_AUTH_TOKEN and SMS_FROM to send real SMS.",
      " ---------------------------------------------------------------------",
      "",
    ].join("\n")
  );

  // `delivered` stays true so the development flow still completes, but the
  // explicit status means no caller can describe this as a real send.
  return { status: "mock", provider: "console", delivered: true };
}


/**
 * Real SMS provider: Twilio, through its documented REST API
 *   POST {base}/Accounts/{AccountSid}/Messages.json   (HTTP Basic auth)
 *
 * The REST API is used directly so NO new npm dependency is required. If the
 * official `twilio` SDK happens to be installed it can be used instead without
 * changing this module's contract. Credentials come from server-side env vars
 * only and are never logged.
 *
 * `TWILIO_API_BASE` lets tests point the adapter at a local stub; it defaults to
 * the real Twilio endpoint.
 */
function twilioApiBase() {
  return (process.env.TWILIO_API_BASE || "https://api.twilio.com/2010-04-01").replace(/\/+$/, "");
}

async function deliverViaTwilio({ to, body }) {
  const missing = missingTwilioEnv();
  if (missing.length > 0) {
    return {
      status: "failed",
      provider: "twilio",
      delivered: false,
      error:
        `SMS is not configured: ${missing.join(", ")} missing. ` +
        `Set ${TWILIO_REQUIRED_ENV.join(", ")} and SMS_DELIVERY=twilio in backend/.env.`,
    };
  }

  // Providers require E.164. Falling back to a malformed number is worse than
  // refusing, so a number that cannot be normalised fails clearly.
  const e164 = toE164(to);
  if (!/^\+\d{7,15}$/.test(e164)) {
    return {
      status: "failed",
      provider: "twilio",
      delivered: false,
      error: "Invalid phone number for SMS delivery (expected E.164, e.g. +919876543210).",
    };
  }

  const sid = process.env.SMS_ACCOUNT_SID;
  const token = process.env.SMS_AUTH_TOKEN;
  const from = process.env.SMS_FROM;

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetch(
      `${twilioApiBase()}/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: e164, From: from, Body: body }).toString(),
      }
    );

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      // Twilio answers { message, code }. Log the provider's reason only -
      // never credentials and never the OTP body.
      const detail = (payload && payload.message) || `HTTP ${res.status}`;
      console.error(
        `[sms] twilio rejected the message (${(payload && payload.code) || res.status}): ${detail}`
      );
      return {
        status: "failed",
        provider: "twilio",
        delivered: false,
        error: `SMS provider rejected the message: ${detail}`,
      };
    }

    // "sent" == the provider ACCEPTED the message (queued for delivery).
    return {
      status: "sent",
      provider: "twilio",
      delivered: true,
      providerMessageId: payload && payload.sid ? String(payload.sid) : undefined,
    };
  } catch (error) {
    console.error("[sms] twilio transport error:", error?.message || "unknown error");
    return {
      status: "failed",
      provider: "twilio",
      delivered: false,
      error: "SMS transport error (provider unreachable).",
    };
  }
}

/**
 * Sends an SMS using the configured provider.
 *
 * @param {{to:string, body:string, kind?:string, devCode?:string}} message
 * @returns {Promise<{status:"sent"|"mock"|"failed", provider:string, delivered:boolean, error?:string, providerMessageId?:string, devCode?:string}>}
 */
export async function sendSms({ to, body, kind = "generic", devCode }) {
  const mode = resolveSmsMode();
  let result;

  if (mode === "twilio") {
    result = await deliverViaTwilio({ to, body });
  } else if (mode === "console") {
    if (process.env.NODE_ENV === "production") {
      // Hard guard: mock delivery must NEVER be used in production, even if an
      // operator explicitly configured SMS_DELIVERY=console.
      result = {
        status: "failed",
        provider: "console",
        delivered: false,
        error:
          `Mock SMS delivery is disabled in production. Set SMS_DELIVERY=twilio and ` +
          `${TWILIO_REQUIRED_ENV.join(", ")}.`,
      };
    } else {
      result = deliverViaConsole({ to, body, kind });
    }
  } else if (mode === "unsupported") {
    result = {
      status: "failed",
      provider: String(process.env.SMS_DELIVERY || ""),
      delivered: false,
      error: `SMS_DELIVERY="${process.env.SMS_DELIVERY}" is not supported. Use "twilio" or "console".`,
    };
  } else {
    // Production with nothing configured: fail safely instead of mocking.
    result = {
      status: "failed",
      provider: "unconfigured",
      delivered: false,
      error:
        `SMS delivery is not configured. Set SMS_DELIVERY=twilio and ` +
        `${TWILIO_REQUIRED_ENV.join(", ")}.`,
    };
  }

  // A dev code is attached ONLY for the development mock, and only outside
  // production. A real provider response never echoes the OTP back.
  if (result.status === "mock" && devCode && exposeDevCode()) {
    return { ...result, devCode };
  }

  return result;
}

/** Non-secret snapshot of the SMS configuration (safe to log / show in a UI). */
export function smsConfig() {
  const mode = resolveSmsMode();
  return {
    mode,
    realDelivery: mode === "twilio",
    missingEnv: mode === "twilio" ? missingTwilioEnv() : [],
    exposesDevCode: exposeDevCode(),
  };
}

export default { sendSms, smsConfig, resolveSmsMode, toE164, missingTwilioEnv };
