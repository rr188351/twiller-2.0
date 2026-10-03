/**
 * Production-mode safety check.
 *
 * Starts the backend with NODE_ENV=production on a spare port and proves that
 * no OTP / devCode is ever returned to the client, and that nothing secret is
 * written to the server log.
 *
 * Run:  node tests/production-guard.test.js
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { buildTestMongoUrl } from "./helpers/testServer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5099;
const BASE = `http://localhost:${PORT}`;
// Isolated test database - this suite must never write to the development DB.
const MONGO_URL =
  process.env.TEST_MONGO_URL ||
  buildTestMongoUrl(process.env.MONOGDB_URL || process.env.MONGODB_URL);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
};

async function waitForServer(url, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const server = spawn(process.execPath, ["index.js"], {
  cwd: path.join(here, ".."),
  env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), MONOGDB_URL: MONGO_URL, MONGODB_URL: MONGO_URL },
});

let log = "";
server.stdout.on("data", (d) => (log += d.toString()));
server.stderr.on("data", (d) => (log += d.toString()));

async function main() {
  console.log("\nTwiller 2.0 - production guard check");
  console.log(`Starting backend on ${BASE} with NODE_ENV=production\n`);

  const up = await waitForServer(`${BASE}/`);
  if (!up) {
    console.log("  FAIL  backend did not start");
    process.exit(1);
  }
  console.log("  ....  backend started\n");

  const stamp = Date.now();
  const email = `prod.${stamp}@twiller.test`;
  const phone = `9196${String(stamp).slice(-7)}`;

  const post = async (p, body) =>
    (
      await fetch(`${BASE}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();

  await post("/register", {
    username: `prod_${stamp}`,
    displayName: "prod",
    avatar: "https://example.com/a.png",
    email,
    phone,
  });

  console.log("[1] phone channel must NOT return devCode in production");
  const res = await post("/auth/forgot-password/request", { identifier: phone });
  check("response has no devCode field", !("devCode" in (res || {})), JSON.stringify(res));
  check("response does not leak an OTP", !JSON.stringify(res).match(/\b\d{6}\b/));

  console.log("\n[2] unknown-account hint must NOT be exposed in production");
  const res2 = await post("/auth/forgot-password/request", { identifier: `ghost.${stamp}@x.test` });
  check("no devHint field in production", !("devHint" in (res2 || {})), JSON.stringify(res2));

  console.log("\n[3] mock provider log must not print the OTP in production");
  check("OTP body hidden in production log", !log.includes("verification code is"), log.slice(-300));

  console.log(`\n==================================================`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log("==================================================\n");

  server.kill();
  // Drop the isolated test database; the development DB is untouched.
  try {
    await mongoose.connect(MONGO_URL);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
