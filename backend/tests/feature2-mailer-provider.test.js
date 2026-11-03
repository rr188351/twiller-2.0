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

import { sendMail, resolveMailMode, missingSmtpEnv, SMTP_REQUIRED_ENV } from "../utils/mailer.js";
// Shared stub: the configured path runs against a local SMTP server, so no
// real mail and no credentials are involved (see tests/helpers/smtpStub.js).
import { startSmtpStub, closedPort } from "./helpers/smtpStub.js";

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
  return { ...cleared, SMTP_PORT: undefined, ...extra };
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
