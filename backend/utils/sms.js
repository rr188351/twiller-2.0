/**
 * SMS provider abstraction for Twiller 2.0.
 *
 * Mirrors `mailer.js` exactly so the two channels behave consistently.
 * Feature code calls `sendSms()` and never talks to a vendor directly.
 *
 *   OTP_DELIVERY=console  -> mock: prints to the server console
 *   OTP_DELIVERY=sms      -> real: Twilio / MSG91 / Fast2SMS (added later)
 *
 * Mobile OTP is required by internship Feature 2 (mobile access), Feature 4
 * (non-French languages) and Feature 6 (phone password recovery), so this
 * single module serves all three.
 *
 * SECURITY: the plain OTP is only returned to the caller when NODE_ENV is not
 * "production", and is never written to logs in production.
 */

import { exposeDevCode } from "./mailer.js";

const OTP_DELIVERY = (process.env.OTP_DELIVERY || "console").toLowerCase();
const SMS_PROVIDER = (process.env.SMS_PROVIDER || "twilio").toLowerCase();

/** Mock provider - prints the OTP to the server console. */
function deliverViaConsole({ to, body, kind }) {
  const maskedTo = process.env.NODE_ENV === "production" ? "[redacted]" : to;
  const bodyLine = exposeDevCode() ? body : "[body hidden in production]";

  console.log(
    [
      "",
      " ----------------------------- MOCK SMS ------------------------------",
      `  kind    : ${kind}`,
      `  to      : ${maskedTo}`,
      `  body    : ${bodyLine}`,
      "  (mock provider - no real SMS was sent)",
      " ---------------------------------------------------------------------",
      "",
    ].join("\n")
  );

  return { delivered: true, provider: "console" };
}

/**
 * Real SMS provider placeholder.
 * `twilio` is loaded dynamically so mock mode needs no dependency at all.
 */
async function deliverViaRealProvider({ to, body }) {
  try {
    if (SMS_PROVIDER !== "twilio") {
      console.error(`[sms] SMS_PROVIDER="${SMS_PROVIDER}" is not implemented yet.`);
      return { delivered: false, provider: SMS_PROVIDER, error: "Provider not implemented" };
    }

    const twilio = (await import("twilio")).default;
    const client = twilio(process.env.SMS_ACCOUNT_SID, process.env.SMS_AUTH_TOKEN);

    await client.messages.create({
      body,
      from: process.env.SMS_FROM,
      to,
    });

    return { delivered: true, provider: "twilio" };
  } catch (error) {
    console.error("[sms] delivery failed:", error?.message || "unknown error");
    return { delivered: false, provider: SMS_PROVIDER, error: "SMS delivery failed" };
  }
}

/**
 * Sends an SMS using the configured provider.
 *
 * @param {{to:string, body:string, kind?:string, devCode?:string}} message
 * @returns {Promise<{delivered:boolean, provider:string, devCode?:string}>}
 */
export async function sendSms({ to, body, kind = "generic", devCode }) {
  const result =
    OTP_DELIVERY === "sms"
      ? await deliverViaRealProvider({ to, body })
      : deliverViaConsole({ to, body, kind });

  if (result.delivered && devCode && exposeDevCode()) {
    return { ...result, devCode };
  }

  return result;
}

export const smsConfig = {
  provider: OTP_DELIVERY === "sms" ? SMS_PROVIDER : "console",
  exposesDevCode: exposeDevCode(),
};

export default { sendSms, smsConfig };
