/**
 * Subscription plans for Twiller 2.0 - Internship Feature 1 (phase 1).
 *
 * SINGLE SOURCE OF TRUTH. Every subscription plan is defined exactly once,
 * here. Nothing else in the codebase may hard-code plan names, prices or
 * tweet limits - routes, tests and (later) the UI must all import from here.
 *
 * Prices are in Indian rupees (INR) per calendar month. The free plan costs
 * nothing and allows a single tweet each billing period; the gold plan is
 * unlimited. Later phases will reuse this module for checkout, the payment
 * window and invoice emails, but phase 1 uses only identity and tweet limits.
 *
 * Monthly usage is NOT stored anywhere. Instead the tweet count is computed
 * from the existing Tweet collection (see `getCurrentPeriod`) using the
 * timestamp the project already keeps on every tweet. Nothing can drift out
 * of sync and no reset job is ever needed - the count is always "tweets by
 * this author in the current IST month".
 */

import istTime, { getIstParts } from "./istTime.js";

const IST_OFFSET_MS = istTime.IST_OFFSET_MINUTES * 60 * 1000;

export const DEFAULT_PLAN_ID = "free";

export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    priceInr: 0,
    tweetLimit: 1,
    unlimited: false,
  },
  bronze: {
    id: "bronze",
    name: "Bronze",
    priceInr: 100,
    tweetLimit: 3,
    unlimited: false,
  },
  silver: {
    id: "silver",
    name: "Silver",
    priceInr: 300,
    tweetLimit: 5,
    unlimited: false,
  },
  gold: {
    id: "gold",
    name: "Gold",
    priceInr: 1000,
    tweetLimit: null,
    unlimited: true,
  },
};

/**
 * Resolves a stored plan id to its definition.
 * Unknown or missing ids fall back to `free`. Falling back to the MOST
 * restrictive plan is deliberate: the backend must never grant unlimited
 * access just because a document contains a typo.
 */
export function getPlan(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
}

/**
 * The current subscription period: the present IST calendar month, expressed
 * as real UTC Dates suitable for MongoDB range queries.
 *
 * Because the period is derived from the calendar, usage resets on its own
 * when the month changes - no counters, no cron jobs, no stored state.
 */
export function getCurrentPeriod(now = new Date()) {
  const { year, month } = getIstParts(now);
  // 00:00:00.000 on the 1st of this month in IST, expressed in UTC.
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
  // 00:00:00.000 on the 1st of next month in IST, expressed in UTC.
  const endYear = month === 12 ? year + 1 : year;
  const endMonth = month === 12 ? 1 : month + 1;
  const end = new Date(
    Date.UTC(endYear, endMonth - 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS
  );
  const label = `${year}-${String(month).padStart(2, "0")}`;
  return { start, end, label };
}

export default {
  PLANS,
  DEFAULT_PLAN_ID,
  getPlan,
  getCurrentPeriod,
};
