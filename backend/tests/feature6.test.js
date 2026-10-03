/**
 * Feature 6 - Forgot Password : backend test suite
 *
 * HOW TO RUN
 *   cd backend
 *   node tests/feature6.test.js
 *
 * NOTE: start a FRESH backend first (`node index.js`). The per-IP rate limiter
 * is kept in memory, so a stale process would change the expected result of
 * the last test.
 *
 * Exits 0 when everything passes, 1 on any failure.
 * Uses Node's built-in fetch - no test framework dependency is added.
 */

import "dotenv/config";
import mongoose from "mongoose";
import PasswordReset from "../models/passwordreset.js";

const BASE = process.env.BASE_URL || "http://localhost:5000";
const MONGO_URL = process.env.MONOGDB_URL || process.env.MONGODB_URL;

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, body: json };
}

const stamp = Date.now();
const emailA = `fp.a.${stamp}@twiller.test`;
const emailB = `fp.b.${stamp}@twiller.test`;
const phoneB = `9198${String(stamp).slice(-7)}`;

async function register(username, email, phone) {
  return api("/register", {
    method: "POST",
    body: { username, displayName: username, avatar: "https://example.com/a.png", email, phone },
  });
}

async function main() {
  console.log(`\nTwiller 2.0 - Feature 6 (Forgot Password) test suite`);
  console.log(`Target: ${BASE}\n`);

  // One shared database connection for the whole suite.
  if (MONGO_URL) {
    await mongoose.connect(MONGO_URL);
  }

  console.log("[setup] creating test accounts");
  const reg = await register(`fp_a_${stamp}`, emailA, `+91 90000 ${String(stamp).slice(-5)}`);
  check("register stores a normalised (digits only) phone", /^\d+$/.test(reg.body?.phone || ""), JSON.stringify(reg.body));
  await register(`fp_b_${stamp}`, emailB, phoneB);

  console.log("\n[1] EMAIL channel - request recovery");
  const r1 = await api("/auth/forgot-password/request", { method: "POST", body: { identifier: emailA } });
  check("first request succeeds (200)", r1.status === 200, `got ${r1.status}`);
  check("channel is 'email'", r1.body?.channel === "email");
  check("a user-facing message is returned", Boolean(r1.body?.message));

  console.log("\n[2] DAILY LIMIT - second request on the same IST day");
  const r2 = await api("/auth/forgot-password/request", { method: "POST", body: { identifier: emailA } });
  check("second request is blocked (429)", r2.status === 429, `got ${r2.status}`);
  check("dailyLimitReached flag is set", r2.body?.dailyLimitReached === true);
  check("warning message is returned", /already requested/i.test(r2.body?.error || ""));
  check("nextAllowedAt is provided", Boolean(r2.body?.nextAllowedAt));

  console.log("\n[3] SECURITY - unknown account must not leak existence");
  const r3 = await api("/auth/forgot-password/request", { method: "POST", body: { identifier: `ghost.${stamp}@nowhere.test` } });
  check("unknown identifier returns 200 (not 404)", r3.status === 200, `got ${r3.status}`);
  check("response uses generic wording", /if that account exists/i.test(r3.body?.message || ""));

  console.log("\n[4] PHONE channel - request OTP");
  const r4 = await api("/auth/forgot-password/request", { method: "POST", body: { identifier: `+91 ${phoneB.slice(2)}` } });
  check("phone request succeeds (200)", r4.status === 200, `got ${r4.status}`);


  check("channel is 'phone'", r4.body?.channel === "phone");
  const otp = r4.body?.devCode;
  check("devCode is returned in NON-production mode", /^\d{6}$/.test(otp || ""), `devCode=${otp}`);

  console.log("\n[5] OTP - wrong code is rejected");
  const badOtp = otp === "000000" ? "111111" : "000000";
  const r5 = await api("/auth/forgot-password/verify-otp", { method: "POST", body: { identifier: phoneB, otp: badOtp } });
  check("wrong OTP is rejected (401)", r5.status === 401, `got ${r5.status}`);
  check("remaining attempts are reported", /attempt/i.test(r5.body?.error || ""));

  console.log("\n[6] OTP - correct code issues a recovery token");
  const r6 = await api("/auth/forgot-password/verify-otp", { method: "POST", body: { identifier: phoneB, otp } });
  check("correct OTP is accepted (200)", r6.status === 200, `got ${r6.status}`);
  const recoveryToken = r6.body?.recoveryToken;
  check("a recovery token is issued", typeof recoveryToken === "string" && recoveryToken.length >= 32);
  console.log("\n[7] PASSWORD POLICY - letters only, no digits or symbols");
  const policyCases = [
    ["lowercase-only is rejected", "alllowercase", false],
    ["digits are rejected", "Pass1234", false],
    ["symbols are rejected", "Pass@word", false],
    ["mixed-case letters are accepted", "TwillerLettersOnly", true],
  ];
  for (const [label, value, expectValid] of policyCases) {
    const res = await api("/auth/forgot-password/validate-password", { method: "POST", body: { password: value } });
    check(label, res.body?.valid === expectValid, `got valid=${res.body?.valid} for "${value}"`);
  }

  const newPassword = "TwillerLettersOnly";

  console.log("\n[8] COMPLETE - weak password is refused by the SERVER");
  const r8 = await api("/auth/forgot-password/complete", { method: "POST", body: { identifier: phoneB, password: "Pass1234", recoveryToken } });
  check("password containing digits is rejected (400)", r8.status === 400, `got ${r8.status}`);
  check("policy tag returned", r8.body?.policy === "letters-only");

  console.log("\n[9] COMPLETE - invalid recovery token is refused");
  const r9 = await api("/auth/forgot-password/complete", { method: "POST", body: { identifier: phoneB, password: newPassword, recoveryToken: "f".repeat(64) } });
  check("bad recovery token is rejected (401)", r9.status === 401, `got ${r9.status}`);

  console.log("\n[10] COMPLETE - valid letters-only password succeeds");
  const r10 = await api("/auth/forgot-password/complete", { method: "POST", body: { identifier: phoneB, password: newPassword, recoveryToken } });
  check("reset is recorded (200)", r10.status === 200, `got ${r10.status} ${JSON.stringify(r10.body)}`);
  check("IST timestamp is returned", /IST/.test(r10.body?.istTime || ""));

  console.log("\n[11] REPLAY - a completed request cannot be reused");
  const r11 = await api("/auth/forgot-password/complete", { method: "POST", body: { identifier: phoneB, password: newPassword, recoveryToken } });
  check("replay is blocked (409)", r11.status === 409, `got ${r11.status}`);

  console.log("\n[12] STORAGE - no plaintext password or OTP in MongoDB");
  if (MONGO_URL) {
    const record = await PasswordReset.findOne({ identifier: phoneB }).sort({ requestedAt: -1 });
    check("OTP hash destroyed after verification", record?.otpHash === null);
    check("recovery token hash destroyed after completion", record?.recoveryTokenHash === null);
    check("status is 'completed'", record?.status === "completed");
    check("a salted password FINGERPRINT is stored", typeof record?.appliedPasswordHash === "string" && record.appliedPasswordHash.length === 64);
    const serialised = JSON.stringify(record);
    check("plaintext password is NOT stored", !serialised.includes(newPassword));
    check("plaintext OTP is NOT stored", !serialised.includes(otp));
  } else {
    console.log("  SKIP  no MONOGDB_URL - storage assertions skipped");
  }

  console.log("\n[13] EXPIRY - an expired OTP is refused by the server");
  if (MONGO_URL) {
    const phoneD = `9197${String(stamp).slice(-7)}`;
    await register(`fp_d_${stamp}`, `fp.d.${stamp}@twiller.test`, phoneD);
    await api("/auth/forgot-password/request", { method: "POST", body: { identifier: phoneD } });

    await PasswordReset.updateOne({ identifier: phoneD }, { $set: { otpExpiresAt: new Date(Date.now() - 60 * 1000) } });

    const r13 = await api("/auth/forgot-password/verify-otp", { method: "POST", body: { identifier: phoneD, otp: "123456" } });
    check("expired OTP is rejected (410)", r13.status === 410, `got ${r13.status}`);
    check("expiry message is clear", /expired/i.test(r13.body?.error || ""));
  }

  console.log("\n[14] HISTORY - audit trail is readable and leak-free");
  const r14 = await api(`/auth/forgot-password/history?email=${encodeURIComponent(emailA)}`);
  check("history returns records (200)", r14.status === 200, `got ${r14.status}`);
  check("history exposes no secrets", Array.isArray(r14.body) && r14.body.every((x) => !("otpHash" in x) && !("recoveryTokenHash" in x) && !("appliedPasswordHash" in x)));

  console.log("\n[15] RATE LIMIT - per-IP anti-abuse on the request endpoint");
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await api("/auth/forgot-password/request", { method: "POST", body: { identifier: `rl.${stamp}.${i}@twiller.test` } });
    if (res.status === 429 && /too many recovery attempts/i.test(res.body?.error || "")) {
      limited = true;
      break;
    }
  }
  check("per-IP rate limiter returns 429", limited, "never rate limited");

  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log("==================================================\n");
  if (MONGO_URL) await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Test suite crashed:", error);
  process.exit(1);
});
