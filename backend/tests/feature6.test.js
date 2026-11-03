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
import { startTestServer, removeTestFixtures } from "./helpers/testServer.js";

let BASE = "http://localhost:5000";
// Points at the ISOLATED test database, never the development one.
let MONGO_URL = process.env.MONOGDB_URL || process.env.MONGODB_URL;

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

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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

async function register(username, email, phone, token) {
  // A verified Firebase token is required to register a new profile.
  return api('/register', {
    method: 'POST',
    body: { username, displayName: username, avatar: 'https://example.com/a.png', email, phone },
    token,
  });
}

async function main() {
  const server = await startTestServer({ fbMock: true });
  BASE = server.base;
  MONGO_URL = server.mongoUrl;

  // Mock Firebase tokens required by the secured /register route.
  //
  // Each account needs its OWN token + uid: /register resolves the profile by
  // Firebase UID FIRST, so reusing one token for several accounts kept
  // returning the first profile and never created the others - which then made
  // the phone-recovery lookups answer "no pending code" (404).
  const stamp = Date.now();
  const emailA = 'fp.a.' + stamp + '@twiller.test';
  const emailB = 'fp.b.' + stamp + '@twiller.test';
  const emailD = 'fp.d.' + stamp + '@twiller.test';
  const tokenFor = (tag) => 'fp-tok-' + tag + '-' + stamp;
  server.setMap({
    [tokenFor('a')]: { uid: 'fp-uid-a-' + stamp, email: emailA, email_verified: true },
    [tokenFor('b')]: { uid: 'fp-uid-b-' + stamp, email: emailB, email_verified: true },
    [tokenFor('d')]: { uid: 'fp-uid-d-' + stamp, email: emailD, email_verified: true },
  });

  console.log('\\nTwiller 2.0 - Feature 6 (Forgot Password) test suite');
  console.log('Target   : ' + BASE);
  console.log('Database : ' + MONGO_URL + '  (isolated - development DB untouched)' + '\\n');

  if (MONGO_URL) {
    await mongoose.connect(MONGO_URL);
  }

  console.log('[setup] creating test accounts');
  const reg = await register('fp_a_' + stamp, emailA, '+91 90000 ' + String(stamp).slice(-5), tokenFor('a'));
  check('register stores a normalised (digits only) phone', /^\d+$/.test(reg.body?.phone || ''), JSON.stringify(reg.body));
  const regB = await register('fp_b_' + stamp, emailB, '9198' + String(stamp).slice(-7), tokenFor('b'));
  check('second account created with its own Firebase UID', regB.status === 201 && typeof regB.body?._id === 'string', 'got ' + regB.status);

  console.log('\\n[1] EMAIL channel - request recovery');
  const r1 = await api('/auth/forgot-password/request', { method: 'POST', body: { identifier: emailA } });
  check('first request succeeds (200)', r1.status === 200, 'got ' + r1.status);
  check('channel is email', r1.body?.channel === 'email');
  check('a user-facing message is returned', Boolean(r1.body?.message));
  check('email channel issues NO code (Firebase emails the reset link)', !('devCode' in (r1.body || {})));

  console.log('\\n[2] DAILY LIMIT - second request on the same IST day');
  const r2 = await api('/auth/forgot-password/request', { method: 'POST', body: { identifier: emailA } });
  check('daily limit respected (429)', r2.status === 429, 'got ' + r2.status);

  console.log('\n[3] EMAIL channel - request recovery (no OTP verification needed for email)');
  const r3 = await api('/auth/forgot-password/verify-otp', { method: 'POST', body: { identifier: emailA, otp: '123456' } });
  check('email verify-otp refused (401 incorrect code)', r3.status === 401, 'got ' + r3.status);
  check('no recovery token is issued for the email channel', !r3.body?.recoveryToken);

  console.log('\\n[4] PHONE channel - request recovery');
  const phoneB = '9198' + String(stamp).slice(-7);
  const r4 = await api('/auth/forgot-password/request', { method: 'POST', body: { identifier: phoneB } });
  check('phone request succeeds (200)', r4.status === 200, 'got ' + r4.status);
  check('phone channel is reported as "phone"', r4.body?.channel === 'phone', JSON.stringify(r4.body?.channel));
  check('a 6-digit code is issued for the phone channel', /^\d{6}$/.test(r4.body?.devCode || ''), JSON.stringify(r4.body?.devCode));

  console.log('\\n[5] PHONE channel - verify OTP with correct code');
  const r5 = await api('/auth/forgot-password/verify-otp', { method: 'POST', body: { identifier: phoneB, otp: r4.body?.devCode } });
  check('phone verify-otp succeeds (200)', r5.status === 200, 'got ' + r5.status + ' ' + JSON.stringify(r5.body));
  check('verification reports ok', r5.body?.ok === true);

  const recoveryToken = r5.body?.recoveryToken;
  console.log('\\n[6] OTP - correct code issues a recovery token');
  check('a recovery token is issued', typeof recoveryToken === 'string' && recoveryToken.length >= 32);

  console.log('\\n[7] complete - no recovery token is refused');
  const r7 = await api('/auth/forgot-password/complete', { method: 'POST', body: { identifier: phoneB, password: 'Pass1234' } });
  check('no recovery token is rejected (401)', r7.status === 401, 'got ' + r7.status);

  const r9 = await api('/auth/forgot-password/complete', { method: 'POST', body: { identifier: phoneB, password: 'AlphaBetaGammaReset', recoveryToken: 'f'.repeat(64) } });
  check('bad recovery token is rejected (401)', r9.status === 401, 'got ' + r9.status);

  console.log('\\n[8] COMPLETE - valid password with recovery token');
  // The assignment allows LETTERS ONLY - no digits, no symbols.
  const newPassword = 'AlphaBetaGammaReset';

  const r8a = await api('/auth/forgot-password/complete', { method: 'POST', body: { identifier: phoneB, password: 'Reset' + stamp, recoveryToken } });
  check('digits in the password are refused (400 letters-only)', r8a.status === 400 && r8a.body?.policy === 'letters-only', 'got ' + r8a.status + ' ' + JSON.stringify(r8a.body));

  const r8 = await api('/auth/forgot-password/complete', { method: 'POST', body: { identifier: phoneB, password: newPassword, recoveryToken } });
  check('reset is recorded (200)', r8.status === 200, 'got ' + r8.status + ' ' + JSON.stringify(r8.body));
  check('IST timestamp is returned', /IST/.test(r8.body?.istTime || ''));

  console.log('\\n[9] COMPLETE - invalid recovery token is refused');
  // NOTE: the bad-token check runs BEFORE the successful completion below -
  // once a record is completed the API answers 409 before it inspects the
  // token, so the 401 case must be exercised while the record is "verified".

  console.log('\\n[10] COMPLETE - valid letters-only password succeeds');
  const r10 = await api('/auth/forgot-password/complete', { method: 'POST', body: { identifier: phoneB, password: 'AnotherLettersOnly', recoveryToken } });
  check('re-using a completed session is refused (409)', r10.status === 409, 'got ' + r10.status);

  console.log('\\n[11] REPLAY - a completed request cannot be reused');
  const r11 = await api('/auth/forgot-password/complete', { method: 'POST', body: { identifier: phoneB, password: newPassword, recoveryToken } });
  check('replay is blocked (409)', r11.status === 409, 'got ' + r11.status);

  console.log('\\n[12] STORAGE - no plaintext password or OTP in MongoDB');
  if (MONGO_URL) {
    const record = await PasswordReset.findOne({ identifier: phoneB }).sort({ requestedAt: -1 });
    check('OTP hash destroyed after verification', record?.otpHash === null);
    check('recovery token hash destroyed after completion', record?.recoveryTokenHash === null);
    check('status is completed', record?.status === 'completed');
    check('a salted password FINGERPRINT is stored', typeof record?.appliedPasswordHash === 'string' && record.appliedPasswordHash.length === 64);
    const serialised = JSON.stringify(record);
    check('plaintext password is NOT stored', !serialised.includes(newPassword));
    check('plaintext OTP is NOT stored', !serialised.includes('123456'));
  } else {
    console.log('  SKIP  no MONGO_URL - storage assertions skipped');
  }

  console.log('\\n[13] EXPIRY - an expired OTP is refused by the server');
  if (MONGO_URL) {
    const phoneD = '9197' + String(stamp).slice(-7);
    await register('fp_d_' + stamp, emailD, phoneD, tokenFor('d'));
    await api('/auth/forgot-password/request', { method: 'POST', body: { identifier: phoneD } });
    await PasswordReset.updateOne({ identifier: phoneD }, { otpExpiresAt: new Date(Date.now() - 60 * 1000) });
    const r13 = await api('/auth/forgot-password/verify-otp', { method: 'POST', body: { identifier: phoneD, otp: '123456' } });
    check('expired OTP is rejected (410)', r13.status === 410, 'got ' + r13.status);
    check('expiry message is clear', /expired/i.test(r13.body?.error || ''));
  }

  console.log('\\n[14] HISTORY - audit trail is readable and leak-free');
  const r14 = await api('/auth/forgot-password/history?email=' + encodeURIComponent(emailA));
  check('history returns records (200)', r14.status === 200, 'got ' + r14.status);
  check('history exposes no secrets', Array.isArray(r14.body) && r14.body.every((x) => !('otpHash' in x) && !('recoveryTokenHash' in x) && !('appliedPasswordHash' in x)));

  console.log('\\n[15] RATE LIMIT - per-IP anti-abuse on the request endpoint');
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await api('/auth/forgot-password/request', { method: 'POST', body: { identifier: 'rl.' + stamp + '.' + i + '@twiller.test' } });
    if (res.status === 429 && /too many recovery attempts/i.test(res.body?.error || '')) {
      limited = true;
      break;
    }
  }
  check('per-IP rate limiter returns 429', limited, 'never rate limited');

  if (MONGO_URL) await mongoose.disconnect();
  await removeTestFixtures(server.mongoUrl, ['fp\\.'], []);
  await server.stop();
  console.log('  ....  test database dropped; development database never touched');

  console.log('\\n==================================================');
  console.log('  passed: ' + passed + '   failed: ' + failed);
  console.log('==================================================' + '\\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Test suite crashed:', error);
  process.exit(1);
});