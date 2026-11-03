/**
 * Database-name resolution for the Twiller backend.
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend connects with ONE URI taken from `MONOGDB_URL`. On Render that
 * URI is a `mongodb+srv://.../` string with an EMPTY database path, and the
 * MongoDB driver then falls back to its built-in default database name
 * ("test"). Real accounts therefore landed in `test.users` instead of
 * `twiller.users`.
 *
 * This module resolves the database name ONCE, deterministically:
 *   1. `MONGODB_DB` (explicit override, if set)      - deliberate escape hatch
 *   2. the database path already inside the URI      - never overridden, so
 *      isolated test databases keep working unchanged
 *   3. `DEFAULT_APP_DB_NAME` ("twiller")             - the application database
 *
 * SECURITY: this module only ever reads/produces the database NAME. Credentials,
 * hostnames and query options are ignored and are never returned or logged.
 */

/** The database every normal Twiller collection must live in. */
export const DEFAULT_APP_DB_NAME = "twiller";

/** Environment variable that can pin the database name explicitly. */
export const DB_NAME_ENV = "MONGODB_DB";

/**
 * Extracts the database name from a MongoDB connection string, or "" when the
 * URI carries no database path.
 *
 * Reserved characters in credentials must be percent-encoded in a MongoDB URI,
 * so the first "/" after the scheme is always the host/path separator.
 *
 * @param {string} uri
 * @returns {string}
 */
export function databaseNameFromUri(uri) {
  const raw = String(uri || "");
  if (!raw) return "";
  const schemeStripped = raw.replace(/^mongodb(\+srv)?:\/\//i, "");
  const slash = schemeStripped.indexOf("/");
  if (slash === -1) return "";
  const segment = schemeStripped.slice(slash + 1).split("?")[0];
  return segment ? decodeURIComponent(segment) : "";
}

/**
 * The database name to connect to.
 *
 * @param {string} uri  the connection string (MONOGDB_URL)
 * @param {Record<string,string|undefined>} [env]  environment (defaults to process.env)
 * @returns {string} a non-empty database name - never "test" unless explicitly configured
 */
export function resolveDatabaseName(uri, env = process.env) {
  const explicit = String((env && env[DB_NAME_ENV]) || "").trim();
  if (explicit) return explicit;
  const fromUri = databaseNameFromUri(uri);
  if (fromUri) return fromUri;
  return DEFAULT_APP_DB_NAME;
}

/** The MongoDB driver's own default database name - never valid in production. */
export const TEST_DB_NAME = "test";

/** True when a database name looks like a test/fixture database. */
export function isTestDatabaseName(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  return (
    n === TEST_DB_NAME ||
    n.endsWith("_test") ||
    n.startsWith("twiller_test") ||
    n.startsWith("twiller_langotp") ||
    n.startsWith("twiller_audio") ||
    n.startsWith("twiller_qa") ||
    n.startsWith("twiller_debug") ||
    n.startsWith("twiller_diag")
  );
}

/**
 * Guards a PRODUCTION boot against a test database.
 *
 * - The driver's default (`test`) is a HARD failure: that is exactly the silent
 *   fallback that sent real production writes into `test` when the URI carried
 *   no database path. Failing fast turns a silent data-routing bug into an
 *   obvious boot error.
 * - Any other test-looking name is allowed but REPORTED, so deliberate
 *   configurations (and the production-guard test) keep working.
 *
 * Outside production nothing is restricted: tests keep their isolated
 * databases (e.g. `twiller_test`).
 *
 * @param {string} dbName resolved database name
 * @param {Record<string,string|undefined>} [env]
 * @throws {Error} when NODE_ENV=production and the name is the driver default
 */
export function assertProductionDatabaseName(dbName, env = process.env) {
  const name = String(dbName || "").trim();
  const isProduction = String((env && env.NODE_ENV) || "").trim().toLowerCase() === "production";
  if (!isProduction) return { ok: true, warning: null };

  if (name === TEST_DB_NAME) {
    throw new Error(
      `Refusing to start: NODE_ENV=production but the selected MongoDB database is "${TEST_DB_NAME}" ` +
        `(the driver default). Set MONGODB_DB=twiller, or include /twiller in MONOGDB_URL, before deploying.`
    );
  }
  if (isTestDatabaseName(name)) {
    return { ok: true, warning: `the selected database "${name}" looks like a test database` };
  }
  return { ok: true, warning: null };
}

/**
 * Host only - the userinfo (credentials), database path and query options are
 * stripped, so this is safe to print in logs or paste into a report.
 */
export function sanitizeMongoHost(uri) {
  const raw = String(uri || "");
  if (!raw) return "(unset)";
  const stripped = raw.replace(/^mongodb(\+srv)?:\/\//i, "");
  const afterCredentials = stripped.includes("@") ? stripped.split("@").pop() : stripped;
  const host = afterCredentials.split("/")[0].split("?")[0];
  return host || "(unknown)";
}

export default {
  DEFAULT_APP_DB_NAME,
  DB_NAME_ENV,
  TEST_DB_NAME,
  databaseNameFromUri,
  resolveDatabaseName,
  isTestDatabaseName,
  assertProductionDatabaseName,
  sanitizeMongoHost,
};
