/**
 * Internship Feature 1 (phase 1) - subscription plans + tweet quota.
 *
 * Verifies plan limits on the EXISTING tweet creation endpoint:
 *   free   -> 1 tweet per IST month, 2nd rejected
 *   bronze -> 3 tweets, 4th rejected
 *   silver -> 5 tweets, 6th rejected
 *   gold   -> unlimited (posts 8 with no rejection)
 *   period -> tweets from a previous IST month do NOT count toward this month
 * Existing behaviour (201 shape, populate on GET, validation 400) is covered
 * by the regression suite, which also runs against this guard.
 *
 * DATABASE SAFETY
 *   Uses the shared isolated test infrastructure: boots its OWN backend on a
 *   spare port bound to the separate `twiller_test` database, removes only
 *   the fixtures it created and drops the test database afterwards. The
 *   development database is never read or written.
 *
 * Run:  node tests/feature1-quota.test.js
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

async function call(base, path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, body: json, text };
}

async function main() {
  const server = await startTestServer();
  const BASE = server.base;

  console.log(`\nTwiller 2.0 - Feature 1 phase 1 (subscription quota) test suite`);
  console.log(`Target   : ${BASE}`);
  console.log(`Database : ${server.mongoUrl}  (isolated - development DB untouched)\n`);

  const stamp = Date.now();

  const makeUser = async (tag, plan) => {
    const email = `f1.${tag}.${stamp}@twiller.test`;
    const reg = await call(BASE, "/register", {
      method: "POST",
      body: {
        username: `f1_${tag}_${stamp}`,
        displayName: `F1 ${tag}`,
        avatar: "https://example.com/a.png",
        email,
      },
    });
    check(`setup: user ${tag} registered`, reg.status === 201, `got ${reg.status}`);
    if (plan) {
      await call(BASE, `/userupdate/${encodeURIComponent(email)}`, {
        method: "PATCH",
        body: { plan },
      });
    }
    return reg.body;
  };

  const post = (userId, i) =>
    call(BASE, "/post", {
      method: "POST",
      body: { author: userId, content: `quota tweet ${i} ${stamp}`, image: "" },
    });

  const postUntilRejected = async (userId, maxAttempts = 9) => {
    let created = 0;
    let rejection = null;
    for (let i = 1; i <= maxAttempts; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(userId, i);
      if (res.status === 201) {
        created += 1;
      } else {
        rejection = res;
        break;
      }
    }
    return { created, rejection };
  };

  console.log("[1] new/existing users default to Free");
  const freeUser = await makeUser("free");
  check("fresh user has no stored plan (behaves as Free)", freeUser?.plan === undefined, `plan=${JSON.stringify(freeUser?.plan)}`);

  console.log("\n[2] Free: 1 tweet allowed, 2nd rejected in the same period");
  const freeRun = await postUntilRejected(freeUser._id, 3);
  check("free user posts exactly 1 tweet", freeRun.created === 1, `created=${freeRun.created}`);
  check("2nd tweet rejected with 429", freeRun.rejection?.status === 429, `got ${freeRun.rejection?.status}`);
  check("rejection carries quotaExceeded flag", freeRun.rejection?.body?.quotaExceeded === true);
  check("rejection names the free plan", freeRun.rejection?.body?.plan === "free");
  check("rejection reports limit 1 and used 1", freeRun.rejection?.body?.tweetLimit === 1 && freeRun.rejection?.body?.used === 1);
  check(
    "rejection message is the specified upgrade text",
    freeRun.rejection?.body?.error === "Tweet limit reached. Upgrade your plan to post more."
  );

  console.log("\n[3] Bronze: 3 allowed, 4th rejected");
  const bronze = await makeUser("bronze", "bronze");
  const bronzeRun = await postUntilRejected(bronze._id, 5);
  check("bronze posts exactly 3 tweets", bronzeRun.created === 3, `created=${bronzeRun.created}`);
  check("4th tweet rejected with 429", bronzeRun.rejection?.status === 429);
  check("rejection names bronze with limit 3", bronzeRun.rejection?.body?.plan === "bronze" && bronzeRun.rejection?.body?.tweetLimit === 3);

  console.log("\n[4] Silver: 5 allowed, 6th rejected");
  const silver = await makeUser("silver", "silver");
  const silverRun = await postUntilRejected(silver._id, 7);
  check("silver posts exactly 5 tweets", silverRun.created === 5, `created=${silverRun.created}`);
  check("6th tweet rejected with 429", silverRun.rejection?.status === 429);
  check("rejection names silver with limit 5", silverRun.rejection?.body?.plan === "silver" && silverRun.rejection?.body?.tweetLimit === 5);

  console.log("\n[5] Gold: unlimited, posts 8 with no rejection");
  const gold = await makeUser("gold", "gold");
  const goldRun = { created: 0, rejection: null };
  for (let i = 1; i <= 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(gold._id, i);
    if (res.status === 201) goldRun.created += 1;
    else {
      goldRun.rejection = res;
      break;
    }
  }
  check("gold posts 8 tweets", goldRun.created === 8, `created=${goldRun.created}`);
  check("no rejection for gold", goldRun.rejection === null);

  console.log("\n[6] previous-period tweets do NOT consume the current quota");
  const rollover = await makeUser("rollover");
  const first = await post(rollover._id, 1);
  check("first tweet of this month succeeds", first.status === 201);
  await mongoose.connect(server.mongoUrl);
  const lastMonth = new Date(first.body.timestamp);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  await mongoose.connection.db
    .collection("tweets")
    .updateOne({ _id: new mongoose.Types.ObjectId(first.body._id) }, { $set: { timestamp: lastMonth } });
  await mongoose.disconnect();
  const after = await post(rollover._id, 2);
  check("free user can post again after last month expired", after.status === 201, `got ${after.status}`);

  console.log("\n[7] unknown plan id falls back to Free, never to unlimited");
  const odd = await makeUser("odd");
  await call(BASE, `/userupdate/${encodeURIComponent(odd.email)}`, {
    method: "PATCH",
    body: { plan: "not-a-real-plan" },
  });
  const oddFirst = await post(odd._id, 1);
  check("unknown plan allows 1 tweet like free", oddFirst.status === 201, `got ${oddFirst.status}`);
  const oddSecond = await post(odd._id, 2);
  check("unknown plan rejects 2nd tweet like free", oddSecond.status === 429, `got ${oddSecond.status}`);

  console.log("\n[8] existing tweet behavior unchanged");
  const feed = await call(BASE, "/post");
  check("GET /post still lists tweets", feed.status === 200 && Array.isArray(feed.body));
  check("author still populated", feed.body.length > 0 && typeof feed.body[0].author?.username === "string");
  const bad = await call(BASE, "/post", { method: "POST", body: {} });
  check("missing author still rejected with validation 400", bad.status === 400, `got ${bad.status}`);

  // ---- clean up ONLY what this run created ---------------------------
  await removeTestFixtures(server.mongoUrl, ["f1\\."], ["quota tweet"]);
  await server.stop();
  console.log("  ....  test database dropped; development database never touched");

  console.log(`\n==================================================`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Test suite crashed:", error);
  process.exit(1);
});

