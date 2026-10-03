/**
 * Removes ONLY automated-test fixtures that older test runs leaked into the
 * DEVELOPMENT database. Safe by construction:
 *
 *   - it matches ONLY the strict prefixes used by the test suites
 *     (regress., f3., fp., baseline@) - real accounts cannot match;
 *   - it NEVER deletes a tweet whose content does not look like a test tweet;
 *   - it NEVER deletes tweets authored by accounts it did not match;
 *   - it is a DRY RUN unless you pass --confirm, and prints every document it
 *     would delete so you can inspect the list first.
 *
 * YOUR OWN DATA IS SAFE: your account and your tweets are not matched by any
 * rule below.
 *
 * USAGE
 *   node tests/cleanup-test-fixtures.js            # dry run - lists only
 *   node tests/cleanup-test-fixtures.js --confirm  # actually deletes
 *
 * Going forward the suites no longer write here at all - see
 * tests/helpers/testServer.js, which runs them against `twiller_test`.
 */

import "dotenv/config";
import mongoose from "mongoose";

const CONFIRM = process.argv.includes("--confirm");

// Strict prefixes that ONLY the automated suites ever produce.
const TEST_EMAIL_PREFIXES = ["regress.", "f3.", "fp.", "baseline@"];
// Strict content prefixes that ONLY the automated suites ever produce.
const TEST_CONTENT_PREFIXES = [
  "regression tweet",
  "baseline smoke test tweet",
];

async function main() {
  const url = process.env.MONOGDB_URL || process.env.MONGODB_URL;
  await mongoose.connect(url);
  const db = mongoose.connection.db;

  const users = db.collection("users");
  const tweets = db.collection("tweets");

  const emailRe = new RegExp(`^(${TEST_EMAIL_PREFIXES.map((p) => p.replace(/[.@]/g, "\\$&")).join("|")})`);
  const contentRe = new RegExp(`^(${TEST_CONTENT_PREFIXES.join("|")})`);

  const matchedUsers = await users.find({ email: emailRe }).toArray();
  const matchedUserIds = matchedUsers.map((u) => u._id);

  // Tweets matched by content OR authored by a matched fixture user.
  const matchedTweets = await tweets
    .find({ $or: [{ content: contentRe }, { author: { $in: matchedUserIds } }] })
    .toArray();

  const keptTweets = await tweets
    .find({ $nor: [{ content: contentRe }, { author: { $in: matchedUserIds } }] })
    .toArray();

  console.log(`\nDatabase: ${url}`);
  console.log(`Mode    : ${CONFIRM ? "CONFIRM - will delete" : "DRY RUN - nothing will be deleted"}`);
  console.log(`\nUsers that WOULD be removed (${matchedUsers.length}):`);
  for (const u of matchedUsers) {
    console.log(`   - ${u.email}   (username: ${u.username})`);
  }

  console.log(`\nTweets that WOULD be removed (${matchedTweets.length}):`);
  for (const t of matchedTweets) {
    const text = String(t.content || "").replace(/\s+/g, " ").slice(0, 70);
    console.log(`   - "${text}"`);
  }

  console.log(`\nTweets that would be KEPT (${keptTweets.length}):`);
  for (const t of keptTweets) {
    const text = String(t.content || "").replace(/\s+/g, " ").slice(0, 70);
    console.log(`   * "${text}"`);
  }

  if (!CONFIRM) {
    console.log(`\nNothing was deleted. Re-run with --confirm if this list is correct.\n`);
    await mongoose.disconnect();
    return;
  }

  const removedUsers = await users.deleteMany({ email: emailRe });
  const removedTweets = await tweets.deleteMany({
    $or: [{ content: contentRe }, { author: { $in: matchedUserIds } }],
  });

  console.log(`\nRemoved ${removedUsers.deletedCount} fixture users.`);
  console.log(`Removed ${removedTweets.deletedCount} fixture tweets.`);
  console.log(`Kept ${keptTweets.length} tweets, including all of your own.\n`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("Cleanup failed:", e);
  process.exit(1);
});