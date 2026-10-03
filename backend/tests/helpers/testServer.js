/**
 * Shared test-server helper.
 *
 * WHY THIS EXISTS
 * ---------------
 * The regression / feature3 / feature6 suites used to call
 * `http://localhost:5000` - the DEVELOPMENT backend. That backend reads
 * MONOGDB_URL=mongodb://127.0.0.1:27017/twiller, so every test was writing
 * fixture users and tweets straight into the development database, and
 * `GET /post` returns every tweet unfiltered - so test tweets appeared in the
 * developer's feed.
 *
 * This helper fixes that by giving the suites their OWN backend process,
 * bound to a SEPARATE test database (`twiller_test`), and by dropping that
 * test database afterwards so nothing accumulates.
 *
 * The development database is never touched.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(here, "..", "..");

/** Default test database name. Deliberately different from `twiller`. */
export const TEST_DB_NAME = process.env.TEST_DB_NAME || "twiller_test";

/**
 * Derives the test Mongo URL from the real one by swapping the database name,
 * so tests keep the same host/credentials but never share data.
 * e.g. mongodb://127.0.0.1:27017/twiller  ->  mongodb://127.0.0.1:27017/twiller_test
 */
export function buildTestMongoUrl(realUrl) {
  const url = String(realUrl);
  // Strip an existing database name, then append the test one.
  const withoutDb = url.replace(/\/[^/?]*(\?|$)/, "$1");
  return `${withoutDb.replace(/\/$/, "")}/${TEST_DB_NAME}`;
}

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Boots a throwaway backend on a spare port, bound to the test database.
 *
 * @returns {Promise<{base:string, port:number, mongoUrl:string, stop:() => Promise<void>}>}
 */
export async function startTestServer() {
  const port = Number(process.env.TEST_PORT || 5097);
  const realMongoUrl = process.env.MONOGDB_URL || process.env.MONGODB_URL;
  const mongoUrl = process.env.TEST_MONGO_URL || buildTestMongoUrl(realMongoUrl);

  // Start from a clean slate every run.
  await mongoose.connect(mongoUrl);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  const child = spawn(process.execPath, ["index.js"], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MONOGDB_URL: mongoUrl,
      MONGODB_URL: mongoUrl,
      NODE_ENV: "development",
    },
    stdio: "ignore",
  });

  const base = `http://localhost:${port}`;
  const up = await waitForServer(`${base}/`);
  if (!up) {
    child.kill();
    throw new Error(`test backend failed to start on ${base} (db: ${mongoUrl})`);
  }

  /** Kills the backend and deletes the whole test database. */
  async function stop() {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try {
      await mongoose.connect(mongoUrl);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    } catch {
      /* best effort cleanup */
    }
  }

  return { base, port, mongoUrl, stop };
}

/**
 * Removes ONLY the documents a test suite created, matched by strict email /
 * content prefixes. Used as a safety net in addition to dropping the whole
 * test database. Never matches real accounts or real tweets.
 */
export async function removeTestFixtures(mongoUrl, emailPrefixes, contentPrefixes) {
  await mongoose.connect(mongoUrl);
  const db = mongoose.connection.db;
  const users = db.collection("users");
  const tweets = db.collection("tweets");
  const resets = db.collection("passwordresets");

  const emailRe = new RegExp(`^(${emailPrefixes.join("|")})`);
  const contentRe = new RegExp(`^(${contentPrefixes.join("|")})`);

  const userIds = (await users.find({ email: emailRe }).toArray()).map((u) => u._id);

  const result = {
    users: await users.deleteMany({ email: emailRe }),
    tweets: await tweets.deleteMany({ content: contentRe }),
    otherTweets: userIds.length ? await tweets.deleteMany({ author: { $in: userIds } }) : { deletedCount: 0 },
    resets: userIds.length ? await resets.deleteMany({ user: { $in: userIds } }) : { deletedCount: 0 },
  };

  await mongoose.disconnect();
  return result;
}

export default { startTestServer, removeTestFixtures, buildTestMongoUrl, TEST_DB_NAME };