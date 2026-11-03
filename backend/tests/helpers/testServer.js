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
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import mongoose from "mongoose";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(here, "..", "..");

/**
 * Shared mock-Firebase boot configuration.
 *
 * When the spawned backend is started with `fbMock: true` in the options of
 * `startTestServer`, the process is given:
 *   - a structurally valid DUMMY service account (never a real key),
 *   - the `twiller-bdc11` project id,
 *   - a rewrite-able token->identity map file (MOCK_FIREBASE_MAP_PATH), and
 *   - the NODE_OPTIONS --import hook that redirects `firebase-admin` imports
 *     to tests/helpers/mockFirebaseAdminImpl.mjs.
 *
 * This is the SAME mechanism the feature4 / feature5 suites use, so the
 * secure-auth suites can exercise real token verification without touching
 * production code or the real Firebase project.
 */
const DUMMY_SA = JSON.stringify({
  type: "service_account",
  project_id: "twiller-bdc11",
  private_key_id: "test",
  private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
  client_email: "test@twiller-test.iam.gserviceaccount.com",
  client_id: "1",
});

export function fbMockEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twiller-fbmock-"));
  const mapPath = path.join(dir, "map.json");
  fs.writeFileSync(mapPath, JSON.stringify(extra.map || {}));
  return {
    mapPath,
    setMap: (m) => fs.writeFileSync(mapPath, JSON.stringify(m)),
    env: {
      FIREBASE_SERVICE_ACCOUNT_JSON: DUMMY_SA,
      FIREBASE_PROJECT_ID: "twiller-bdc11",
      MOCK_FIREBASE_MAP_PATH: mapPath,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import ${pathToFileURL(path.join(here, "fbMockRegister.mjs")).href}`.trim(),
    },
  };
}

/** Strip all Firebase configuration so the backend fails closed (503). */
export function fbDisabledEnv() {
  return {
    FIREBASE_SERVICE_ACCOUNT_JSON: "",
    FIREBASE_SERVICE_ACCOUNT_PATH: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    FIREBASE_PROJECT_ID: "twiller-bdc11",
  };
}

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
/**
 * Boots a throwaway backend on a spare port, bound to the test database.
 *
 * Options:
 *   fbMock  - true: boot with the mock Firebase Admin (dummy service account
 *              + rewrite-able token map). Returns `setMap`/`mapPath` for the
 *              test to swap identities at runtime; `tokenApi` sends requests
 *              with `Authorization: Bearer <token>`.
 *   fbDisabled - true: boot with NO Firebase configuration so every
 *              protected route fails closed with 503 auth-unavailable.
 *   env - extra environment overrides for the spawned process.
 */
export async function startTestServer(options = {}) {
  const port = Number(options.port || process.env.TEST_PORT || 5097);
  const realMongoUrl = process.env.MONOGDB_URL || process.env.MONGODB_URL;
  const mongoUrl = process.env.TEST_MONGO_URL || buildTestMongoUrl(realMongoUrl);

  let mock = null;
  let extraEnv = options.env || {};
  if (options.fbMock) {
    mock = fbMockEnv({ map: options.map || {} });
    extraEnv = { ...mock.env, ...extraEnv };
  }
  if (options.fbDisabled) {
    extraEnv = { ...fbDisabledEnv(), ...extraEnv };
  }

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
      ...extraEnv,
    },
    stdio: "ignore",
  });

  const base = `http://localhost:${port}`;
  const up = await waitForServer(`${base}/`);
  if (!up) {
    child.kill();
    throw new Error(`test backend failed to start on ${base} (db: ${mongoUrl})`);
  }

  /** Request with the same JSON contract, plus an optional bearer token. */
  async function api(path, { method = "GET", body, token } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain-text response */
    }
    return { status: res.status, body: json, text };
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

  return {
    base,
    port,
    mongoUrl,
    stop,
    api,
    ...(mock ? { setMap: mock.setMap, mapPath: mock.mapPath } : {}),
  };
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