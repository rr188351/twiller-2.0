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
  missingResendEnv,
  missingMailEnv,
  SMTP_REQUIRED_ENV,
  smtpTransportOptions,
  redact,
} from "../utils/mailer.js";
// Shared stub: the configured path runs against a local SMTP server, so no
// real mail and no credentials are involved (see tests/helpers/smtpStub.js).
import { startSmtpStub, closedPort } from "./helpers/smtpStub.js";

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

/** The SMTP_* variables plus OTP_DELIVERY, all cleared. */
function noSmtpEnv(extra = {}) {
  const cleared = Object.fromEntries(SMTP_REQUIRED_ENV.map((k) => [k, undefined]));
  return {
    ...cleared,
    SMTP_PORT: undefined,
    // Keep the provider deterministic for every section.
    MAIL_PROVIDER: undefined,
    RESEND_API_KEY: undefined,
    RESEND_API_URL: undefined,
    RESEND_TIMEOUT_MS: undefined,
    ...extra,
  };
}

/** Tiny HTTP stub standing in for the Resend REST API. */
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
  console.log("\n[9] Resend HTTPS provider (works where Render blocks SMTP)");
  await withEnv(
    noSmtpEnv({ RESEND_API_KEY: "rk_test_dummy", MAIL_FROM: "Twiller <no-reply@twiller.test>" }),
    async () => {
      check("a RESEND_API_KEY switches the transport to resend", resolveMailProvider() === "resend");
      check(
        "resend needs no SMTP_* variable at all",
        missingResendEnv().length === 0 && missingMailEnv().length === 0
      );
    }
  );
  await withEnv(
    noSmtpEnv({ MAIL_PROVIDER: "smtp", RESEND_API_KEY: "rk_test_dummy" }),
    async () => {
      check("MAIL_PROVIDER=smtp still forces the SMTP transport", resolveMailProvider() === "smtp");
    }
  );

  // --- successful send -------------------------------------------------
  const okState = {};
  const okStub = await startHttpStub((req, res, body) => {
    okState.path = req.url;
    okState.auth = req.headers.authorization || "";
    okState.body = body;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "stub-message-id" }));
  });
  await withEnv(
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      MAIL_PROVIDER: "resend",
      NODE_ENV: "production",
      RESEND_API_KEY: "rk_test_dummy",
      RESEND_API_URL: okStub.base,
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "Your code", body: "OTP-CODE-123456", devCode: "123456" });
      check('resend acceptance -> delivered true, status "sent"', r.delivered === true && r.status === "sent", JSON.stringify(r));
      check('provider is "resend"', r.provider === "resend", JSON.stringify(r));
      check("PRODUCTION never echoes the devCode", !("devCode" in r), JSON.stringify(r));
      let sent = null;
      try {
        sent = JSON.parse(okState.body);
      } catch {
        sent = null;
      }
      check(
        "the provider received from/to/subject/text",
        !!sent && sent.subject === "Your code" && Array.isArray(sent.to) && sent.to[0] === "user@twiller.test" && String(sent.text).includes("OTP-CODE-123456") && String(sent.from).includes("no-reply@twiller.test"),
        okState.body
      );
      check("the API key is sent as a Bearer token, never in the body", /^Bearer\s+\S+$/.test(okState.auth) && !String(okState.body).includes("rk_test_dummy"));
      check("the documented /emails endpoint is used", okState.path === "/emails", okState.path);
    }
  );
  await okStub.close();

  // --- provider rejection ---------------------------------------------
  const badStub = await startHttpStub((req, res) => {
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ statusCode: 422, name: "validation_error", message: "The twiller.test domain is not verified" }));
  });
  await withEnv(
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      MAIL_PROVIDER: "resend",
      NODE_ENV: "production",
      RESEND_API_KEY: "rk_test_dummy",
      RESEND_API_URL: badStub.base,
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "OTP-CODE-777777", devCode: "777777" });
      check("provider rejection -> delivered false / failed", r.delivered === false && r.status === "failed", JSON.stringify(r));
      check("the provider's own reason is surfaced", String(r.error).includes("not verified"), r.error);
      check("the rejection leaks no OTP", !JSON.stringify(r).includes("OTP-CODE-777777"));
    }
  );
  await badStub.close();

  // --- timeout ---------------------------------------------------------
  const hangStub = await startHttpStub(() => {
    /* deliberately never responds */
  });
  const startedAt = Date.now();
  await withEnv(
    noSmtpEnv({
      OTP_DELIVERY: "smtp",
      MAIL_PROVIDER: "resend",
      NODE_ENV: "production",
      RESEND_API_KEY: "rk_test_dummy",
      RESEND_API_URL: hangStub.base,
      RESEND_TIMEOUT_MS: "300",
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "x" });
      check("a hanging provider -> failed with a timeout error", r.delivered === false && /timed out/i.test(String(r.error)), JSON.stringify(r));
      check("no devCode on a timeout", !("devCode" in r));
    }
  );
  check("the request budget is enforced (returned well under 5s)", Date.now() - startedAt < 5000, `ms=${Date.now() - startedAt}`);
  await hangStub.close();

  // --- missing configuration ------------------------------------------
  await withEnv(
    noSmtpEnv({ OTP_DELIVERY: "smtp", MAIL_PROVIDER: "resend", NODE_ENV: "production", MAIL_FROM: "Twiller <x@twiller.test>" }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "x" });
      check('resend without RESEND_API_KEY -> failed, names the variable', r.delivered === false && String(r.error).includes("RESEND_API_KEY"), JSON.stringify(r));
    }
  );
  await withEnv(
    noSmtpEnv({ OTP_DELIVERY: "smtp", MAIL_PROVIDER: "resend", NODE_ENV: "production", RESEND_API_KEY: "rk_test_dummy" }),
    async () => {
      const r = await sendMail({ to: "user@twiller.test", subject: "s", body: "x" });
      check('resend without MAIL_FROM -> failed, names MAIL_FROM', r.delivered === false && String(r.error).includes("MAIL_FROM"), JSON.stringify(r));
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
