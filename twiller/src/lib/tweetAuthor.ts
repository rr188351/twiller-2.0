/**
 * Safe author resolution for tweets.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Tweet.author` is an ObjectId reference to a User. When the referenced user
 * document no longer exists, `populate("author")` resolves the field to `null`,
 * and `POST /post` returns the raw id (not an object) straight after creating a
 * tweet. Both shapes used to be dereferenced directly in the UI, e.g.
 * `tweet.author.avatar`, which throws:
 *   "TypeError: Cannot read properties of null (reading 'avatar')"
 *
 * `resolveTweetAuthor()` is the single place that turns ANY of those shapes into
 * a complete, non-null author view. It never throws, never invents a real user
 * id, and is used by every component that renders tweet.author.*, so a missing
 * or deleted author can no longer crash a card.
 */

/** Shown when the author document is missing (deleted user) or unusable. */
export const UNKNOWN_AUTHOR_NAME = "Unknown user";

/** Fallback avatar URL. Empty on purpose: AvatarFallback renders the initial. */
export const FALLBACK_AVATAR = "";

export interface ResolvedTweetAuthor {
  /** The author's id when one is known, otherwise "". Never invented. */
  id: string;
  username: string;
  displayName: string;
  /** "" when unset, so AvatarImage can be skipped and the fallback rendered. */
  avatar: string;
  verified: boolean;
  /** True when the author document was missing/unusable. */
  isUnknown: boolean;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

/**
 * Normalises whatever `tweet.author` happens to be into a safe author view.
 *
 * Accepted inputs:
 *   - a populated author object           -> its fields (with fallbacks)
 *   - an id string / number (not expanded) -> id preserved, unknown name/avatar
 *   - null / undefined (deleted user)     -> unknown placeholder
 *   - anything else                        -> unknown placeholder
 */
export function resolveTweetAuthor(author: unknown): ResolvedTweetAuthor {
  const unknown: ResolvedTweetAuthor = {
    id: "",
    username: "",
    displayName: UNKNOWN_AUTHOR_NAME,
    avatar: FALLBACK_AVATAR,
    verified: false,
    isUnknown: true,
  };

  if (author === null || author === undefined) return unknown;

  // An un-expanded reference (ObjectId serialises to a string). Keep the id so
  // ownership checks still work, but show the placeholder name.
  if (typeof author === "string" || typeof author === "number") {
    const id = String(author);
    return id ? { ...unknown, id } : unknown;
  }

  if (typeof author !== "object") return unknown;

  const raw = author as Record<string, unknown>;
  const id = nonEmptyString(raw._id) || nonEmptyString(raw.id);
  const username = nonEmptyString(raw.username);
  const displayName = nonEmptyString(raw.displayName);

  return {
    id,
    username,
    displayName: displayName || username || UNKNOWN_AUTHOR_NAME,
    avatar: nonEmptyString(raw.avatar),
    verified: raw.verified === true,
    isUnknown: false,
  };
}

/** Single-character fallback for the avatar circle. */
export function authorInitial(author: ResolvedTweetAuthor): string {
  const source = author.displayName || author.username || "";
  const first = source.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

export default { resolveTweetAuthor, authorInitial, UNKNOWN_AUTHOR_NAME, FALLBACK_AVATAR };
