/**
 * Twiller 2.0 - Feature 4 (phase 2): frontend non-JSON response handling.
 *
 * WHY THIS EXISTS
 * ---------------
 * The language-switch OTP client is a JSON API client. The backend now
 * guarantees a JSON error contract (backend/index.js), but the client must
 * still behave sanely when the response is NOT JSON - e.g. an HTML error
 * page from a proxy or gateway, plain text, or an empty body. Before this
 * fix, reading `.error` off a string body yielded `undefined`, so the OTP
 * dialog could render an EMPTY error message (the user saw nothing at all).
 *
 * WHAT IT PROVES
 *   - A non-JSON (plain text) body becomes a readable, non-empty message.
 *   - An HTML error page never reaches the UI as raw markup.
 *   - A JSON error body still wins and is preserved verbatim (status, code,
 *     retryAfterSeconds, attemptsRemaining).
 *   - A body with no usable message falls back to the generic message.
 *   - A network failure (server down) still reports status 0 / NETWORK.
 *   - The success path is unaffected.
 *
 * HOW TO RUN
 *   cd twiller
 *   node tests/languageOtpErrorContract.test.ts
 *
 * No test framework is installed or required - Node 24 runs TypeScript
 * directly via type stripping, so this file uses a tiny `check()` helper.
 * Exits 0 on success, 1 on any failure.
 *
 * The test starts a REAL local HTTP server that answers with the raw bodies
 * under test, so the actual axios client (and its actual parsing behaviour)
 * is exercised - not a hand-written mock.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/**
 * `LanguageOtpResult` is a discriminated union, so `res.error` only exists on
 * the failure branch. These helpers read the failure payload without forcing
 * a narrowing dance at every call site.
 */
type ApiErrorPayload = {
  status: number;
  code?: string;
  error: string;
  retryAfterSeconds?: number;
  attemptsRemaining?: number;
};

function apiError(res: { ok: boolean }): ApiErrorPayload | undefined {
  return (res as { error?: ApiErrorPayload }).error;
}

function apiData(res: { ok: boolean }): unknown {
  return (res as { data?: unknown }).data;
}

/** The human-readable error message, or "" when there is none. */
function errorMessage(res: { ok: boolean }): string {
  const e = apiError(res);
  return typeof e?.error === "string" ? e.error : "";
}


/**
 * Start a real HTTP server that answers every request with the same
 * (status, contentType, rawBody) triple. Using a real socket means the
 * actual axios response parsing is exercised.
 */
type Responder = {
  status: number;
  contentType: string;
  body: string;
};

async function startServer(responder: Responder) {
  const server = http.createServer((_req, res) => {
    res.writeHead(responder.status, {
      "Content-Type": responder.contentType,
    });
    res.end(responder.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Point the axios instance at a different origin for one scenario. */
async function withBackend(base: string) {
  const mod = await import("../src/lib/axiosInstance.js");
  const instance = mod.default;
  const previous = instance.defaults.baseURL;
  instance.defaults.baseURL = base;
  return {
    instance,
    restore: () => {
      instance.defaults.baseURL = previous;
    },
  };
}

async function main() {
  console.log("\nTwiller 2.0 - Feature 4: frontend non-JSON response handling");
  console.log("==================================================\n");

  const otp = await import("../src/lib/languageOtp.ts");

  /* ------------------------------------------------------------------ */
  /* [1] A plain-text (non-JSON) error body.                             */
  /* ------------------------------------------------------------------ */
  console.log("[1] PLAIN TEXT ERROR BODY");
  {
    const server = await startServer({
      status: 502,
      contentType: "text/plain",
      body: "upstream server is unavailable",
    });
    const { restore } = await withBackend(server.base);
    const res = await otp.requestLanguageOtp("token", "fr");
    restore();
    await server.stop();

    check("request failed as expected", res.ok === false, JSON.stringify(res));
    check("status is preserved (502)", res.status === 502, String(res.status));
    check(
      "the plain-text body becomes the error message",
      apiError(res)?.error === "upstream server is unavailable",
      String(apiError(res)?.error)
    );
    check(
      "the message is not empty (this was the original bug)",
      errorMessage(res).length > 0,
      String(apiError(res)?.error)
    );
  }


  /* ------------------------------------------------------------------ */
  /* [2] An HTML error page must never reach the UI.                     */
  /* ------------------------------------------------------------------ */
  console.log("\n[2] HTML ERROR PAGE");
  {
    const server = await startServer({
      status: 504,
      contentType: "text/html",
      body:
        "<!DOCTYPE html><html><head><title>504</title></head><body><h1>Gateway Timeout</h1></body></html>",
    });
    const { restore } = await withBackend(server.base);
    const res = await otp.requestLanguageOtp("token", "fr");
    restore();
    await server.stop();

    check("request failed as expected", res.ok === false, JSON.stringify(res));
    check("status is preserved (504)", res.status === 504, String(res.status));
    check(
      "the HTML page is not used as the message",
      !String(apiError(res)?.error).includes("<"),
      String(apiError(res)?.error)
    );
    check(
      "the HTML page is not used as the message (no doctype/html)",
      !/doctype|<html/i.test(String(apiError(res)?.error)),
      String(apiError(res)?.error)
    );
    check(
      "a generic fallback message is used instead",
      errorMessage(res).length > 0,
      String(apiError(res)?.error)
    );
  }


  /* ------------------------------------------------------------------ */
  /* [3] The documented JSON error shape still wins.                      */
  /* ------------------------------------------------------------------ */
  console.log("\n[3] JSON ERROR BODY (unchanged behaviour)");
  {
    const payload = {
      error: "Too many attempts. Try again in 42 seconds.",
      code: "too-many-attempts",
      retryAfterSeconds: 42,
      attemptsRemaining: 0,
    };
    const server = await startServer({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
    const { restore } = await withBackend(server.base);
    const res = await otp.verifyLanguageOtp("token", "fr", "123456");
    restore();
    await server.stop();

    check("verify failed as expected", res.ok === false, JSON.stringify(res));
    check("status is preserved (429)", res.status === 429, String(res.status));
    check(
      "the JSON error message is used verbatim",
      apiError(res)?.error === payload.error,
      String(apiError(res)?.error)
    );
    check(
      "the JSON code is preserved",
      apiError(res)?.code === "too-many-attempts",
      String(apiError(res)?.code)
    );
    check(
      "retryAfterSeconds is preserved",
      apiError(res)?.retryAfterSeconds === 42,
      String(apiError(res)?.retryAfterSeconds)
    );
    check(
      "attemptsRemaining is preserved",
      apiError(res)?.attemptsRemaining === 0,
      String(apiError(res)?.attemptsRemaining)
    );
  }


  /* ------------------------------------------------------------------ */
  /* [4] A JSON body with no message falls back to the generic message.  */
  /* ------------------------------------------------------------------ */
  console.log("\n[4] JSON BODY WITHOUT A MESSAGE");
  {
    const server = await startServer({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ unexpected: true }),
    });
    const { restore } = await withBackend(server.base);
    const res = await otp.verifyLanguageOtp("token", "fr", "123456");
    restore();
    await server.stop();

    check("verify failed as expected", res.ok === false, JSON.stringify(res));
    check("status is preserved (500)", res.status === 500, String(res.status));
    check(
      "a non-empty fallback message is produced",
      errorMessage(res).length > 0,
      String(apiError(res)?.error)
    );
    check(
      "the message does not leak the raw payload",
      !String(apiError(res)?.error).includes("unexpected"),
      String(apiError(res)?.error)
    );
  }

  /* ------------------------------------------------------------------ */
  /* [5] An empty body.                                                  */
  /* ------------------------------------------------------------------ */
  console.log("\n[5] EMPTY BODY");
  {
    const server = await startServer({
      status: 500,
      contentType: "text/plain",
      body: "",
    });
    const { restore } = await withBackend(server.base);
    const res = await otp.requestLanguageOtp("token", "fr");
    restore();
    await server.stop();

    check("request failed as expected", res.ok === false, JSON.stringify(res));
    check(
      "an empty body still yields a non-empty message",
      errorMessage(res).length > 0,
      String(apiError(res)?.error)
    );
  }


  /* ------------------------------------------------------------------ */
  /* [6] The success path is unaffected.                                 */
  /* ------------------------------------------------------------------ */
  console.log("\n[6] SUCCESS PATH");
  {
    const payload = {
      sent: true,
      channel: "email",
      destination: "a***@e***.com",
    };
    const server = await startServer({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
    const { restore } = await withBackend(server.base);
    const res = await otp.requestLanguageOtp("token", "fr");
    restore();
    await server.stop();

    check("the request succeeded", res.ok === true, JSON.stringify(res));
    check("the status is 200", res.status === 200, String(res.status));
    check(
      "the payload is passed through untouched",
      JSON.stringify(apiData(res)) === JSON.stringify(payload),
      JSON.stringify(apiData(res))
    );
  }


  /* ------------------------------------------------------------------ */
  /* [7] A network failure (nothing listening).                          */
  /* ------------------------------------------------------------------ */
  console.log("\n[7] NETWORK FAILURE");
  {
    // Bind and immediately close to obtain a port that is (almost surely) free.
    const server = await startServer({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
    const base = server.base;
    await server.stop();

    const { restore } = await withBackend(base);
    const res = await otp.requestLanguageOtp("token", "fr");
    restore();

    check("the request failed as expected", res.ok === false, JSON.stringify(res));
    check("status is 0 for a network failure", res.status === 0, String(res.status));
    check("the code is NETWORK", apiError(res)?.code === "NETWORK", String(apiError(res)?.code));
    check(
      "a helpful network message is produced",
      errorMessage(res).length > 0,
      String(apiError(res)?.error)
    );
  }

  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failures.length) console.log(`  failures: ${failures.join(" | ")}`);
  console.log("==================================================\n");

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nFrontend error-contract suite crashed:", err);
  process.exit(1);
});