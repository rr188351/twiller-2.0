/**
 * Internship Feature 3 - Browser notifications: unit tests.
 *
 * HOW TO RUN
 *   cd twiller
 *   node tests/tweetNotifications.test.ts
 *
 * No test framework is installed or required - Node 24 runs TypeScript
 * directly via type stripping, so this file uses a tiny `check()` helper.
 * Exits 0 on success, 1 on any failure.
 *
 * Notification side effects are injected, so these tests run headless and
 * never touch a real browser.
 */

import {
  containsBothKeywords,
  notifyIfMatching,
  seedExistingTweets,
  resetNotifiedTweets,
  hasNotified,
  setPendingTweetId,
  peekPendingTweetId,
  consumePendingTweetId,
  clearPendingTweetId,
  decideReveal,
  getPendingTweetId,
  OPEN_TWEET_EVENT,
} from "../src/lib/tweetNotifications.ts";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

interface Captured {
  title: string;
  body?: string;
  tag?: string;
}

/** Records notifications instead of showing them. */
function makeNotifier() {
  const calls: Captured[] = [];
  return {
    calls,
    notifier: (title: string, options: NotificationOptions) => {
      calls.push({ title, body: options.body as string, tag: options.tag as string });
    },
  };
}

const tweet = (id: string, content: string) => ({ _id: id, content });

console.log("\nTwiller 2.0 - Feature 3 (browser notifications) test suite\n");

// ------------------------------------------------------------------ matching
console.log("[1] KEYWORD MATCHING - both words required, case-insensitive");

const shouldMatch: Array<[string, string]> = [
  ["contains both words", "Learning about cricket and science today"],
  ["uppercase CRICKET + lowercase science", "CRICKET and science"],
  ["lowercase cricket + uppercase SCIENCE", "cricket and SCIENCE"],
  ["both fully uppercase", "CRICKET AND SCIENCE"],
  ["mixed title case", "Cricket And Science"],
  ["extra words around them", "My thoughts on Cricket, Science and life"],
];

for (const [label, content] of shouldMatch) {
  check(label, containsBothKeywords(content), `for "${content}"`);
}

const shouldNotMatch: Array<[string, string]> = [
  ["only cricket", "I love cricket so much"],
  ["only science", "Science is fascinating"],
  ["neither word", "Just had a lovely afternoon walk"],
  ["empty string", ""],
  ["substring words do not trigger", "sciences and cricketers debated"],
  ["whitespace only", "   "],
];

for (const [label, content] of shouldNotMatch) {
  check(label, !containsBothKeywords(content), `for "${content}"`);
}

check(
  "non-string input is handled safely",
  containsBothKeywords(undefined as unknown as string) === false
);

// ------------------------------------------------------------ notifications
console.log("\n[2] NOTIFICATION DELIVERY - permission = granted");
resetNotifiedTweets();
{
  const { calls, notifier } = makeNotifier();
  const result = notifyIfMatching(tweet("t1", "cricket and science together"), {
    enabled: true,
    permission: "granted",
    notifier,
  });
  check("matching tweet notifies", result.notified && result.reason === "shown");
  check("exactly one notification fired", calls.length === 1, `got ${calls.length}`);
  check("body contains the FULL tweet text", calls[0]?.body === "cricket and science together");
  check("tag is derived from the tweet id", calls[0]?.tag === "twiller-tweet-t1");
}

console.log("\n[3] NO NOTIFICATION for partial matches");
for (const [label, content] of [
  ["only cricket", "cricket only"],
  ["only science", "science only"],
  ["neither", "unrelated post"],
] as Array<[string, string]>) {
  resetNotifiedTweets();
  const { calls, notifier } = makeNotifier();
  const result = notifyIfMatching(tweet(`p-${label}`, content), {
    enabled: true,
    permission: "granted",
    notifier,
  });
  check(`${label} does not notify`, !result.notified && result.reason === "no-keyword-match");
  check(`${label} fired no notification`, calls.length === 0);
}

console.log("\n[4] DUPLICATE SUPPRESSION - same tweet never notifies twice");
resetNotifiedTweets();
{
  const { calls, notifier } = makeNotifier();
  const t = tweet("dup-1", "cricket plus science again");
  const first = notifyIfMatching(t, { enabled: true, permission: "granted", notifier });
  const second = notifyIfMatching(t, { enabled: true, permission: "granted", notifier });
  const third = notifyIfMatching(t, { enabled: true, permission: "granted", notifier });
  check("first call notifies", first.notified);
  check("second call is suppressed", !second.notified && second.reason === "duplicate");
  check("third call is suppressed", !third.notified && third.reason === "duplicate");
  check("only ONE notification shown in total", calls.length === 1, `got ${calls.length}`);
  check("duplicate state is tracked", hasNotified("dup-1"));
}

console.log("\n[5] USER SETTING - notifications disabled");
resetNotifiedTweets();
{
  const { calls, notifier } = makeNotifier();
  const result = notifyIfMatching(tweet("off-1", "cricket and science"), {
    enabled: false,
    permission: "granted",
    notifier,
  });
  check("disabled user is not notified", !result.notified && result.reason === "disabled-by-user");
  check("no notification fired while disabled", calls.length === 0);
}

console.log("\n[6] BROWSER PERMISSION STATES");
resetNotifiedTweets();
for (const [label, permission] of [
  ["default (not yet asked)", "default"],
  ["denied", "denied"],
  ["unsupported browser", "unsupported"],
] as Array<[string, string]>) {
  const { calls, notifier } = makeNotifier();
  const result = notifyIfMatching(tweet(`perm-${permission}`, "cricket and science"), {
    enabled: true,
    permission: permission as never,
    notifier,
  });
  check(`${label} does not notify`, !result.notified, `reason=${result.reason}`);
  check(`${label} fired no notification`, calls.length === 0);
}
{
  // A denied user must never start re-prompting. There is no prompt call in
  // this module at all - it only runs from an explicit user action.
  const { calls, notifier } = makeNotifier();
  for (let i = 0; i < 5; i += 1) {
    notifyIfMatching(tweet(`denied-loop-${i}`, "cricket and science"), {
      enabled: true,
      permission: "denied",
      notifier,
    });
  }
  check("repeated denied attempts never notify or re-prompt", calls.length === 0);
}

console.log("\n[7] INITIAL FEED LOAD - history must not spam notifications");
resetNotifiedTweets();
{
  const history = [
    tweet("h1", "old cricket and science post"),
    tweet("h2", "another old cricket + science post"),
  ];
  seedExistingTweets(history);
  const { calls, notifier } = makeNotifier();
  for (const t of history) {
    notifyIfMatching(t, { enabled: true, permission: "granted", notifier });
  }
  check("pre-existing tweets are marked as seen", hasNotified("h1") && hasNotified("h2"));
  check("no notification fired for history", calls.length === 0, `got ${calls.length}`);

  const fresh = tweet("h3", "brand new cricket and science post");
  const result = notifyIfMatching(fresh, { enabled: true, permission: "granted", notifier });
  check("a genuinely NEW matching tweet still notifies", result.notified);
  check("exactly one notification for the new tweet", calls.length === 1, `got ${calls.length}`);
}

console.log("\n[8] ROBUSTNESS - missing id and throwing notifier");
resetNotifiedTweets();
{
  const { notifier } = makeNotifier();
  const result = notifyIfMatching(
    { _id: "", content: "cricket and science" },
    { enabled: true, permission: "granted", notifier }
  );
  check("tweet without an id is skipped", !result.notified && result.reason === "missing-id");
}
{
  const thrower = () => {
    throw new Error("Notifications blocked");
  };
  const result = notifyIfMatching(tweet("throw-1", "cricket and science"), {
    enabled: true,
    permission: "granted",
    notifier: thrower,
  });
  check("a throwing notifier never breaks the feed", !result.notified);
}

console.log("\n[9] NOTIFICATION CLICK -> reveal the tweet (pending tweet id handoff)");
{
  check("no pending tweet id initially", getPendingTweetId() === null);

  setPendingTweetId("tweet-abc123");
  check("pending tweet id is stored", getPendingTweetId() === "tweet-abc123");

  const consumed = consumePendingTweetId();
  check("feed receives the tweet id on mount", consumed === "tweet-abc123");
  check("pending id is cleared after consuming", getPendingTweetId() === null);
  check("a second consume returns null", consumePendingTweetId() === null);
}

console.log("\n[10] EVENT NAME is stable (Feed and Mainlayout rely on it)");
check("event name is twiller:open-tweet", OPEN_TWEET_EVENT === "twiller:open-tweet");

console.log("\n[11] CLICKING the notification reveals the tweet");
{
  resetNotifiedTweets();
  const g = globalThis as unknown as Record<string, unknown>;
  const originalWindow = g.window;
  const originalNotification = g.Notification;

  const dispatched: Array<{ type: string; detail: any }> = [];
  let focused = 0;
  let closed = 0;

  class FakeNotification {
    static permission = "granted";
    onclick: (() => void) | null = null;
    title: string;
    options: any;
    constructor(title: string, options: any) {
      this.title = title;
      this.options = options;
      instances.push(this);
    }
    close() {
      closed += 1;
    }
  }
  const instances: FakeNotification[] = [];

  g.window = {
    focus: () => {
      focused += 1;
    },
    dispatchEvent: (e: any) => {
      dispatched.push({ type: e.type, detail: e.detail });
      return true;
    },
  };
  g.Notification = FakeNotification;

  const result = notifyIfMatching(
    { _id: "click-42", content: "cricket and science everywhere" },
    { enabled: true, permission: "granted" }
  );

  check("notification was created", result.notified && instances.length === 1);
  check("full tweet text is the body", instances[0]?.options?.body === "cricket and science everywhere");

  // THE BUG BEING FIXED: there was no onclick at all before.
  check("an onclick handler IS attached", typeof instances[0]?.onclick === "function");

  // Simulate the user clicking the notification.
  instances[0]?.onclick?.();

  check("window was focused", focused >= 1, `focused=${focused}`);
  check("the open-tweet event was dispatched", dispatched.length === 1, JSON.stringify(dispatched));
  check("event type is twiller:open-tweet", dispatched[0]?.type === "twiller:open-tweet");
  check("event carries the tweet id", dispatched[0]?.detail?.tweetId === "click-42");
  check("the tweet id was stored for the feed", getPendingTweetId() === "click-42");
  check("the notification was closed after clicking", closed === 1);
  check(
    "the feed can consume the id handoff",
    consumePendingTweetId() === "click-42"
  );

  g.window = originalWindow;
  g.Notification = originalNotification;
console.log("\n[12] REVEAL TIMING - pending id is NOT lost while loading");
{
  // Simulates a tiny DOM: the only "rendered" tweets are the ids in this set.
  const rendered = new Set<string>();
  const exists = (id: string) => rendered.has(id);

  // (a) Click while the tweet is already rendered -> reveal immediately.
  setPendingTweetId("tweet-mounted");
  rendered.add("tweet-mounted");
  const mounted = decideReveal(peekPendingTweetId(), true, exists);
  check("mounted feed reveals immediately", mounted.action === "reveal" && mounted.tweetId === "tweet-mounted");
  clearPendingTweetId();
  check("revealed id is cleared", peekPendingTweetId() === null);

  // (b) Click from Profile before the tweets finish loading -> WAIT, keep id.
  setPendingTweetId("tweet-slow");
  const waiting = decideReveal(peekPendingTweetId(), false, exists);
  check("loading feed waits instead of failing", waiting.action === "wait");
  check("pending id is NOT lost during loading", peekPendingTweetId() === "tweet-slow");

  // Same state, one more retry while still loading -> still kept, no notice.
  const retryWhileLoading = decideReveal(peekPendingTweetId(), false, exists);
  check("repeated retries while loading keep the id", retryWhileLoading.action === "wait" && peekPendingTweetId() === "tweet-slow");

  // The tweets arrive and the anchor renders -> the very next retry reveals.
  rendered.add("tweet-slow");
  const landed = decideReveal(peekPendingTweetId(), true, exists);
  check("tweet reveals once it renders", landed.action === "reveal" && landed.tweetId === "tweet-slow");
  clearPendingTweetId();

  // (c) Loading finished and the tweet really is missing -> report it.
  setPendingTweetId("tweet-absent");
  const missing = decideReveal(peekPendingTweetId(), true, exists);
  check("missing tweet after load is reported", missing.action === "missing" && missing.tweetId === "tweet-absent");
  clearPendingTweetId();

  // (d) Nothing pending -> the retry effect is a cheap no-op.
  const idle = decideReveal(peekPendingTweetId(), true, exists);
  check("no pending id means idle", idle.action === "idle");
}

console.log("\n[13] PEEK vs CONSUME semantics");
{
  setPendingTweetId("tweet-peek");
  check("peek reads without clearing", peekPendingTweetId() === "tweet-peek" && peekPendingTweetId() === "tweet-peek");
  check("explicit clear forgets the id", (clearPendingTweetId(), peekPendingTweetId() === null));
  setPendingTweetId("tweet-once");
  check("consume still returns and clears", consumePendingTweetId() === "tweet-once" && consumePendingTweetId() === null);
}


}

console.log(`\n==================================================`);
console.log(`  passed: ${passed}   failed: ${failed}`);
console.log("==================================================\n");
process.exit(failed === 0 ? 0 : 1);

