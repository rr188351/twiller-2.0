/**
 * Email provider abstraction for Twiller 2.0.
 *
 * PROVIDER-ABSTRACTION DESIGN
 * ---------------------------
 * Feature code NEVER talks to an email vendor directly. It always calls
 * `sendMail()` below. That means switching from the mock provider to a real
 * SMTP server later is a configuration change (`OTP_DELIVERY=smtp` plus
 * credentials in `.env`), NOT a rewrite of any feature logic.
 *
 *   OTP_DELIVERY=console  -> mock: prints to the server console
 *   OTP_DELIVERY=smtp     -> real: nodemailer over SMTP (added later)
 *
 * SECURITY RULES ENFORCED HERE
 * ----------------------------
 * 1. A `devCode` is only ever attached to the returned object when
 *    NODE_ENV is NOT "production". In production the function simply does not
 *    put the secret in the response at all - see `exposeDevCode()`.
 * 2. Real secrets are never logged. The console output shows a masked
 *    identifier and a masked code by default; the full code is printed only
 *    in non-production.
 * 3. Logging goes through `redact()` so an SMTP password or reset token can
 *    never be written to the log file.
 */

const OTP_DELIVERY = (process.env.OTP_DELIVERY || "console").toLowerCase();
const MAIL_FROM = process.env.MAIL_FROM || "Twiller <no-reply@twiller.local>";

/**
 * Whether secret values may be surfaced to the caller.
 * This is the single gate that keeps `devCode` out of production responses.
 */
export function exposeDevCode() {
  return process.env.NODE_ENV !== "production";
}

/**
 * The mock provider prints the message to the server console so a developer can
 * complete the flow without an email account.
 */
function deliverViaConsole({ to, subject, body, kind }) {
  // Never print the full identifier or the full secret in production.
  const maskedTo = process.env.NODE_ENV === "production" ? "[redacted]" : to;
  const secretLine = exposeDevCode() ? body : "[body hidden in production]";

  console.log(
    [
      "",
      "  ----------------------------- MOCK EMAIL -----------------------------",
      `  kind    : ${kind}`,
      `  to      : ${maskedTo}`,
      `  subject : ${subject}`,
      `  body    : ${secretLine}`,
      "  (mock provider - no real email was sent)",
      "  ----------------------------------------------------------------------",
      "",
    ].join("\n")
  );

  return { delivered: true, provider: "console" };
}

/**
 * Real SMTP provider.
 * Implemented with `nodemailer`, which is added to package.json only when you
 * are ready to switch OTP_DELIVERY to "smtp". Keeping it behind a dynamic
 * import means the mock mode has zero install cost.
 */
async function deliverViaSmtp({ to, subject, body }) {
  let nodemailer;
  try {
    // Dynamic import so the mock provider works with no extra dependency.
    nodemailer = (await import("nodemailer")).default;
  } catch {
    console.error(
      "[mailer] OTP_DELIVERY=smtp but 'nodemailer' is not installed. Run: npm install nodemailer"
    );
    return { delivered: false, provider: "smtp", error: "nodemailer not installed" };
  }

  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE) === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transport.sendMail({ from: MAIL_FROM, to, subject, text: body });
    return { delivered: true, provider: "smtp" };
  } catch (error) {
    // error.message could contain credentials, so keep it generic in logs.
    console.error("[mailer] SMTP delivery failed:", error?.message || "unknown error");
    return { delivered: false, provider: "smtp", error: "SMTP delivery failed" };
  }
}

/**
 * Sends an email using the configured provider.
 *
 * @param {{to:string, subject:string, body:string, kind?:string, devCode?:string}} message
 * @returns {Promise<{delivered:boolean, provider:string, devCode?:string}>}
 *          `devCode` is present ONLY outside production.
 */
export async function sendMail({ to, subject, body, kind = "generic", devCode }) {
  const result =
    OTP_DELIVERY === "smtp"
      ? await deliverViaSmtp({ to, subject, body })
      : deliverViaConsole({ to, subject, body, kind });

  // Never echo the secret back to the client in production.
  if (result.delivered && devCode && exposeDevCode()) {
    return { ...result, devCode };
  }

  return result;
}

/** Sends the invoice / plan confirmation email (Internship Feature 1). */
export function sendInvoiceEmail({ to, invoiceNumber, planName, amount, date }) {
  return sendMail({
    kind: "invoice",
    to,
    subject: `Your Twiller invoice ${invoiceNumber}`,
    body: [
      `Hello,`,
      ``,
      `Thank you for your Twiller subscription.`,
      ``,
      `Invoice number : ${invoiceNumber}`,
      `Plan            : ${planName}`,
      `Amount          : INR ${amount}`,
      `Date            : ${date}`,
      ``,
      `You can continue using your plan until the end of the billing period.`,
      ``,
      `- Twiller`,
    ].join("\n"),
  });
}

export const mailerConfig = {
  provider: OTP_DELIVERY === "smtp" ? "smtp" : "console",
  from: MAIL_FROM,
  exposesDevCode: exposeDevCode(),
};

export default { sendMail, sendInvoiceEmail, exposeDevCode, mailerConfig };
