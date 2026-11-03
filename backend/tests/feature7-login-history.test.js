/**
 * Feature 2 - login history + browser/mobile access rules.
 *
 * Run:  node tests/feature7-login-history.test.js
 *
 * ISOLATION
 *  - Dedicated Mongo databases per spawn (twiller_loginh_*). The development
 *    database is never touched; each test database is dropped before AND after.
 *  - Firebase verification is mocked ONLY inside the spawned backends via the
 *    existing NODE_OPTIONS --import loader. No bypass header exists anywhere.
 *  - The mobile window is exercised deterministically through the
 *    DEVICE_POLICY_NOW development hatch (ignored when NODE_ENV=production).
 *
 * Exits 0 when everything passes, 1 on any failure. No framework added.
 */

import "dotenv/config";
import { startTestServer } from "./helpers/testServer.js";
import { parseUserAgent, resolveClientIp } from "../utils/userAgent.js";
import { isWithinIstWindow } from "../utils/istTime.js";
import {
  requiresEmailOtp,
  MOBILE_WINDOW_START_HOUR,
  MOBILE_WINDOW_END_HOUR,
} from "../middleware/devicePolicy.js";

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

const UA = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  edge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  android:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  ipad:
    "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  firefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
};

/** Raw request helper so the User-Agent can be controlled per call. */
async function call(s, path, { method = "GET", token, body, ua } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  headers["User-Agent"] = ua === undefined ? UA.chrome : ua;
  const res = await fetch(`${s.base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json, text };
}

const tokenMap = {
  "tok-a": { uid: "uid-a", email: "loginh.a@twiller.test", email_verified: true },
  "tok-b": { uid: "uid-b", email: "loginh.b@twiller.test", email_verified: true },
};

async function unitTests() {
  console.log("\n[1] User-Agent parsing (descriptive only, never identity)");
  check(
    "Chrome desktop",
    parseUserAgent(UA.chrome).browser === "Chrome" &&
      parseUserAgent(UA.chrome).os === "Windows" &&
      parseUserAgent(UA.chrome).deviceCategory === "desktop",
    JSON.stringify(parseUserAgent(UA.chrome))
  );
  check("Edge wins over the Chrome token", parseUserAgent(UA.edge).browser === "Edge", parseUserAgent(UA.edge).browser);
  check("Android phone -> mobile", parseUserAgent(UA.android).deviceCategory === "mobile", parseUserAgent(UA.android).deviceCategory);
  check("iPad -> tablet", parseUserAgent(UA.ipad).deviceCategory === "tablet", parseUserAgent(UA.ipad).deviceCategory);
  check("Firefox", parseUserAgent(UA.firefox).browser === "Firefox");
  check(
    "empty UA -> Unknown/desktop (never mobile)",
    parseUserAgent("").browser === "Unknown" && parseUserAgent("").deviceCategory === "desktop"
  );
  check(
    "malformed UA does not throw",
    (() => {
      try {
        parseUserAgent(undefined);
        parseUserAgent("!!!");
        return true;
      } catch {
        return false;
      }
    })()
  );
  check("Chrome requires an emailed code", requiresEmailOtp("Chrome") === true);
  check("Edge does NOT require a code", requiresEmailOtp("Edge") === false);
  check("unknown browser does NOT require a code", requiresEmailOtp("Unknown") === false);

  console.log("\n[2] IP resolution never trusts raw forwarded headers");
  const spoofed = {
    ip: "203.0.113.9",
    headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" },
  };
  check("uses Express req.ip, not x-forwarded-for", resolveClientIp(spoofed) === "203.0.113.9", resolveClientIp(spoofed));
  check("strips the ::ffff: IPv6-mapped prefix", resolveClientIp({ ip: "::ffff:10.0.0.5" }) === "10.0.0.5");
  check("missing ip -> unknown", resolveClientIp({}) === "unknown");

  console.log("\n[3] Mobile window boundaries (Asia/Kolkata)");
  // IST = UTC+05:30, so 10:00 IST is 04:30Z and 13:00 IST is 07:30Z.
  check("09:59 IST -> outside", isWithinIstWindow(MOBILE_WINDOW_START_HOUR, MOBILE_WINDOW_END_HOUR, new Date("2026-11-02T04:29:00.000Z")) === false);
  check("10:00 IST -> inside (inclusive start)", isWithinIstWindow(MOBILE_WINDOW_START_HOUR, MOBILE_WINDOW_END_HOUR, new Date("2026-11-02T04:30:00.000Z")) === true);
  check("12:59 IST -> inside", isWithinIstWindow(MOBILE_WINDOW_START_HOUR, MOBILE_WINDOW_END_HOUR, new Date("2026-11-02T07:29:00.000Z")) === true);
  check("13:00 IST -> outside (exclusive end)", isWithinIstWindow(MOBILE_WINDOW_START_HOUR, MOBILE_WINDOW_END_HOUR, new Date("2026-11-02T07:30:00.000Z")) === false);
}

async function main() {
  console.log("\nTwiller 2.0 - Feature 2: login history + device/browser rules");
  await unitTests();

  /* ============ mobile OUTSIDE the window (07:30 IST) ============ */
  console.log("\n[4] Mobile outside 10:00-13:00 IST -> blocked SERVER-side");
  const closed = await startTestServer({
    fbMock: true,
    map: tokenMap,
    env: { OTP_DELIVERY: "console", DEVICE_POLICY_NOW: "2026-11-02T02:00:00.000Z" },
  });
  {
    const reg = await call(closed, "/register", {
      method: "POST",
      token: "tok-a",
      ua: UA.android,
      body: { email: "loginh.a@twiller.test", username: "la", displayName: "LA", avatar: "x" },
    });
    check(
      "mobile registration is refused while the window is closed",
      reg.status === 403 && reg.body?.code === "mobile-window-closed",
      `status=${reg.status} body=${JSON.stringify(reg.body)}`
    );
    check("the refusal names the IST window", reg.body?.window?.timeZone === "Asia/Kolkata");

    const feed = await call(closed, "/post", { ua: UA.android });
    check("mobile cannot read the feed while closed", feed.status === 403 && feed.body?.code === "mobile-window-closed");

    const desktop = await call(closed, "/post", { ua: UA.chrome });
    check("desktop is NOT restricted by the mobile window", desktop.status === 200, `status=${desktop.status}`);
  }
  await closed.stop();

  /* ============ inside the window (10:30 IST) ============ */
  console.log("\n[5] Inside the window + Chrome OTP + Edge + history ownership");
  const open = await startTestServer({
    fbMock: true,
    map: tokenMap,
    env: { OTP_DELIVERY: "console", DEVICE_POLICY_NOW: "2026-11-02T05:00:00.000Z" },
  });

  const regA = await call(open, "/register", {
    method: "POST",
    token: "tok-a",
    ua: UA.chrome,
    body: { email: "loginh.a@twiller.test", username: "la", displayName: "LA", avatar: "x" },
  });
  check("desktop Chrome registers inside the window", regA.status === 201, `status=${regA.status}`);

  const gateNoOtp = await call(open, "/auth/login-event", { method: "POST", token: "tok-a", ua: UA.chrome });
  check("Chrome login-event requires the emailed code (428)", gateNoOtp.status === 428 && gateNoOtp.body?.code === "chrome-otp-required", `status=${gateNoOtp.status}`);

  const req1 = await call(open, "/auth/login/otp/request", { method: "POST", token: "tok-a", ua: UA.chrome });
  check("Chrome can request a code", req1.status === 200 && typeof req1.body?.devCode === "string", `status=${req1.status}`);

  const req2 = await call(open, "/auth/login/otp/request", { method: "POST", token: "tok-a", ua: UA.chrome });
  check("resend is rate-limited (429)", req2.status === 429 && req2.body?.code === "resend-cooldown", `status=${req2.status}`);

  const devCode = req1.body.devCode;
  const badOtp = devCode === "000000" ? "111111" : "000000";
  const wrong = await call(open, "/auth/login/otp/verify", { method: "POST", token: "tok-a", ua: UA.chrome, body: { otp: badOtp } });
  check("wrong code -> 401 incorrect-code", wrong.status === 401 && wrong.body?.code === "incorrect-code", `status=${wrong.status}`);
  check("attempts remaining is reported", typeof wrong.body?.attemptsRemaining === "number");

  const verified = await call(open, "/auth/login/otp/verify", { method: "POST", token: "tok-a", ua: UA.chrome, body: { otp: devCode } });
  check("correct code -> 200 verified", verified.status === 200 && verified.body?.verified === true, `status=${verified.status}`);

  const replay = await call(open, "/auth/login/otp/verify", { method: "POST", token: "tok-a", ua: UA.chrome, body: { otp: devCode } });
  check("replaying the accepted code -> 404 no-pending-code", replay.status === 404, `status=${replay.status}`);

  const gateOk = await call(open, "/auth/login-event", { method: "POST", token: "tok-a", ua: UA.chrome });
  check("Chrome session is granted after verification", gateOk.status === 200 && gateOk.body?.allowed === true, `status=${gateOk.status} body=${JSON.stringify(gateOk.body)}`);
  check("server reports the parsed browser/device", gateOk.body?.browser === "Chrome" && gateOk.body?.deviceCategory === "desktop");
  check("server reports the resolved IP", typeof gateOk.body?.ip === "string" && gateOk.body.ip.length > 0, gateOk.body?.ip);

  const gateAgain = await call(open, "/auth/login-event", { method: "POST", token: "tok-a", ua: UA.chrome });
  check("the verified code is single-use (428 again)", gateAgain.status === 428, `status=${gateAgain.status}`);

  // -- Microsoft Edge: no extra code --
  const regB = await call(open, "/register", {
    method: "POST",
    token: "tok-b",
    ua: UA.edge,
    body: { email: "loginh.b@twiller.test", username: "lb", displayName: "LB", avatar: "x" },
  });
  check("Edge registers without any code", regB.status === 201, `status=${regB.status}`);
  const gateEdge = await call(open, "/auth/login-event", { method: "POST", token: "tok-b", ua: UA.edge });
  check("Edge login-event is allowed without a code", gateEdge.status === 200 && gateEdge.body?.otpRequired === false, `status=${gateEdge.status}`);
  const edgeOtp = await call(open, "/auth/login/otp/request", { method: "POST", token: "tok-b", ua: UA.edge });
  check("Edge cannot mint a code (400 otp-not-required)", edgeOtp.status === 400 && edgeOtp.body?.code === "otp-not-required", `status=${edgeOtp.status}`);

  // -- mobile INSIDE the window is allowed --
  const mobileInside = await call(open, "/post", { ua: UA.android });
  check("mobile inside the window can read the feed", mobileInside.status === 200, `status=${mobileInside.status}`);

  // -- history: recorded, own-rows-only, no secrets --
  const histA = await call(open, "/auth/login-history", { ua: UA.chrome, token: "tok-a" });
  check("A can read their own history (200 array)", histA.status === 200 && Array.isArray(histA.body), `status=${histA.status}`);
  check(
    "history rows carry browser/os/device/ip/time",
    Array.isArray(histA.body) &&
      histA.body.length > 0 &&
      typeof histA.body[0].browser === "string" &&
      typeof histA.body[0].os === "string" &&
      typeof histA.body[0].deviceCategory === "string" &&
      typeof histA.body[0].ip === "string" &&
      !!histA.body[0].loggedInAt
  );
  check(
    "history records the browser-specific outcome (otp-required then allowed)",
    Array.isArray(histA.body) &&
      histA.body.some((r) => r.outcome === "otp-required") &&
      histA.body.some((r) => r.outcome === "allowed")
  );
  check("no OTP/token/password material is stored in history", !/otpHash|otpSalt|recoveryToken|password/i.test(JSON.stringify(histA.body)));

  const histB = await call(open, "/auth/login-history", { ua: UA.edge, token: "tok-b" });
  check(
    "B only sees B's own rows (Edge, never A's Chrome rows)",
    histB.status === 200 && Array.isArray(histB.body) && histB.body.every((r) => r.browser === "Edge"),
    JSON.stringify((histB.body || []).map((r) => r.browser))
  );

  const anon = await call(open, "/auth/login-history", { ua: UA.chrome });
  check("history without a token -> 401", anon.status === 401, `status=${anon.status}`);

  const anonEvent = await call(open, "/auth/login-event", { method: "POST", ua: UA.chrome });
  check("login-event without a token -> 401", anonEvent.status === 401, `status=${anonEvent.status}`);

  await open.stop();

  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failures.length) console.log(`  failures: ${failures.join(" | ")}`);
  console.log("==================================================\n");
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("Test suite crashed:", error);
  process.exitCode = 1;
});
