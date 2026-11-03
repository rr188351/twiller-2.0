/**
 * Twiller 2.0 - REGRESSION test suite
 *
 * Purpose: prove that the internship features did NOT break any existing
 * Twiller functionality. It exercises every endpoint that existed in the
 * original training project:
 *
 *   GET  /                      health check
 *   POST /register              create user profile
 *   GET  /loggedinuser          fetch profile by email
 *   PATCH /userupdate/:email    update profile
 *   POST /post                  create a tweet
 *   GET  /post                  list tweets (with author populated)
 *   POST /like/:tweetid         like a tweet
 *   POST /retweet/:tweetid      retweet a tweet
 *
 * Run:  node tests/regression.test.js
 *
 * DATABASE SAFETY
 *   This suite starts its OWN backend process on a spare port, bound to a
 *   SEPARATE test database (`twiller_test`). The development database is never
 *   read or written, and the test database is dropped when the run finishes.
 *   It also deletes only the fixtures it created.
 */

import "dotenv/config";
import mongoose from "mongoose";
import { startTestServer, removeTestFixtures } from "./helpers/testServer.js";

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

async function call(base, path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Read the body ONCE, then decide whether it is JSON.
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text response, e.g. the GET / health check */
  }
  return { status: res.status, body: json, text };
}

async function main() {
  // The profile/tweet routes are now secured by requireFirebaseAuth, so the
  // suite boots the mock-Firebase backend (dummy service account, rewriteable
  // token map) exactly like the feature3/feature6 suites.
  const server = await startTestServer({ fbMock: true });
  const BASE = server.base;

  console.log(`\nTwiller 2.0 - regression suite (original functionality)`);
  console.log(`Target   : ${BASE}`);
  console.log(`Database : ${server.mongoUrl}  (isolated - development DB untouched)\n`);

  const stamp = Date.now();
  const email = `regress.${stamp}@twiller.test`;
  const uid = `regress-uid-${stamp}`;
  const token = `regress-tok-${stamp}`;
  server.setMap({ [token]: { uid, email, email_verified: true } });

  console.log("[0] secured routes reject unauthenticated requests");
  const anonReg = await call(BASE, "/register", { method: "POST", body: { username: "x", email } });
  check("register without a token returns 401", anonReg.status === 401, `got ${anonReg.status}`);
  check("401 carries the auth-required code", anonReg.body?.code === "auth-required", JSON.stringify(anonReg.body));
  const anonProfile = await call(BASE, "/loggedinuser");
  check("profile lookup without a token returns 401", anonProfile.status === 401, `got ${anonProfile.status}`);
  const anonPost = await call(BASE, "/post", { method: "POST", body: { author: "x", content: "x" } });
  check("tweet creation without a token returns 401", anonPost.status === 401, `got ${anonPost.status}`);

  console.log("[1] GET /");
  const health = await call(BASE, "/");
  check("health endpoint responds 200", health.status === 200, `got ${health.status}`);
  check("health message unchanged", health.text.includes("Twiller backend is running successfully"));

  console.log("\n[2] POST /register (verified Firebase token attached)");
  const reg = await call(BASE, "/register", {
    method: "POST",
    token,
    body: { username: `regress_${stamp}`, displayName: "Regression User", avatar: "https://example.com/a.png", email },
  });
  check("register returns 201", reg.status === 201, `got ${reg.status}`);
  const userId = reg.body?._id;
  check("register returns the original shape", Boolean(userId && reg.body.username && reg.body.email));
  check("new phone field defaults cleanly", reg.body?.phone === "");
  check("new profile carries the verified Firebase UID", reg.body?.firebaseUid === uid, JSON.stringify(reg.body?.firebaseUid));
  check("new profile carries the project id", reg.body?.firebaseProjectId === "twiller-bdc11", JSON.stringify(reg.body?.firebaseProjectId));

  console.log("\n[3] GET /loggedinuser (token-resolved)");
  const login = await call(BASE, "/loggedinuser", { token });
  check("profile lookup returns 200", login.status === 200, `got ${login.status}`);
  check("profile matches the registered user", login.body?._id === userId);
  // A client-supplied email query no longer acts as identity: an unknown token
  // is still rejected with 401 even when the query email matches the profile.
  const spoofed = await call(BASE, `/loggedinuser?email=${encodeURIComponent(email)}`, { token: "regress-unknown-token" });
  check("unknown token rejected with 401 despite matching email query", spoofed.status === 401, `got ${spoofed.status}`);

  console.log("\n[4] PATCH /userupdate/:email (token must own the email)");
  const upd = await call(BASE, `/userupdate/${encodeURIComponent(email)}`, {
    method: "PATCH",
    token,
    body: { bio: "regression bio", location: "Test City", website: "example.com" },
  });
  check("profile update returns 200", upd.status === 200, `got ${upd.status}`);
  check("bio was saved", upd.body?.bio === "regression bio");
  check("location was saved", upd.body?.location === "Test City");

  console.log("\n[5] POST /post (acting user from the verified token)");
  const post = await call(BASE, "/post", {
    method: "POST",
    token,
    body: { author: userId, content: `regression tweet ${stamp}`, image: "" },
  });
  check("tweet creation returns 201", post.status === 201, `got ${post.status}`);
  const tweetId = post.body?._id;
  check("tweet returns the original shape", Boolean(tweetId && post.body.content && post.body.likes === 0));
  check(
    "tweet author is the token's user (expanded, like GET /post)",
    String(post.body?.author?._id ?? post.body?.author) === String(userId),
    JSON.stringify(post.body?.author)
  );
  check(
    "created tweet author is renderable (name + avatar present)",
    typeof post.body?.author?.displayName === "string" &&
      post.body.author.displayName.length > 0 &&
      typeof post.body.author.avatar === "string",
    JSON.stringify(post.body?.author)
  );

  console.log("\n[6] GET /post");
  const list = await call(BASE, "/post");
  check("tweet list returns 200", list.status === 200, `got ${list.status}`);
  check("list is an array", Array.isArray(list.body) && list.body.length > 0);
  const found = list.body.find((t) => t._id === tweetId);
  check("new tweet appears in the feed", Boolean(found));
  check("author is populated (original .populate behaviour)", found?.author?.username === `regress_${stamp}`);

  console.log("\n[7] POST /like/:tweetid (acting user from the verified token)");
  const like = await call(BASE, `/like/${tweetId}`, { method: "POST", token, body: { userId } });
  check("like returns 200", like.status === 200, `got ${like.status}`);
  check("likes incremented", like.body?.likes === 1, `got ${like.body?.likes}`);
  check("likedBy contains the user", like.body?.likedBy?.includes(userId));

  console.log("\n[8] POST /retweet/:tweetid (acting user from the verified token)");
  const rt = await call(BASE, `/retweet/${tweetId}`, { method: "POST", token, body: { userId } });
  check("retweet returns 200", rt.status === 200, `got ${rt.status}`);
  check("retweets incremented", rt.body?.retweets === 1, `got ${rt.body?.retweets}`);
  check("retweetedBy contains the user", rt.body?.retweetedBy?.includes(userId));

  console.log("\n[9] duplicate register is still idempotent (same token)");
  const dup = await call(BASE, "/register", {
    method: "POST",
    token,
    body: { username: `regress_${stamp}`, displayName: "Regression User", avatar: "https://example.com/a.png", email },
  });
  check("duplicate register returns 200 with the existing user", dup.status === 200 && dup.body?._id === userId);

  // ---- clean up ONLY what this run created --------------------------
  const cleaned = await removeTestFixtures(
    server.mongoUrl,
    ["regress\\."],
    ["regression tweet"]
  );
  check(
    "test fixtures were removed from the test database",
    cleaned.users.deletedCount >= 1 && cleaned.tweets.deletedCount >= 1,
    JSON.stringify(cleaned)
  );

  await server.stop();
  console.log("  ....  test database dropped; development database never touched");

  console.log(`\n==================================================`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log("==================================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Regression suite crashed:", e);
  process.exit(1);
});
