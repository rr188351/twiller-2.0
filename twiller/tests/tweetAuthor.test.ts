/**
 * TweetCard author-safety regression tests.
 *
 * HOW TO RUN
 *   cd twiller
 *   node tests/tweetAuthor.test.ts
 *
 * WHY
 * ---
 * `Tweet.author` is an ObjectId reference. `populate("author")` resolves it to
 * `null` when the referenced user document no longer exists, and `POST /post`
 * returned the raw id, so `tweet.author.avatar` threw:
 *   "TypeError: Cannot read properties of null (reading 'avatar')"
 * These tests pin the single normaliser that TweetCard / ProfilePage now use for
 * every author field. No framework is installed - Node runs TypeScript directly.
 */

import {
  resolveTweetAuthor,
  authorInitial,
  UNKNOWN_AUTHOR_NAME,
  FALLBACK_AVATAR,
} from "../src/lib/tweetAuthor.ts";

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

/* ---------------------------------------------------------------- */
console.log("\n[1] a valid author is preserved exactly");

const valid = {
  _id: "abc123",
  username: "elonmusk",
  displayName: "Elon Musk",
  avatar: "https://cdn.example/a.png",
  verified: true,
};
const rv = resolveTweetAuthor(valid);
check("id / username / displayName preserved", rv.id === "abc123" && rv.username === "elonmusk" && rv.displayName === "Elon Musk", JSON.stringify(rv));
check("avatar preserved", rv.avatar === "https://cdn.example/a.png", rv.avatar);
check("verified flag preserved", rv.verified === true, String(rv.verified));
check("not flagged as unknown", rv.isUnknown === false);
check("avatar initial is the first letter of the display name", authorInitial(rv) === "E", authorInitial(rv));
check("the shape the UI reads is always present", ["id", "username", "displayName", "avatar", "verified"].every((k) => k in rv));

/* ---------------------------------------------------------------- */
console.log("\n[2] a null / undefined author (deleted user) never crashes");

const nullishCases: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
];
for (const [label, input] of nullishCases) {
  const a = resolveTweetAuthor(input);
  check(`${label} author -> never null/undefined`, a !== null && a !== undefined);
  check(`${label} author -> fallback display name`, a.displayName === UNKNOWN_AUTHOR_NAME, a.displayName);
  check(`${label} author -> empty avatar so AvatarFallback renders`, a.avatar === FALLBACK_AVATAR, JSON.stringify(a.avatar));
  check(`${label} author -> marked unknown, no invented id`, a.isUnknown === true && a.id === "", JSON.stringify({ id: a.id, isUnknown: a.isUnknown }));
  check(`${label} author -> never verified`, a.verified === false);
  check(`${label} author -> reading .avatar/.displayName/.username/.verified cannot throw`, (() => {
    try {
      void a.avatar;
      void a.displayName;
      void a.username;
      void a.verified;
      return true;
    } catch {
      return false;
    }
  })());
  check(`${label} author -> avatar initial is a real single character`, authorInitial(a).length === 1 && authorInitial(a) === a.displayName.trim().charAt(0).toUpperCase(), authorInitial(a));
}

/* ---------------------------------------------------------------- */
console.log("\n[3] missing or blank avatar / display name");

check("null avatar -> empty fallback", resolveTweetAuthor({ _id: "1", username: "u", displayName: "U", avatar: null }).avatar === FALLBACK_AVATAR);
check("blank avatar -> empty fallback", resolveTweetAuthor({ _id: "1", displayName: "U", avatar: "   " }).avatar === FALLBACK_AVATAR);
check("non-string avatar -> empty fallback", resolveTweetAuthor({ _id: "1", displayName: "U", avatar: 42 }).avatar === FALLBACK_AVATAR);
check("missing displayName -> falls back to username", resolveTweetAuthor({ _id: "1", username: "handle" }).displayName === "handle");
check("blank displayName -> falls back to username", resolveTweetAuthor({ _id: "1", username: "handle", displayName: "  " }).displayName === "handle");
check("missing displayName AND username -> Unknown user", resolveTweetAuthor({ _id: "1" }).displayName === UNKNOWN_AUTHOR_NAME, resolveTweetAuthor({ _id: "1" }).displayName);
check("initial comes from the username when needed", authorInitial(resolveTweetAuthor({ _id: "1", username: "handle" })) === "H");
check("initial is never empty for any blank name", ["", " ", "   ", null, undefined].every((v) => authorInitial(resolveTweetAuthor({ _id: "1", displayName: v })).length === 1));
check("a completely missing author still yields a single-character initial", authorInitial(resolveTweetAuthor(null)).length === 1, authorInitial(resolveTweetAuthor(null)));

/* ---------------------------------------------------------------- */
console.log("\n[4] an un-expanded reference (bare id) is still safe");

const byId = resolveTweetAuthor("64f0c2b8e1a2b3c4d5e6f7a8");
check("bare id string: id preserved for ownership checks", byId.id === "64f0c2b8e1a2b3c4d5e6f7a8", byId.id);
check("bare id string: placeholder name + empty avatar (no crash)", byId.displayName === UNKNOWN_AUTHOR_NAME && byId.avatar === FALLBACK_AVATAR && byId.isUnknown === true);
check("numeric reference handled the same way", resolveTweetAuthor(12345).displayName === UNKNOWN_AUTHOR_NAME);
check("empty string reference -> unknown, no id", resolveTweetAuthor("").id === "" && resolveTweetAuthor("").isUnknown === true);

/* ---------------------------------------------------------------- */
console.log("\n[5] hostile / unexpected shapes never throw");

const hostile: unknown[] = [0, false, Number.NaN, [], {}, { _id: null, username: 5 }, () => undefined];
for (const weird of hostile) {
  check(`input ${Object.prototype.toString.call(weird)} -> non-null safe author`, (() => {
    try {
      const a = resolveTweetAuthor(weird);
      return (
        a !== null &&
        typeof a.displayName === "string" &&
        a.displayName.length > 0 &&
        typeof a.avatar === "string" &&
        typeof a.id === "string"
      );
    } catch {
      return false;
    }
  })());
}

/* ---------------------------------------------------------------- */
console.log("\n==================================================");
console.log(`  passed: ${passed}   failed: ${failed}`);
if (failed > 0) console.log(`  failures: ${failures.join(" | ")}`);
console.log("==================================================\n");
process.exit(failed === 0 ? 0 : 1);
