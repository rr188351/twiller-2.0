/**
 * THROWAWAY SMTP PROBE - Twiller 2.0 (Vercel only, branch test/serverless-probe)
 * ============================================================================
 * Three INDEPENDENTLY REPORTED phases, each clearly separated in the JSON:
 *
 *   1. connectivity   net.connect() to smtp.gmail.com:465 and :587 (TCP only)
 *   2. tls            a raw TLS handshake against 465 - protocol, cipher,
 *                     certificate authorization and the SMTP 220 greeting.
 *                     Evidence that the TLS layer really ran, not just "ok".
 *   3. authentication nodemailer verify() on EVERY reachable port (handshake +
 *                     AUTH; implicit TLS on 465, STARTTLS enforced on 587).
 *                     Sends NOTHING.
 *
 * Optional extra: ONE explicitly requested test message. POST-only and
 * triple-gated (PROBE_SEND_ENABLED=true + the recipient must be listed in
 * PROBE_ALLOWED_RECIPIENTS + confirm must exactly equal to). A GET request, and
 * any POST that is not action=send, can never send mail.
 *
 * WHY THIS EXISTS
 *   Render's Free plan blocks outbound SMTP (25/465/587), which is why the
 *   Language/Audio OTP and invoice emails never leave the backend:
 *     [mailer] SMTP delivery TIMEOUT (host=smtp.gmail.com, port=465 ...): Connection timeout
 *   Vercel's docs do not document SMTP egress, so it had to be measured from
 *   inside a deployed function. That measurement now reports both ports open.
 *
 * HARD GUARANTEES (do not weaken)
 *   - No automatic sending: never at deploy or startup time, never on a plain
 *     probe request. At most ONE message per request, only to an allow-listed
 *     address, only after an explicit confirmation, only when enabled.
 *   - Credentials come only from process.env. They are never returned, logged,
 *     placed in a URL, or committed.
 *   - No stack traces and no raw environment dumps; errors are codes plus
 *     sanitized text, with the configured username stripped too.
 *   - Standalone: no MongoDB, no Firebase, no Twiller application imports.
 *   - Fails closed: without PROBE_KEY every request is a 404.
 *
 * DELETE AFTER TESTING (see README.md in this folder).
 */

import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const HOST = "smtp.gmail.com";
const PORTS = [465, 587];
const TCP_TIMEOUT_MS = 8000;
const TLS_TIMEOUT_MS = 8000;
const SMTP_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 15000;
const HANDLER_BUDGET_MS = 45000;

/** Strip anything secret-shaped, then the configured username, from a message. */
function sanitize(value) {
  let out = String(value ?? "")
    .replace(/(pass(word)?|token|secret|api[-_]?key)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/[A-Za-z0-9/+=]{40,}/g, "<redacted>");
  const user = (process.env.SMTP_USER || "").trim();
  if (user) out = out.split(user).join("<user>");
  return out.slice(0, 300);
}

/** Constant-time key comparison. */
function keyMatches(provided) {
  const expected = process.env.PROBE_KEY || "";
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Exactly one plain address: no display name, no whitespace, no second recipient. */
function isSingleAddress(value) {
  const v = String(value ?? "").trim();
  if (!v || /[,;<>"\s]/.test(v)) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
}

function envFlag(name) {
  return (process.env[name] || "").trim().toLowerCase() === "true";
}

function allowedRecipients() {
  return (process.env.PROBE_ALLOWED_RECIPIENTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function authConfigured() {
  return Boolean((process.env.SMTP_USER || "").trim() && (process.env.SMTP_PASS || "").trim());
}

/** Plain TCP reachability test with a bounded budget. */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (connected, error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve({ port, tcpConnected: connected, ms: Date.now() - started, error: error || null });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (err) => finish(false, err?.code || err?.name || "ERROR"));
  });
}

/**
 * Raw TLS handshake against 465 (implicit TLS). Proves the TLS layer itself
 * works and captures what was negotiated. Reads the SMTP greeting; sends no
 * SMTP commands.
 */
function tlsProbe(port) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let greeting = "";
    let socket;
    let greetingTimer = null;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (greetingTimer) clearTimeout(greetingTimer);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve({
        port,
        ms: Date.now() - started,
        greeting: greeting.replace(/\s+/g, " ").trim().slice(0, 120) || null,
        ...extra,
      });
    };

    try {
      socket = tls.connect({ host: HOST, port, servername: HOST, rejectUnauthorized: true });
    } catch (err) {
      resolve({ port, ms: Date.now() - started, handshakeOk: false, error: err?.code || err?.name || "ERROR" });
      return;
    }

    socket.setTimeout(TLS_TIMEOUT_MS);
    socket.on("data", (buf) => {
      greeting += buf.toString("utf8");
    });
    socket.once("secureConnect", () => {
      // Give the server a moment to send its 220 banner, then report and close.
      greetingTimer = setTimeout(
        () =>
          finish({
            handshakeOk: true,
            authorized: socket.authorized === true,
            protocol: socket.getProtocol() || null,
            cipher: socket.getCipher()?.name || null,
            tlsError: null,
          }),
        400
      );
    });
    socket.once("timeout", () => finish({ handshakeOk: false, error: "ETIMEDOUT" }));
    socket.once("error", (err) => finish({ handshakeOk: false, error: err?.code || err?.name || "ERROR" }));
  });
}

/** SMTP handshake + AUTH via nodemailer verify(). Sends NOTHING. */
async function smtpVerify(port) {
  const tlsMode = port === 465 ? "implicit-tls" : "starttls";
  if (!authConfigured()) {
    return { port, tlsMode, attempted: false, reason: "skipped: SMTP_USER/SMTP_PASS not configured" };
  }

  const started = Date.now();
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: HOST,
      port,
      secure: port === 465,
      // On 587, REFUSE to fall back to plaintext: STARTTLS must be negotiated,
      // otherwise "AUTH ok" would not prove TLS works.
      requireTLS: port === 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
    await transport.verify(); // handshake + AUTH only; never sends a message
    try {
      transport.close();
    } catch {
      /* ignore */
    }
    return { port, tlsMode, attempted: true, ok: true, ms: Date.now() - started };
  } catch (err) {
    return {
      port,
      tlsMode,
      attempted: true,
      ok: false,
      ms: Date.now() - started,
      code: err?.code || err?.name || "ERROR",
      responseCode: err?.responseCode || null,
      message: sanitize(err?.message || "unknown error"),
    };
  }
}

/**
 * Sends exactly ONE message. Reached only through the triple gate in the
 * handler, so an accidental send from a probe request is not possible.
 */
async function sendOne(to, port) {
  const started = Date.now();
  const tlsMode = port === 465 ? "implicit-tls" : "starttls";
  const base = { requested: true, port, tlsMode, ms: 0, sentRealEmail: false };
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: HOST,
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
    const info = await transport.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject: "Twiller SMTP probe - single requested test message",
      text: [
        "This is the ONE test message you explicitly requested from the Twiller SMTP probe.",
        `Sent at: ${new Date().toISOString()}`,
        `Runtime: ${process.env.VERCEL ? "vercel" : "local"} region ${process.env.VERCEL_REGION || "unknown"} on ${process.version}`,
        `Port: ${port} (${tlsMode})`,
        "If you received this, outbound SMTP from this host works end-to-end. Delete the probe afterwards.",
      ].join("\n"),
    });
    try {
      transport.close();
    } catch {
      /* ignore */
    }
    return {
      ...base,
      ms: Date.now() - started,
      sentRealEmail: true,
      accepted: Array.isArray(info?.accepted) ? info.accepted.length : null,
      rejected: Array.isArray(info?.rejected) ? info.rejected.length : null,
      messageId: sanitize(String(info?.messageId || "")) || null,
      response: sanitize(String(info?.response || "")) || null,
      note: "exactly one message was sent",
    };
  } catch (err) {
    return {
      ...base,
      ms: Date.now() - started,
      code: err?.code || err?.name || "ERROR",
      responseCode: err?.responseCode || null,
      message: sanitize(err?.message || "unknown error"),
    };
  }
}

/** Small, capped body reader: works whether or not the platform pre-parsed it. */
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) return null; // never buffer an unbounded body
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** One human-readable line that keeps the three phases distinct. */
function buildVerdict({ reachable, tlsBlock, authentication, send }) {
  const parts = [];
  parts.push(
    reachable.length === 0
      ? "SMTP EGRESS BLOCKED - neither 465 nor 587 accepted a TCP connection."
      : `TCP OPEN on ${reachable.join(", ")}.`
  );
  if (tlsBlock?.handshakeOk === true) parts.push(`TLS handshake OK (${tlsBlock.protocol}, ${tlsBlock.cipher}).`);
  else if (tlsBlock?.handshakeOk === false) parts.push(`TLS handshake FAILED (${tlsBlock.error}).`);

  if (!authentication.configured) parts.push("AUTH not tested: SMTP_USER/SMTP_PASS are not configured.");
  else if (authentication.ok) parts.push(`AUTH ACCEPTED on ${authentication.okPorts.join(", ")}.`);
  else {
    const why =
      authentication.results
        .map((r) => r.code || r.reason)
        .filter(Boolean)
        .join(", ") || "unknown";
    parts.push(`AUTH FAILED (${why}).`);
  }

  if (send?.requested) {
    parts.push(
      send.sentRealEmail
        ? `One test message SENT on port ${send.port} to the allow-listed recipient.`
        : `Send FAILED (${send.code || "unknown"}); nothing was delivered.`
    );
  }
  return parts.join(" ");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const startedAll = Date.now();
  const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);

  // ---- Gate 1: the probe key. Fail closed, 404 (indistinguishable from absent).
  if (!keyMatches(req.headers["x-probe-key"] || url.searchParams.get("key"))) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed", code: "method-not-allowed" });
    return;
  }

  // GET is always read-only. POST exists ONLY for the explicitly confirmed
  // single-message send, so a POST without action=send is refused outright
  // rather than silently downgraded to a probe.
  const rawAction = url.searchParams.get("action");
  const action = rawAction === null ? (req.method === "POST" ? null : "probe") : String(rawAction).trim().toLowerCase();
  if (action === "send" && req.method !== "POST") {
    res.status(400).json({ error: "action=send requires POST.", code: "send-requires-post" });
    return;
  }
  if (action !== "probe" && action !== "send") {
    res.status(400).json({
      error:
        req.method === "POST"
          ? "POST requires an explicit action=send (with confirmation). Use GET for the read-only probe."
          : "Unsupported action. Omit action, or use action=send over POST with an explicit confirmation.",
      code: "unsupported-action",
    });
    return;
  }

  // ---- Phase 1: connectivity (TCP only) --------------------------------
  const ports = [];
  for (const port of PORTS) {
    ports.push(await tcpProbe(HOST, port, TCP_TIMEOUT_MS));
  }
  const reachable = ports.filter((p) => p.tcpConnected).map((p) => p.port);

  // ---- Phase 2: TLS handshake evidence (465 = implicit TLS) -------------
  const tlsBlock = reachable.includes(465)
    ? await tlsProbe(465)
    : { port: 465, skipped: reachable.length ? "465 is not reachable" : "no port reachable" };

  // ---- Phase 3: authentication, once per reachable port ----------------
  const authResults = [];
  for (const port of reachable) {
    if (Date.now() - startedAll > HANDLER_BUDGET_MS) {
      authResults.push({ port, attempted: false, reason: "skipped: handler budget exceeded" });
      continue;
    }
    authResults.push(await smtpVerify(port));
  }
  const okPorts = authResults.filter((r) => r.ok).map((r) => r.port);
  const authentication = {
    configured: authConfigured(),
    attempted: authResults.some((r) => r.attempted),
    ok: okPorts.length > 0,
    okPorts,
    results:
      authResults.length > 0
        ? authResults
        : [{ attempted: false, reason: reachable.length ? "skipped: handler budget exceeded" : "skipped: no port reachable" }],
  };

  // ---- Optional: exactly ONE explicitly requested test message ---------
  // Never reached by a plain probe. Requires ALL of:
  //   action=send (POST) + PROBE_SEND_ENABLED=true + allow-listed recipient
  //   + confirm exactly equal to to.
  let send = { requested: false, sentRealEmail: false, note: "read-only request - no email was sent" };
  if (action === "send") {
    const body = await readBody(req);
    const to = String(body?.to ?? url.searchParams.get("to") ?? "").trim();
    const confirm = String(body?.confirm ?? url.searchParams.get("confirm") ?? "").trim();
    const allow = allowedRecipients();
    const deny = (status, code, error) => {
      res.status(status).json({ ok: false, code, error, send: { requested: true, sentRealEmail: false } });
    };

    if (!envFlag("PROBE_SEND_ENABLED")) {
      return deny(
        403,
        "send-disabled",
        "Email sending is disabled for this probe. Set PROBE_SEND_ENABLED=true in the probe project's environment to enable the single-message test, then redeploy."
      );
    }
    if (allow.length === 0) {
      return deny(
        403,
        "no-allowlist",
        "No allowed recipients are configured. Set PROBE_ALLOWED_RECIPIENTS to a comma-separated list containing your own address."
      );
    }
    if (!isSingleAddress(to)) {
      return deny(400, "invalid-recipient", "to must be exactly one plain email address (no display name, no second recipient).");
    }
    if (!allow.includes(to.toLowerCase())) {
      return deny(403, "recipient-not-allowed", "That recipient is not in PROBE_ALLOWED_RECIPIENTS, so nothing was sent.");
    }
    if (confirm !== to) {
      return deny(400, "confirmation-required", "Confirmation missing: send confirm set to exactly the same value as to.");
    }

    const requestedPort = Number(url.searchParams.get("port") || process.env.PROBE_SEND_PORT || 465);
    send = await sendOne(to, requestedPort === 587 ? 587 : 465);
  }

  res.status(200).json({
    ok: true,
    sentRealEmail: send.sentRealEmail === true,
    host: HOST,
    portsTested: PORTS,
    connectivity: { ports, reachablePorts: reachable },
    tls: tlsBlock,
    authentication,
    send,
    verdict: buildVerdict({ reachable, tlsBlock, authentication, send }),
    runtime: {
      platform: process.env.VERCEL ? "vercel" : "unknown",
      region: process.env.VERCEL_REGION || null,
      env: process.env.VERCEL_ENV || null,
      node: process.version,
      serverless: Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
      tcpTimeoutMs: TCP_TIMEOUT_MS,
      authTimeoutMs: SMTP_TIMEOUT_MS,
      sendTimeoutMs: SEND_TIMEOUT_MS,
      handlerBudgetMs: HANDLER_BUDGET_MS,
    },
    elapsedMs: Date.now() - startedAll,
  });
}
