/**
 * Tweet author orphan safety - regression test for
 *   "TypeError: Cannot read properties of null (reading 'avatar')"
 *
 * Run:  node tests/tweet-author-orphan.test.js
 *
 * PROVES
 *  - a tweet whose author document no longer exists is returned with a NON-NULL,
 *    clearly-labelled placeholder author (populate() used to yield null)
 *  - a valid author is still returned expanded, exactly as before
 *  - the endpoint WRITES nothing: no user is fabricated and no tweet is
 *    reassigned or deleted
 *
 * ISOLATION: this suite uses its own throwaway database (dropped afterwards) and
 * only ever deletes a document inside THAT database.
 */
import { startTestServer } from "./helpers/testServer.js";
import mongoose from "mongoose";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function countUsers(mongoUrl) {
  await mongoose.connect(mongoUrl);
  const users = await mongoose.connection.db.collection("users").countDocuments();
  await mongoose.disconnect();
  return users;
}

async function main() {
  const server = await startTestServer({ fbMock: true });
  const stamp = Date.now();
  const email = `orphan.${stamp}@twiller.test`;
  const token = `orphan-tok-${stamp}`;
  server.setMap({ [token]: { uid: `orphan-uid-${stamp}`, email, email_verified: true } });

  console.log("\nTwiller 2.0 - tweet author orphan safety");
  console.log(`Target: ${server.base}  (isolated database)\n`);

  console.log("[1] a valid author still renders");
  const reg = await server.api("/register", {
    method: "POST",
    token,
    body: { username: `orphan_${stamp}`, displayName: "Orphan User", avatar: "https://example.com/a.png", email },
  });
  check("fixture user registers", reg.status === 201, `got ${reg.status}`);
  const userId = reg.body?._id;

  const post = await server.api("/post", { method: "POST", token, body: { content: `orphan probe ${stamp}`, image: "" } });
  check("tweet is created", post.status === 201, `got ${post.status}`);
  const tweetId = post.body?._id;

  let feed = await server.api("/post");
  let mine = (feed.body || []).find((t) => t._id === tweetId);
  check(
    "valid author is expanded (name + avatar)",
    mine?.author?._id === userId && mine?.author?.displayName === "Orphan User" && typeof mine?.author?.avatar === "string",
    JSON.stringify(mine?.author)
  );

  console.log("\n[2] the author document disappears (the reported crash condition)");
  await mongoose.connect(server.mongoUrl);
  const del = await mongoose.connection.db.collection("users").deleteOne({ _id: new mongoose.Types.ObjectId(userId) });
  await mongoose.disconnect();
  check("author document removed from the TEST database only", del.deletedCount === 1, `deleted=${del.deletedCount}`);

  console.log("\n[3] GET /post must never hand the client a null author");
  feed = await server.api("/post");
  const orphan = (feed.body || []).find((t) => t._id === tweetId);
  check("the tweet is still listed (nothing deleted or reassigned)", Boolean(orphan));
  check("author is NOT null (the exact crash cause is gone)", orphan?.author !== null && orphan?.author !== undefined, JSON.stringify(orphan?.author));
  check(
    "author is the explicit placeholder",
    orphan?.author?._id === null && orphan?.author?.displayName === "Unknown user",
    JSON.stringify(orphan?.author)
  );
  check(
    "placeholder carries renderable fields",
    typeof orphan?.author?.avatar === "string" && typeof orphan?.author?.username === "string" && orphan?.author?.verified === false,
    JSON.stringify(orphan?.author)
  );
  check("the tweet content is untouched", String(orphan?.content || "").includes(`orphan probe ${stamp}`), String(orphan?.content));
  check("no user document was fabricated", (await countUsers(server.mongoUrl)) === 0, `users=${await countUsers(server.mongoUrl)}`);

  await server.stop();
  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failed > 0) console.log(`  failures: ${failures.join(" | ")}`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Tweet-orphan suite crashed:", error);
  process.exit(1);
});
