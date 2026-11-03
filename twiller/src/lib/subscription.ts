/**
 * Subscription API layer - Internship Feature 1 (phase 4).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `plans.js` on the backend is the single source of truth for plan names,
 * prices and quotas. This module gives the frontend one typed place to read
 * that data (`GET /plans`) and to call `POST /subscription/payment`. Any
 * formatting (₹ labels, quota text, window sentence) lives here too, so the
 * page component cannot hard-code plan values that would drift from the
 * backend.
 *
 * Nothing in this file decides whether a payment is allowed. The BACKEND
 * remains authoritative for price, quota and the 10:00-11:00 IST window.
 */

import axiosInstance from "@/lib/axiosInstance";

export type PlanId = "free" | "bronze" | "silver" | "gold";

export interface SubscriptionPlan {
  id: PlanId;
  name: string;
  priceInr: number;
  tweetLimit: number | null;
  unlimited: boolean;
}

export interface PaymentWindowInfo {
  startHour: number;
  endHour: number;
  timeZone: string;
}

export interface PlansResponse {
  plans: SubscriptionPlan[];
  paymentWindow: PaymentWindowInfo;
}

export interface PaymentRequest {
  userId: string;
  planId: string;
}

export interface PaymentSuccessResponse {
  ok: boolean;
  status: "success";
  provider: string;
  providerRef: string;
  plan: PlanId;
  planName: string;
  amountInr: number;
  transactionId: string;
  periodLabel: string;
  invoiceNumber: string;
  invoiceStatus: "issued" | "failed";
  emailDelivery: "pending" | "sent" | "failed";
}

export type PaymentErrorCode =
  | "UNKNOWN_PLAN"
  | "FREE_PLAN_NO_PAYMENT"
  | "PAYMENT_WINDOW_CLOSED"
  | "PAYMENT_FAILED"
  | "PAYMENT_CANCELLED";

export interface PaymentErrorInfo {
  message: string;
  code?: string;
  status?: number;
  istTime?: string;
}

/** Backend call kept inside this file so the plan list has one entry point. */
export async function fetchPlans(): Promise<PlansResponse> {
  const res = await axiosInstance.get<PlansResponse>("/plans");
  return res.data;
}

/**
 * Sends ONLY the values the backend requires (requirement 5): the user id
 * and the plan id. NEVER sends amount, quota or plan name - the backend is
 * authoritative for all of those.
 *
 * `testOutcome` is appended ONLY when explicitly requested by the caller.
 * The subscription page passes it solely from its development-only testing
 * control; production builds omit it, and the backend ignores it when
 * NODE_ENV=production anyway.
 */
export async function requestPayment(
  request: PaymentRequest,
  testOutcome?: "success" | "failed" | "cancelled"
): Promise<PaymentSuccessResponse> {
  const res = await axiosInstance.post<PaymentSuccessResponse>(
    "/subscription/payment",
    testOutcome ? { ...request, testOutcome } : request
  );
  return res.data;
}

/**
 * Normalises every failure mode into one typed shape so the page can react
 * without reading raw axios internals. Network failures, HTTP error bodies
 * and unexpected errors all become a readable message. Never throws.
 */
export function describePaymentError(error: unknown): PaymentErrorInfo {
  const fallback = "Something went wrong. Please try again.";

  if (error !== null && typeof error === "object" && "response" in error) {
    const response = (error as {
      response?: { status?: number; data?: Record<string, unknown> };
    }).response;
    const data = response?.data;
    if (data && typeof data === "object" && typeof data.error === "string") {
      const info: PaymentErrorInfo = { message: data.error };
      if (typeof data.code === "string") info.code = data.code;
      if (typeof response?.status === "number") info.status = response.status;
      if (typeof data.istTime === "string") info.istTime = data.istTime;
      return info;
    }
    if (typeof response?.status === "number") {
      return { message: fallback, status: response.status };
    }
  }

  if (error instanceof Error) {
    if (error.message === "Network Error" || /network/i.test(error.message)) {
      return {
        message: "Cannot reach the Twiller backend. Please check your connection and try again.",
        code: "NETWORK",
      };
    }
    return { message: error.message };
  }

  return { message: fallback };
}

/** "free" fallback keeps components safe when the backend list is empty. */
export function findPlan(plans: SubscriptionPlan[], id: string | undefined): SubscriptionPlan {
  const lower = (id || "free").toLowerCase();
  return (
    plans.find((plan) => plan.id === lower) ?? {
      id: "free",
      name: "Free",
      priceInr: 0,
      tweetLimit: 1,
      unlimited: false,
    }
  );
}

/** "₹100/month"; the free plan renders as the word "Free". */
export function formatPrice(plan: SubscriptionPlan): string {
  if (plan.priceInr === 0) return "Free";
  return `₹${plan.priceInr}/month`;
}

/** "Unlimited tweets/month", "3 tweets/month" or "1 tweet/month". */
export function formatQuota(plan: SubscriptionPlan): string {
  if (plan.unlimited) return "Unlimited tweets/month";
  const count = plan.tweetLimit ?? 0;
  return `${count} ${count === 1 ? "tweet" : "tweets"}/month`;
}

/** "Subscription payments are available from 10:00 AM to 11:00 AM IST." */
export function formatPaymentWindow(window: PaymentWindowInfo): string {
  const part = (hour: number) => {
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return `${twelve}:00 ${hour < 12 ? "AM" : "PM"}`;
  };
  return `Subscription payments are available from ${part(
    window.startHour
  )} to ${part(window.endHour)} IST.`;
}

/**
 * UX-ONLY check of the payment window against the browser clock in the
 * window's own time zone. The BACKEND always re-decides with server time
 * (and is the authority even when this says "Open now"), so a wrong local
 * clock can never bypass anything - it can only colour the advisory chip.
 */
export function isPaymentWindowOpen(
  window: PaymentWindowInfo,
  now: Date = new Date()
): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: window.timeZone || "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return false;
    const minutes = hour * 60 + minute;
    return minutes >= window.startHour * 60 && minutes < window.endHour * 60;
  } catch {
    // Unknown time zone - show "Closed now" rather than a wrong "Open now".
    return false;
  }
}

/** "Email sent" / "Email failed" / "Email pending" for the receipt panel. */
export function formatEmailDelivery(status: PaymentSuccessResponse["emailDelivery"]): string {
  if (status === "sent") return "Email sent";
  if (status === "failed") return "Email failed";
  return "Email pending";
}
