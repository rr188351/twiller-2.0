/**
 * THROWAWAY SMTP EGRESS PROBE - Twiller 2.0 (Vercel only, branch test/serverless-probe)
 * =====================================================================================
 * ANSWERS ONE QUESTION: can a Vercel Function open an outbound TCP connection to
 * smtp.gmail.com on ports 465 / 587, and (optionally) complete an SMTP handshake?
 *
 * WHY THIS EXISTS
 *   Render's Free plan blocks outbound SMTP (25/465/587), which is why the
 *   Language/Audio OTP and invoice emails never leave the backend:
 *     [mailer] SMTP delivery TIMEOUT (host=smtp.gmail.com, port=465 ...): Connection timeout
 *   Neither Vercel's nor Netlify's docs document SMTP egress, so it can only be
 *   settled empirically - from inside a deployed function. This is that test.
 *
 * HARD GUARANTEES (do not weaken)
 *   - NEVER sends an email. Only net.connect() and nodemailer verify() (a
 *     handshake + AUTH check). sendMail is never imported or called.
 *   - NO MongoDB, NO Firebase, NO app imports. Fully standalone.
 *   - No secret is ever returned or logged: only error CODES/messages, redacted.
 *   - Fails closed: without PROBE_KEY configured, every request is a 404.
 *
 * DELETE AFTER TESTING (see README.md in this folder).
 */

import net from "node:net";
import crypto from "node:crypto";

const HOST = "smtp.gmail.com";
const PORTS = [465, 587];
const TCP_TIMEOUT_MS = 8000;
const SMTP_TIMEOUT_MS = 8000;

/** Strip anything password/token-shaped from a message before it leaves here. */
function redact(value) {
  return String(value ?? "")
    .replace(/(pass(word)?|token|secret|api[-_]?key)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/[A-Za-z0-9/+=]{40,}/g, "<redacted>");
}

/** Constant-time key comparison. */
function keyMatches(provided) {
  const expected = process.env.PROBE_KEY || "";
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
      resolve({ port, connected, ms: Date.now() - started, error: error || null });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (err) => finish(false, err?.code || err?.name || "ERROR"));
  });
}

/** Optional: full SMTP handshake + AUTH. Sends NOTHING. */
async function smtpVerify(port) {
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  if (!user || !pass) {
    return { attempted: false, reason: "skipped: SMTP_USER/SMTP_PASS not configured (TCP-only mode)" };
  }

  const started = Date.now();
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: HOST,
      port,
      secure: port === 465,
      auth: { user, pass },
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
    return { port, attempted: true, ok: true, ms: Date.now() - started };
  } catch (err) {
    return {
      port,
      attempted: true,
      ok: false,
      ms: Date.now() - started,
      code: err?.code || err?.name || "ERROR",
      responseCode: err?.responseCode || null,
      message: redact(err?.message || "unknown error"),
    };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Fail closed: 404 (not 401) so the endpoint is indistinguishable from absent.
  const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
  const provided = req.headers["x-probe-key"] || url.searchParams.get("key");
  if (!keyMatches(provided)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const startedAll = Date.now();
  const ports = [];
  for (const port of PORTS) {
    ports.push(await tcpProbe(HOST, port, TCP_TIMEOUT_MS));
  }

  const reachable = ports.filter((p) => p.connected).map((p) => p.port);
  const verify =
    reachable.length > 0 ? await smtpVerify(reachable[0]) : { attempted: false, reason: "skipped: no port reachable" };

  let verdict;
  if (reachable.length === 0) {
    verdict =
      "SMTP EGRESS BLOCKED - neither 465 nor 587 accepted a TCP connection. Do NOT migrate: email cannot work here either.";
  } else if (!verify.attempted) {
    verdict = `PORT OPEN (${reachable.join(", ")}) - handshake not tested (no SMTP credentials supplied).`;
  } else if (verify.ok) {
    verdict = `SMTP EGRESS WORKS on port ${verify.port} and credentials were ACCEPTED. Migration is worth pursuing.`;
  } else {
    verdict = `PORT OPEN (${reachable.join(", ")}) but the SMTP handshake/AUTH failed (${verify.code}). Egress works; credentials or provider policy do not.`;
  }

  res.status(200).json({
    ok: true,
    sentRealEmail: false, // proof of intent: this probe never sends mail
    host: HOST,
    portsTested: PORTS,
    ports,
    reachablePorts: reachable,
    verify,
    verdict,
    runtime: {
      platform: process.env.VERCEL ? "vercel" : "unknown",
      region: process.env.VERCEL_REGION || null,
      env: process.env.VERCEL_ENV || null,
      node: process.version,
      serverless: Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
      tcpTimeoutMs: TCP_TIMEOUT_MS,
    },
    elapsedMs: Date.now() - startedAll,
  });
}
