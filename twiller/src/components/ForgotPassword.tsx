"use client";

/**
 * ForgotPassword - Internship Feature 6.
 *
 * WHY THIS COMPONENT EXISTS
 * -------------------------
 * `Authmodel.tsx` is Twiller's only login entry point, so this is a new
 * sibling modal opened from it. It follows the EXACT same visual pattern as
 * `Authmodel` / `Editprofile` (fixed overlay + shadcn Card, Input, Label,
 * Button, LoadingSpinner) so no new styling was invented.
 *
 * THE THREE-STEP FLOW
 *   step 1 "identify"     -> email OR phone submitted to the backend, which
 *                            applies the once-per-day limit.
 *   step 2 "verify"       -> phone channel only: enter the SMS OTP. The email
 *                            channel skips it because Firebase itself sends
 *                            the proof by email.
 *   step 3 "new-password" -> paste the Firebase reset code, generate a
 *                            letters-only password, Firebase applies it.
 *
 * PASSWORD RULES ARE ENFORCED TWICE: instantly here, and again on the server
 * so they cannot be bypassed by posting straight to the API.
 */

import React, { useState } from "react";
import { X, Mail, KeyRound, ShieldCheck, RefreshCw, Copy, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import LoadingSpinner from "./loading-spinner";
import axiosInstance from "@/lib/axiosInstance";
import {
  generateLettersOnlyPassword,
  validateGeneratedPassword,
} from "@/lib/passwordGenerator";
import { auth, sendPasswordResetEmail, confirmPasswordReset } from "@/context/firebase";

// Internship Feature 4 (phase 1) - localized strings.
import { useLanguage } from "@/context/LanguageContext";

interface ForgotPasswordProps {
  isOpen: boolean;
  onClose: () => void;
}

type Step = "identify" | "verify" | "new-password" | "done";

export default function ForgotPassword({ isOpen, onClose }: ForgotPasswordProps) {
  const [step, setStep] = useState<Step>("identify");
  const [identifier, setIdentifier] = useState("");
  const [channel, setChannel] = useState<"email" | "phone" | null>(null);
  const [otp, setOtp] = useState("");
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [devHint, setDevHint] = useState("");
  // Internship Feature 4 (phase 1).
  const { t } = useLanguage();

  if (!isOpen) return null;

  /**
   * Firebase requires a redirect `url` alongside `handleCodeInApp`.
   * Twiller only has a single page, so the app simply returns to "/".
   */
  const actionCodeSettings = {
    url: typeof window !== "undefined" ? `${window.location.origin}/` : "",
    handleCodeInApp: true,
  };

  const reset = () => {
    setStep("identify");
    setIdentifier("");
    setChannel(null);
    setOtp("");
    setRecoveryToken(null);
    setResetCode("");
    setNewPassword("");
    setError("");
    setInfo("");
    setDevHint("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // ---- STEP 1: ask the backend to start recovery --------------------------
  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) {
      setError(t("forgot.errIdentifierClient"));
      return;
    }

    setIsLoading(true);
    setError("");
    setInfo("");
    setDevHint("");

    try {
      const res = await axiosInstance.post("/auth/forgot-password/request", {
        identifier: identifier.trim(),
      });

      // The backend deliberately hides whether the account exists.
      if (res.data?.devHint) setDevHint(res.data.devHint);

      const resolvedChannel = res.data?.channel as "email" | "phone" | undefined;

      if (resolvedChannel === "phone") {
        setChannel("phone");
        setInfo(res.data.message || t("forgot.infoPhoneSent"));
        if (res.data?.devCode) {
          setDevHint(`Development mode - your verification code is ${res.data.devCode}`);
        }
        setStep("verify");
        return;
      }

      if (resolvedChannel === "email") {
        setChannel("email");
        // Firebase sends the real reset email from the browser. The reset LINK
        // completes the change on Firebase's own secure page, so this widget
        // must NOT ask for a code or a new password for the email channel.
        await sendPasswordResetEmail(auth, identifier.trim(), actionCodeSettings);
        setInfo("");
        setStep("done");
        return;
      }

      setInfo(res.data?.message || t("forgot.infoGeneric"));
    } catch (err: any) {
      const data = err?.response?.data;
      if (data?.dailyLimitReached) {
        setError(
          `${data.error} ${t("forgot.nextAttemptAt", {
            time: new Date(data.nextAllowedAt).toLocaleString(),
          })}`
        );
      } else {
        setError(data?.error || t("forgot.errGeneric"));
      }
    } finally {
      setIsLoading(false);
    }
  };

  // ---- STEP 2 (phone only): verify the SMS OTP ---------------------------
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp.trim())) {
      setError(t("forgot.errOtpFormat"));
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const res = await axiosInstance.post("/auth/forgot-password/verify-otp", {
        identifier: identifier.trim(),
        otp: otp.trim(),
      });

      setRecoveryToken(res.data.recoveryToken);
      setInfo(t("forgot.infoPhoneVerified"));

      // Firebase is the second factor that actually changes the password.
      // Every Twiller account has an email (it is required by the User model).
      // The interceptor attaches the Firebase token; the backend resolves the
      // signed-in user's profile from the verified token, so the email below
      // belongs to the caller and is safe to use for the reset link.
      const profile = await axiosInstance.get("/loggedinuser");
      const email = profile.data?.email;
      if (email) {
        await sendPasswordResetEmail(auth, email, actionCodeSettings);
        setInfo(t("forgot.infoPhoneVerifiedEmail"));
      }
      setStep("new-password");
    } catch (err: any) {
      setError(err?.response?.data?.error || t("forgot.errVerifyFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  // ---- Generate a compliant password -------------------------------------
  const handleGenerate = () => {
    setNewPassword(generateLettersOnlyPassword());
    setError("");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(newPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("forgot.errCopyFailed"));
    }
  };

  // ---- STEP 3: apply the new password through Firebase --------------------
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!resetCode.trim()) {
      setError(t("forgot.errResetCodeClient"));
      return;
    }

    const check = validateGeneratedPassword(newPassword);
    if (!check.valid) {
      setError(check.reason || "Invalid password.");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      // 1) Firebase applies the new password - it owns the credentials.
      await confirmPasswordReset(auth, resetCode.trim(), newPassword);

      // 2) The backend records the reset and re-checks the policy server-side.
      await axiosInstance.post("/auth/forgot-password/complete", {
        identifier: identifier.trim(),
        password: newPassword,
        recoveryToken,
      });

      setStep("done");
    } catch (err: any) {
      setError(
        err?.response?.data?.error ||
          err?.message ||
          t("forgot.errResetInvalid")
      );
    } finally {
      setIsLoading(false);
    }
  };

  // The EMAIL flow ends at "identify" (Firebase's reset link does the rest), so
  // the verify / new-password steps are only shown for the phone two-factor
  // flow where they are genuinely used.
  const stepLabels: Array<{ key: Step; label: string }> =
    channel === "email"
      ? [{ key: "identify", label: t("forgot.step1Label") }]
      : [
          { key: "identify", label: t("forgot.step1Label") },
          { key: "verify", label: t("forgot.step2Label") },
          { key: "new-password", label: t("forgot.step3Label") },
        ];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-md bg-black border-gray-800 text-white">
        <CardHeader className="relative pb-4 border-b border-gray-800">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl font-bold text-white flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
                {t("forgot.title")}
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="text-gray-400 hover:text-white"
              onClick={handleClose}
              aria-label={t("common.close")}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="pt-6 space-y-4">
          {step !== "done" && (
            <div className="flex items-center gap-2 text-xs">
              {stepLabels.map((s, i) => {
                const activeOrder = step === "identify" ? 0 : step === "verify" ? 1 : 2;
                return (
                  <span
                    key={s.key}
                    className={i <= activeOrder ? "text-blue-400 font-semibold" : "text-gray-500"}
                  >
                    {s.label}
                    {i < stepLabels.length - 1 ? " →" : ""}
                  </span>
                );
              })}
            </div>
          )}

          {step === "done" ? (
            <div className="space-y-4 text-center py-4">
              <ShieldCheck className="h-12 w-12 text-green-500 mx-auto" />
              <p className="text-white font-semibold">
                {channel === "email" ? t("forgot.checkInbox") : t("forgot.doneTitle")}
              </p>
              <p className="text-sm text-gray-400">
                {channel === "email"
                  ? t("pwreset.emailSentMessage")
                  : t("forgot.doneMessage")}
              </p>
              <Button
                className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-full"
                onClick={handleClose}
              >
                {t("auth.signInLink")}
              </Button>
            </div>
          ) : (
            <>
              {info && (
                <p className="text-sm text-blue-300 bg-blue-900/20 rounded-lg p-3">{info}</p>
              )}
              {devHint && (
                <p className="text-xs text-amber-300 bg-amber-900/20 rounded-lg p-2">
                  {devHint}
                </p>
              )}
              {error && (
                <p className="text-sm text-red-400 bg-red-900/20 rounded-lg p-3">{error}</p>
              )}


              {step === "identify" && (
                <form onSubmit={handleRequest} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="fp-identifier" className="text-white">
                      {t("forgot.identifierLabel")}
                    </Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-5 w-5" />
                      <Input
                        id="fp-identifier"
                        placeholder={t("forgot.identifierPlaceholder")}
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        className="pl-10 bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500"
                        disabled={isLoading}
                      />
                    </div>
                    <p className="text-xs text-gray-500">
                      {t("forgot.hintOncePerDay")}
                    </p>
                  </div>

                  <Button
                    type="submit"
                    disabled={isLoading}
                    className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-full"
                  >
                    {isLoading ? (
                      <div className="flex items-center gap-2">
                        <LoadingSpinner size="sm" />
                        <span>{t("forgot.sending")}</span>
                      </div>
                    ) : (
                      t("forgot.sendLink")
                    )}
                  </Button>
                </form>
              )}

              {step === "verify" && (
                <form onSubmit={handleVerifyOtp} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="fp-otp" className="text-white">
                      {t("forgot.otpLabel")}
                    </Label>
                    <Input
                      id="fp-otp"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder={t("forgot.otpPlaceholder")}
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                      className="bg-transparent border-gray-600 text-white text-center text-2xl tracking-[0.4em] placeholder-gray-600 focus:border-blue-500"
                      disabled={isLoading}
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={isLoading || otp.length !== 6}
                    className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-full"
                  >
                    {isLoading ? t("forgot.verifying") : t("forgot.verify")}
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setStep("identify")}
                    className="w-full text-gray-400 hover:text-white"
                  >
                    {t("forgot.useDifferent")}
                  </Button>
                </form>
              )}


              {step === "new-password" && (
                <form onSubmit={handleResetPassword} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="fp-code" className="text-white">
                      {t("forgot.resetCodeLabel")}
                    </Label>
                    <Input
                      id="fp-code"
                      placeholder={t("forgot.resetCodePlaceholder")}
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value)}
                      className="bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500"
                      disabled={isLoading}
                    />
                  </div>

                  <Separator className="bg-gray-700" />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="fp-newpass" className="text-white">
                        {t("forgot.newPasswordLabel")}
                      </Label>
                      <button
                        type="button"
                        onClick={handleGenerate}
                        className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                      >
                        <RefreshCw className="h-3 w-3" /> {t("forgot.generate")}
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        id="fp-newpass"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={t("forgot.newPasswordPlaceholder")}
                        className="bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500 font-mono"
                        disabled={isLoading}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={handleCopy}
                        disabled={!newPassword}
                        className="border-gray-600 text-white hover:bg-gray-900"
                        aria-label={t("common.copyPassword")}
                      >
                        {copied ? (
                          <Check className="h-4 w-4 text-green-400" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-gray-500">
                      {t("forgot.passwordHint")}
                    </p>
                  </div>

                  <Button
                    type="submit"
                    disabled={isLoading || !resetCode || !newPassword}
                    className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-full"
                  >
                    {isLoading ? t("forgot.updating") : t("forgot.setNewPassword")}
                  </Button>
                </form>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

