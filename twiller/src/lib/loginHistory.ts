/**
 * Login-history + device-gate API client - Internship Feature 2.
 *
 * Thin wrapper over the existing axiosInstance, which already attaches the
 * Firebase ID token. Identity ALWAYS comes from that token: neither the browser
 * nor the IP address is ever sent as a claim, and no user id is accepted.
 *
 * Nothing here logs tokens or OTPs.
 */

import axiosInstance from "./axiosInstance.js";

export type LoginOutcome = "allowed" | "blocked-mobile-window" | "otp-required";

export interface LoginHistoryEntry {
  id: string;
  loggedInAt: string;
  browser: string;
  os: string;
  deviceCategory: "desktop" | "mobile" | "tablet" | "unknown" | string;
  ip: string;
  outcome: LoginOutcome | string;
}

export type LoginEventResult =
  | {
      ok: true;
      allowed: true;
      browser: string;
      os: string;
      deviceCategory: string;
      ip: string;
      otpRequired: boolean;
      istTime: string;
    }
  | { ok: false; blocked: "mobile-window"; retryAfterSeconds?: number; istTime?: string }
  | { ok: false; otpRequired: true; browser: string }
  | { ok: false; failure: string };

/** Records this login attempt and asks the server whether the session may run. */
export async function recordLoginEvent(): Promise<LoginEventResult> {
  try {
    const res = await axiosInstance.post("/auth/login-event", {});
    return { ok: true, ...res.data };
  } catch (err: unknown) {
    const response = (err as { response?: { status?: number; data?: any } })?.response;
    const status = response?.status ?? 0;
    const data = response?.data ?? {};
    if (status === 403 && data.code === "mobile-window-closed") {
      return {
        ok: false,
        blocked: "mobile-window",
        retryAfterSeconds: data.retryAfterSeconds,
        istTime: data.istTime,
      };
    }
    if (status === 428 && data.code === "chrome-otp-required") {
      return { ok: false, otpRequired: true, browser: String(data.browser || "Chrome") };
    }
    return {
      ok: false,
      failure: typeof data.error === "string" ? data.error : "Something went wrong.",
    };
  }
}

/** Requests the emailed sign-in code (Chrome policy). */
export async function requestLoginOtp(): Promise<
  { ok: true; devCode?: string; deliveryStatus?: string } | { ok: false; error: string }
> {
  try {
    const res = await axiosInstance.post("/auth/login/otp/request", {});
    return { ok: true, devCode: res.data?.devCode, deliveryStatus: res.data?.deliveryStatus };
  } catch (err: unknown) {
    const data = (err as { response?: { data?: any } })?.response?.data;
    return { ok: false, error: (data?.error as string) || "Could not send the code." };
  }
}

/** Verifies the emailed code. `verified === true` is the only success signal. */
export async function verifyLoginOtp(
  otp: string
): Promise<{ ok: true } | { ok: false; error: string; attemptsRemaining?: number }> {
  try {
    const res = await axiosInstance.post("/auth/login/otp/verify", { otp });
    if (res.data?.ok === true && res.data?.verified === true) return { ok: true };
    return { ok: false, error: "Verification failed." };
  } catch (err: unknown) {
    const data = (err as { response?: { data?: any } })?.response?.data;
    return {
      ok: false,
      error: (data?.error as string) || "Incorrect code.",
      attemptsRemaining:
        typeof data?.attemptsRemaining === "number" ? data.attemptsRemaining : undefined,
    };
  }
}

/** The caller's OWN login history (server scopes it to the verified token). */
export async function fetchLoginHistory(): Promise<LoginHistoryEntry[]> {
  const res = await axiosInstance.get("/auth/login-history");
  return Array.isArray(res.data) ? (res.data as LoginHistoryEntry[]) : [];
}
