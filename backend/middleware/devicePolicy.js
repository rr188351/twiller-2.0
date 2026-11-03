/**
 * Device/browser access policy - Internship Feature 2.
 *
 * ASSIGNMENT RULES IMPLEMENTED HERE
 * ---------------------------------
 *  - Google Chrome  : the user must verify an emailed one-time code.
 *  - Microsoft Edge : no extra one-time code (Firebase auth is still required).
 *  - Mobile devices : access only between 10:00 and 13:00 IST.
 *
 * SECURITY POSTURE
 * ----------------
 * These are ADDITIONAL restrictions layered on top of Firebase ID-token
 * verification - they never replace it and never make a protected route public.
 * The User-Agent is a spoofable hint, so it is used only to *categorise* an
 * already-authenticated session. A missing/ambiguous User-Agent is treated as a
 * desktop with no extra OTP, so it can never lock a user out or be mistaken for
 * a mobile device.
 *
 * The mobile window is evaluated on the SERVER using Asia/Kolkata, so hiding UI
 * elements cannot bypass it.
 */

import { exposeDevCode } from "../utils/mailer.js";
import { isWithinIstWindow, millisUntilNextIstWindow, getIstTimeString } from "../utils/istTime.js";
import { parseUserAgent, resolveClientIp } from "../utils/userAgent.js";

/** Assignment window: mobile access is allowed only in [10:00, 13:00) IST. */
export const MOBILE_WINDOW_START_HOUR = 10;
export const MOBILE_WINDOW_END_HOUR = 13;

/** Browsers that must present an emailed code before their session is granted. */
export const OTP_REQUIRED_BROWSERS = ["Chrome"];

/**
 * The clock used for the mobile window.
 *
 * `DEVICE_POLICY_NOW` (an ISO timestamp) is a DEVELOPMENT/TEST hatch that lets
 * the boundary cases be asserted deterministically. It is ignored whenever
 * NODE_ENV=production, so it can never weaken the deployed rule. This mirrors
 * the existing AUDIO_UPLOAD_FORCE_WINDOW_OPEN / testOutcome pattern.
 */
export function devicePolicyNow() {
  const override = process.env.DEVICE_POLICY_NOW;
  if (override && exposeDevCode()) {
    const parsed = new Date(override);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** True when this browser must complete the emailed-code step. */
export function requiresEmailOtp(browser) {
  return OTP_REQUIRED_BROWSERS.includes(String(browser || ""));
}

/**
 * Evaluates the request against the device/browser policy.
 *
 * @param {import("express").Request} req
 * @returns {{
 *   allowed: boolean,
 *   device: {browser:string, os:string, deviceCategory:string, userAgent:string},
 *   ip: string,
 *   now: Date,
 *   retryAfterSeconds?: number,
 *   istTime: string
 * }}
 */
export function evaluateDevicePolicy(req) {
  const device = parseUserAgent(req?.headers ? req.headers["user-agent"] : undefined);
  const ip = resolveClientIp(req);
  const now = devicePolicyNow();
  const istTime = getIstTimeString(now);

  // Only a positively-identified MOBILE device is time-restricted. Desktops,
  // tablets and unknown clients are never blocked by this rule.
  if (device.deviceCategory === "mobile" && !isWithinIstWindow(MOBILE_WINDOW_START_HOUR, MOBILE_WINDOW_END_HOUR, now)) {
    return {
      allowed: false,
      device,
      ip,
      now,
      istTime,
      retryAfterSeconds: Math.ceil(
        millisUntilNextIstWindow(MOBILE_WINDOW_START_HOUR, MOBILE_WINDOW_END_HOUR, now) / 1000
      ),
    };
  }

  return { allowed: true, device, ip, now, istTime };
}

/**
 * Express middleware enforcing the MOBILE TIME WINDOW ONLY.
 *
 * Applied to the routes that constitute actual access (register, read/write
 * tweets, login event) so the rule is genuinely server-enforced and cannot be
 * bypassed by editing the frontend. It deliberately does NOT require the Chrome
 * OTP: that happens once, at POST /auth/login-event.
 */
export function enforceMobileWindow(req, res, next) {
  const decision = evaluateDevicePolicy(req);
  req.deviceInfo = decision.device;
  req.clientIp = decision.ip;

  if (!decision.allowed) {
    return res.status(403).send({
      error:
        "Mobile devices can access Twiller only between 10:00 AM and 1:00 PM IST.",
      code: "mobile-window-closed",
      window: {
        startHour: MOBILE_WINDOW_START_HOUR,
        endHour: MOBILE_WINDOW_END_HOUR,
        timeZone: "Asia/Kolkata",
      },
      istTime: decision.istTime,
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }

  return next();
}

export default {
  MOBILE_WINDOW_START_HOUR,
  MOBILE_WINDOW_END_HOUR,
  OTP_REQUIRED_BROWSERS,
  devicePolicyNow,
  requiresEmailOtp,
  evaluateDevicePolicy,
  enforceMobileWindow,
};
