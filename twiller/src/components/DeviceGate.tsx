"use client";

/**
 * DeviceGate - Internship Feature 2 (session gate).
 *
 * WHAT IT DOES
 * ------------
 * On mount it asks the SERVER (`POST /auth/login-event`) whether this session
 * may run. The server - not this component - decides:
 *   - mobile device outside 10:00-13:00 IST  -> 403, blocked screen shown
 *   - Google Chrome without a verified code  -> 428, emailed-code step shown
 *   - everything else                        -> allowed
 *
 * The checks are re-evaluated server-side on every access route too, so a user
 * editing the frontend cannot bypass them. Firebase authentication still runs
 * exactly as before; this only adds the assignment's extra rules.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Clock, Mail, ShieldCheck } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import LoadingSpinner from "./loading-spinner";
import { useLanguage } from "@/context/LanguageContext";
import { useAuth } from "@/context/AuthContext";
import {
  recordLoginEvent,
  requestLoginOtp,
  verifyLoginOtp,
} from "@/lib/loginHistory";

type GateState = "checking" | "allowed" | "blocked" | "otp";

export default function DeviceGate({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [state, setState] = useState<GateState>("checking");
  const [busy, setBusy] = useState(false);
  const [otp, setOtp] = useState("");
  const [devCode, setDevCode] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const evaluate = useCallback(async () => {
    if (!user) {
      setState("allowed");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await recordLoginEvent();
      if (result.ok) {
        setState("allowed");
      } else if ("blocked" in result) {
        setState("blocked");
      } else if ("otpRequired" in result) {
        setState("otp");
      } else {
        // Unknown failure: do NOT block the user, Firebase auth already passed.
        setState("allowed");
      }
    } finally {
      setBusy(false);
    }
  }, [user]);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  const handleSendCode = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await requestLoginOtp();
      if (res.ok) {
        setDevCode(res.devCode);
        setMessage(t("login.otpSent"));
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await verifyLoginOtp(otp.trim());
      if (res.ok) {
        setOtp("");
        await evaluate(); // the server must now accept the session
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  if (state === "allowed") return <>{children}</>;

  if (state === "checking") {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (state === "blocked") {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <Clock className="h-10 w-10 text-amber-400 mx-auto" />
          <h1 className="text-xl font-bold">{t("login.blockedTitle")}</h1>
          <p className="text-gray-400 text-sm">{t("login.blockedBody")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <form onSubmit={handleVerify} className="max-w-md w-full space-y-4">
        <div className="text-center space-y-2">
          <ShieldCheck className="h-10 w-10 text-blue-400 mx-auto" />
          <h1 className="text-xl font-bold">{t("login.otpTitle")}</h1>
          <p className="text-gray-400 text-sm">{t("login.otpBody")}</p>
        </div>

        <Button
          type="button"
          onClick={handleSendCode}
          disabled={busy}
          className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-400 disabled:opacity-100 text-white font-semibold rounded-full"
        >
          <Mail className="h-4 w-4 mr-2" />
          {t("login.otpSend")}
        </Button>

        {message && <p className="text-green-400 text-sm">{message}</p>}
        {devCode && <p className="text-xs text-amber-300">DEV: {devCode}</p>}

        <div className="space-y-2">
          <Label htmlFor="login-otp" className="text-white">
            {t("login.otpLabel")}
          </Label>
          <Input
            id="login-otp"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500 text-center font-mono"
            placeholder="000000"
            disabled={busy}
          />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <Button
          type="submit"
          disabled={busy || otp.trim().length !== 6}
          className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-400 disabled:opacity-100 text-white font-semibold rounded-full"
        >
          {busy ? <LoadingSpinner size="sm" /> : t("login.otpVerify")}
        </Button>
      </form>
    </div>
  );
}
