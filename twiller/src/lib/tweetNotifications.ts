/**
 * Tweet notification matching + delivery - Internship Feature 3.
 *
 * WHY THIS IS A PLAIN .ts FILE WITH NO REACT
 * -------------------------------------------
 * The rules ("contains BOTH cricket AND science, case-insensitively, show the
 * full text, never twice") are pure logic. Keeping them here means:
 *   1. they can be unit-tested by Node with NO test framework installed
 *      (`node tests/tweetNotifications.test.ts`),
 *   2. the React component only has to worry about wiring,
 *   3. the rules are reusable.
 *
 * BROWSER NOTIFICATION API NOTES
 * ------------------------------
 * - `Notification.permission` is "default" | "granted" | "denied".
 * - We only call `requestPermission()` from an explicit user action (the
 *   settings toggle). Browsers ignore prompts that are not user-initiated, and
 *   repeatedly prompting a denied user is bad manners.
 * - `body` is the full tweet text. Desktop browsers may truncate long bodies
 *   visually, which is a platform limitation - hence the `tag`, which lets a
 *   later notification for the same tweet replace the earlier one instead of
 *   stacking up.
 *
 * WHY NO BACKEND INVOLVEMENT
 * --------------------------
 * The `/post` endpoint already returns the full tweet text, and the feed
 * already receives it, so matching can be done entirely in the browser. No new
 * route, collection or dependency is required.
 */

export const ALERT_KEYWORD_A = "cricket";
export const ALERT_KEYWORD_B = "science";

export type PermissionState = NotificationPermission | "unsupported";

export interface TweetLike {
  _id: string;
  content: string;
  author?: { displayName?: string; username?: string } | null;
}

/**
 * True when the text contains BOTH keywords, case-insensitively.
 *
 * "Both" is deliberate: a tweet containing only one of them must not notify.
 * Word matching uses `\b` so "sciences" does not accidentally trigger, but
 * "Cricket", "SCIENCE" and "my CRICKET and Science thoughts" do.
 */
export function containsBothKeywords(content: string): boolean {
  if (typeof content !== "string" || content.length === 0) return false;
  const text = content.toLowerCase();
  return (
    new RegExp(`\\b${ALERT_KEYWORD_A}\\b`).test(text) &&
    new RegExp(`\\b${ALERT_KEYWORD_B}\\b`).test(text)
  );
}

/** Kept for readability at the call site. */
export const tweetMatchesAlert = containsBothKeywords;

/**
 * Current permission state, or "unsupported" when the browser has no
 * Notification API (older browsers, or plain Node during tests).
 */
export function getPermissionState(): PermissionState {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

/**
 * Asks the browser for permission. MUST only be called from a user action.
 * Returns the resulting state and never throws.
 */
export async function requestNotificationPermission(): Promise<PermissionState> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  try {
    const ctor = Notification as unknown as {
      requestPermission: (cb?: (p: NotificationPermission) => void) => Promise<NotificationPermission> | void;
    };
    const result = await ctor.requestPermission();
    return (result as NotificationPermission) ?? Notification.permission;
  } catch {
    return Notification.permission;
  }
}

/**
 * Tweet ids already handled in this browser session.
 * Module-scoped on purpose: it survives the component unmounting and
 * remounting (React strict mode, navigation, tab switches) so the same tweet
 * can never notify twice.
 */
const notifiedTweetIds = new Set<string>();

/**
 * --- Notification click -> reveal the tweet -------------------------------
 *
 * The browser Notification API does nothing when it is clicked unless an
 * `onclick` handler is supplied. That was the bug: clicking the notification
 * simply left the user where they were.
 *
 * We deliberately do NOT add routing. Twiller has a single page and
 * `Mainlayout` already swaps views with a `currentPage` state, so the handler
 * only needs to:
 *   1. focus the window,
 *   2. remember the tweet id (so it still works if the feed mounts later),
 *   3. fire a plain DOM event that Mainlayout and Feed already listen for.
 * The tweet id is the stable identifier throughout.
 */
export const OPEN_TWEET_EVENT = "twiller:open-tweet";

let pendingTweetId: string | null = null;

/** Called by the notification click handler. */
export function setPendingTweetId(tweetId: string): void {
  pendingTweetId = tweetId;
}

/**
 * Returns and clears the stored tweet id. `Feed` calls this when it mounts,
 * which covers the case where the user was on the Profile view (so the feed
 * was not mounted) at the moment the notification was clicked.
 */
export function consumePendingTweetId(): string | null {
  const id = pendingTweetId;
  pendingTweetId = null;
  return id;
}

/** Test helper. */
export function getPendingTweetId(): string | null {
  return pendingTweetId;
}

/**
 * Non-destructive read of the pending tweet id.
 *
 * `Feed` uses this while the feed is still loading: it needs to know WHICH
 * tweet is pending without losing it, because the matching DOM element does
 * not exist yet. (The old code called `consumePendingTweetId()` eagerly, which
 * discarded the id before the tweets had rendered - the notification-click
 * timing bug.)
 */
export function peekPendingTweetId(): string | null {
  return pendingTweetId;
}

/** Explicitly forgets the pending tweet id. */
export function clearPendingTweetId(): void {
  pendingTweetId = null;
}

/**
 * Decision returned by `decideReveal`. Kept as a pure function so the timing
 * rules can be unit-tested without React or a real DOM.
 */
export type RevealDecision =
  | { action: "idle" }
  | { action: "wait" }
  | { action: "reveal"; tweetId: string }
  | { action: "missing"; tweetId: string };

/**
 * Works out what to do about a pending "reveal this tweet" request.
 *
 * @param pendingId      the tweet the user clicked a notification for
 * @param hasLoaded      whether the feed's first fetch has finished
 * @param elementExists  checks the DOM for the tweet's anchor element
 *
 * Rules:
 *   idle    - nothing pending.
 *   reveal  - the tweet is on screen, so scroll to and highlight it.
 *   wait    - the tweet is not on screen YET but the feed is still loading:
 *             KEEP the id and try again once the tweets arrive.
 *   missing - loading has finished and the tweet really is not in the feed:
 *             only now is it safe to show the "not in your feed" message.
 */
export function decideReveal(
  pendingId: string | null,
  hasLoaded: boolean,
  elementExists: (tweetId: string) => boolean
): RevealDecision {
  if (!pendingId) return { action: "idle" };
  if (elementExists(pendingId)) return { action: "reveal", tweetId: pendingId };
  if (!hasLoaded) return { action: "wait" };
  return { action: "missing", tweetId: pendingId };
}

/**
 * The default click behaviour: focus the tab and ask the app to reveal the
 * tweet. Safe to call in a non-browser context (it simply does nothing).
 */
export function openTweet(tweetId: string): void {
  if (typeof window === "undefined") return;
  try {
    setPendingTweetId(tweetId);
    window.focus?.();
    window.dispatchEvent(new CustomEvent(OPEN_TWEET_EVENT, { detail: { tweetId } }));
  } catch {
    /* never let a click handler break the page */
  }
}

/** Test helper - clears the "already notified" memory. */
export function resetNotifiedTweets(): void {
  notifiedTweetIds.clear();
}

/** Read-only view of what has already notified. */
export function hasNotified(tweetId: string): boolean {
  return notifiedTweetIds.has(tweetId);
}

/**
 * Marks every supplied tweet as already handled WITHOUT notifying.
 * Used once when the feed first loads so historical matching tweets do not
 * spam the user on every refresh - only genuinely NEW tweets notify.
 */
export function seedExistingTweets(tweets: TweetLike[]): void {
  for (const tweet of tweets) {
    if (tweet?._id) notifiedTweetIds.add(tweet._id);
  }
}

export interface NotifyOptions {
  /** The user's own preference, persisted on their profile. */
  enabled?: boolean;
  /** Defaults to the live browser permission. Injectable for tests. */
  permission?: PermissionState;
  /** Defaults to the real Notification constructor. Injectable for tests. */
  notifier?: (title: string, options: NotificationOptions) => void;
}

export type NotifyReason =
  | "shown"
  | "disabled-by-user"
  | "permission-not-granted"
  | "unsupported"
  | "duplicate"
  | "no-keyword-match"
  | "missing-id";

export interface NotifyResult {
  notified: boolean;
  reason: NotifyReason;
}

/**
 * Decides whether a tweet should raise a notification, and raises it.
 * Never throws - a notification problem must never break the feed.
 */
export function notifyIfMatching(
  tweet: TweetLike,
  options: NotifyOptions = {}
): NotifyResult {
  const permission = options.permission ?? getPermissionState();

  // 1. The user's own preference (profile setting) wins over everything.
  if (options.enabled === false) {
    return { notified: false, reason: "disabled-by-user" };
  }

  // 2. Browser support.
  if (permission === "unsupported") {
    return { notified: false, reason: "unsupported" };
  }

  // 3. Only "granted" may show anything. This also stops a denied user from
  //    being prompted over and over.
  if (permission !== "granted") {
    return { notified: false, reason: "permission-not-granted" };
  }

  // 4. An id is required so duplicates can be suppressed.
  if (!tweet?._id) {
    return { notified: false, reason: "missing-id" };
  }

  // 5. The rule itself: BOTH keywords must be present in the same tweet.
  if (!containsBothKeywords(tweet.content)) {
    return { notified: false, reason: "no-keyword-match" };
  }

  // 6. Duplicate suppression - the last check before showing.
  if (notifiedTweetIds.has(tweet._id)) {
    return { notified: false, reason: "duplicate" };
  }

  const authorName = tweet.author?.displayName || tweet.author?.username || "Someone";
  const title = `${authorName} posted about cricket and science`;
  // The FULL tweet text is used, as the assignment requires.
  const body = tweet.content;

  const show =
    options.notifier ??
    ((t: string, o: NotificationOptions) => {
      // `tag` groups/replaces rather than stacking duplicates.
      const notification = new Notification(t, {
        body: o.body,
        tag: o.tag,
        silent: true,
      });
      // Clicking the notification reveals the matching tweet in the feed.
      notification.onclick = () => {
        try {
          window.focus();
          openTweet(tweet._id);
          notification.close();
        } catch {
          /* never let a click handler break the page */
        }
      };
    });

  try {
    show(title, { body, tag: `twiller-tweet-${tweet._id}` });
    notifiedTweetIds.add(tweet._id);
    return { notified: true, reason: "shown" };
  } catch {
    // A blocked or broken Notification constructor must not break the feed.
    return { notified: false, reason: "permission-not-granted" };
  }
}

export default {
  ALERT_KEYWORD_A,
  ALERT_KEYWORD_B,
  containsBothKeywords,
  tweetMatchesAlert,
  getPermissionState,
  requestNotificationPermission,
  notifyIfMatching,
  seedExistingTweets,
  resetNotifiedTweets,
  hasNotified,
  setPendingTweetId,
  peekPendingTweetId,
  consumePendingTweetId,
  clearPendingTweetId,
  decideReveal,
  openTweet,
  OPEN_TWEET_EVENT,
};

