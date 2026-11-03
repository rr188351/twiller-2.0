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

export default {
  DEFAULT_APP_DB_NAME,
  DB_NAME_ENV,
  databaseNameFromUri,
  resolveDatabaseName,
};
