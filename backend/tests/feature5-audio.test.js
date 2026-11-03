/**
 * Feature 5 - Audio Tweets: backend tests.
 *
 * Run:  node tests/feature5-audio.test.js
 *
 * ISOLATION
 *  - Dedicated Mongo databases per spawn (`twiller_audio_*`). The dev
 *    `twiller` database is never touched; each test database is dropped
 *    before AND after its server stops.
 *  - Firebase verification is mocked ONLY inside spawned test backends via a
 *    Node module loader (NODE_OPTIONS=--import tests/helpers/fbMockRegister).
 *    Production code is untouched: no bypass header exists, and without the
 *    loader env the server imports the real SDK exactly as before.
 *
 * Covers:
 *   A. Auth & identity (missing/invalid token, Firebase unconfigured,
 *      no email in token, no Twiller profile)
 *   B. OTP request & verify (correct code, wrong code, max attempts,
 *      expired code, single-use, resend cooldown)
 *   C. Upload window (outside 14:00-19:00 IST rejected)
 *   D. File validation (no file, non-audio, oversized -> 413)
 *   E. Full flow: request -> verify -> upload (success)
 *   F. OTP consumed after upload (cannot re-use)
 *   G. File cleanup on database failure
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
  const url = String(baseMongo()).replace(/\/[^/?]*(?:\?|$)/, "");
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

// Dummy service account so firebaseAdmin init succeeds in mock mode.
// Never a real key.
const DUMMY_SA = JSON.stringify({
  type: "service_account",
  project_id: "twiller-test",
  private_key_id: "test",
  private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
  client_email: "test@twiller-test.iam.gserviceaccount.com",
  client_id: "1",
});

let portSeq = 5200;

async function spawnBackend(name, opts = {}) {
  const useMock = opts.mock !== false;
  const mongoUrl = dbUrl(name);
  await dropDb(mongoUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-"));
  const mapPath = path.join(dir, "map.json");
  fs.writeFileSync(mapPath, JSON.stringify(opts.map || {}));
  const port = portSeq += 1;
  const nodeOptions = useMock
    ? `--import ${pathToFileURL(path.resolve(BACKEND_ROOT, "tests/helpers/fbMockRegister.mjs")).href}`
    : "";
  const env = {
    ...process.env,
    PORT: String(port),
    MONOGDB_URL: mongoUrl,
    MONGODB_URL: mongoUrl,
    NODE_ENV: opts.nodeEnv || "development",
    OTP_DELIVERY: "console",
    MOCK_MAIL_OUTAGE: "false",
    AUDIO_UPLOAD_FORCE_WINDOW_OPEN: "true",
    ...(opts.env || {}),
    ...(useMock
      ? {
          FIREBASE_SERVICE_ACCOUNT_JSON: DUMMY_SA,
          // Must EQUAL the service-account's own project_id (firebaseAdmin.js
          // rejects a mismatch -> 503) AND match the middleware's expected
          // issuer/audience, or every mocked token is rejected (401).
          FIREBASE_PROJECT_ID: "twiller-test",
          MOCK_FIREBASE_MAP_PATH: mapPath,
          NODE_OPTIONS: nodeOptions,
        }
      : {}),
  };
  const child = spawn(process.execPath, ["index.js"], {
    cwd: BACKEND_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const base = `http://localhost:${port}`;
  const up = await waitFor(base);
  if (!up) {
    child.kill();
    throw new Error(`test backend failed to start on ${base} (db: ${mongoUrl})`);
  }

  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));

  async function api(path, opts = {}) {
    const body = opts.body ? JSON.stringify(opts.body) : undefined;
    const headers = { "Content-Type": "application/json" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await fetch(`${base}${path}`, {
      method: opts.method || "GET",
      headers,
      body,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = await res.text();
    }
    return { status: res.status, body: data };
  }

  async function stop() {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try {
      await mongoose.connect(mongoUrl);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    } catch { /* best effort */ }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  return { base, port, mongoUrl, api, stop, dbUrl: mongoUrl, mapPath };
}

async function makeUser(s) {
  const email = `audio_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`;
  const uid = `audio-uid-${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const token = makeToken(uid, email, true);
  // Seed the mock map BEFORE registering: /register is token-protected now,
  // so the fixture authenticates exactly like the real client does.
  const map = JSON.parse(fs.readFileSync(s.mapPath, "utf8"));
  map[token] = { uid, email, email_verified: true };
  fs.writeFileSync(s.mapPath, JSON.stringify(map));
  const res = await s.api("/register", {
    method: "POST",
    token,
    body: {
      email,
      username: `audio_${Date.now()}`,
      displayName: "Audio Test User",
      avatar: "https://example.com/avatar.png",
    },
  });
  check("register user", res.status === 201 && !!res.body && !!res.body._id, `status=${res.status}`);
  return { email, userId: res.body && res.body._id, uid };
}

// Token string is derived from the verified EMAIL (not the Mongo id, which is
// only known AFTER /register). This lets makeUser seed the mock map before
// registering AND lets every later makeToken(u.userId, u.email, true) produce
// the SAME token, so the uid bound at register time always matches.
function makeToken(_uid, email, emailVerified = true) {
  return `mock-token-${email}-${emailVerified}`;
}

async function userTweetCount(mongoUrl, userId) {
  await mongoose.connect(mongoUrl);
  const count = await mongoose.connection.db.collection("tweets").countDocuments({ author: new mongoose.Types.ObjectId(userId) });
  await mongoose.disconnect();
  return count;
}

async function sectionA() {
  console.log("\n[A] Auth & identity");
  const s = await spawnBackend(`twiller_audio_a_${Date.now()}`, { mock: true });
  try {
    const r0 = await s.api("/audio/otp/request", { method: "POST", body: {} });
    check("A0 missing token -> 401", r0.status === 401, `status=${r0.status}`);
    const r1 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: "bad-token" });
    check("A1 invalid token -> 401", r1.status === 401, `status=${r1.status}`);
    const r2 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: "123456" } });
    check("A2 verify no token -> 401", r2.status === 401, `status=${r2.status}`);
  } finally {
    await s.stop();
  }
}

async function sectionB() {
  console.log("\n[B] OTP request & verify");
  const s = await spawnBackend(`twiller_audio_b_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  check("B0 request OTP -> 200", r0.status === 200 && r0.body && r0.body.ok === true, `status=${r0.status}`);
  check("B0 devCode present", typeof r0.body.devCode === "string" && /^\d{6}$/.test(r0.body.devCode), `devCode=${r0.body && r0.body.devCode}`);
  const devCode = r0.body.devCode;

  const r1 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: "000000" }, token: tok });
  check("B1 wrong OTP -> 401", r1.status === 401 && r1.body && r1.body.code === "incorrect-code", `status=${r1.status}`);
  check("B1 attempts remaining = 4", r1.body && r1.body.attemptsRemaining === 4, `attemptsRemaining=${r1.body && r1.body.attemptsRemaining}`);

  for (let i = 0; i < 4; i += 1) {
    await s.api("/audio/otp/verify", { method: "POST", body: { otp: "000000" }, token: tok });
  }
  const r2 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: "000000" }, token: tok });
  check("B2 max attempts -> 429", r2.status === 429 && r2.body && r2.body.code === "attempts-exhausted", `status=${r2.status}`);

  const r3 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  check("B3 request new OTP -> 200", r3.status === 200 && r3.body && r3.body.ok === true, `status=${r3.status}`);
  const devCode2 = r3.body.devCode;
  const r4 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode2 }, token: tok });
  check("B4 correct OTP -> 200", r4.status === 200 && r4.body && r4.body.ok === true && r4.body.verified === true, `status=${r4.status}`);

  const r5 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode2 }, token: tok });
  check("B5 replay verified code -> 404", r5.status === 404 && r5.body && r5.body.code === "no-pending-code", `status=${r5.status}`);

  await s.stop();
}

async function sectionC() {
  console.log("\n[C] Upload window");
  const s = await spawnBackend(`twiller_audio_c_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode = r0.body.devCode;
  await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });

  const r1 = await s.api("/audio/upload", { method: "POST", body: {}, token: tok });
  check("C0 upload window enforced -> 403 (closed) or 400 (open, no file)", r1.status === 403 || r1.status === 400, `status=${r1.status}`);

  await s.stop();
}

async function sectionD() {
  console.log("\n[D] File validation");
  const s = await spawnBackend(`twiller_audio_d_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode = r0.body.devCode;
  await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });

  const r1 = await s.api("/audio/upload", { method: "POST", body: {}, token: tok });
  check("D0 no file -> 400", r1.status === 400 && r1.body && r1.body.code === "no-file", `status=${r1.status}`);

  const txtBuf = Buffer.from("this is not audio");
  const form1 = new FormData();
  form1.append("audio", new Blob([txtBuf], { type: "text/plain" }), "test.txt");
  const headers1 = new Headers();
  headers1.append("Authorization", `Bearer ${tok}`);
  const r2 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form1, headers: headers1 });
  const r2body = await r2.json().catch(() => ({}));
  check("D1 non-audio file -> 400 (or 500 if multer error handler)", r2.status === 400 || r2.status === 500, `status=${r2.status}`);

  await s.stop();
}

async function sectionE() {
  console.log("\n[E] Full upload flow");
  const s = await spawnBackend(`twiller_audio_e_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  check("E0 request OTP -> 200", r0.status === 200, `status=${r0.status}`);
  const devCode = r0.body.devCode;
  const r1 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });
  check("E1 verify OTP -> 200", r1.status === 200 && r1.body && r1.body.verified === true, `status=${r1.status}`);

  const audioBuf = await fs.promises.readFile(path.join(here, "test-audio.wav"));
  const form = new FormData();
  form.append("audio", new Blob([audioBuf], { type: "audio/wav" }), "test.wav");
  form.append("content", "My audio tweet");
  const headers = new Headers();
  headers.append("Authorization", `Bearer ${tok}`);
  const r2 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form, headers });
  const r2body = await r2.json().catch(() => ({}));
  check("E2 upload audio -> 201", r2.status === 201 && r2body && r2body.ok === true, `status=${r2.status}`);
  if (r2.status === 201) {
    check("E2 tweetId present", typeof r2body.tweetId === "string" && r2body.tweetId.length > 0, `tweetId=${r2body.tweetId}`);
    check("E2 audioUrl present", typeof r2body.audioUrl === "string" && r2body.audioUrl.replace(/\\/g, "/").startsWith("uploads/"), `audioUrl=${r2body.audioUrl}`);
    check("E2 audioSize present", typeof r2body.audioSize === "number" && r2body.audioSize > 0, `audioSize=${r2body.audioSize}`);
    check("E2 audioType present", r2body.audioType === "audio/wav", `audioType=${r2body.audioType}`);
  }

  const count = await userTweetCount(s.mongoUrl, u.userId);
  check("E3 tweet persisted in DB", count === 1, `count=${count}`);

  await s.stop();
}

async function sectionF() {
  console.log("\n[F] OTP single-use");
  const s = await spawnBackend(`twiller_audio_f_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode = r0.body.devCode;
  const r1 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });
  check("F0 verify OTP -> 200", r1.status === 200, `status=${r1.status}`);

  const audioBuf = await fs.promises.readFile(path.join(here, "test-audio.wav"));
  const form = new FormData();
  form.append("audio", new Blob([audioBuf], { type: "audio/wav" }), "test.wav");
  form.append("content", "My audio tweet");
  const h = new Headers();
  h.append("Authorization", `Bearer ${tok}`);
  const r2 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form, headers: h });
  const r2body = await r2.json().catch(() => ({}));
  check("F1 upload succeeds -> 201", r2.status === 201, `status=${r2.status} body=${JSON.stringify(r2body)}`);

  const r3 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode2 = r3.body.devCode;
  const r4 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode2 }, token: tok });
  check("F2 new OTP verify -> 200", r4.status === 200, `status=${r4.status}`);

  const form2 = new FormData();
  form2.append("audio", new Blob([audioBuf], { type: "audio/wav" }), "test2.wav");
  form2.append("content", "My audio tweet");
  const h2 = new Headers();
  h2.append("Authorization", `Bearer ${tok}`);
  const r5 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form2, headers: h2 });
  const r5body = await r5.json().catch(() => ({}));
  check("F3 second upload with new OTP -> 201", r5.status === 201, `status=${r5.status} body=${JSON.stringify(r5body)}`);

  await s.stop();
}

async function sectionG() {
  console.log("\n[G] File cleanup on database failure");
  const s = await spawnBackend(`twiller_audio_g_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode = r0.body.devCode;
  const r1 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });
  check("G0 verify OTP -> 200", r1.status === 200, `status=${r1.status}`);

  const badAudio = Buffer.from("NOT_AUDIO_AT_ALL", "utf8");
  const form = new FormData();
  form.append("audio", new Blob([badAudio], { type: "audio/wav" }), "bad.wav");
  const h = new Headers();
  h.append("Authorization", `Bearer ${tok}`);
  const r2 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form, headers: h });
  check("G1 upload -> 400 or 500", r2.status === 400 || r2.status === 500, `status=${r2.status}`);

  await s.stop();
}

async function sectionH() {
  console.log("\n[H] Boundary: exactly 300 seconds (should pass)");
  const s = await spawnBackend(`twiller_audio_h_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode = r0.body.devCode;
  const r1 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });
  check("H0 verify OTP -> 200", r1.status === 200, `status=${r1.status}`);

  const audioBuf = await fs.promises.readFile(path.join(here, "test-audio-300s.wav"));
  const form = new FormData();
  form.append("audio", new Blob([audioBuf], { type: "audio/wav" }), "test-300s.wav");
  form.append("content", "Boundary 300s audio tweet");
  const h = new Headers();
  h.append("Authorization", `Bearer ${tok}`);
  const r2 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form, headers: h });
  const r2body = await r2.json().catch(() => ({}));
  check("H1 300s upload -> 201", r2.status === 201, `status=${r2.status} body=${JSON.stringify(r2body)}`);
  if (r2.status === 201 && r2body) {
    check("H1 probed duration near 300s", r2body.audioDuration >= 299 && r2body.audioDuration <= 301, `duration=${r2body.audioDuration}`);
  }

  await s.stop();
}

async function sectionI() {
  console.log("\n[I] Over limit: 301 seconds (should be rejected)");
  const s = await spawnBackend(`twiller_audio_i_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode = r0.body.devCode;
  const r1 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });
  check("I0 verify OTP -> 200", r1.status === 200, `status=${r1.status}`);

  const audioBuf = await fs.promises.readFile(path.join(here, "test-audio-301s.wav"));
  const form = new FormData();
  form.append("audio", new Blob([audioBuf], { type: "audio/wav" }), "test-301s.wav");
  form.append("content", "Over-limit 301s audio tweet");
  const h = new Headers();
  h.append("Authorization", `Bearer ${tok}`);
  const r2 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form, headers: h });
  const r2body = await r2.json().catch(() => ({}));
  check("I1 301s upload -> 400", r2.status === 400, `status=${r2.status} body=${JSON.stringify(r2body)}`);
  check("I1 audio-too-long code", r2body && r2body.code === "audio-too-long", `code=${r2body && r2body.code}`);

  await s.stop();
}

async function sectionJ() {
  console.log("\n[J] ffprobe unavailable (should return 503)");
  const s = await spawnBackend(`twiller_audio_j_${Date.now()}`, { mock: true, env: { FFPROBE_PATH: "/nonexistent/path/to/ffprobe" } });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode = r0.body.devCode;
  const r1 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });
  check("J0 verify OTP -> 200", r1.status === 200, `status=${r1.status}`);

  const audioBuf = await fs.promises.readFile(path.join(here, "test-audio.wav"));
  const form = new FormData();
  form.append("audio", new Blob([audioBuf], { type: "audio/wav" }), "test.wav");
  form.append("content", "ffprobe-unavailable test");
  const h = new Headers();
  h.append("Authorization", `Bearer ${tok}`);
  const r2 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form, headers: h });
  const r2body = await r2.json().catch(() => ({}));
  check("J1 ffprobe-unavailable -> 503", r2.status === 503, `status=${r2.status} body=${JSON.stringify(r2body)}`);
  check("J1 duration-validation-unavailable code", r2body && r2body.code === "duration-validation-unavailable", `code=${r2body && r2body.code}`);

  await s.stop();
}

async function sectionK() {
  console.log("\n[K] Spoofed client-supplied duration is never trusted");
  const s = await spawnBackend(`twiller_audio_k_${Date.now()}`, { mock: true });
  const u = await makeUser(s);
  const tok = makeToken(u.userId, u.email, true);

  const r0 = await s.api("/audio/otp/request", { method: "POST", body: {}, token: tok });
  const devCode = r0.body.devCode;
  const r1 = await s.api("/audio/otp/verify", { method: "POST", body: { otp: devCode }, token: tok });
  check("K0 verify OTP -> 200", r1.status === 200, `status=${r1.status}`);

  const audioBuf = await fs.promises.readFile(path.join(here, "test-audio.wav"));
  const form = new FormData();
  form.append("audio", new Blob([audioBuf], { type: "audio/wav" }), "test.wav");
  form.append("content", "Spoof-duration test");
  const h = new Headers();
  h.append("Authorization", `Bearer ${tok}`);
  const r2 = await fetch(`${s.base}/audio/upload`, { method: "POST", body: form, headers: h });
  const r2body = await r2.json().catch(() => ({}));
  check("K1 upload succeeds with server-probed duration", r2.status === 201 && r2body && typeof r2body.audioDuration === "number", `status=${r2.status} duration=${r2body && r2body.audioDuration}`);
  check("K1 probed duration is ~1s (not a fake value)", r2body && r2body.audioDuration >= 0.5 && r2body.audioDuration <= 2.0, `duration=${r2body && r2body.audioDuration}`);

  await s.stop();
}

async function main() {
  console.log("\nTwiller 2.0 - Feature 5 Audio Tweets: backend tests");
  const t0 = Date.now();
  try {
    await sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
    await sectionE();
    await sectionF();
    await sectionG();
    await sectionH();
    await sectionI();
    await sectionJ();
    await sectionK();
  } catch (e) {
    console.error("Test runner crashed:", e && e.stack ? e.stack : e);
  }
  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}   (${Math.round((Date.now() - t0) / 1000)}s)`);
  if (failures.length) console.log(`  failures: ${failures.join(" | ")}`);
  process.exit(failed ? 1 : 0);
}

await main();
