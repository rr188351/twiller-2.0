/**
 * Internship Feature 1 (phase 3) - invoice + confirmation tests.
 *
 * Verifies, against the EXISTING /subscription/payment endpoint:
 *   success -> Bronze/Silver/Gold each create exactly ONE invoice with the
 *              correct plan, plan name, INR amount, currency, payment link,
 *              providerRef, unique invoice number and a mock confirmation
 *   failure -> failed/cancelled/unknown/free/outside-window create NO invoice
 *   email   -> a simulated mailer failure keeps payment success + plan +
 *              invoice, marks email failed, and the API says so honestly
 *   dup     -> creating an invoice twice for one payment yields ONE row
 *   data    -> amounts/quotas come from plans.js, never the request body
 *
 * DATABASE SAFETY
 *   Same isolated strategy as the other suites: boots its OWN backend bound
 *   to `twiller_test`, removes only fixtures it created, drops the test
 *   database afterwards. The development database is never read or written.
 *
 * Run:  node tests/feature1-invoice.test.js
 */

import "dotenv/config";
import mongoose from "mongoose";
import { PLANS } from "../utils/plans.js";
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

  console.log(`\nTwiller 2.0 - Feature 1 phase 3 (invoice + confirmation) test suite`);
  console.log(`Target   : ${BASE}`);
  console.log(`Database : ${server.mongoUrl}  (isolated - development DB untouched)\n`);

  const stamp = Date.now();
  const OPEN = "2026-11-04T10:30:00+05:30";
  const OUTSIDE = "2026-11-04T09:00:00+05:30";

  const makeUser = async (tag) => {
    const email = `f1inv.${tag}.${stamp}@twiller.test`;
    const reg = await call(BASE, "/register", {
      method: "POST",
      body: {
        username: `f1inv_${tag}_${stamp}`,
        displayName: `F1 Inv ${tag}`,
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

  const invoicesFor = async (userId) => {
    await mongoose.connect(server.mongoUrl);
    const rows = await mongoose.connection.db
      .collection("invoices")
      .find({ user: new mongoose.Types.ObjectId(userId) })
      .toArray();
    await mongoose.disconnect();
    return rows;
  };

  console.log("[1] successful payments each create exactly one invoice");
  for (const [planId, price, quota] of [["bronze", 100, "3"], ["silver", 300, "5"], ["gold", 1000, "unlimited"]]) {
    // eslint-disable-next-line no-await-in-loop
    const user = await makeUser(planId);
    const expected = PLANS[planId];
    // eslint-disable-next-line no-await-in-loop
    const res = await buy(user._id, planId, { asOf: OPEN, testOutcome: "success" });
    check(`${planId} purchase succeeds with 201`, res.status === 201, `got ${res.status} ${JSON.stringify(res.body)}`);
    check(`${planId} response carries invoice number`, typeof res.body?.invoiceNumber === "string" && res.body.invoiceNumber.length > 0);
    check(`${planId} response reports issued invoice`, res.body?.invoiceStatus === "issued");
    check(`${planId} response reports email delivery`, res.body?.emailDelivery === "sent", `got ${res.body?.emailDelivery}`);
    // eslint-disable-next-line no-await-in-loop
    const rows = await invoicesFor(user._id);
    check(`${planId} created exactly one invoice`, rows.length === 1, `rows=${rows.length}`);
    const inv = rows[0];
    check(`${planId} invoice has correct plan`, inv?.plan === planId);
    check(`${planId} invoice has correct plan name`, inv?.planName === expected.name);
    check(`${planId} invoice amount INR ${price}`, inv?.amountInr === price);
    check(`${planId} invoice currency is INR`, inv?.currency === "INR");
    check(`${planId} invoice references the payment`, String(inv?.subscription) === String(res.body?.transactionId));
    check(`${planId} providerRef matches`, inv?.providerRef === res.body?.providerRef && Boolean(inv?.providerRef));
    check(`${planId} quota ${quota} derivable from plans.js`, quota === "unlimited" ? expected.unlimited === true : expected.tweetLimit === Number(quota));
  }

  console.log("\n[2] invoice numbers are unique");
  await mongoose.connect(server.mongoUrl);
  const numbers = await mongoose.connection.db.collection("invoices").distinct("invoiceNumber");
  await mongoose.disconnect();
  check("all invoice numbers unique", numbers.length === 3, `distinct=${numbers.length}`);
  check("invoice numbers look like Twiller invoices", numbers.every((n) => /^INV-\d{4}-[A-Z0-9]{6}$/.test(n)), numbers.join(","));

  console.log("\n[3] non-successful requests create no invoice");
  const probe = await makeUser("probe");
  const badCases = [
    ["failed payment", await buy(probe._id, "bronze", { asOf: OPEN, testOutcome: "failed" }), 402],
    ["cancelled payment", await buy(probe._id, "bronze", { asOf: OPEN, testOutcome: "cancelled" }), 402],
    ["unknown plan", await buy(probe._id, "platinum", { asOf: OPEN }), 400],
    ["free plan", await buy(probe._id, "free", { asOf: OPEN }), 400],
    ["outside window", await buy(probe._id, "bronze", { asOf: OUTSIDE, testOutcome: "success" }), 403],
  ];
  for (const [label, res, status] of badCases) {
    check(`${label} rejected with ${status}`, res.status === status, `got ${res.status}`);
  }
  const probeRows = await invoicesFor(probe._id);
  check("no invoice exists for any rejected request", probeRows.length === 0, `rows=${probeRows.length}`);


  console.log("\n[4] confirmation email contains the required invoice details");
  // The mock (console) mailer is the one configured provider and nodemailer
  // is deliberately NOT installed, so `sendInvoiceEmail` prints its body
  // here. Capturing console.log verifies the payload the assignment requires
  // without any real email leaving the process.
  const mailer = await import("../utils/mailer.js");
  const printed = [];
  const originalLog = console.log;
  console.log = (...args) => printed.push(args.join(" "));
  const mailResult = await mailer.sendInvoiceEmail({
    to: "demo@twiller.test",
    invoiceNumber: "INV-2026-TEST01",
    planName: "Silver",
    amount: 300,
    date: "2026-11",
    providerRef: "mock_silver_1_abc",
    tweetQuota: 5,
  });
  const goldResult = await mailer.sendInvoiceEmail({
    to: "demo@twiller.test",
    invoiceNumber: "INV-2026-TEST02",
    planName: "Gold",
    amount: 1000,
    date: "2026-11",
    providerRef: "mock_gold_1_def",
    tweetQuota: "unlimited",
  });
  console.log = originalLog;
  const body = printed.join("\n");
  const goldBody = printed.filter((l) => l.includes("TEST02")).join("\n") + printed.join("\n");
  check("mailer accepted both confirmations", mailResult.delivered === true && goldResult.delivered === true);
  check("mentions Twiller", body.includes("Twiller"));
  check("confirms payment success", body.includes("payment was successful"));
  check("contains plan name", body.includes("Plan            : Silver"));
  check("contains amount in INR", body.includes("Amount          : INR 300"));
  check("contains invoice number", body.includes("INV-2026-TEST01"));
  check("contains payment/reference id", body.includes("mock_silver_1_abc"));
  check("contains date", body.includes("2026-11"));
  check("contains monthly tweet quota", body.includes("Tweet quota       : 5 tweets per month"));
  check("Gold clearly shows unlimited quota", printed.join("\n").includes("unlimited tweets per month") && goldBody.includes("INV-2026-TEST02"));
  const forbidden = ["password", "otp", "token", "firebase"];
  check("no sensitive auth data in the body", !forbidden.some((w) => body.toLowerCase().includes(w)), body.slice(0, 120));

  console.log("\n[5] duplicate invoice creation returns the same row");
  const dupUser = await makeUser("dup");
  const dupBuy = await buy(dupUser._id, "bronze", { asOf: OPEN, testOutcome: "success" });
  check("setup purchase succeeds", dupBuy.status === 201);
  await mongoose.connect(server.mongoUrl);
  const subs = await mongoose.connection.db
    .collection("subscriptions")
    .find({ user: new mongoose.Types.ObjectId(dupUser._id), status: "success" })
    .toArray();
  const { createInvoice } = await import("../utils/invoice.js");
  const again = await createInvoice({
    userId: new mongoose.Types.ObjectId(dupUser._id),
    subscriptionId: subs[0]._id,
    plan: PLANS.bronze,
    provider: "mock",
    providerRef: subs[0].providerRef,
    paidAt: new Date(),
  });
  const dupCount = await mongoose.connection.db
    .collection("invoices")
    .countDocuments({ subscription: subs[0]._id });
  await mongoose.disconnect();
  check("second call reports not-created", again.created === false);
  check("exactly one invoice exists for the payment", dupCount === 1, `count=${dupCount}`);
  check("returned row is the original invoice", String(again.invoice?.subscription) === String(subs[0]._id));

  console.log("\n[6] amounts come from plans.js, never the request body");
  const tamper = await makeUser("tamper");
  const tamperBuy = await call(BASE, "/subscription/payment", {
    method: "POST",
    body: { userId: tamper._id, planId: "bronze", amountInr: 1, asOf: OPEN, testOutcome: "success" },
  });
  check("purchase succeeds despite bogus amount field", tamperBuy.status === 201, `got ${tamperBuy.status}`);
  check("charged amount is INR 100 from plans.js", tamperBuy.body?.amountInr === 100, `got ${tamperBuy.body?.amountInr}`);

  // ---- clean up ONLY what this run created ---------------------------
  await removeTestFixtures(server.mongoUrl, ["f1inv\\."], []);
  await mongoose.connect(server.mongoUrl);
  await mongoose.connection.db.collection("invoices").deleteMany({});
  await mongoose.connection.db.collection("subscriptions").deleteMany({});
  await mongoose.disconnect();
  await server.stop();
  console.log("  ....  first test database dropped; development database never touched");

  console.log("\n[7] mailer outage does NOT downgrade a successful payment");
  // A fresh backend is required because delivery happens inside the spawned
  // server process, not in this test process. The helper drops the (already
  // empty) test DB and re-spawns on the same port, so the earlier BASE still
  // applies. MOCK_MAIL_OUTAGE makes the console mock report failure.
  process.env.MOCK_MAIL_OUTAGE = "true";
  await new Promise((r) => setTimeout(r, 800));
  const outageServer = await startTestServer();

  const outUser = await makeUser("outage");
  const outBuy = await buy(outUser._id, "gold", { asOf: OPEN, testOutcome: "success" });
  check("payment still succeeds with 201", outBuy.status === 201, `got ${outBuy.status} ${JSON.stringify(outBuy.body)}`);
  check("payment status is still success", outBuy.body?.status === "success");
  check("API honestly reports emailDelivery failed", outBuy.body?.emailDelivery === "failed", `got ${outBuy.body?.emailDelivery}`);
  check("response does NOT claim email was sent", outBuy.body?.emailDelivery !== "sent");

  const outProfile = await call(BASE, `/loggedinuser?email=${encodeURIComponent(outUser.email)}`);
  check("plan still activated (gold)", outProfile.body?.plan === "gold", `plan=${outProfile.body?.plan}`);

  const outRows = await invoicesFor(outUser._id);
  check("invoice still recorded", outRows.length === 1, `rows=${outRows.length}`);
  check("invoice status still issued", outRows[0]?.status === "issued");
  check("invoice emailDelivery marked failed", outRows[0]?.emailDelivery === "failed", `got ${outRows[0]?.emailDelivery}`);

  delete process.env.MOCK_MAIL_OUTAGE;
  await removeTestFixtures(outageServer.mongoUrl, ["f1inv\\."], []);
  await outageServer.stop();
  console.log("  ....  outage test database dropped; development database never touched");


  console.log(`\n==================================================`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Test suite crashed:", error);
  process.exit(1);
});

