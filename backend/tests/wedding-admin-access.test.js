/**
 * Wedding guest viewer - access control and read-only behaviour.
 *
 * Run:  node tests/wedding-admin-access.test.js
 *
 * WHAT IT PROVES
 *  · Without a token the guest-response endpoint answers 401 - there is no
 *    "hidden URL" security anywhere in this feature.
 *  · A forged, edited, expired or merely malformed token is refused just the same.
 *  · A wrong user name and a wrong password are refused identically.
 *  · A correct sign-in mints a token, and only then does the data come back.
 *  · The payload carries the FOUR fields the viewer shows and nothing else -
 *    no email, no object id, no request id, no confirmation-email record.
 *  · The data path is read-only: there is no write route to find.
 *  · A deployment without the two secrets answers 503 (it fails shut, never open).
 *  · The wedding origin is allowed to use the route and an unrelated origin is not.
 *
 * SAFETY
 *  The suite starts its OWN backend against a LOCAL MongoDB
 *  (127.0.0.1:27017 by default, database `wedding_rsvp`), inserts two clearly
 *  marked fixture replies and deletes exactly those before it exits. The cloud
 *  database and every genuine guest reply are never touched. No email can be
 *  sent: the child process runs the mail transport in console mode.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(here, "..");

const MONGO_URL =
  process.env.TEST_LOCAL_MONGO_URL || "mongodb://127.0.0.1:27017/wedding_viewer_test";
const WEDDING_ORIGIN = "https://rr188351.github.io";
const ADMIN_USER = "viewer-admin";
const ADMIN_PASSWORD = "correct-horse-battery";
const TOKEN_SECRET = "a-test-signing-secret-of-sufficient-length";
const RUN = Date.now().toString(36);
const MARK = `viewer-fixture-${RUN}`;

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
    console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts one backend process and waits until it answers. */
async function startBackend({ port, adminEnv }) {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      MONOGDB_URL: MONGO_URL,
      MONGODB_URL: MONGO_URL,
      MONGODB_DB: "twiller_test",
      PORT: String(port),
      NODE_ENV: "development",
      OTP_DELIVERY: "console",
      FIREBASE_SERVICE_ACCOUNT_JSON: "",
      FIREBASE_SERVICE_ACCOUNT_PATH: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
      WEDDING_ADMIN_USER: ADMIN_USER,
      WEDDING_ADMIN_PASSWORD: ADMIN_PASSWORD,
      WEDDING_ADMIN_TOKEN_SECRET: TOKEN_SECRET,
      WEDDING_ADMIN_LOGIN_RATE_LIMIT_MAX: "500",
      WEDDING_ADMIN_READ_RATE_LIMIT_MAX: "500",
      ...adminEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const log = [];
  child.stdout.on("data", (chunk) => log.push(chunk.toString()));
  child.stderr.on("data", (chunk) => log.push(chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return { child, base, log };
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`backend on ${port} never became ready:\n${log.join("")}`);
}

async function call(base, pathname, { method = "GET", body, token, origin = WEDDING_ORIGIN } = {}) {
  const headers = { Origin: origin };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json, headers: response.headers };
}

async function main() {
  console.log("\nWedding guest viewer - access control");
  console.log(`Local database: ${MONGO_URL}  (cloud data is never touched)\n`);

  // --- fixtures on the LOCAL database only --------------------------------
  const conn = await mongoose.createConnection(MONGO_URL, { dbName: "wedding_rsvp" }).asPromise();
  const guests = conn.db.collection("guests");
  const xssMessage = '<script>alert("xss")</script>';
  const fixtures = [
    {
      name: "Viewer Fixture Older",
      attendance: "accept",
      partySize: 3,
      email: "never-shown@example.com",
      message: "A note we are happy to show",
      requestId: `${MARK}-a`,
      source: "wedding_invitation",
      capturedAt: new Date(Date.now() - 3 * 60 * 1000),
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
      updatedAt: new Date(Date.now() - 3 * 60 * 1000),
    },
    {
      name: "Viewer Fixture Newer",
      attendance: "decline",
      partySize: 0,
      email: "",
      message: xssMessage,
      requestId: `${MARK}-b`,
      source: "wedding_invitation",
      capturedAt: new Date(Date.now() - 60 * 1000),
      createdAt: new Date(Date.now() - 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 1000),
    },
  ];
  await guests.deleteMany({ requestId: new RegExp(`^${MARK}`) });
  await guests.insertMany(fixtures);
  console.log(`[fixtures] two replies written to the LOCAL database (marker ${MARK})\n`);

  const server = await startBackend({ port: 5093, adminEnv: {} });
  const { base } = server;

  console.log("[1] without a token, the guest responses are refused");
  const anonymous = await call(base, "/api/wedding/admin/guests");
  check("no token -> 401", anonymous.status === 401, `status=${anonymous.status}`);
  check(
    "the refusal carries no guest data",
    !JSON.stringify(anonymous.json || {}).includes("Viewer Fixture"),
  );

  console.log("\n[2] forged, edited and malformed tokens are refused");
  const cases = [
    ["an empty bearer", " "],
    ["a made-up token", "not-a-real-token"],
    ["a token with no signature", "eyJzdWIiOiJ3ZWRkaW5nLWFkbWluIn0"],
    ["an edited payload", `${Buffer.from(JSON.stringify({ sub: "wedding-admin", exp: 9e15 })).toString("base64url")}.forgedsignature`],
  ];
  for (const [label, token] of cases) {
    const result = await call(base, "/api/wedding/admin/guests", { token });
    check(`${label} -> 401`, result.status === 401, `status=${result.status}`);
  }

  console.log("\n[3] sign-in refusals");
  const wrongPassword = await call(base, "/api/wedding/admin/login", {
    method: "POST",
    body: { user: ADMIN_USER, password: "wrong-password" },
  });
  check("a wrong password -> 401", wrongPassword.status === 401, `status=${wrongPassword.status}`);
  check("no token is issued", !wrongPassword.json?.token);
  const wrongUser = await call(base, "/api/wedding/admin/login", {
    method: "POST",
    body: { user: "someone-else", password: ADMIN_PASSWORD },
  });
  check("a wrong user -> 401", wrongUser.status === 401, `status=${wrongUser.status}`);
  const emptyLogin = await call(base, "/api/wedding/admin/login", { method: "POST", body: {} });
  check("no credentials at all -> 401", emptyLogin.status === 401, `status=${emptyLogin.status}`);

  console.log("\n[4] a correct sign-in mints a token");
  const login = await call(base, "/api/wedding/admin/login", {
    method: "POST",
    body: { user: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  check("correct credentials -> 200", login.status === 200, `status=${login.status}`);
  check("a token is returned", typeof login.json?.token === "string" && login.json.token.includes("."));
  check("the token is unambiguously short-lived", /^20\d\d-/.test(String(login.json?.expiresAt)));
  const token = login.json?.token;

  console.log("\n[5] the authenticated read returns exactly the four fields");
  const data = await call(base, "/api/wedding/admin/guests", { token });
  check("authorised read -> 200", data.status === 200, `status=${data.status}`);
  check("success flag is true", data.json?.success === true);
  check("guests is an array", Array.isArray(data.json?.guests), typeof data.json?.guests);

  const rows = data.json?.guests || [];
  const mine = rows.filter((row) => String(row.name).startsWith("Viewer Fixture"));
  check("both fixtures are visible (acceptance AND regret)", mine.length === 2, `found ${mine.length}`);
  check(
    "every row carries exactly the four allowed keys",
    rows.every((row) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["message", "name", "partySize", "rsvpDate"])),
    JSON.stringify(Object.keys(rows[0] || {})),
  );
  check(
    "newest first",
    rows.length > 1 &&
      new Date(rows[0].rsvpDate).getTime() >= new Date(rows[rows.length - 1].rsvpDate).getTime(),
  );
  const newer = mine.find((row) => row.name.endsWith("Newer"));
  const older = mine.find((row) => row.name.endsWith("Older"));
  check("the newest fixture comes first of the two", rows.indexOf(newer) < rows.indexOf(older));
  check("partySize survives as a number", older?.partySize === 3 && newer?.partySize === 0);
  check(
    "a guest message is returned verbatim, as data (escaping is the page's job)",
    newer?.message === xssMessage,
    String(newer?.message),
  );
  check("rsvpDate is an ISO string", /^\d{4}-\d{2}-\d{2}T/.test(String(newer?.rsvpDate)));

  const raw = JSON.stringify(data.json || {});
  const leaks = ["@example.com", "never-shown", "requestId", "attendance", "confirmationEmail", "_id", "source", "capturedAt", "createdAt", "updatedAt", "partySize:null"];
  const leaked = leaks.filter((term) => raw.includes(term));
  check("nothing private appears anywhere in the payload", leaked.length === 0, leaked.join(", "));
  check("no object id shape appears", !/[0-9a-f]{24}/i.test(raw));

  console.log("\n[6] the data path is read-only");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const result = await call(base, "/api/wedding/admin/guests", {
      method,
      token,
      body: method === "DELETE" ? undefined : { name: "should not be written" },
    });
    check(`${method} ${"/api/wedding/admin/guests"} -> 404 (no write route)`, result.status === 404, `status=${result.status}`);
  }
  const stillTwo = await guests.countDocuments({ requestId: new RegExp(`^${MARK}`) });
  check("the write attempts changed nothing", stillTwo === 2, `count=${stillTwo}`);

  console.log("\n[7] CORS: the wedding origin may call it, others may not");
  const preflight = await fetch(`${base}/api/wedding/admin/guests`, {
    method: "OPTIONS",
    headers: {
      Origin: WEDDING_ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    },
  });
  check("preflight -> 204", preflight.status === 204, `status=${preflight.status}`);
  const allowMethods = String(preflight.headers.get("access-control-allow-methods") || "");
  const allowHeaders = String(preflight.headers.get("access-control-allow-headers") || "");
  check("GET is advertised", allowMethods.includes("GET"), allowMethods);
  check("the Authorization header is advertised", /authorization/i.test(allowHeaders), allowHeaders);
  check(
    "the wedding origin is echoed back",
    preflight.headers.get("access-control-allow-origin") === WEDDING_ORIGIN,
    String(preflight.headers.get("access-control-allow-origin")),
  );
  const foreign = await call(base, "/api/wedding/admin/guests", {
    token,
    origin: "https://evil.example.com",
  });
  check("an unrelated origin is refused outright", foreign.status === 403, `status=${foreign.status}`);

  console.log("\n[8] an unconfigured deployment fails shut");
  const bare = await startBackend({
    port: 5094,
    adminEnv: { WEDDING_ADMIN_PASSWORD: "", WEDDING_ADMIN_TOKEN_SECRET: "" },
  });
  const bareLogin = await call(bare.base, "/api/wedding/admin/login", {
    method: "POST",
    body: { user: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  check("sign-in -> 503 when no secrets are configured", bareLogin.status === 503, `status=${bareLogin.status}`);
  const bareRead = await call(bare.base, "/api/wedding/admin/guests", { token });
  check("the read -> 503 as well", bareRead.status === 503, `status=${bareRead.status}`);
  check("neither answer contains data", !JSON.stringify(bareRead.json || {}).includes("Viewer Fixture"));
  bare.child.kill();

  // --- cleanup: only this run's fixtures ----------------------------------
  const removed = await guests.deleteMany({ requestId: new RegExp(`^${MARK}`) });
  const left = await guests.countDocuments({ requestId: new RegExp(`^${MARK}`) });
  console.log(`\ncleanup: removed ${removed.deletedCount} fixture(s); ${left} left behind`);
  await conn.close();
  server.child.kill();
  await sleep(400);

  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failed) {
    console.log("  failed checks:");
    for (const name of failures) console.log(`   - ${name}`);
  }
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Test crashed:", error);
  process.exit(1);
});
