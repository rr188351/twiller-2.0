"use client";

/**
 * SubscriptionPage - Internship Feature 1 (phase 4).
 *
 * WHERE IT LIVES
 * --------------
 * `Mainlayout` renders pages with plain state (`currentPage === "profile" ?
 * <ProfilePage /> : children`), so this page is wired the exact same way -
 * `{currentPage === "subscription" ? <SubscriptionPage /> : ...}` plus one
 * `Sidebar` nav entry. No router was added and no architecture changed.
 *
 * WHAT IT DOES (AND DOES NOT DO)
 * ------------------------------
 * Displays every plan exactly as the BACKEND reports it (`GET /plans`),
 * shows the user's current plan from AuthContext, calls
 * `POST /subscription/payment` with ONLY `{ userId, planId }`, and renders
 * whatever the backend returns (success/invoice/email status or the
 * 400/402/403/404 messages). Price, quota, the time window and the outcome
 * are all decided server-side; this page never invents them.
 *
 * The mock-provider `testOutcome` is sent ONLY from the development-only
 * testing control below (stripped out of production bundles by Next.js
 * dead-code elimination on `process.env.NODE_ENV`). The backend ignores it
 * in production regardless.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Check, CreditCard } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardTitle } from "./ui/card";
import LoadingSpinner from "./loading-spinner";
import { useAuth } from "@/context/AuthContext";
import {
  describePaymentError,
  fetchPlans,
  findPlan,
  formatEmailDelivery,
  formatPaymentWindow,
  formatPrice,
  formatQuota,
  isPaymentWindowOpen,
  requestPayment,
  type PaymentSuccessResponse,
  type PaymentWindowInfo,
  type PlanId,
  type SubscriptionPlan,
} from "@/lib/subscription";

/** True only in `next dev` - Next.js inlines this, so production omits it. */
const DEV_TESTING = process.env.NODE_ENV !== "production";

type SimulateOutcome = "success" | "failed" | "cancelled";

interface PageStatus {
  kind: "success" | "error";
  text: string;
  /** Human title derived from the backend error code (cancelled vs failed vs
   *  validation vs window-closed) so each state reads distinctly. */
  title?: string;
}

/**
 * Maps a backend error code to an honest, specific banner title.
 * The message itself always comes from the backend - only the label is local.
 */
function titleForError(info: { code?: string; status?: number }): string {
  switch (info.code) {
    case "PAYMENT_CANCELLED":
      return "Payment cancelled";
    case "PAYMENT_WINDOW_CLOSED":
      return "Payment window closed";
    case "PAYMENT_FAILED":
      return "Payment failed";
    case "FREE_PLAN_NO_PAYMENT":
    case "UNKNOWN_PLAN":
      return "Validation error";
    case "NETWORK":
      return "Cannot reach the backend";
    default:
      return "Payment failed";
  }
}

/** Appends HTTP status / code / server IST time for debugging (requirement:
 *  API failures must be useful, never swallowed). */
function debugSuffix(info: { code?: string; status?: number; istTime?: string }): string {
  const parts: string[] = [];
  if (info.status) parts.push(`HTTP ${info.status}`);
  if (info.code) parts.push(info.code);
  if (info.istTime) parts.push(`server time ${info.istTime}`);
  return parts.length ? ` (${parts.join(" · ")})` : "";
}

export default function SubscriptionPage() {
  const { user, refreshUser } = useAuth();

  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [paymentWindow, setPaymentWindow] = useState<PaymentWindowInfo | null>(null);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [payingPlanId, setPayingPlanId] = useState<PlanId | null>(null);
  const [status, setStatus] = useState<PageStatus | null>(null);
  const [receipt, setReceipt] = useState<PaymentSuccessResponse | null>(null);
  const [simulate, setSimulate] = useState<SimulateOutcome>("success");

  // The stored plan id from the BACKEND profile (/loggedinuser). Empty string
  // means "no plan stored" - the backend explicitly treats that as Free
  // (backend/models/user.js), so Free is the backend's answer, not a guess.
  const storedPlanId = (user?.plan ?? "").trim().toLowerCase();
  // Once plans are loaded, an id that matches nothing is genuinely UNKNOWN -
  // we must not silently present it as Free (requirement: never assume).
  const matchedPlan = storedPlanId
    ? plans.find((plan) => plan.id === storedPlanId)
    : undefined;
  const planIsUnknown =
    storedPlanId !== "" && plans.length > 0 && !matchedPlan;
  // Display plan: matched id, or Free only when nothing is stored.
  // findPlan's Free fallback is still used for the empty case (backend default).
  const currentPlan = matchedPlan ?? findPlan(plans, storedPlanId || "free");

  const loadPlans = useCallback(async () => {
    setIsLoadingPlans(true);
    setLoadError("");
    try {
      const res = await fetchPlans();
      setPlans(res.plans);
      setPaymentWindow(res.paymentWindow);
    } catch (error) {
      const info = describePaymentError(error);
      setLoadError(info.message + debugSuffix(info));
    } finally {
      setIsLoadingPlans(false);
    }
  }, []);

  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  // Advisory open/closed chip. Re-evaluated every 30s so it flips at the
  // 10:00/11:00 IST boundaries without a reload. UX ONLY - the backend
  // re-checks the window with server time on every payment attempt.
  const [windowNow, setWindowNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setWindowNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const windowIsOpen = paymentWindow
    ? isPaymentWindowOpen(paymentWindow, windowNow)
    : false;

  if (!user) return null;

  const handleChoose = async (plan: SubscriptionPlan) => {
    if (payingPlanId) return; // a payment is already running: ignore extras
    if (!user?._id) {
      setStatus({
        kind: "error",
        title: "Not signed in",
        text: "Please sign in again to subscribe.",
      });
      return;
    }
    setPayingPlanId(plan.id);
    setStatus(null);
    setReceipt(null);
    try {
      // Backend stays authoritative: amount/quota/plan name are NOT sent.
      // The development-only mock control is the only source of testOutcome.
      const res = await requestPayment(
        { userId: user._id, planId: plan.id },
        DEV_TESTING ? simulate : undefined
      );
      setReceipt(res);
      setStatus({
        kind: "success",
        text: `Payment successful. ${res.planName} is now your active plan.`,
      });
      // Update the displayed current plan without a full page reload. If the
      // refresh fails, refreshUser swallows it (payment already succeeded and
      // is shown above) - the plan simply updates on the next page load.
      await refreshUser();
    } catch (error) {
      const info = describePaymentError(error);
      setStatus({
        kind: "error",
        title: titleForError(info),
        text: info.message + debugSuffix(info),
      });
    } finally {
      setPayingPlanId(null);
    }
  };

  const dismissStatus = () => {
    setStatus(null);
    setReceipt(null);
  };

  return (
    <div className="min-h-screen bg-black">
      <div className="sticky top-0 bg-black/90 backdrop-blur-md border-b border-gray-800 z-10">
        <div className="px-4 py-3 flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-blue-400" aria-hidden="true" />
          <h1 className="text-xl font-bold text-white">Subscription</h1>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">
        <section aria-labelledby="current-plan-heading" className="rounded-xl border border-gray-800 bg-gray-950 p-4">
          <p id="current-plan-heading" className="text-sm text-gray-400">
            Current Plan
          </p>
          {isLoadingPlans ? (
            /* Don't flash a plan name while /plans is in flight - wait for
               real data instead of assuming anything. */
            <div className="flex items-center gap-2 mt-2 text-gray-400" role="status">
              <LoadingSpinner size="sm" aria-hidden="true" />
              <span className="text-sm">Loading your plan&hellip;</span>
            </div>
          ) : planIsUnknown ? (
            /* Stored id matches no plan the backend serves: say so plainly
               rather than silently relabeling it Free. */
            <>
              <p className="text-2xl font-bold text-white mt-1">
                {user.plan}
              </p>
              <p className="text-amber-400 text-sm mt-1" role="alert">
                This plan id isn&apos;t in the backend&apos;s plan list. It is shown
                exactly as stored - not assumed to be Free. Choose a plan below
                to switch to a known plan.
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl font-bold text-white mt-1">{currentPlan.name}</p>
              <p className="text-gray-400 text-sm mt-1">
                {formatPrice(currentPlan)} &middot; {formatQuota(currentPlan)}
                {storedPlanId === "" && (
                  <span className="text-gray-500">
                    {" "}
                    (no plan stored on your profile - the backend defaults new and
                    pre-subscription accounts to Free)
                  </span>
                )}
              </p>
            </>
          )}
        </section>

        {paymentWindow && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400" role="note">
            <span>{formatPaymentWindow(paymentWindow)} The backend enforces this
              window using server time &mdash; even if this page looks available,
              payment outside the window will be declined.</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
                windowIsOpen
                  ? "bg-green-900/40 text-green-300"
                  : "bg-gray-800 text-gray-300"
              }`}
              data-testid="window-status"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  windowIsOpen ? "bg-green-400" : "bg-gray-500"
                }`}
                aria-hidden="true"
              />
              {windowIsOpen ? "Open now" : "Closed now"}
            </span>
          </div>
        )}

        {loadError && (
          <div role="alert" className="rounded-lg border border-red-900/60 bg-red-900/20 p-3">
            <p className="text-sm font-semibold text-red-300">Could not load plans</p>
            <p className="text-sm text-red-300/90">{loadError}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={loadPlans}
              disabled={isLoadingPlans}
              className="mt-2 border-gray-600 text-white hover:bg-gray-900"
            >
              Try again
            </Button>
          </div>
        )}

        {status && (
          <div
            role={status.kind === "error" ? "alert" : "status"}
            aria-live="polite"
            className={`rounded-lg border p-3 ${
              status.kind === "success"
                ? "border-green-900/60 bg-green-900/20"
                : "border-red-900/60 bg-red-900/20"
            }`}
          >
            <p
              className={`text-sm font-semibold ${
                status.kind === "success" ? "text-green-300" : "text-red-300"
              }`}
            >
              {status.title ??
                (status.kind === "success" ? "Payment successful" : "Payment failed")}
            </p>
            <p className="text-sm text-gray-300 mt-1">{status.text}</p>
            {receipt && (
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-400">Plan</dt>
                  <dd className="text-white font-medium">{receipt.planName}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-400">Amount</dt>
                  <dd className="text-white font-medium">₹{receipt.amountInr}/month</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-400">Invoice</dt>
                  <dd className="text-white font-medium break-all">{receipt.invoiceNumber}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-400">Invoice status</dt>
                  <dd className="text-white font-medium capitalize">{receipt.invoiceStatus}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-400">Reference</dt>
                  <dd className="text-white font-medium break-all">{receipt.providerRef}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-400">Confirmation</dt>
                  <dd className="text-white font-medium">{formatEmailDelivery(receipt.emailDelivery)}</dd>
                </div>
              </dl>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={dismissStatus}
              className="mt-2 text-gray-300 hover:text-white hover:bg-gray-900"
            >
              Dismiss
            </Button>
          </div>
        )}


        <section aria-labelledby="plans-heading">
          <h2 id="plans-heading" className="text-lg font-semibold text-white mb-3">
            Plans
          </h2>
          {isLoadingPlans ? (
            <div className="flex items-center gap-3 py-6" role="status" aria-live="polite">
              <LoadingSpinner size="sm" />
              <span className="text-sm text-gray-400">Loading plans&hellip;</span>
            </div>
          ) : plans.length === 0 ? (
            <p className="text-sm text-gray-400" role="status">
              No plans are available right now. Please try again later.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
              {plans.map((plan) => {
                // Never mark a card active when the stored id is unknown -
                // the highlight must reflect matched backend data only.
                const isCurrent = !planIsUnknown && plan.id === currentPlan.id;
                const isPayingThis = payingPlanId === plan.id;
                const isBusy = payingPlanId !== null;
                return (
                  <Card
                    key={plan.id}
                    className={`min-w-0 p-5 ${
                      isCurrent
                        ? "bg-gray-950 border-blue-500 ring-1 ring-blue-500/40"
                        : "bg-gray-950 border-gray-800"
                    }`}
                  >
                    <CardContent className="p-0">
                      <div className="flex items-start justify-between gap-2 min-w-0">
                        <CardTitle className="text-lg text-white">{plan.name}</CardTitle>
                        {isCurrent && (
                          <span className="shrink-0 text-xs font-semibold bg-blue-500 text-white rounded-full px-2 py-0.5">
                            Current Plan
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-2xl font-bold text-white">{formatPrice(plan)}</p>
                      <p className="text-sm text-gray-400 mt-1">{formatQuota(plan)}</p>
                      <div className="mt-4">
                        {isCurrent ? (
                          <Button
                            disabled
                            aria-label={`${plan.name} plan, your current plan`}
                            className="w-full bg-gray-800 text-white"
                          >
                            <Check className="h-4 w-4" aria-hidden="true" /> Current Plan
                          </Button>
                        ) : plan.id === "free" ? (
                          <Button
                            variant="outline"
                            disabled
                            aria-label="Free is the default plan and cannot be purchased"
                            className="w-full border-gray-700 text-gray-400 bg-transparent"
                          >
                            Default plan
                          </Button>
                        ) : (
                          <Button
                            onClick={() => handleChoose(plan)}
                            disabled={isBusy}
                            aria-label={`Choose the ${plan.name} plan for ${formatPrice(plan)}`}
                            className="w-full bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-70"
                          >
                            {isPayingThis ? (
                              <span className="inline-flex items-center gap-2">
                                <LoadingSpinner size="sm" aria-hidden="true" />
                                Paying&hellip;
                              </span>
                            ) : (
                              `Choose ${plan.name}`
                            )}
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {DEV_TESTING && (
          <section
            aria-labelledby="dev-testing-heading"
            className="rounded-xl border border-dashed border-gray-700 p-3"
          >
            <h2 id="dev-testing-heading" className="text-xs font-semibold text-gray-400">
              Developer testing (development only)
            </h2>
            <p className="text-[11px] text-gray-500 mt-1">
              Simulates the mock provider outcome for the next payment. This
              control is stripped from production builds, and the backend
              ignores test outcomes in production regardless.
            </p>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Simulated payment outcome">
              {(["success", "failed", "cancelled"] as SimulateOutcome[]).map((outcome) => (
                <Button
                  key={outcome}
                  type="button"
                  variant={simulate === outcome ? "default" : "outline"}
                  size="sm"
                  aria-pressed={simulate === outcome}
                  onClick={() => setSimulate(outcome)}
                  className={
                    simulate === outcome
                      ? "bg-blue-500 hover:bg-blue-600 text-white"
                      : "border-gray-700 text-gray-300 hover:bg-gray-900"
                  }
                >
                  {outcome === "success" ? "Simulate success" : `Simulate ${outcome}`}
                </Button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
