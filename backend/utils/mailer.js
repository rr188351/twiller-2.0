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

/**
 * Env vars the real SMTP adapter cannot work WITHOUT (names only - never
 * values). SMTP_PORT and SMTP_SECURE are deliberately NOT required: both have
 * correct, self-consistent defaults (see smtpTransportOptions). Requiring them
 * turned a perfectly valid configuration into a hard "not configured" failure,
 * which is indistinguishable from a provider outage.
 */
export const SMTP_REQUIRED_ENV = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"];

/** Default submission port (STARTTLS) and the implicit-TLS port. */
export const SMTP_DEFAULT_PORT = 587;
export const SMTP_IMPLICIT_TLS_PORT = 465;

/**
 * HTTPS transactional-email provider (Resend).
 *
 * WHY THIS EXISTS
 * ---------------
 * Render's Free web services BLOCK outbound SMTP (ports 25, 465 and 587), so
 * `smtp.gmail.com:465` can only ever time out there - the provider is never
 * reached and no SMTP port/credential fix can help. The provider's HTTPS API
 * runs on 443, which is never blocked, so this transport works on every Render
 * plan while keeping the exact same `sendMail()` interface for callers.
 *
 * Configuration:
 *   RESEND_API_KEY   secret API key (never committed, never logged)
 *   MAIL_FROM        a sender VERIFIED in Resend (domain or single address)
 *   MAIL_PROVIDER    "resend" | "smtp" (optional; inferred from the key)
 *   RESEND_API_URL   override for tests (local stub)
 *   RESEND_TIMEOUT_MS  request budget (default 15000) so a hang cannot stall
 *                      an OTP request
 */
export const RESEND_REQUIRED_ENV = ["RESEND_API_KEY", "MAIL_FROM"];
export const RESEND_DEFAULT_API_URL = "https://api.resend.com";
export const RESEND_DEFAULT_TIMEOUT_MS = 15000;

/** Configured sender address (call time, so tests can override it). */
function mailFrom() {
  return process.env.MAIL_FROM || "Twiller <no-reply@twiller.local>";
}

/** Tolerant parser for switch-style env values ("true", "TRUE", "1", "yes", "on"). */
export function envFlag(value) {
  return ["true", "1", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/**
 * Builds the nodemailer transport options, keeping port and TLS mode
 * CONSISTENT when the operator configures only one of SMTP_PORT /
 * SMTP_SECURE.
 *
 *   SMTP_PORT set        -> that port wins (explicit configuration)
 *   SMTP_PORT unset      -> 465 when SMTP_SECURE is truthy, else 587
 *   SMTP_SECURE unset    -> derived: true only for port 465
 *
 * This prevents the classic "implicit TLS on the submission port" mix-up
 * (587 + secure:true), which cannot connect and surfaces as a generic
 * delivery failure instead of a precise configuration error.
 */
export function smtpTransportOptions() {
  const rawPort = String(process.env.SMTP_PORT ?? "").trim();
  const parsedPort = Number(rawPort);
  const hasPort = rawPort !== "" && Number.isFinite(parsedPort) && parsedPort > 0;
  const hasSecureFlag = String(process.env.SMTP_SECURE ?? "").trim() !== "";
  const secureFlag = envFlag(process.env.SMTP_SECURE);

  const port = hasPort
    ? parsedPort
    : secureFlag
      ? SMTP_IMPLICIT_TLS_PORT
      : SMTP_DEFAULT_PORT;
  const secure = hasSecureFlag ? secureFlag : port === SMTP_IMPLICIT_TLS_PORT;

  // Name the two combinations that can never work, instead of hiding them
  // behind a timeout. Values logged are ports/booleans - never secrets.
  if (port === SMTP_IMPLICIT_TLS_PORT && hasSecureFlag && !secureFlag) {
    console.warn(
      `[mailer] SMTP_PORT=${port} requires SMTP_SECURE=true (implicit TLS). The current combination cannot connect.`
    );
  }
  if (port === SMTP_DEFAULT_PORT && secureFlag) {
    console.warn(
      `[mailer] SMTP_PORT=${port} with SMTP_SECURE=true is inconsistent (587 uses STARTTLS). Set SMTP_PORT=465 or SMTP_SECURE=false.`
    );
  }

  return {
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  };
}

/** Strips anything sensitive from a value before it reaches a log line. */
export function redact(text) {
  return String(text ?? "")
    .replace(/[\w.+-]+@[\w.-]+/g, "<email>")
    .replace(/\b[A-Za-z0-9_\-+/=]{16,}\b/g, "<redacted>");
}

/** Logs a delivery failure with NO secrets (mode, provider and redacted reason). */
function logDeliveryFailure(mode, error) {
  console.error(`[mailer] email delivery failed (mode=${mode}): ${redact(error)}`);
}

/**
 * Resolves which mail transport to use. Read at CALL time (like utils/sms.js)
 * so tests and hosted environments can change it without a restart.
 *
 *   OTP_DELIVERY=smtp             -> real SMTP (nodemailer)
 *   OTP_DELIVERY=console | mock   -> development console mock
 *   unset in production           -> "unconfigured"  (fail closed)
 *   unset outside production      -> console mock
 *
 * Production NEVER silently falls back to the mock, so the API can never report
 * a delivered OTP when no provider actually sent it.
 */
export function resolveMailMode() {
  const explicit = (process.env.OTP_DELIVERY || "").trim().toLowerCase();
  // "live" and "resend" are accepted aliases for "real delivery"; the actual
  // transport is chosen by resolveMailProvider().
  if (explicit === "smtp" || explicit === "live" || explicit === "resend") return "smtp";
  if (explicit === "console" || explicit === "mock") return "console";
  if (!explicit) return process.env.NODE_ENV === "production" ? "unconfigured" : "console";
  return "unsupported";
}

/**
 * Which real transport to use once delivery is switched on.
 *
 *   MAIL_PROVIDER=resend | smtp  -> explicit choice wins
 *   unset                        -> "resend" when RESEND_API_KEY is present,
 *                                   otherwise "smtp" (backwards compatible)
 *
 * This is why an existing deployment that only sets `OTP_DELIVERY=smtp` keeps
 * using SMTP until a RESEND_API_KEY is added, at which point it moves to the
 * HTTPS API with no other change.
 */
export function resolveMailProvider() {
  const explicit = (process.env.MAIL_PROVIDER || "").trim().toLowerCase();
  if (explicit === "resend" || explicit === "smtp") return explicit;
  return String(process.env.RESEND_API_KEY || "").trim() ? "resend" : "smtp";
}

/** Resend variables still missing (names only - never values). */
export function missingResendEnv() {
  return RESEND_REQUIRED_ENV.filter((key) => !String(process.env[key] || "").trim());
}

/** Variables the SELECTED provider cannot work without (names only). */
export function missingMailEnv(provider = resolveMailProvider()) {
  return provider === "resend" ? missingResendEnv() : missingSmtpEnv();
}

/** Resend API base; RESEND_API_URL lets tests point at a local stub. */
function resendApiBase() {
  return String(process.env.RESEND_API_URL || RESEND_DEFAULT_API_URL).replace(/\/+$/, "");
}

/** Bounded request budget so a hanging provider can never stall an OTP call. */
function resendTimeoutMs() {
  const raw = Number(String(process.env.RESEND_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : RESEND_DEFAULT_TIMEOUT_MS;
}

/** SMTP variables still missing (names only - never values). */
export function missingSmtpEnv() {
  return SMTP_REQUIRED_ENV.filter((key) => !String(process.env[key] || "").trim());
}

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
  // TEST-ONLY outage simulation, gated exactly like `testOutcome` in
  // utils/payment.js: read at call time and honoured ONLY when NODE_ENV is
  // not "production". It can only ever make delivery report failure - it can
  // never fabricate a success. Lets feature1-invoice.test.js prove that a
  // mailer failure never downgrades an already-successful payment.
  if (exposeDevCode() && process.env.MOCK_MAIL_OUTAGE === "true") {
    return {
      delivered: false,
      status: "failed",
      provider: "console",
      error: "Simulated mail outage (MOCK_MAIL_OUTAGE=true)",
    };
  }

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

  // `status` mirrors utils/sms.js so callers can distinguish a real provider
  // acceptance ("sent") from a development mock ("mock").
  return { delivered: true, status: "mock", provider: "console" };
}

/**
 * Real SMTP provider.
 * Implemented with `nodemailer`, which is added to package.json only when you
 * are ready to switch OTP_DELIVERY to "smtp". Keeping it behind a dynamic
 * import means the mock mode has zero install cost.
 */
async function deliverViaSmtp({ to, subject, body }) {
  const missing = missingSmtpEnv();
  if (missing.length > 0) {
    // Configuration fact only (variable NAMES) - never a credential value.
    return {
      delivered: false,
      status: "failed",
      provider: "smtp",
      error:
        `Email delivery is not configured: ${missing.join(", ")} missing. ` +
        `Set OTP_DELIVERY=smtp and ${SMTP_REQUIRED_ENV.join(", ")} in the backend environment.`,
    };
  }

  let nodemailer;
  try {
    // Dynamic import so the mock provider works with no extra dependency.
    nodemailer = (await import("nodemailer")).default;
  } catch {
    console.error(
      "[mailer] OTP_DELIVERY=smtp but 'nodemailer' is not installed. Run: npm install nodemailer"
    );
    return { delivered: false, status: "failed", provider: "smtp", error: "nodemailer not installed" };
  }

  try {
    const options = smtpTransportOptions();
    const transport = nodemailer.createTransport(options);
    await transport.sendMail({ from: mailFrom(), to, subject, text: body });
    return { delivered: true, status: "sent", provider: "smtp" };
  } catch (error) {
    // Log the transport facts (host/port/secure) plus a redacted reason, so a
    // production failure is diagnosable without a second round trip. No
    // credential, address or OTP can reach this line.
    console.error(
      `[mailer] SMTP delivery failed (host=${process.env.SMTP_HOST}, port=${smtpTransportOptions().port}, secure=${smtpTransportOptions().secure}): ${redact(error?.message || "unknown error")}`
    );
    return { delivered: false, status: "failed", provider: "smtp", error: "SMTP delivery failed" };
  }
}

/**
 * Real HTTPS provider (Resend).
 *
 * Used instead of SMTP because Render's Free plan blocks outbound SMTP ports;
 * HTTPS/443 is always reachable. The response contract is identical to
 * `deliverViaSmtp` so no caller changes.
 */
async function deliverViaResend({ to, subject, body }) {
  const missing = missingResendEnv();
  if (missing.length > 0) {
    // Configuration fact only (variable NAMES) - never a credential value.
    return {
      delivered: false,
      status: "failed",
      provider: "resend",
      error:
        `Email delivery is not configured: ${missing.join(", ")} missing. ` +
        `Set OTP_DELIVERY=smtp, MAIL_PROVIDER=resend and ${RESEND_REQUIRED_ENV.join(", ")} in the backend environment.`,
    };
  }

  const timeoutMs = resendTimeoutMs();
  try {
    const res = await fetch(`${resendApiBase()}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: mailFrom(), to: [to], subject, text: body }),
      // A bounded budget: a hanging provider must never stall the OTP request.
      signal: AbortSignal.timeout(timeoutMs),
    });

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (payload && (payload.message || payload.error)) || `HTTP ${res.status}`;
      console.error(`[mailer] resend rejected the message (${res.status}): ${redact(detail)}`);
      return {
        delivered: false,
        status: "failed",
        provider: "resend",
        error: `Email provider rejected the message: ${redact(detail)}`,
      };
    }

    return {
      delivered: true,
      status: "sent",
      provider: "resend",
      providerMessageId: payload && payload.id ? String(payload.id) : undefined,
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
    const reason = timedOut
      ? `request exceeded the ${timeoutMs}ms budget`
      : redact(error?.message || "unknown error");
    console.error(`[mailer] resend delivery failed (timeout=${timeoutMs}ms): ${reason}`);
    return {
      delivered: false,
      status: "failed",
      provider: "resend",
      error: timedOut
        ? `Email provider timed out after ${timeoutMs}ms`
        : "Email transport error (provider unreachable).",
    };
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
  const mode = resolveMailMode();
  let result;

  if (mode === "smtp") {
    // Which real transport: MAIL_PROVIDER, or inferred from RESEND_API_KEY.
    const provider = resolveMailProvider();
    result =
      provider === "resend"
        ? await deliverViaResend({ to, subject, body })
        : await deliverViaSmtp({ to, subject, body });
  } else if (mode === "console") {
    if (process.env.NODE_ENV === "production") {
      // Hard guard: the development mock must NEVER be used in production, even
      // if an operator set OTP_DELIVERY=console. This is what stops the API
      // reporting a delivered OTP when nothing was sent.
      result = {
        delivered: false,
        status: "failed",
        provider: "console",
        error:
          `Mock email delivery is disabled in production. Set OTP_DELIVERY=smtp and either ` +
          `${RESEND_REQUIRED_ENV.join(", ")} (HTTPS - required on Render Free, where SMTP is blocked) ` +
          `or ${SMTP_REQUIRED_ENV.join(", ")}.`,
      };
    } else {
      result = deliverViaConsole({ to, subject, body, kind });
    }
  } else if (mode === "unsupported") {
    result = {
      delivered: false,
      status: "failed",
      provider: String(process.env.OTP_DELIVERY || ""),
      error: `OTP_DELIVERY="${process.env.OTP_DELIVERY}" is not supported. Use "smtp" (or "resend"), or "console".`,
    };
  } else {
    // Production with nothing configured: fail safely instead of mocking.
    result = {
      delivered: false,
      status: "failed",
      provider: "unconfigured",
      error:
        `Email delivery is not configured. Set OTP_DELIVERY=smtp and either ` +
        `${RESEND_REQUIRED_ENV.join(", ")} (HTTPS - required on Render Free, where SMTP is blocked) ` +
        `or ${SMTP_REQUIRED_ENV.join(", ")}.`,
    };
  }

  // A failed delivery is logged with the mode and a REDACTED reason so the
  // incident is diagnosable from the server logs (the API response also carries
  // `reason`, which is what makes a production failure actionable).
  if (!result.delivered) {
    logDeliveryFailure(mode, result.error);
  }

  // Never echo the secret back to the client in production.
  if (result.delivered && devCode && exposeDevCode()) {
    return { ...result, devCode };
  }

  return result;
}

/** Sends the invoice / plan confirmation email (Internship Feature 1).
 * Phase 3 extends the confirmation with the fields the assignment requires:
 * payment/reference id, tweet quota (or "unlimited" for Gold) and plan
 * details, all supplied by the caller from plans.js + the verified payment.
 * Optional fields keep older callers working unchanged. No passwords, OTPs,
 * tokens or other sensitive data may ever be passed in or printed here. */
export function sendInvoiceEmail({ to, invoiceNumber, planName, amount, date, providerRef, tweetQuota }) {
  const quotaLine =
    tweetQuota === undefined || tweetQuota === null
      ? []
      : [`Tweet quota       : ${tweetQuota} tweets per month`, ``];
  const refLine = providerRef ? [`Payment reference : ${providerRef}`, ``] : [];
  return sendMail({
    kind: "invoice",
    to,
    subject: `Your Twiller invoice ${invoiceNumber}`,
    body: [
      `Hello,`,
      ``,
      `Your Twiller subscription payment was successful.`,
      ``,
      `Invoice number : ${invoiceNumber}`,
      `Plan            : ${planName}`,
      `Amount          : INR ${amount}`,
      `Date            : ${date}`,
      ``,
      ...refLine,
      ...quotaLine,
      `You can continue using your plan until the end of the billing period.`,
      ``,
      `- Twiller`,
    ].join("\n"),
  });
}

/** Non-secret snapshot of the mail configuration (safe to log / show in a UI). */
export const mailerConfig = {
  get mode() {
    return resolveMailMode();
  },
  get provider() {
    return resolveMailMode() === "smtp" ? resolveMailProvider() : "console";
  },
  get from() {
    return mailFrom();
  },
  get missingEnv() {
    return resolveMailMode() === "smtp" ? missingMailEnv() : [];
  },
  get exposesDevCode() {
    return exposeDevCode();
  },
};

export default {
  sendMail,
  sendInvoiceEmail,
  exposeDevCode,
  mailerConfig,
  resolveMailMode,
  resolveMailProvider,
  missingSmtpEnv,
  missingResendEnv,
  missingMailEnv,
  smtpTransportOptions,
  redact,
};
