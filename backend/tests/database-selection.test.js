/**
 * Database-selection tests - application data must use `twiller`, never `test`.
 *
 * Run:  node tests/database-selection.test.js
 *
 * WHY
 * ---
 * The connection string used on Render is a `mongodb+srv://.../` URI with an
 * EMPTY database path. The MongoDB driver then falls back to its built-in
 * default database name (`test`), so real accounts were written to `test.users`
 * instead of `twiller.users`. These tests pin the fix:
 *
 *   [1] the resolver picks `twiller` when the URI has no database path
 *   [2] an explicit MONGODB_DB override wins
 *   [3] a database name already inside the URI is never overridden
 *       (so the isolated test databases keep working unchanged)
 *   [4] a spawned backend reports the selected database and the diagnostic
 *       leaks neither the URI nor credentials
 *   [5] a real register + tweet write lands in the configured database
 *
 * ISOLATION: the spawned backend uses an isolated `twiller_test` database that
 * is dropped afterwards. The `test` and `twiller` databases are never written.
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import {
  DEFAULT_APP_DB_NAME,
  databaseNameFromUri,
  resolveDatabaseName,
} from "../utils/dbName.js";
import { buildTestMongoUrl, TEST_DB_NAME, startTestServer } from "./helpers/testServer.js";

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

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function dropDatabase(url) {
  await mongoose.connect(url);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

async function main() {
  const baseUri =
    process.env.MONOGDB_URL ||
    process.env.MONGODB_URL ||
    "mongodb://127.0.0.1:27017/twiller";
  const mongoUrl = buildTestMongoUrl(baseUri);
  const isolatedDbName = databaseNameFromUri(mongoUrl);

  console.log("\nTwiller 2.0 - database selection (app DB must be `twiller`)");
  console.log(`Isolated test database: ${isolatedDbName}\n`);

  console.log("[1] resolver: a URI with no database path resolves to twiller");
  check(
    "srv + empty path -> twiller",
    resolveDatabaseName("mongodb+srv://user:pass@host/?retryWrites=true") === "twiller",
    resolveDatabaseName("mongodb+srv://user:pass@host/?retryWrites=true")
  );
  check(
    "srv + no slash at all -> twiller",
    resolveDatabaseName("mongodb+srv://user:pass@host") === "twiller"
  );
  check("empty URI -> twiller", resolveDatabaseName("") === "twiller");
  check("undefined URI -> twiller", resolveDatabaseName(undefined) === "twiller");
  check("never resolves to the driver default `test`", resolveDatabaseName("mongodb+srv://h/") !== "test");
  check("DEFAULT_APP_DB_NAME is twiller", DEFAULT_APP_DB_NAME === "twiller");

  console.log("\n[2] resolver: an explicit MONGODB_DB override wins");
  check(
    "override beats an empty URI path",
    resolveDatabaseName("mongodb+srv://h/", { MONGODB_DB: "twiller" }) === "twiller"
  );
  check(
    "override beats a URI database name",
    resolveDatabaseName("mongodb://h/test", { MONGODB_DB: "twiller" }) === "twiller"
  );

  console.log("\n[3] resolver: an existing URI database name is preserved");
  check(
    "mongodb://host:27017/twiller_test -> twiller_test",
    databaseNameFromUri("mongodb://127.0.0.1:27017/twiller_test") === "twiller_test"
  );
  check(
    "srv + query -> twiller_test",
    databaseNameFromUri("mongodb+srv://u:p@h/twiller_test?retryWrites=true") === "twiller_test"
  );
  check(
    "resolver keeps the URI name when there is no override",
    resolveDatabaseName("mongodb://127.0.0.1:27017/twiller_test", {}) === "twiller_test"
  );
  check(
    "credentials never leak into the resolved value",
    !databaseNameFromUri("mongodb+srv://secretUser:secretPass@h/twiller?x=1").includes("secret")
  );

  console.log("\n[4] spawned backend: safe startup diagnostic");
  await dropDatabase(mongoUrl);
  const port = Number(process.env.TEST_DB_SELECTION_PORT || 5098);
  const child = spawn(process.execPath, ["index.js"], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MONOGDB_URL: mongoUrl,
      MONGODB_URL: mongoUrl,
      NODE_ENV: "development",
      // Force the resolver to use the URI path (not an outside override).
      MONGODB_DB: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  const started = await waitFor(`http://localhost:${port}/`);
  check("backend started", started, log.slice(-300));

  const dbLine = log.split("\n").find((l) => l.includes("[db] using database")) || "";
  check(
    "startup log reports the URI's database",
    dbLine.includes(`"${isolatedDbName}"`),
    dbLine.trim() || "no [db] line"
  );
  check(
    "diagnostic never prints the URI or credentials",
    dbLine.length > 0 && !dbLine.includes("mongodb") && !dbLine.includes("@"),
    dbLine.trim()
  );

  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  await dropDatabase(mongoUrl);

  console.log("\n[5] real user/profile and tweet writes use the configured database");
  const server = await startTestServer({ fbMock: true });
  try {
    const stamp = Date.now();
    const email = `dbsel.${stamp}@twiller.test`;
    const uid = `dbsel-uid-${stamp}`;
    const token = `dbsel-tok-${stamp}`;
    const tweetContent = `dbsel fixture tweet ${stamp}`;
    server.setMap({ [token]: { uid, email, email_verified: true } });

    const reg = await server.api("/register", {
      method: "POST",
      token,
      body: {
        username: `dbsel${stamp}`,
        displayName: "DB Selection",
        avatar: "https://example.com/avatar.png",
        email,
      },
    });
    check("register succeeds", reg.status === 201 || reg.status === 200, `got ${reg.status}`);

    const post = await server.api("/post", {
      method: "POST",
      token,
      body: { content: tweetContent },
    });
    check("tweet creation succeeds", post.status === 201, `got ${post.status}`);

    await mongoose.connect(server.mongoUrl);
    const db = mongoose.connection;
    check("connected database is the configured one", db.name === TEST_DB_NAME, db.name);
    check("normal writes never land in `test`", db.name !== "test", db.name);
    check("normal writes never land in production `twiller`", db.name !== "twiller", db.name);

    const userCount = await db.collection("users").countDocuments({ email });
    check("user profile written to the configured database", userCount === 1, `count=${userCount}`);
    const tweetCount = await db.collection("tweets").countDocuments({ content: tweetContent });
    check("tweet written to the configured database", tweetCount === 1, `count=${tweetCount}`);
    await mongoose.disconnect();
  } finally {
    await server.stop();
  }

  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failed > 0) console.log(`  failures: ${failures.join(" | ")}`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nDATABASE-SELECTION SUITE ERROR:", error);
  process.exit(1);
});
