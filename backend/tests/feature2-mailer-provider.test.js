/**
 * Feature 2 - email provider / OTP mail delivery tests.
 *
 * Run:  node tests/feature2-mailer-provider.test.js
 *
 * WHAT IT PROVES
 *  - The mail transport is selected by OTP_DELIVERY and resolved at CALL time.
 *  - Production NEVER falls back to the console mock: an unconfigured mailer
 *    answers delivered:false with an accurate, secret-free error instead of a
 *    fake success (this is what made "the email OTP never arrived" look like it
 *    had worked).
 *  - A real provider ACCEPTANCE is reported as "sent"; a rejection, a missing
 *    configuration or a transport error as "failed"; the development console
 *    path as "mock".
 *  - A devCode is attached ONLY outside production.
 *
 * NO REAL EMAIL IS EVER SENT. The configured path is exercised against a local
 * SMTP stub (the same idea as the Twilio HTTP stub in
 * feature2-sms-provider.test.js), so no credentials and no network are needed.
 *
 * Exits 0 when everything passes, 1 on any failure. No framework added.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sendMail,
  resolveMailMode,
  resolveMailProvider,
  missingSmtpEnv,
  missingBrevoEnv,
  missingMailEnv,
  senderFromMailFrom,
  SMTP_REQUIRED_ENV,
  BREVO_REQUIRED_ENV,
  smtpTransportOptions,
  redact,
  checkEmailDelivery,
} from "../utils/mailer.js";
// Shared stub: the configured path runs against a local SMTP server, so no
// real mail and no credentials are involved (see tests/helpers/smtpStub.js).
import { startSmtpStub, closedPort, startSilentServer } from "./helpers/smtpStub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(here, "..");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** Runs `fn` with a temporary environment, always restoring the original. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every email-transport variable cleared, so each section stays deterministic. */
function noSmtpEnv(extra = {}) {
  const cleared = Object.fromEntries(
    [...SMTP_REQUIRED_ENV, ...BREVO_REQUIRED_ENV].map((k) => [k, undefined])
  );
  return {
    ...cleared,
    SMTP_PORT: undefined,
    MAIL_PROVIDER: undefined,
    BREVO_API_URL: undefined,
    BREVO_TIMEOUT_MS: undefined,
    ...extra,
  };
}

/** Tiny HTTP stub standing in for the Brevo REST API. */
function startHttpStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            try {
              server.closeAllConnections?.();
            } catch {
              /* older node */
            }
            server.close(() => r());
          }),
      });
    });
  });
}

// The SMTP stub + closedPort helper live in tests/helpers/smtpStub.js so this
// suite and feature4-language-otp.test.js share exactly one implementation.

async function main() {
  console.log("\nTwiller 2.0 - Feature 2: email provider / OTP mail delivery");

  /* ---------------------------------------------------------------- */
  console.log("\n[1] Transport selection (OTP_DELIVERY)");
  await withEnv({ OTP_DELIVERY: undefined, NODE_ENV: "development" }, async () => {
    check("nothing configured in development -> console", resolveMailMode() === "console");
  });
  await withEnv({ OTP_DELIVERY: undefined, NODE_ENV: "production" }, async () => {
    check("nothing configured in production -> unconfigured (fail closed)", resolveMailMode() === "unconfigured");
  });
  await withEnv({ OTP_DELIVERY: "smtp", NODE_ENV: "development" }, async () => {
    check("OTP_DELIVERY=smtp -> smtp (dev)", resolveMailMode() === "smtp");
  });
  await withEnv({ OTP_DELIVERY: "SMTP", NODE_ENV: "production" }, async () => {
    check("OTP_DELIVERY is case-insensitive -> smtp", resolveMailMode() === "smtp");
  });
  await withEnv({ OTP_DELIVERY: "mock", NODE_ENV: "development" }, async () => {
    check("OTP_DELIVERY=mock is an accepted alias for console", resolveMailMode() === "console");
  });
  await withEnv({ OTP_DELIVERY: "carrier-pigeon", NODE_ENV: "development" }, async () => {
    check("unknown provider name -> unsupported", resolveMailMode() === "unsupported");
  });

  /* ---------------------------------------------------------------- */
  console.log("\n[2] Unconfigured or failed delivery never reports success");
  await withEnv(noSmtpEnv({ OTP_DELIVERY: undefined, NODE_ENV: "production" }), async () => {
    const r = await sendMail({ to: "u@twiller.test", subject: "s", body: "code 123456", devCode: "123456" });
    check('PRODUCTION, nothing configured -> "failed"', r.delivered === false && r.status === "failed", JSON.stringify(r));
    check('provider reported as "unconfigured"', r.provider === "unconfigured", JSON.stringify(r));
    check("error names the SMTP variables (names only)", SMTP_REQUIRED_ENV.every((k) => r.error.includes(k)), r.error);
    check("no devCode leaked", !("devCode" in r), JSON.stringify(r));
  });
  await withEnv(noSmtpEnv({ OTP_DELIVERY: "console", NODE_ENV: "production" }), async () => {
    const r = await sendMail({ to: "u@twiller.test", subject: "s", body: "code 123456", devCode: "123456" });
    check('PRODUCTION + console -> "failed" (mock rejected)', r.delivered === false && r.status === "failed", JSON.stringify(r));
    check("error tells the operator to set OTP_DELIVERY=smtp", r.error.includes("OTP_DELIVERY=smtp"), r.error);
    check("no devCode leaked", !("devCode" in r));
  });
  await withEnv(noSmtpEnv({ OTP_DELIVERY: "smtp", NODE_ENV: "production" }), async () => {
    const r = await sendMail({ to: "u@twiller.test", subject: "s", body: "code 123456" });
    check('PRODUCTION + smtp with missing SMTP_* -> "failed"', r.delivered === false && r.status === "failed", JSON.stringify(r));
    check("provider is smtp and the error names what is missing", r.provider === "smtp" && r.error.includes("SMTP_HOST"), r.error);
    check("missingSmtpEnv() lists every required name", missingSmtpEnv().length === SMTP_REQUIRED_ENV.length);
  });
  await withEnv(noSmtpEnv({ OTP_DELIVERY: "carrier-pigeon", NODE_ENV: "development" }), async () => {
    const r = await sendMail({ to: "u@twiller.test", subject: "s", body: "x" });
    check('unsupported OTP_DELIVERY -> "failed"', r.delivered === false && r.status === "failed", JSON.stringify(r));
  });

  /* ---------------------------------------------------------------- */
  console.log("\n[3] Development console mock");
  await withEnv(noSmtpEnv({ OTP_DELIVERY: "console", NODE_ENV: "development", MOCK_MAIL_OUTAGE: "false" }), async () => {
    const r = await sendMail({ to: "u@twiller.test", subject: "s", body: "Your code is 123456", devCode: "123456" });
    check('dev console -> delivered true, status "mock"', r.delivered === true && r.status === "mock", JSON.stringify(r));
    check("dev console attaches the devCode outside production", r.devCode === "123456", JSON.stringify(r));
  });
  await withEnv(noSmtpEnv({ OTP_DELIVERY: "console", NODE_ENV: "development", MOCK_MAIL_OUTAGE: "true" }), async () => {
    const r = await sendMail({ to: "u@twiller.test", subject: "s", body: "x", devCode: "123456" });
    check("simulated outage -> delivered false (5xx path)", r.delivered === false && r.status === "failed", JSON.stringify(r));
  });

  /* ---------------------------------------------------------------- */
  console.log("\n[4] Configured SMTP (local stub - no real mail leaves the process)");
  const stub = await startSmtpStub();
  await withEnv(
    {
      OTP_DELIVERY: "smtp",
      NODE_ENV: "production",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(stub.port),
      SMTP_SECURE: "false",
      SMTP_USER: "stub-user",
      SMTP_PASS: "stub-pass",
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    },
    async () => {
      const r = await sendMail({
        to: "user@twiller.test",
        subject: "Your code",
        body: "OTP-CODE-123456",
        devCode: "123456",
      });
      check('smtp acceptance -> delivered true, status "sent"', r.delivered === true && r.status === "sent", JSON.stringify(r));
      check('provider is "smtp"', r.provider === "smtp", JSON.stringify(r));
      check("PRODUCTION never echoes the devCode", !("devCode" in r), JSON.stringify(r));
      check(
        "the stub actually received the message body",
        stub.state.messages.length === 1 && stub.state.messages[0].includes("OTP-CODE-123456"),
        JSON.stringify(stub.state.messages).slice(0, 200)
      );
      check("credentials were used for AUTH", stub.state.authAttempts >= 1);
    }
  );
  await stub.close();

  /* ---------------------------------------------------------------- */
  console.log("\n[5] Provider failure is reported, never masked");
  const dead = await closedPort();
  await withEnv(
    {
      OTP_DELIVERY: "smtp",
      NODE_ENV: "production",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(dead),
      SMTP_SECURE: "false",
      SMTP_USER: "stub-user",
      SMTP_PASS: "stub-pass",
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    },
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "OTP-CODE-999999", devCode: "999999" });
      check("unreachable SMTP -> delivered false / failed", r.delivered === false && r.status === "failed", JSON.stringify(r));
      check(
        "error is generic (no credentials, no OTP)",
        !JSON.stringify(r).includes("OTP-CODE-999999") && !String(r.error).includes("stub-pass"),
        r.error
      );
    }
  );

  /* ---------------------------------------------------------------- */
  console.log("\n[6] The SMS/Twilio provider is gone from the backend");
  const FORBIDDEN = [
    "sendSms",
    "resolveSmsMode",
    "SMS_DELIVERY",
    "SMS_ACCOUNT_SID",
    "SMS_AUTH_TOKEN",
    "SMS_FROM",
    "SMS_DEFAULT_COUNTRY_CODE",
    "twilio",
    "Twilio",
  ];
  // Skip editor/backup leftovers (e.g. "index - Copy.js") - they are untracked
  // scratch files, not part of the backend module graph.
  const BACKUP = /( - Copy|\.bak|\.orig|\.original|\.new|\.tmp|\.clean)/i;
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === "tests") return [];
      if (BACKUP.test(entry.name)) return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return full.endsWith(".js") || full.endsWith(".mjs") ? [full] : [];
    });
  const offenders = [];
  for (const file of walk(BACKEND_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    for (const needle of FORBIDDEN) {
      if (src.includes(needle)) offenders.push(`${path.relative(BACKEND_ROOT, file)} -> ${needle}`);
    }
  }
  check("no SMS/Twilio reference anywhere in backend source", offenders.length === 0, offenders.join(", "));
  check("backend/utils/sms.js has been deleted", !fs.existsSync(path.join(BACKEND_ROOT, "utils", "sms.js")));

  /* ---------------------------------------------------------------- */
  console.log("\n[7] SMTP transport options stay self-consistent");
  await withEnv(noSmtpEnv({ SMTP_SECURE: undefined }), async () => {
    const o = smtpTransportOptions();
    check(
      "no SMTP_PORT + no SMTP_SECURE -> 587 + STARTTLS (never implicit TLS on 587)",
      o.port === 587 && o.secure === false,
      JSON.stringify({ port: o.port, secure: o.secure })
    );
  });
  await withEnv(noSmtpEnv({ SMTP_SECURE: "true" }), async () => {
    const o = smtpTransportOptions();
    check(
      "SMTP_SECURE=true WITHOUT SMTP_PORT -> 465 + implicit TLS (previously a hard 'not configured' failure)",
      o.port === 465 && o.secure === true,
      JSON.stringify({ port: o.port, secure: o.secure })
    );
  });
  await withEnv(noSmtpEnv({ SMTP_SECURE: "True" }), async () => {
    check("SMTP_SECURE parsing is case-insensitive", smtpTransportOptions().secure === true);
  });
  await withEnv(noSmtpEnv({ SMTP_SECURE: "on" }), async () => {
    check('SMTP_SECURE="on" counts as true', smtpTransportOptions().secure === true);
  });
  await withEnv(noSmtpEnv({ SMTP_PORT: "465", SMTP_SECURE: "false" }), async () => {
    const o = smtpTransportOptions();
    check(
      "an explicit SMTP_PORT always wins over derivation",
      o.port === 465 && o.secure === false,
      JSON.stringify({ port: o.port, secure: o.secure })
    );
  });
  await withEnv(noSmtpEnv({ SMTP_PORT: "587", SMTP_SECURE: undefined }), async () => {
    const o = smtpTransportOptions();
    check("SMTP_PORT=587 with SMTP_SECURE unset -> STARTTLS", o.port === 587 && o.secure === false);
  });
  await withEnv(noSmtpEnv({ SMTP_SECURE: "true" }), async () => {
    check("SMTP_PORT is no longer a required variable", !SMTP_REQUIRED_ENV.includes("SMTP_PORT"));
    check(
      "a secure-only configuration is not reported as missing configuration",
      missingSmtpEnv().length === SMTP_REQUIRED_ENV.length && !missingSmtpEnv().includes("SMTP_PORT")
    );
  });

  /* ---------------------------------------------------------------- */
  console.log("\n[8] Failure logging is redacted and OTP-free");
  {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(" "));
    try {
      await withEnv(noSmtpEnv({ OTP_DELIVERY: "smtp", NODE_ENV: "production" }), async () => {
        await sendMail({
          to: "incident.user@example.com",
          subject: "s",
          body: "Your Twiller verification code is 654321.",
          devCode: "654321",
        });
      });
    } finally {
      console.error = original;
    }
    const joined = lines.join("\n");
    check("a failed delivery is logged with its mode", joined.includes("[mailer] email delivery failed"), joined.slice(0, 200));
    check("the OTP never reaches the log", !joined.includes("654321"));
    check("the recipient address never reaches the log", !joined.includes("incident.user@example.com"));
    check("the log names the MISSING variables instead", joined.includes("SMTP_HOST"), joined.slice(0, 300));
    check("redact() masks addresses and long secrets", !redact("x user@example.com y").includes("user@example.com") && !redact("token abcdefghijklmnopqrstuvwx").includes("abcdefghijklmnopqrstuvwx"));
  }

  /* ---------------------------------------------------------------- */
  console.log("\n[10] SMTP waits are BOUNDED (a blackholed host can no longer hang the request)");
  const transport = smtpTransportOptions();
  check(
    "the transport exposes bounded connect/greeting/socket timeouts",
    transport.connectionTimeout > 0 &&
      transport.greetingTimeout > 0 &&
      transport.socketTimeout > 0 &&
      transport.connectionTimeout <= 30000 &&
      transport.socketTimeout <= 60000,
    JSON.stringify({
      connection: transport.connectionTimeout,
      greeting: transport.greetingTimeout,
      socket: transport.socketTimeout,
    })
  );

  const silent = await startSilentServer();
  const silentEnv = (budgetMs) =>
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(silent.port),
      SMTP_SECURE: "false",
      SMTP_USER: "u",
      SMTP_PASS: "p",
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
      SMTP_CONNECTION_TIMEOUT_MS: String(budgetMs),
      SMTP_GREETING_TIMEOUT_MS: String(budgetMs),
    });

  // (a) REPRODUCE the pre-fix behaviour. The wait equals the configured budget,
  //     so with nodemailer's 120s default the request stayed "pending" for ~2
  //     minutes. Proven here by showing it has NOT settled while the budget is
  //     still open (a rejection handler is attached so nothing goes unhandled).
  await withEnv(silentEnv(5000), async () => {
    let settled = false;
    const pending = sendMail({ to: "u@twiller.test", subject: "s", body: "x" }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    void pending;
    await new Promise((r) => setTimeout(r, 1500));
    check(
      "REPRODUCED: with a long budget the send is still pending (the stuck request)",
      settled === false,
      `settled=${settled}`
    );
  });

  // (b) FIXED: the same unreachable host now fails fast, truthfully and without
  //     leaking the OTP, the address or any credential.
  const silentStarted = Date.now();
  const silentResult = await withEnv(silentEnv(600), async () =>
    sendMail({ to: "u@twiller.test", subject: "s", body: "OTP-CODE-424242", devCode: "424242" })
  );
  const silentMs = Date.now() - silentStarted;
  check(
    "FIXED: the same host fails within a bounded time instead of hanging",
    silentResult.delivered === false && silentMs < 5000,
    `${silentMs}ms ${JSON.stringify(silentResult)}`
  );
  check(
    "the failure is reported as a timeout (actionable, no secrets)",
    /timed out/i.test(String(silentResult.error)) &&
      !String(silentResult.error).includes("OTP-CODE-424242") &&
      !String(silentResult.error).includes("no-reply@twiller.test"),
    silentResult.error
  );
  await silent.close();

  /* ---------------------------------------------------------------- */
  console.log("\n[11] boot-time email-delivery health check (names a blocked egress)");
  await withEnv(noSmtpEnv({ OTP_DELIVERY: "console", NODE_ENV: "production" }), async () => {
    const h = await checkEmailDelivery();
    check("not-configured mode -> not reachable, names the mode", h.reachable === false && String(h.reason).includes("mode=console"), JSON.stringify(h));
  });
  await withEnv(noSmtpEnv({ OTP_DELIVERY: "smtp", NODE_ENV: "production" }), async () => {
    const h = await checkEmailDelivery();
    check("missing SMTP_* -> not reachable, names the variables", h.reachable === false && String(h.reason).includes("SMTP_HOST"), JSON.stringify(h));
  });
  {
    const silentHealth = await startSilentServer();
    const healthStarted = Date.now();
    const h = await withEnv(
      noSmtpEnv({
        OTP_DELIVERY: "smtp",
        NODE_ENV: "production",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(silentHealth.port),
        SMTP_SECURE: "false",
        SMTP_USER: "leak-user",
        SMTP_PASS: "sup3rsecret-pass",
        MAIL_FROM: "Twiller <no-reply@twiller.test>",
        SMTP_CONNECTION_TIMEOUT_MS: "600",
        SMTP_GREETING_TIMEOUT_MS: "600",
      }),
      async () => checkEmailDelivery()
    );
    const healthMs = Date.now() - healthStarted;
    check("blackholed SMTP -> not reachable and flagged as a timeout", h.reachable === false && h.timedOut === true, JSON.stringify(h));
    check("the health check is bounded (it can never hang the boot)", healthMs < 5000, `${healthMs}ms`);
    check(
      "the health check leaks no credential",
      !JSON.stringify(h).includes("leak-user") && !JSON.stringify(h).includes("sup3rsecret-pass"),
      JSON.stringify(h)
    );
    await silentHealth.close();
  }
  {
    const liveStub = await startSmtpStub();
    const h = await withEnv(
      noSmtpEnv({
        OTP_DELIVERY: "smtp",
        NODE_ENV: "production",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(liveStub.port),
        SMTP_SECURE: "false",
        SMTP_USER: "stub-user",
        SMTP_PASS: "stub-pass",
        MAIL_FROM: "Twiller <no-reply@twiller.test>",
      }),
      async () => checkEmailDelivery()
    );
    check("a reachable SMTP host -> reachable true with host+port", h.reachable === true && h.port === liveStub.port, JSON.stringify(h));
    await liveStub.close();
  }

  /* ---------------------------------------------------------------- */
  console.log("\n[12] Brevo HTTPS provider (NO domain needed; works where SMTP is blocked)");
  await withEnv(noSmtpEnv({ BREVO_API_KEY: "xkeysib-test-dummy", MAIL_FROM: "Twiller <no-reply@twiller.test>" }), async () => {
    check("a BREVO_API_KEY switches the transport to brevo", resolveMailProvider() === "brevo");
    check("brevo needs no SMTP_* variable at all", missingMailEnv().length === 0 && missingBrevoEnv().length === 0);
    check("MAIL_FROM is parsed into Brevo's sender object", (() => {
      const s = senderFromMailFrom();
      return s.email === "no-reply@twiller.test" && s.name === "Twiller";
    })());
  });
  await withEnv(noSmtpEnv({ MAIL_PROVIDER: "smtp", BREVO_API_KEY: "xkeysib-test-dummy" }), async () => {
    check("MAIL_PROVIDER=smtp still forces SMTP (local development)", resolveMailProvider() === "smtp");
  });

  const brevoState = {};
  const brevoOk = await startHttpStub((req, res, body) => {
    brevoState.path = req.url;
    brevoState.key = req.headers["api-key"] || "";
    brevoState.body = body;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messageId: "<stub@brevo>" }));
  });
  await withEnv(
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      MAIL_PROVIDER: "brevo",
      NODE_ENV: "production",
      BREVO_API_KEY: "xkeysib-test-dummy",
      BREVO_API_URL: brevoOk.base,
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "Your code", body: "OTP-CODE-123456", devCode: "123456" });
      check('brevo acceptance -> delivered true, status "sent"', r.delivered === true && r.status === "sent", JSON.stringify(r));
      check('provider is "brevo"', r.provider === "brevo", JSON.stringify(r));
      check("PRODUCTION never echoes the devCode", !("devCode" in r), JSON.stringify(r));
      let sent = null;
      try {
        sent = JSON.parse(brevoState.body);
      } catch {
        sent = null;
      }
      check(
        "the provider received sender/to/subject/textContent",
        !!sent &&
          sent.subject === "Your code" &&
          sent.to?.[0]?.email === "user@twiller.test" &&
          String(sent.textContent).includes("OTP-CODE-123456") &&
          sent.sender?.email === "no-reply@twiller.test",
        brevoState.body
      );
      check(
        "the documented endpoint + api-key header are used",
        brevoState.path === "/v3/smtp/email" && /^xkeysib-/.test(brevoState.key),
        `${brevoState.path} auth=${String(brevoState.key).slice(0, 7)}...`
      );
      check("the API key never appears in the body", !String(brevoState.body).includes("xkeysib-test-dummy"));
    }
  );
  await brevoOk.close();

  const brevoBad = await startHttpStub((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "invalid_parameter", message: "Sender is not valid / not verified" }));
  });
  await withEnv(
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      MAIL_PROVIDER: "brevo",
      NODE_ENV: "production",
      BREVO_API_KEY: "xkeysib-test-dummy",
      BREVO_API_URL: brevoBad.base,
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "OTP-CODE-777777", devCode: "777777" });
      check("brevo rejection -> delivered false / failed", r.delivered === false && r.status === "failed", JSON.stringify(r));
      check("the provider's own reason is surfaced (e.g. sender not verified)", String(r.error).includes("not verified"), r.error);
      check(
        "the rejection leaks no OTP and no key",
        !JSON.stringify(r).includes("OTP-CODE-777777") && !JSON.stringify(r).includes("xkeysib-test-dummy")
      );
    }
  );
  await brevoBad.close();

  const brevoHang = await startHttpStub(() => {
    /* deliberately never responds */
  });
  const brevoStarted = Date.now();
  await withEnv(
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      MAIL_PROVIDER: "brevo",
      NODE_ENV: "production",
      BREVO_API_KEY: "xkeysib-test-dummy",
      BREVO_API_URL: brevoHang.base,
      BREVO_TIMEOUT_MS: "400",
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "x" });
      check("a hanging brevo API -> failed with a timeout error", r.delivered === false && /timed out/i.test(String(r.error)), JSON.stringify(r));
      check("no devCode on a timeout", !("devCode" in r));
    }
  );
  check("the brevo budget is enforced (returned well under 5s)", Date.now() - brevoStarted < 5000, `ms=${Date.now() - brevoStarted}`);
  await brevoHang.close();

  await withEnv(
    noSmtpEnv({ OTP_DELIVERY: "smtp", MAIL_PROVIDER: "brevo", NODE_ENV: "production", MAIL_FROM: "Twiller <x@twiller.test>" }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "x" });
      check("brevo without BREVO_API_KEY -> failed, names the variable", r.delivered === false && String(r.error).includes("BREVO_API_KEY"), JSON.stringify(r));
      const h = await checkEmailDelivery();
      check("the boot health check reports brevo unconfigured", h.reachable === false && String(h.reason).includes("BREVO_API_KEY"), JSON.stringify(h));
    }
  );
  // Missing MAIL_FROM: the send fails BEFORE any network call, naming it.
  await withEnv(
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      MAIL_PROVIDER: "brevo",
      NODE_ENV: "production",
      BREVO_API_KEY: "xkeysib-test-dummy",
    }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "x" });
      check("brevo without MAIL_FROM -> failed, names MAIL_FROM", r.delivered === false && String(r.error).includes("MAIL_FROM"), JSON.stringify(r));
      const h = await checkEmailDelivery();
      check("the boot health check names MAIL_FROM too", h.reachable === false && String(h.reason).includes("MAIL_FROM"), JSON.stringify(h));
    }
  );
  // Fully configured: the health check passes WITHOUT any network call (HTTPS is
  // never blocked, unlike SMTP), so it is safe to run on every boot.
  await withEnv(
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      MAIL_PROVIDER: "brevo",
      NODE_ENV: "production",
      BREVO_API_KEY: "xkeysib-test-dummy",
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    }),
    async () => {
      const h = await checkEmailDelivery();
      check("the boot health check reports brevo configured (config-only, no network)", h.reachable === true && h.provider === "brevo", JSON.stringify(h));
    }
  );
  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failed > 0) console.log(`  failures: ${failures.join(" | ")}`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nMAILER PROVIDER SUITE ERROR:", error);
  process.exit(1);
});
