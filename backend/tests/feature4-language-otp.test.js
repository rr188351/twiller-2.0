/**
 * Feature 4 Phase 2 Stage B - Language OTP backend tests + security validation.
 *
 * Run:  node tests/feature4-language-otp.test.js
 *
 * ISOLATION
 *  - Dedicated Mongo databases per spawn (`twiller_langotp_*`). The dev
 *    `twiller` database is never touched; each test database is dropped
 *    before AND after its server stops.
 *  - Firebase verification is mocked ONLY inside spawned test backends via a
 *    Node module loader (NODE_OPTIONS=--import tests/helpers/fbMockRegister)
 *    redirecting `import("firebase-admin")` to a mock. Production code is
 *    untouched: no bypass header exists, and without the loader env the
 *    server imports the real SDK exactly as before.
 *
 * Exits 0 when everything passes, 1 on any failure. No framework added.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import mongoose from "mongoose";
// Local SMTP stub so the production email path can be tested end-to-end
// without credentials and without sending real mail.
import { startSmtpStub } from "./helpers/smtpStub.js";

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

function baseMongo() {
  return process.env.MONOGDB_URL || process.env.MONGODB_URL || "mongodb://127.0.0.1:27017/twiller";
}
function dbUrl(name) {
  const url = String(baseMongo()).replace(/\/[^/?]*(\?|$)/, "$1");
  return `${url.replace(/\/$/, "")}/${name}`;
}
async function dropDb(url) {
  await mongoose.connect(url);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
async function waitFor(base, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Dummy but structurally valid service account so firebaseAdmin init succeeds
// and the mock SDK is exercised. Never a real key.
const DUMMY_SA = JSON.stringify({
  type: "service_account",
  project_id: "twiller-bdc11",
  private_key_id: "test",
  private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
  client_email: "test@twiller-test.iam.gserviceaccount.com",
  client_id: "1",
});

let portSeq = 5110;

/**
 * Spawn a backend on its own database. mock=true (default) injects the
 * Firebase mock loader + token-map file; mock=false leaves Firebase
 * unconfigured (fail-closed 503). env adds server env overrides.
 */
async function spawnBackend(name, opts = {}) {
  const useMock = opts.mock !== false;
  const mongoUrl = dbUrl(name);
  await dropDb(mongoUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "langotp-"));
  const mapPath = path.join(dir, "map.json");
  fs.writeFileSync(mapPath, JSON.stringify(opts.map || {}));
  const port = portSeq += 1;
  const env = {
    ...process.env,
    PORT: String(port),
    MONOGDB_URL: mongoUrl,
    MONGODB_URL: mongoUrl,
    NODE_ENV: opts.nodeEnv || "development",
    OTP_DELIVERY: "console",
    MOCK_MAIL_OUTAGE: "false",
    ...(useMock
      ? {
          FIREBASE_SERVICE_ACCOUNT_JSON: DUMMY_SA,
          FIREBASE_PROJECT_ID: "twiller-bdc11",
          MOCK_FIREBASE_MAP_PATH: mapPath,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import ${pathToFileURL(path.join(here, "helpers", "fbMockRegister.mjs")).href}`.trim(),
        }
      : {
          FIREBASE_SERVICE_ACCOUNT_JSON: "",
          FIREBASE_SERVICE_ACCOUNT_PATH: "",
          GOOGLE_APPLICATION_CREDENTIALS: "",
          FIREBASE_PROJECT_ID: "twiller-bdc11",
        }),
    ...(opts.env || {}),
  };
  const child = spawn(process.execPath, ["index.js"], { cwd: BACKEND_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  const base = `http://localhost:${port}`;
  if (!await waitFor(base)) {
    child.kill();
    throw new Error(`backend ${name} did not start. log tail: ${log.slice(-800)}`);
  }
  const api = async (p, { method = "GET", body, token } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${p}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json };
  };
  return {
    base, api,
    setMap: (m) => fs.writeFileSync(mapPath, JSON.stringify(m)),
    dbUrl: mongoUrl,
    log: () => log,
    stop: async () => {
      child.kill();
      await new Promise((r) => setTimeout(r, 400));
      try { await dropDb(mongoUrl); } catch { /* best effort */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    },
  };
}

async function directDb(url, fn) {
  await mongoose.connect(url);
  try {
    return await fn(mongoose.connection.db);
  } finally {
    await mongoose.disconnect();
  }
}

/**
 * Bounded index-readiness gate. The spawned server listens as soon as
 * mongoose.connect() resolves, but Mongoose builds collection indexes in the
 * background - an HTTP 200 from GET / proves the port is up, NOT that the
 * unique partial `user_1_targetLocale_1` gate exists. Firing Section G's
 * concurrent burst before that index exists lets N creates succeed (nothing
 * to violate), which looks exactly like a production single-flight defect.
 * Poll the SAME database the backend uses until the exact index (key +
 * unique + partial filter) is listed, else throw loudly. No sleeps-as-fix:
 * bounded poll, explicit timeout, failure aborts the section.
 */
const EXPECTED_LANGOTP_SINGLE_FLIGHT_INDEX = {
  name: "user_1_targetLocale_1",
  key: { user: 1, targetLocale: 1 },
  unique: true,
  partialFilterExpression: { status: "pending" },
};
async function waitForLangOtpSingleFlightIndex(dbUrl, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "none";
  for (;;) {
    const indexes = await directDb(dbUrl, (db) => db.collection("languageotps").listIndexes().toArray().catch((e) => {
      lastSeen = `list-error:${((e && e.message) || e)}`.slice(0, 80);
      return null;
    }));
    if (indexes) {
      lastSeen = JSON.stringify(indexes.map((i) => i.name));
      const match = indexes.find((i) => i.name === EXPECTED_LANGOTP_SINGLE_FLIGHT_INDEX.name);
      if (
        match
        && match.unique === true
        && JSON.stringify(match.key) === JSON.stringify(EXPECTED_LANGOTP_SINGLE_FLIGHT_INDEX.key)
        && JSON.stringify(match.partialFilterExpression || null) === JSON.stringify(EXPECTED_LANGOTP_SINGLE_FLIGHT_INDEX.partialFilterExpression)
      ) {
        return match.name;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`single-flight unique index ${EXPECTED_LANGOTP_SINGLE_FLIGHT_INDEX.name} not ready within ${timeoutMs}ms. lastIndexes=${lastSeen}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const stamp = String(Date.now()).slice(-8);
let userSeq = 0;
async function makeUser(s, { phone, email, uid } = {}) {
  userSeq += 1;
  const em = email || `langotp.u${userSeq}.${stamp}@twiller.test`;
  const ph = phone !== undefined ? phone : `9198${stamp}${userSeq}`.slice(0, 12);
  // /register is token-protected now: seed the mock map with the identity this
  // fixture will bind, then register WITH that token (same as the real client).
  const bindUid = uid || `uid-u${userSeq}-${stamp}`;
  const regTok = `langotp-reg-${bindUid}`;
  s.setMap({ [regTok]: ident(bindUid, em, true) });
  const r = await s.api("/register", {
    method: "POST",
    token: regTok,
    body: { username: `lo_${stamp}_${userSeq}`, displayName: "lo", avatar: "https://example.com/a.png", email: em, phone: ph },
  });
  return { email: em, phone: ph, status: r.status };
}
const T = (n) => `langotp-tok-${stamp}-${n}`;
function ident(uid, email, verified) {
  const o = { uid };
  if (email !== undefined) o.email = email;
  if (verified !== undefined) o.email_verified = verified;
  return o;
}
const OTP_RE = /^\d{6}$/;


/* ================= A. auth + identity (server sA) ================= */
async function sectionA() {
  console.log("\n[A] authentication and identity");
  const s = await spawnBackend(`twiller_langotp_a_${stamp}`, { map: {} });

  const u = await makeUser(s, { uid: "uid-a" });
  check("A0 fixture user registers", u.status === 201, `status=${u.status}`);
  const tokV = T("a-v");
  s.setMap({ [tokV]: ident("uid-a", u.email, true) });

  let r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "en" } });
  check("A1 missing Bearer -> 401 auth-required", r.status === 401 && r.body && r.body.code === "auth-required", JSON.stringify(r));

  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "en" }, token: T("a-unknown") });
  check("A2 invalid token -> 401 auth-invalid", r.status === 401 && r.body && r.body.code === "auth-invalid", JSON.stringify(r));

  r = await s.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "en", otp: "000000" } });
  check("A3 verify without token -> 401", r.status === 401, `status=${r.status}`);

  const tokNoClaim = T("a-noclaim");
  const tokFalse = T("a-false");
  s.setMap({ [tokV]: ident("uid-a", u.email, true), [tokNoClaim]: ident("uid-a", u.email), [tokFalse]: ident("uid-a", u.email, false) });
  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "fr" }, token: tokNoClaim });
  check("A4 fr + missing email_verified claim -> 403 email-unverified", r.status === 403 && r.body && r.body.code === "email-unverified", JSON.stringify(r));
  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "fr" }, token: tokFalse });
  check("A5 fr + email_verified false -> 403 email-unverified", r.status === 403 && r.body && r.body.code === "email-unverified", JSON.stringify(r));
  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "fr" }, token: tokV });
  check("A6 fr + email_verified true -> 200 email channel", r.status === 200 && r.body && r.body.channel === "email" && OTP_RE.test(r.body.devCode || ""), JSON.stringify(r));

  const tokEvil = T("a-evil");
  s.setMap({ [tokV]: ident("uid-a", u.email, true), [tokEvil]: ident("uid-evil", "evil@twiller.test", true) });
  r = await s.api("/auth/language/otp/request", {
    method: "POST",
    body: { targetLocale: "fr", email: u.email, userId: "anything", phone: u.phone },
    token: tokEvil,
  });
  check("A7 body email/userId cannot impersonate -> 404 no-profile", r.status === 404 && r.body && r.body.code === "no-profile", JSON.stringify(r));

  const tokGhost = T("a-ghost");
  s.setMap({ [tokGhost]: ident("uid-ghost", `ghost.${stamp}@twiller.test`, true) });
  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "en" }, token: tokGhost });
  check("A8 unknown Firebase email -> 404 no-profile", r.status === 404 && r.body && r.body.code === "no-profile", JSON.stringify(r));

  const tokNoMail = T("a-nomail");
  s.setMap({ [tokNoMail]: ident("uid-nomail") });
  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "en" }, token: tokNoMail });
  check("A9 token without email -> 401 auth-no-email", r.status === 401 && r.body && r.body.code === "auth-no-email", JSON.stringify(r));

  const noPhone = await makeUser(s, { phone: "", uid: "uid-nophone" });
  const tokNoPhone = T("a-nophone");
  s.setMap({ [tokNoPhone]: ident("uid-nophone", noPhone.email, true) });
  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "hi" }, token: tokNoPhone });
  check("A10 sms locale + no stored phone -> 422 phone-setup-required", r.status === 422 && r.body && r.body.code === "phone-setup-required", JSON.stringify(r));

  await s.stop();
}

/* ================= B. locale + destination (server sB) ================= */
async function sectionB() {
  console.log("\n[B] locale validation and destination binding");
  const s = await spawnBackend(`twiller_langotp_b_${stamp}`, { map: {} });
  const u = await makeUser(s, { uid: "uid-b" });
  const tok = T("b-main");
  s.setMap({ [tok]: ident("uid-b", u.email, true) });
  // Isolated identity for the case-fold check: B1 leaves a live `en` pending
  // code on tok, so "EN" must run as a different user to avoid resend-cooldown
  // and prove "EN" -> "en" normalisation instead of rejection.
  const uCase = await makeUser(s, { uid: "uid-b-case" });
  const tokCase = T("b-case");
  s.setMap({ [tok]: ident("uid-b", u.email, true), [tokCase]: ident("uid-b-case", uCase.email, true) });

  let r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "en" }, token: tok });
  check("B1 en -> sms + 6-digit devCode", r.status === 200 && r.body && r.body.channel === "sms" && OTP_RE.test(r.body.devCode || ""), JSON.stringify(r));

  for (const loc of ["hi", "es", "pt", "zh"]) {
    r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: loc }, token: tok });
    check(`B2 ${loc} -> sms`, r.status === 200 && r.body && r.body.channel === "sms", JSON.stringify(r));
  }

  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "EN" }, token: tokCase });
  check("B3 uppercase EN normalises to en -> 200 sms", r.status === 200 && r.body && r.body.channel === "sms" && r.body.targetLocale === "en" && OTP_RE.test(r.body.devCode || ""), JSON.stringify(r));

  for (const bad of ["de", "xx", ""]) {
    r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: bad }, token: tok });
    check(`B4 locale ${JSON.stringify(bad)} -> 400 unsupported-locale`, r.status === 400 && r.body && r.body.code === "unsupported-locale", JSON.stringify(r));
  }

  r = await s.api("/auth/language/otp/request", { method: "POST", body: {}, token: tok });
  check("B5 missing targetLocale -> 400 unsupported-locale", r.status === 400 && r.body && r.body.code === "unsupported-locale", JSON.stringify(r));

  // Destination binding: verify must reject a body-supplied destination.
  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "fr" }, token: tok });
  const code = r.body && r.body.devCode;
  check("B6 fr request ok, devCode captured", r.status === 200 && OTP_RE.test(code || ""), JSON.stringify(r));
  r = await s.api("/auth/language/otp/verify", {
    method: "POST",
    body: { targetLocale: "fr", otp: code, email: "attacker@twiller.test", phone: "9000000000" },
    token: tok,
  });
  check("B7 verify ignores body email/phone -> 200 verified", r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r));

  await s.stop();
}

/* ===== C. delivery failure rollback (server sC, mail outage) ===== */
async function sectionC() {
  console.log("\n[C] delivery-failure rollback (MOCK_MAIL_OUTAGE)");
  const s = await spawnBackend(`twiller_langotp_c_${stamp}`, { map: {}, env: { MOCK_MAIL_OUTAGE: "true" } });
  const u = await makeUser(s, { uid: "uid-c" });
  const tok = T("c-main");
  s.setMap({ [tok]: ident("uid-c", u.email, true) });

  const r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "fr" }, token: tok });
  check("C1 email outage -> 502 delivery-failed, no devCode", r.status === 502 && r.body && r.body.code === "delivery-failed" && !("devCode" in (r.body || {})), JSON.stringify(r));

  // Production soft-retires the undelivered code (status -> "consumed") rather
  // than deleting it, preserving an audit row that can never verify (verify
  // only matches status "pending"). So the security property is: zero PENDING
  // docs remain, and any retained doc is consumed + unusable.
  const pendingLeft = await directDb(s.dbUrl, (db) => db.collection("languageotps").countDocuments({ email: u.email, status: "pending" }));
  check("C2 failed delivery leaves NO pending OTP doc", pendingLeft === 0, `pending=${pendingLeft}`);
  const retained = await directDb(s.dbUrl, (db) => db.collection("languageotps").find({ email: u.email }).project({ status: 1 }).toArray());
  const allConsumed = retained.length > 0 && retained.every((d) => d.status === "consumed");
  check("C2b retained doc(s) are consumed audit rows", allConsumed, JSON.stringify(retained));
  const rv = await s.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "fr", otp: "000000" }, token: tok });
  check("C2c consumed record cannot verify -> 404 no-pending-code", rv.status === 404 && rv.body && rv.body.code === "no-pending-code", JSON.stringify(rv));
  await s.stop();
}




/* ===== D. wrong-OTP attempts + expiry + single-use (server sD) ===== */
async function sectionD() {
  console.log("\n[D] attempts, expiry, single-use, wrong-locale replay");
  const s = await spawnBackend(`twiller_langotp_d_${stamp}`, { map: {} });
  const u = await makeUser(s, { uid: "uid-d" });
  const tok = T("d-main");
  s.setMap({ [tok]: ident("uid-d", u.email, true) });
  const req = (loc) => s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: loc }, token: tok });
  const ver = (loc, otp, tk = tok) => s.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: loc, otp }, token: tk });

  let r = await req("en");
  const wrong = r.body && r.body.devCode === "000000" ? "111111" : "000000";
  check("D0 en request ok", r.status === 200 && OTP_RE.test((r.body && r.body.devCode) || ""), JSON.stringify(r));

  r = await ver("en", wrong);
  check("D1 wrong OTP -> 401 incorrect-code + attemptsRemaining 4", r.status === 401 && r.body && r.body.code === "incorrect-code" && r.body.attemptsRemaining === 4, JSON.stringify(r));

  for (let i = 0; i < 4; i += 1) {
    r = await ver("en", wrong);
  }
  check("D2 five wrong tries -> 429 attempts-exhausted", r.status === 429 && r.body && r.body.code === "attempts-exhausted", JSON.stringify(r));

  // D3/D4 setup: re-arm BOTH locales with live pending codes. D2's lockout
  // expired the en record, so a bare `req("hi")` would leave en with NO
  // pending doc and a hi-code-at-en verify would 404 (absence, not mismatch).
  // Requesting en fresh first guarantees the D4 rejection proves locale
  // binding (401 incorrect-code), never state leakage.
  r = await req("en");
  const codeEnFresh = r.body && r.body.devCode;
  check("D3a en re-armed after lockout", r.status === 200 && OTP_RE.test(codeEnFresh || ""), JSON.stringify(r));
  r = await req("hi");
  const code2 = r.body && r.body.devCode;
  check("D3 fresh code after lockout (new request resets)", r.status === 200 && OTP_RE.test(code2 || ""), JSON.stringify(r));

  r = await ver("en", code2);
  check("D4 cross-locale replay (hi code at en) -> 401 incorrect-code", r.status === 401 && r.body && r.body.code === "incorrect-code", JSON.stringify(r));

  r = await ver("hi", code2);
  check("D5 correct OTP -> 200 verified, ok true", r.status === 200 && r.body && r.body.ok === true && r.body.verified === true, JSON.stringify(r));

  r = await ver("hi", code2);
  check("D6 replay of consumed OTP -> 404 no-pending-code", r.status === 404 && r.body && r.body.code === "no-pending-code", JSON.stringify(r));

  r = await req("es");
  const code3 = r.body && r.body.devCode;
  // Fixture targets the REAL schema fields: filter the intended pending row,
  // backdate otpExpiresAt, then assert exactly that row moved into the past.
  const expirySet = await directDb(s.dbUrl, (db) => db.collection("languageotps").updateOne(
    { email: u.email, targetLocale: "es", status: "pending" },
    { $set: { otpExpiresAt: new Date(Date.now() - 60 * 1000) } },
  ));
  check("D7a expiry fixture modified exactly the es pending row", expirySet.modifiedCount === 1, JSON.stringify({ matched: expirySet.matchedCount, modified: expirySet.modifiedCount }));
  const expiryRow = await directDb(s.dbUrl, (db) => db.collection("languageotps").findOne(
    { email: u.email, targetLocale: "es", status: "pending" }, { projection: { otpExpiresAt: 1 } },
  ));
  check("D7b es record expiry is in the past", !!expiryRow && new Date(expiryRow.otpExpiresAt).getTime() < Date.now(), JSON.stringify(expiryRow));
  r = await ver("es", code3);
  check("D7 expired OTP -> 410 code-expired", r.status === 410 && r.body && r.body.code === "code-expired", JSON.stringify(r));

  r = await s.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "es" }, token: tok });
  check("D8 verify without otp -> 400 invalid-code-shape", r.status === 400 && r.body && r.body.code === "invalid-code-shape", JSON.stringify(r));
  r = await s.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "es", otp: "12" }, token: tok });
  check("D9 verify malformed otp -> 400 invalid-code-shape", r.status === 400 && r.body && r.body.code === "invalid-code-shape", JSON.stringify(r));

  await s.stop();
}

/* ===== E. cooldown / resend rotation (server sE) ===== */
async function sectionE() {
  console.log("\n[E] resend cooldown");
  const s = await spawnBackend(`twiller_langotp_e_${stamp}`, { map: {} });
  const u = await makeUser(s, { uid: "uid-e" });
  const tok = T("e-main");
  s.setMap({ [tok]: ident("uid-e", u.email, true) });

  let r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "pt" }, token: tok });
  const c1 = r.body && r.body.devCode;
  check("E1 first request ok", r.status === 200 && OTP_RE.test(c1 || ""), JSON.stringify(r));

  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "pt" }, token: tok });
  check("E2 immediate resend -> 429 resend-cooldown + retryAfterSeconds", r.status === 429 && r.body && r.body.code === "resend-cooldown" && typeof r.body.retryAfterSeconds === "number", JSON.stringify(r));

  // Fixture targets the REAL cooldown field: production throttles on
  // `lastSentAt` of the pending row (index.js resend-cooldown branch), not
  // createdAt. Backdate exactly the pt pending row, then prove lastSentAt is
  // older than the 60s cooldown before re-requesting.
  const cooldownSet = await directDb(s.dbUrl, (db) => db.collection("languageotps").updateOne(
    { email: u.email, targetLocale: "pt", status: "pending" },
    { $set: { lastSentAt: new Date(Date.now() - 61 * 1000) } },
  ));
  check("E3a cooldown fixture cleared exactly the pt pending row", cooldownSet.matchedCount === 1 && cooldownSet.modifiedCount === 1, JSON.stringify({ matched: cooldownSet.matchedCount, modified: cooldownSet.modifiedCount }));
  const cooldownRow = await directDb(s.dbUrl, (db) => db.collection("languageotps").findOne(
    { email: u.email, targetLocale: "pt", status: "pending" }, { projection: { lastSentAt: 1 } },
  ));
  check("E3b lastSentAt is older than the 60s cooldown", !!cooldownRow && (Date.now() - new Date(cooldownRow.lastSentAt).getTime()) / 1000 > 60, JSON.stringify(cooldownRow));
  r = await s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "pt" }, token: tok });
  const c2 = r.body && r.body.devCode;
  check("E3 resend after cooldown -> 200, rotated code", r.status === 200 && OTP_RE.test(c2 || "") && c2 !== c1, JSON.stringify({ status: r.status, rotated: c1 !== c2 }));

  r = await s.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "pt", otp: c1 }, token: tok });
  check("E4 old code invalidated by resend -> 401 incorrect-code", r.status === 401 && r.body && r.body.code === "incorrect-code", JSON.stringify(r));
  r = await s.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "pt", otp: c2 }, token: tok });
  check("E5 new code verifies -> 200", r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r));

  await s.stop();
}


/* ===== F. fail-closed 503 + cross-user + legacy + prod guard (sF/sG/sH) ===== */
async function sectionF() {
  console.log("\n[F] fail-closed 503 and cross-user / legacy checks");

  const sF = await spawnBackend(`twiller_langotp_f_${stamp}`, { mock: false });
  let r = await sF.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "en" }, token: "any-token" });
  check("F0 request, Firebase unconfigured -> 503 auth-unavailable", r.status === 503 && r.body && r.body.code === "auth-unavailable", JSON.stringify(r));
  r = await sF.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "en", otp: "000000" }, token: "any-token" });
  check("F1 verify, Firebase unconfigured -> 503 auth-unavailable", r.status === 503 && r.body && r.body.code === "auth-unavailable", JSON.stringify(r));
  r = await sF.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "en" } });
  check("F2 no bypass without token when unconfigured -> 401/503, never 2xx", r.status === 401 || r.status === 503, `status=${r.status}`);
  await sF.stop();

  const sG = await spawnBackend(`twiller_langotp_g_${stamp}`, { map: {} });
  const uA = await makeUser(sG, { uid: "uid-ga" });
  const uB = await makeUser(sG, { uid: "uid-gb" });
  const tokA = T("g-a");
  const tokB = T("g-b");
  sG.setMap({ [tokA]: ident("uid-ga", uA.email, true), [tokB]: ident("uid-gb", uB.email, true) });
  r = await sG.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "zh" }, token: tokA });
  const codeA = r.body && r.body.devCode;
  check("F3a user A code issued", r.status === 200 && OTP_RE.test(codeA || ""), JSON.stringify(r));
  r = await sG.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "zh", otp: codeA }, token: tokB });
  check("F3b user B cannot use A code -> 404 no-pending-code", r.status === 404 && r.body && r.body.code === "no-pending-code", JSON.stringify(r));

  const tokLegacy = T("g-legacy");
  sG.setMap({ [tokA]: ident("uid-ga", uA.email, true), [tokB]: ident("uid-gb", uB.email, true), [tokLegacy]: ident("uid-legacy", `legacy.${stamp}@twiller.test`, true) });
  r = await sG.api("/register", {
    method: "POST",
    token: tokLegacy,
    body: { username: `legacy_${stamp}`, displayName: "legacy", avatar: "https://example.com/a.png", email: `legacy.${stamp}@twiller.test`, phone: `9170${stamp}`.slice(0, 12) },
  });
  check("F4 legacy POST /register unaffected -> 201", r.status === 201, `status=${r.status}`);
  r = await sG.api("/auth/forgot-password/request", { method: "POST", body: { identifier: `legacy.${stamp}@twiller.test` } });
  check("F5 legacy forgot-password unaffected -> 200, no devHint leak change", r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r));
  await sG.stop();

  // Production email behaviour - two independent guarantees:
  //   F6: with a real SMTP provider configured the code IS mailed and the API
  //       answers 200 without ever echoing the code (local stub, no real mail).
  //   F7: with NO provider configured the request FAILS SAFELY (502
  //       delivery-failed) instead of reporting a mock "success".
  const smtpStub = await startSmtpStub();

  const sH = await spawnBackend(`twiller_langotp_h_${stamp}`, {
    map: {},
    nodeEnv: "production",
    env: {
      OTP_DELIVERY: "smtp",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtpStub.port),
      SMTP_SECURE: "false",
      SMTP_USER: "stub-user",
      SMTP_PASS: "stub-pass",
      MAIL_FROM: "Twiller <no-reply@twiller.test>",
    },
  });
  const uH = await makeUser(sH, { uid: "uid-h" });
  const tokH = T("h-main");
  sH.setMap({ [tokH]: ident("uid-h", uH.email, true) });
  r = await sH.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "fr" }, token: tokH });
  const leaked = JSON.stringify(r.body || {});
  check(
    "F6a production + smtp -> 200 email channel, NO devCode/devHint",
    r.status === 200 && r.body && r.body.channel === "email" && !("devCode" in (r.body || {})) && !("devHint" in (r.body || {})),
    leaked.slice(0, 200)
  );
  check("F6b production body has no 6-digit OTP", !/\b\d{6}\b/.test(leaked), leaked.slice(0, 200));
  check("F6c server log never prints OTP material", !/verification code is/i.test(sH.log()), sH.log().slice(-200));
  check(
    "F6d the code actually reached the mail provider",
    smtpStub.state.messages.length === 1,
    JSON.stringify(smtpStub.state.messages).slice(0, 200)
  );
  await sH.stop();
  await smtpStub.close();

  const sH2 = await spawnBackend(`twiller_langotp_h2_${stamp}`, { map: {}, nodeEnv: "production" });
  const uH2 = await makeUser(sH2, { uid: "uid-h2" });
  const tokH2 = T("h2-main");
  sH2.setMap({ [tokH2]: ident("uid-h2", uH2.email, true) });
  r = await sH2.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "fr" }, token: tokH2 });
  const leaked2 = JSON.stringify(r.body || {});
  check(
    "F7a production + unconfigured email -> 502 delivery-failed (never a mock success)",
    r.status === 502 && r.body && r.body.code === "delivery-failed",
    leaked2.slice(0, 200)
  );
  check(
    "F7b failure body leaks no devCode/devHint/OTP",
    !("devCode" in (r.body || {})) && !("devHint" in (r.body || {})) && !/\b\d{6}\b/.test(leaked2),
    leaked2.slice(0, 200)
  );
  await sH2.stop();
}

/* ===== G. concurrency: parallel resends single-flight (server sI) ===== */
async function sectionG() {
  console.log("\n[G] concurrent resend single-flight");
  const s = await spawnBackend(`twiller_langotp_i_${stamp}`, { map: {} });
  const u = await makeUser(s, { uid: "uid-i" });
  const tok = T("i-main");
  s.setMap({ [tok]: ident("uid-i", u.email, true) });

  // Gate the burst on the single-flight unique index itself (same DB the
  // backend writes). Without this, the burst can land before Mongoose's
  // background index build finishes and N creates succeed with nothing to
  // violate - a harness race, not a production defect. Fails loudly on
  // timeout via main()'s HARNESS ERROR path.
  await waitForLangOtpSingleFlightIndex(s.dbUrl);

  const results = await Promise.all(
    Array.from({ length: 6 }, () => s.api("/auth/language/otp/request", { method: "POST", body: { targetLocale: "en" }, token: tok })),
  );
  const okCount = results.filter((x) => x.status === 200).length;
  // Losers are throttled ONLY via the two shipped shapes: 429 resend-cooldown
  // (row exists, cooldown live) or 409 already-in-flight (lost the
  // unique-index race). Anything else is an unexpected failure, never a loser.
  const hist = {};
  for (const x of results) {
    let label;
    if (x.body && x.body.code) label = x.body.code;
    else if (x.status === 200 && x.body && x.body.devCode) label = "devCode-present";
    else label = `shape:${JSON.stringify(x.body || null).slice(0, 60)}`;
    const k = `${x.status}:${label}`;
    hist[k] = (hist[k] || 0) + 1;
  }
  const coolCount = results.filter((x) => x.status === 429 && x.body && x.body.code === "resend-cooldown").length
    + results.filter((x) => x.status === 409 && x.body && x.body.code === "already-in-flight").length;
  check("G1 exactly one winner, rest cooled down", okCount === 1 && okCount + coolCount === 6, `ok=${okCount} cooled=${coolCount} hist=${JSON.stringify(hist)}`);

  const winnerCode = (results.find((x) => x.status === 200) || {}).body?.devCode;
  const n = await directDb(s.dbUrl, (db) => db.collection("languageotps").countDocuments({ email: u.email, targetLocale: "en", status: "pending" }));
  check("G2 single pending OTP doc after race", n === 1, `count=${n}`);
  const r = await s.api("/auth/language/otp/verify", { method: "POST", body: { targetLocale: "en", otp: winnerCode }, token: tok });
  check("G3 winner code verifies", r.status === 200 && r.body && r.body.ok === true, JSON.stringify(r));
  await s.stop();
}

/* ================= main ================= */
async function main() {
  console.log("\nTwiller 2.0 - Feature 4 Phase 2 Stage B: language OTP backend tests");
  const t0 = Date.now();
  try {
    await sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
    await sectionE();
    await sectionF();
    await sectionG();
  } catch (e) {
    console.log("HARNESS ERROR:", (e && e.message) || e);
    process.exitCode = 1;
    return;
  }
  console.log(`\n==================================================`);
  console.log(`  passed: ${passed}   failed: ${failed}   (${Math.round((Date.now() - t0) / 1000)}s)`);
  if (failures.length) console.log(`  failures: ${failures.join(" | ")}`);
  console.log("==================================================\n");
  process.exitCode = failed === 0 ? 0 : 1;
}
await main();
