/**
 * Mock payment provider for Twiller 2.0 - Feature 1 (phase 2).
 *
 * PROVIDER-ABSTRACTION DESIGN (mirrors `mailer.js` / `sms.js`)
 * ------------------------------------------------------------
 * Feature code NEVER talks to a vendor directly. It always calls
 * `processPayment()` below. Switching to Razorpay later means adding a
 * `processRazorpayPayment()` branch here and selecting it with
 * `PAYMENT_PROVIDER=razorpay` - the route, model and tests stay untouched.
 * Phase 2 supports only the mock provider; no Razorpay SDK was installed and
 * no Razorpay-specific field leaks outside this file.
 *
 * DETERMINISTIC TEST OUTCOMES
 * ---------------------------
 * Tests force `success` / `failed` / `cancelled` by passing `testOutcome`.
 * That override is honoured ONLY when `exposeDevCode()` is true
 * (i.e. NODE_ENV !== "production"), exactly like the OTP `devCode` pattern in
 * `sms.js` / `mailer.js`. In production the mock simply approves during the
 * window - a client can never downgrade its own payment to `success`.
 *
 * No network calls are made in ANY mode.
 */

import crypto from "node:crypto";
import { exposeDevCode } from "./mailer.js";
import {
  isWithinIstWindow,
  millisUntilNextIstWindow,
  getIstTimeString,
} from "./istTime.js";

/** Only the mock provider exists in phase 2. */
export const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER || "mock").toLowerCase();

/** Assignment rule: payment allowed ONLY in [10:00, 11:00) Asia/Kolkata. */
export const PAYMENT_WINDOW_START_HOUR = 10;
export const PAYMENT_WINDOW_END_HOUR = 11;

/**
 * Whether payments are currently accepted. `date` is injectable so the rule
 * is unit-testable without touching the system clock. Always uses
 * Asia/Kolkata - never the server machine's local timezone.
 */
export function isPaymentWindowOpen(date = new Date()) {
  return isWithinIstWindow(
    PAYMENT_WINDOW_START_HOUR,
    PAYMENT_WINDOW_END_HOUR,
    date
  );
}

/**
 * Milliseconds until the payment window next opens. 0 when open now.
 * Reuses the existing IST helper - no duplicate timezone logic.
 */
export function millisUntilPaymentWindow(date = new Date()) {
  return millisUntilNextIstWindow(
    PAYMENT_WINDOW_START_HOUR,
    PAYMENT_WINDOW_END_HOUR,
    date
  );
}

/** Current IST clock for human-readable responses, e.g. "10:07 IST". */
export function paymentClock(date = new Date()) {
  return getIstTimeString(date);
}

/**
 * Creates a mock vendor reference id. Opaque to the rest of the app - the
 * only contract is that it is present on successful transactions.
 */
export function createMockReference(planId) {
  const rand = crypto.randomBytes(8).toString("hex");
  return `mock_${planId}_${Date.now()}_${rand}`;
}

/**
 * Runs a payment through the configured provider.
 *
 * @param {{plan: object, amountInr: number, userId: string, testOutcome?: string}} payment
 * @returns {Promise<{ok:boolean,status:string,provider:string,providerRef:string|null,amountInr:number,failureReason:string|null}>}
 *
 * `testOutcome` ("success" | "failed" | "cancelled") is a TEST-ONLY override
 * and is silently ignored in production.
 */
export async function processPayment({ plan, amountInr, userId, testOutcome }) {
  const provider = PAYMENT_PROVIDER;

  if (provider !== "mock") {
    // A future PAYMENT_PROVIDER value plugs in here. Phase 2 has no other
    // provider, so failing loudly (instead of pretending success) is the
    // only safe behaviour.
    return {
      ok: false,
      status: "failed",
      provider,
      providerRef: null,
      amountInr,
      failureReason: `Payment provider "${provider}" is not implemented yet.`,
    };
  }

  // Mock approvals only: the tester (never the client) can steer the result.
  let outcome = "success";
  if (testOutcome && exposeDevCode()) {
    const allowed = ["success", "failed", "cancelled"];
    if (allowed.includes(String(testOutcome).toLowerCase())) {
      outcome = String(testOutcome).toLowerCase();
    }
  }

  return {
    ok: outcome === "success",
    status: outcome,
    provider: "mock",
    providerRef: outcome === "success" ? createMockReference(plan.id) : null,
    amountInr,
    failureReason: outcome === "success" ? null : `Mock payment ${outcome}.`,
  };
}

export const paymentConfig = {
  provider: PAYMENT_PROVIDER,
  windowStartHour: PAYMENT_WINDOW_START_HOUR,
  windowEndHour: PAYMENT_WINDOW_END_HOUR,
  timeZone: "Asia/Kolkata",
  testOutcomesHonored: exposeDevCode(),
};

export default {
  isPaymentWindowOpen,
  millisUntilPaymentWindow,
  paymentClock,
  createMockReference,
  processPayment,
  paymentConfig,
};
