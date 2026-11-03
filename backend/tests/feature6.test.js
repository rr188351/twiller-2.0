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
  // Force the console mailer: OTPs are emailed, and tests must never send real
  // mail or depend on the developer's SMTP credentials.
  const server = await startTestServer({
    fbMock: true,
    env: { OTP_DELIVERY: 'console', MOCK_MAIL_OUTAGE: 'false' },
  });
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
  check('NO backend-issued code is returned (Firebase emails the reset link)', !('devCode' in (r1.body || {})), JSON.stringify(r1.body?.devCode));

  console.log('\\n[2] DAILY LIMIT - second request on the same IST day');
  const r2 = await api('/auth/forgot-password/request', { method: 'POST', body: { identifier: emailA } });
  check('daily limit respected (429)', r2.status === 429, 'got ' + r2.status);

  console.log('\n[3] EMAIL channel uses FIREBASE - the backend issues no code of its own');
  const r3 = await api('/auth/forgot-password/verify-otp', { method: 'POST', body: { identifier: emailA, otp: '123456' } });
  check('no backend-issued OTP can be verified (401)', r3.status === 401, 'got ' + r3.status + ' ' + JSON.stringify(r3.body));
  check('no recovery token is issued', !r3.body?.recoveryToken);
  if (MONGO_URL) {
    const rec = await PasswordReset.findOne({ identifier: emailA }).sort({ requestedAt: -1 });
    check('the audit row for the daily limit exists', Boolean(rec), 'no PasswordReset row');
    check('NO OTP hash/salt is stored (Firebase owns the code)', !rec?.otpHash && !rec?.otpSalt, JSON.stringify({ otpHash: rec?.otpHash, otpSalt: rec?.otpSalt }));
    check('the row carries no verified/recovery state', rec?.status === 'pending' && !rec?.recoveryTokenHash, JSON.stringify({ status: rec?.status }));
  } else {
    console.log('  SKIP  no MONGO_URL - storage assertions skipped');
  }

  console.log('\n[4] the email-only identifier rule is enforced');
  const r4 = await api('/auth/forgot-password/request', { method: 'POST', body: { identifier: '919876543210' } });
  check('a phone identifier is rejected (400 email-required)', r4.status === 400 && r4.body?.code === 'email-required', 'got ' + r4.status + ' ' + JSON.stringify(r4.body));

  console.log('\n[5] an unknown account leaks nothing');
  const r5 = await api('/auth/forgot-password/request', { method: 'POST', body: { identifier: 'ghost.' + stamp + '@twiller.test' } });
  check('unknown account answers the generic 200', r5.status === 200 && r5.body?.ok === true, 'got ' + r5.status + ' ' + JSON.stringify(r5.body));
  check('the generic body claims no channel and no delivery', !('channel' in (r5.body || {})) && !('deliveryStatus' in (r5.body || {})), JSON.stringify(r5.body));

  console.log('\n[6] STORAGE - password recovery stores no secrets');
  if (MONGO_URL) {
    const rec = await PasswordReset.findOne({ identifier: emailA }).sort({ requestedAt: -1 });
    const serialised = JSON.stringify(rec || {});
    check('no plaintext OTP is stored', !/\b\d{6}\b/.test(serialised), serialised.slice(0, 200));
    check('no recovery-token hash is stored', !rec?.recoveryTokenHash, String(rec?.recoveryTokenHash));
    check('no password fingerprint is stored', !rec?.appliedPasswordHash, String(rec?.appliedPasswordHash));
  } else {
    console.log('  SKIP  no MONGO_URL - storage assertions skipped');
  }

  console.log('\n[7] COMPLETE still refuses a request without a verified recovery session');
  const r7 = await api('/auth/forgot-password/complete', { method: 'POST', body: { identifier: emailA, password: 'Pass1234' } });
  check('no recovery token is rejected (401)', r7.status === 401, 'got ' + r7.status);
  const r9 = await api('/auth/forgot-password/complete', { method: 'POST', body: { identifier: emailA, password: 'AlphaBetaGammaReset', recoveryToken: 'f'.repeat(64) } });
  check('a forged recovery token is rejected (401)', r9.status === 401, 'got ' + r9.status);

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

  console.log('\n[16] REGRESSION GUARD - password recovery works with outbound SMTP UNREACHABLE');
  {
    // Reproduces the production condition (SMTP egress blocked/unreachable):
    // password recovery must STILL answer 200 because Firebase sends the link.
    const offline = await startTestServer({
      fbMock: true,
      port: 5096,
      env: {
        OTP_DELIVERY: 'smtp',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '1',
        SMTP_SECURE: 'false',
        MAIL_FROM: 'Twiller <no-reply@twiller.test>',
      },
    });
    const offlineEmail = 'offline.' + stamp + '@twiller.test';
    const offlineTok = 'fp-tok-offline-' + stamp;
    offline.setMap({ [offlineTok]: { uid: 'fp-uid-offline-' + stamp, email: offlineEmail, email_verified: true } });
    const regOffline = await offline.api('/register', {
      method: 'POST',
      token: offlineTok,
      body: { username: 'fp_offline_' + stamp, displayName: 'offline', avatar: 'https://example.com/a.png', email: offlineEmail, phone: '' },
    });
    check('offline fixture registers', regOffline.status === 201, 'got ' + regOffline.status);
    const rOffline = await offline.api('/auth/forgot-password/request', { method: 'POST', body: { identifier: offlineEmail } });
    check('recovery request still returns 200 with SMTP unreachable', rOffline.status === 200, 'got ' + rOffline.status + ' ' + JSON.stringify(rOffline.body));
    check('it reports the email channel', rOffline.body?.channel === 'email', JSON.stringify(rOffline.body));
    check('it claims no delivery status (Firebase sends the link)', !('deliveryStatus' in (rOffline.body || {})) && !('provider' in (rOffline.body || {})), JSON.stringify(rOffline.body));
    await offline.stop();
  }

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
