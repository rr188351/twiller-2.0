/**
 * Twiller 2.0 - Feature 4 (phase 2): JSON error contract regression suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * The language-switch OTP flow is a JSON API. Before this contract existed,
 * Express answered an unknown route with an HTML page ("<html>...Cannot POST
 * /x...") and a malformed request body with an HTML 400 that embedded the
 * full stack trace. The frontend axios client then received a STRING instead
 * of an error object, so the OTP dialog could only show a generic message and
 * the real reason (bad JSON, unknown endpoint) was lost.
 *
 * WHAT IT PROVES
 *   - An unknown route answers 404 with a JSON body ({ error, code }).
 *   - A malformed JSON body answers 400 (body-parser's own status) with a
 *     JSON body ({ error, code: "invalid-json" }) - NOT 500.
 *   - The response Content-Type is JSON, never text/html.
 *   - No stack trace ever reaches the client.
 *   - The success path and the health check are untouched (plain text).
 *
 * Run:  node tests/feature4-json-errors.test.js
 *
 * DATABASE SAFETY
 *   Uses the shared test-server helper: its OWN backend process on a spare
 *   port, bound to the isolated `twiller_test` database. The development
 *   database is never touched.
 */

import "dotenv/config";
import { startTestServer } from "./helpers/testServer.js";

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
};

/**
 * Sends a RAW body string (needed to send deliberately malformed JSON) and
 * returns the parsed JSON body plus the raw text and headers.
 */
async function raw(base, path, { method = "GET", body, contentType } = {}) {
  const headers = {};
  if (contentType) headers["Content-Type"] = contentType;
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON - that is exactly what some assertions look for */
  }
  return {
    status: res.status,
    text,
    json,
    contentType: res.headers.get("content-type") || "",
  };
}


async function main() {
  const server = await startTestServer();
  const BASE = server.base;

  console.log(`\nTwiller 2.0 - Feature 4: JSON error contract`);
  console.log(`Target   : ${BASE}`);
  console.log(`Database : ${server.mongoUrl}  (isolated - development DB untouched)\n`);

  /* ------------------------------------------------------------------ */
  /* [1] Unknown route -> JSON 404.                                     */
  /* ------------------------------------------------------------------ */
  console.log("[1] UNKNOWN ROUTE");
  const notFound = await raw(BASE, "/definitely-not-a-real-route", { method: "GET" });
  check("unknown route returns 404", notFound.status === 404, `got ${notFound.status}`);
  check(
    "unknown route Content-Type is JSON",
    notFound.contentType.includes("application/json"),
    notFound.contentType
  );
  check("unknown route body parses as JSON", notFound.json !== null, notFound.text.slice(0, 120));
  check(
    "unknown route body has a human message",
    typeof notFound.json?.error === "string" && notFound.json.error.length > 0
  );
  check(
    "unknown route body has the not-found code",
    notFound.json?.code === "not-found",
    String(notFound.json?.code)
  );
  check(
    "unknown route body is not an HTML page",
    !notFound.text.trimStart().startsWith("<"),
    notFound.text.slice(0, 80)
  );

  /* ------------------------------------------------------------------ */
  /* [2] Malformed JSON body -> JSON 400 (NOT 500, NOT HTML).            */
  /* ------------------------------------------------------------------ */
  console.log("\n[2] MALFORMED JSON BODY");
  const malformed = await raw(BASE, "/auth/language/otp/request", {
    method: "POST",
    contentType: "application/json",
    body: '{"targetLocale": "fr",,}',
  });
  check(
    "malformed JSON keeps body-parser's 400 status",
    malformed.status === 400,
    `got ${malformed.status}`
  );
  check(
    "malformed JSON Content-Type is JSON",
    malformed.contentType.includes("application/json"),
    malformed.contentType
  );
  check("malformed JSON body parses as JSON", malformed.json !== null, malformed.text.slice(0, 120));
  check(
    "malformed JSON body has a human message",
    typeof malformed.json?.error === "string" && malformed.json.error.length > 0
  );
  check(
    "malformed JSON body has the invalid-json code",
    malformed.json?.code === "invalid-json",
    String(malformed.json?.code)
  );
  check(
    "malformed JSON does not leak a stack trace",
    !malformed.text.includes("SyntaxError") && !malformed.text.includes("node_modules"),
    malformed.text.slice(0, 160)
  );
  check(
    "malformed JSON body is not an HTML page",
    !malformed.text.trimStart().startsWith("<"),
    malformed.text.slice(0, 80)
  );

  /* ------------------------------------------------------------------ */
  /* [3] Truncated / non-JSON bodies are also JSON.                      */
  /* ------------------------------------------------------------------ */
  console.log("\n[3] OTHER MALFORMED BODIES");
  const truncated = await raw(BASE, "/auth/language/otp/verify", {
    method: "POST",
    contentType: "application/json",
    body: '{"targetLocale":"fr","otp":',
  });
  check("truncated JSON returns 400", truncated.status === 400, `got ${truncated.status}`);
  check("truncated JSON body parses as JSON", truncated.json !== null, truncated.text.slice(0, 120));
  check(
    "truncated JSON has the invalid-json code",
    truncated.json?.code === "invalid-json",
    String(truncated.json?.code)
  );

  const notJsonAtAll = await raw(BASE, "/register", {
    method: "POST",
    contentType: "application/json",
    body: "this is not json at all",
  });
  check("non-JSON body returns 400", notJsonAtAll.status === 400, `got ${notJsonAtAll.status}`);
  check("non-JSON body parses as JSON", notJsonAtAll.json !== null, notJsonAtAll.text.slice(0, 120));

  /* ------------------------------------------------------------------ */
  /* [4] The success path is untouched.                                 */
  /* ------------------------------------------------------------------ */
  console.log("\n[4] EXISTING BEHAVIOUR UNCHANGED");
  const health = await raw(BASE, "/");
  check("health check still returns 200", health.status === 200, `got ${health.status}`);
  check(
    "health check message unchanged",
    health.text.includes("Twiller backend is running successfully"),
    health.text.slice(0, 80)
  );

  // A real, well-formed request must still be handled by the normal route
  // (not swallowed by the new 404 handler): the OTP route answers 401 for a
  // missing token, which proves the route still exists and is reachable.
  const missingAuth = await raw(BASE, "/auth/language/otp/request", {
    method: "POST",
    contentType: "application/json",
    body: '{"targetLocale":"fr"}',
  });
  check(
    "the OTP route is still reachable (401 without a token, not 404)",
    missingAuth.status === 401,
    `got ${missingAuth.status}`
  );
  check(
    "the OTP route still answers with JSON",
    missingAuth.json !== null,
    missingAuth.text.slice(0, 120)
  );

  /* ------------------------------------------------------------------ */
  /* [5] Cleanup.                                                       */
  /* ------------------------------------------------------------------ */
  await server.stop();

  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failures.length) console.log(`  failures: ${failures.join(" | ")}`);
  console.log("==================================================\n");

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nJSON error contract suite crashed:", err);
  process.exit(1);
});
