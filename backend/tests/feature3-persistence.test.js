/**
 * Internship Feature 3 - persistence test.
 *
 * Feature 3 deliberately adds NO new backend route. The "enable/disable"
 * preference is saved through Twiller's EXISTING `PATCH /userupdate/:email`
 * route. This test proves that:
 *   1. a new profile gets notificationsEnabled === true by default
 *   2. the preference can be switched OFF and the change persists
 *   3. it can be switched back ON
 *   4. the default survives a profile reload through /loggedinuser
 *
 * Run:  node tests/feature3-persistence.test.js
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
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, body: json };
}

async function main() {
  console.log("\nTwiller 2.0 - Feature 3 persistence test");
  console.log(`Target: ${BASE}\n`);

  const stamp = Date.now();
  const email = `f3.${stamp}@twiller.test`;

  console.log("[1] new profile defaults to notifications ENABLED");
  const reg = await call("/register", {
    method: "POST",
    body: {
      username: `f3_${stamp}`,
      displayName: "Feature Three",
      avatar: "https://example.com/a.png",
      email,
    },
  });
  check("register returns 201", reg.status === 201, `got ${reg.status}`);
  check("notificationsEnabled defaults to true", reg.body?.notificationsEnabled === true, JSON.stringify(reg.body?.notificationsEnabled));

  console.log("\n[2] reload the profile - default is persisted, not just returned");
  const loaded = await call(`/loggedinuser?email=${encodeURIComponent(email)}`);
  check("profile reload still shows enabled", loaded.body?.notificationsEnabled === true);

  console.log("\n[3] switch the setting OFF via the EXISTING update route");
  const off = await call(`/userupdate/${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: { notificationsEnabled: false },
  });
  check("update returns 200", off.status === 200, `got ${off.status}`);
  check("notificationsEnabled is now false", off.body?.notificationsEnabled === false);

  const reloadedOff = await call(`/loggedinuser?email=${encodeURIComponent(email)}`);
  check("OFF persisted to MongoDB", reloadedOff.body?.notificationsEnabled === false);

  console.log("\n[4] switch it back ON");
  const on = await call(`/userupdate/${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: { notificationsEnabled: true },
  });
  check("notificationsEnabled is true again", on.body?.notificationsEnabled === true);

  console.log("\n[5] unrelated profile fields are untouched by the partial update");
  check("username preserved", on.body?.username === `f3_${stamp}`);
  check("email preserved", on.body?.email === email);

  console.log(`\n==================================================`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(1);
});
