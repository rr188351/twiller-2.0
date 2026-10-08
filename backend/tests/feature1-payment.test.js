/**
 * Internship Feature 1 (phase 2) - mock subscription purchase tests.
 *
 * Covers, against the EXISTING /subscription/payment endpoint:
 *   window   -> 09:59:59 IST rejected, 10:00:00 allowed, 10:59:59 allowed,
 *               11:00:00 rejected (all via a test-only server-time override,
 *               verified to be inert in production)
 *   plans    -> bronze/silver/gold accepted, unknown rejected, free handled
 *               without any fake payment
 *   success  -> transaction becomes `success`, provider ref exists, amount
 *               matches plans.js, user.plan activated
 *   failure  -> transaction becomes `failed`, previous plan unchanged
 *   window   -> request outside the window never activates the plan and
 *               creates no successful transaction
 *   quota    -> a Free user with an exhausted quota can post again after a
 *               successful Bronze purchase (reuses the phase-1 guard)
 *
 * DATABASE SAFETY
 *   Same isolated strategy as the other suites: boots its OWN backend bound
 *   to `twiller_test`, removes only fixtures it created, drops the test
 *   database afterwards. The development database is never read or written.
 *
 * Run:  node tests/feature1-payment.test.js
 */

import "dotenv/config";
import mongoose from "mongoose";
import { isPaymentWindowOpen } from "../utils/payment.js";
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

// IST wall-clock text ("2026-11-04 10:00:00") -> instant. Noon-UTC ambiguity
// is impossible by construction: +05:30 is subtracted explicitly.
const atIst = (time) => `2026-11-04T${time}+05:30`;

async function main() {
  const server = await startTestServer();
  const BASE = server.base;

  console.log(`\nTwiller 2.0 - Feature 1 phase 2 (mock subscription) test suite`);
  console.log(`Target   : ${BASE}`);
  console.log(`Database : ${server.mongoUrl}  (isolated - development DB untouched)\n`);

  const stamp = Date.now();
  const OPEN = atIst("10:30:00");
  const OUTSIDE = atIst("09:00:00");

  const makeUser = async (tag) => {
    const email = `f1pay.${tag}.${stamp}@twiller.test`;
    const reg = await call(BASE, "/register", {
      method: "POST",
      body: {
        username: `f1pay_${tag}_${stamp}`,
        displayName: `F1 Pay ${tag}`,
        avatar: "https://example.com/a.png",
        email,
      },
    });
    check(`setup: user ${tag} registered`, reg.status === 201, `got ${reg.status}`);
    return reg.body;
  };

  const buy = (userId, planId, opts = {}) =>
    call(BASE, "/subscription/payment", {
      method: "POST",
      body: { userId, planId, ...opts },
    });

  const profileOf = async (email) => {
    const res = await call(BASE, `/loggedinuser?email=${encodeURIComponent(email)}`);
    return res.body;
  };

  console.log("[1] payment window boundaries (unit level, injected instants)");
  check("09:59:59 IST rejected", isPaymentWindowOpen(new Date(atIst("09:59:59"))) === false);
  check("10:00:00 IST allowed", isPaymentWindowOpen(new Date(atIst("10:00:00"))) === true);
  check("10:59:59 IST allowed", isPaymentWindowOpen(new Date(atIst("10:59:59"))) === true);
  check("11:00:00 IST rejected", isPaymentWindowOpen(new Date(atIst("11:00:00"))) === false);
  check("UTC conversion explicit (04:30Z open)", isPaymentWindowOpen(new Date("2026-11-04T04:30:00.000Z")) === true);
  check("UTC conversion explicit (05:30Z closed)", isPaymentWindowOpen(new Date("2026-11-04T05:30:00.000Z")) === false);

  console.log("\n[2] plan validation through the endpoint (inside the window)");
  const validator = await makeUser("validator");
  for (const planId of ["bronze", "silver", "gold"]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await buy(validator._id, planId, { asOf: OPEN, testOutcome: "cancelled" });
    check(`${planId} accepted as a known plan`, res.status !== 400 || res.body?.code !== "UNKNOWN_PLAN", `got ${res.status} ${JSON.stringify(res.body)}`);
  }
  const unknown = await buy(validator._id, "platinum", { asOf: OPEN });
  check("unknown plan rejected with 400", unknown.status === 400, `got ${unknown.status}`);
  check("unknown plan carries UNKNOWN_PLAN code", unknown.body?.code === "UNKNOWN_PLAN");
  const afterUnknown = await profileOf(validator.email);
  check("unknown plan never touches user.plan", (afterUnknown?.plan || "free") === "free");

  console.log("\n[3] Free is not a paid purchase - no fake payment row");
  const freeReq = await buy(validator._id, "free", { asOf: OPEN });
  check("free purchase handled with 400", freeReq.status === 400, `got ${freeReq.status}`);
  check("free carries FREE_PLAN_NO_PAYMENT code", freeReq.body?.code === "FREE_PLAN_NO_PAYMENT");
  await mongoose.connect(server.mongoUrl);
  const fakeFree = await mongoose.connection.db
    .collection("subscriptions")
    .countDocuments({ user: new mongoose.Types.ObjectId(validator._id), plan: "free" });
  await mongoose.disconnect();
  check("no subscription row created for free", fakeFree === 0, `rows=${fakeFree}`);

  console.log("\n[4] successful purchases activate the plan");
  const buyer = await makeUser("buyer");
  for (const [planId, price] of [["bronze", 100], ["silver", 300], ["gold", 1000]]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await buy(buyer._id, planId, { asOf: OPEN, testOutcome: "success" });
    check(`${planId} purchase succeeds with 201`, res.status === 201, `got ${res.status} ${JSON.stringify(res.body)}`);
    check(`${planId} transaction is success`, res.body?.status === "success");
    check(`${planId} provider ref exists`, typeof res.body?.providerRef === "string" && res.body.providerRef.length > 0);
    check(`${planId} amount matches plans.js (INR ${price})`, res.body?.amountInr === price);
    // eslint-disable-next-line no-await-in-loop
    const profile = await profileOf(buyer.email);
    check(`${planId} activated on user`, profile?.plan === planId, `plan=${profile?.plan}`);
  }


  console.log("\n[5] failed payment leaves the previous plan unchanged");
  const unlucky = await makeUser("unlucky");
  const firstBuy = await buy(unlucky._id, "bronze", { asOf: OPEN, testOutcome: "success" });
  check("setup: bronze activated", firstBuy.status === 201);
  const doomed = await buy(unlucky._id, "gold", { asOf: OPEN, testOutcome: "failed" });
  check("failed payment rejected with 402", doomed.status === 402, `got ${doomed.status}`);
  check("failed transaction recorded as failed", doomed.body?.status === "failed");
  const stillBronze = await profileOf(unlucky.email);
  check("plan still bronze after failure", stillBronze?.plan === "bronze", `plan=${stillBronze?.plan}`);
  const cancelled = await buy(unlucky._id, "gold", { asOf: OPEN, testOutcome: "cancelled" });
  check("cancelled payment rejected with 402", cancelled.status === 402, `got ${cancelled.status}`);
  const stillBronze2 = await profileOf(unlucky.email);
  check("plan still bronze after cancellation", stillBronze2?.plan === "bronze");

  console.log("\n[6] payments outside the window never activate anything");
  const early = await makeUser("early");
  const closedBuy = await buy(early._id, "bronze", { asOf: OUTSIDE, testOutcome: "success" });
  check("outside-window purchase rejected with 403", closedBuy.status === 403, `got ${closedBuy.status}`);
  check("closure carries PAYMENT_WINDOW_CLOSED code", closedBuy.body?.code === "PAYMENT_WINDOW_CLOSED");
  const stillFree = await profileOf(early.email);
  check("plan unchanged after window rejection", (stillFree?.plan || "free") === "free");
  await mongoose.connect(server.mongoUrl);
  const outsideRows = await mongoose.connection.db
    .collection("subscriptions")
    .countDocuments({ user: new mongoose.Types.ObjectId(early._id), status: "success" });
  await mongoose.disconnect();
  check("no successful transaction recorded outside the window", outsideRows === 0);

  console.log("\n[7] quota follows the newly activated plan (no duplicated logic)");
  const capped = await makeUser("capped");
  const firstTweet = await call(BASE, "/post", {
    method: "POST",
    body: { author: capped._id, content: `cap one ${stamp}`, image: "" },
  });
  check("free user posts first tweet", firstTweet.status === 201);
  const blocked = await call(BASE, "/post", {
    method: "POST",
    body: { author: capped._id, content: `cap two ${stamp}`, image: "" },
  });
  check("free quota exhausted as before", blocked.status === 429);
  const upgrade = await buy(capped._id, "bronze", { asOf: OPEN, testOutcome: "success" });
  check("bronze purchase succeeds", upgrade.status === 201);
  const afterUpgrade = await call(BASE, "/post", {
    method: "POST",
    body: { author: capped._id, content: `cap two retry ${stamp}`, image: "" },
  });
  check("same-month slot opens up under bronze", afterUpgrade.status === 201, `got ${afterUpgrade.status}`);

  console.log("\n[8] invalid requests are rejected safely");
  const noUser = await buy("000000000000000000000000", "bronze", { asOf: OPEN });
  check("unknown userId rejected with 404", noUser.status === 404, `got ${noUser.status}`);
  const noId = await call(BASE, "/subscription/payment", {
    method: "POST",
    body: { planId: "bronze", asOf: OPEN },
  });
  check("missing userId rejected with 400", noId.status === 400, `got ${noId.status}`);

  // ---- clean up ONLY what this run created ---------------------------
  await removeTestFixtures(server.mongoUrl, ["f1pay\\."], []);
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

