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
 */

const BASE = process.env.BASE_URL || "http://localhost:5000";

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

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
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
  console.log(`\nTwiller 2.0 - regression suite (original functionality)`);
  console.log(`Target: ${BASE}\n`);

  const stamp = Date.now();
  const email = `regress.${stamp}@twiller.test`;

  console.log("[1] GET /");
  const health = await call("/");
  check("health endpoint responds 200", health.status === 200, `got ${health.status}`);
  check("health message unchanged", health.text.includes("Twiller backend is running successfully"));

  console.log("\n[2] POST /register");
  const reg = await call("/register", {
    method: "POST",
    body: { username: `regress_${stamp}`, displayName: "Regression User", avatar: "https://example.com/a.png", email },
  });
  check("register returns 201", reg.status === 201, `got ${reg.status}`);
  const userId = reg.body?._id;
  check("register returns the original shape", Boolean(userId && reg.body.username && reg.body.email));
  check("new phone field defaults cleanly", reg.body?.phone === "");

  console.log("\n[3] GET /loggedinuser");
  const login = await call(`/loggedinuser?email=${encodeURIComponent(email)}`);
  check("profile lookup returns 200", login.status === 200, `got ${login.status}`);
  check("profile matches the registered user", login.body?._id === userId);

  console.log("\n[4] PATCH /userupdate/:email");
  const upd = await call(`/userupdate/${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: { bio: "regression bio", location: "Test City", website: "example.com" },
  });
  check("profile update returns 200", upd.status === 200, `got ${upd.status}`);
  check("bio was saved", upd.body?.bio === "regression bio");
  check("location was saved", upd.body?.location === "Test City");

  console.log("\n[5] POST /post");
  const post = await call("/post", {
    method: "POST",
    body: { author: userId, content: `regression tweet ${stamp}`, image: "" },
  });
  check("tweet creation returns 201", post.status === 201, `got ${post.status}`);
  const tweetId = post.body?._id;
  check("tweet returns the original shape", Boolean(tweetId && post.body.content && post.body.likes === 0));

  console.log("\n[6] GET /post");
  const list = await call("/post");
  check("tweet list returns 200", list.status === 200, `got ${list.status}`);
  check("list is an array", Array.isArray(list.body) && list.body.length > 0);
  const found = list.body.find((t) => t._id === tweetId);
  check("new tweet appears in the feed", Boolean(found));
  check("author is populated (original .populate behaviour)", found?.author?.username === `regress_${stamp}`);

  console.log("\n[7] POST /like/:tweetid");
  const like = await call(`/like/${tweetId}`, { method: "POST", body: { userId } });
  check("like returns 200", like.status === 200, `got ${like.status}`);
  check("likes incremented", like.body?.likes === 1, `got ${like.body?.likes}`);
  check("likedBy contains the user", like.body?.likedBy?.includes(userId));

  console.log("\n[8] POST /retweet/:tweetid");
  const rt = await call(`/retweet/${tweetId}`, { method: "POST", body: { userId } });
  check("retweet returns 200", rt.status === 200, `got ${rt.status}`);
  check("retweets incremented", rt.body?.retweets === 1, `got ${rt.body?.retweets}`);
  check("retweetedBy contains the user", rt.body?.retweetedBy?.includes(userId));

  console.log("\n[9] duplicate register is still idempotent (original behaviour)");
  const dup = await call("/register", {
    method: "POST",
    body: { username: `regress_${stamp}`, displayName: "Regression User", avatar: "https://example.com/a.png", email },
  });
  check("duplicate register returns 200 with the existing user", dup.status === 200 && dup.body?._id === userId);

  console.log(`\n==================================================`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log("==================================================");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Regression suite crashed:", e);
  process.exit(1);
});
