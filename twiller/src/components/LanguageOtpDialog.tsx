"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import LoadingSpinner from "./loading-spinner";
import { useLanguage } from "@/context/LanguageContext";
import { LOCALE_LABELS, type Locale } from "@/lib/i18n";

interface LanguageOtpDialogProps {
  isOpen: boolean;
  targetLocale: Locale;
  devCode?: string;
  isRequesting: boolean;
  isVerifying: boolean;
  cooldownSeconds: number;
  error: string;
  attemptsRemaining: number | null;
  onVerify: (otp: string) => void;
  onResend: () => void;
  onClose: () => void;
  /** Optional ref to the element that opened the dialog, for focus restoration. */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

const SHOW_DEV_HINT = process.env.NODE_ENV !== "production";

export default function LanguageOtpDialog(props: LanguageOtpDialogProps) {
  const { isOpen, targetLocale } = props;
  const { t } = useLanguage();
  const [otp, setOtp] = useState("");
  const [localError, setLocalError] = useState("");
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const startSentinelRef = useRef<HTMLDivElement | null>(null);
  const endSentinelRef = useRef<HTMLDivElement | null>(null);
  const returnToRef = useRef<HTMLElement | null>(props.triggerRef?.current || null);
  const busy = props.isRequesting || props.isVerifying;

  useEffect(() => {
    if (isOpen) {
      setOtp("");
      setLocalError("");
    }
  }, [isOpen, targetLocale]);

  // Focus the OTP input when the dialog opens and remember the trigger element
  useEffect(() => {
    if (!isOpen) return;
    const input = inputRef.current;
    if (input) {
      input.focus({ preventScroll: true });
    }
    returnToRef.current = (props.triggerRef?.current || document.activeElement) as HTMLElement | null;
  }, [isOpen, props.triggerRef]);

  // Escape closes the dialog (never during an active request/verification)
  useEffect(() => {
    if (!isOpen) return;
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        props.onClose();
      }
    }
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [isOpen, busy, props.onClose]);

  // Focus trap: cycle Tab within the dialog via sentinel elements
  useEffect(() => {
    if (!isOpen || !startSentinelRef.current || !endSentinelRef.current) return;
    function handleSentinelKeydown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      if (event.target === startSentinelRef.current && event.shiftKey) {
        event.preventDefault();
        endSentinelRef.current?.focus({ preventScroll: true });
      }
      if (event.target === endSentinelRef.current && !event.shiftKey) {
        event.preventDefault();
        startSentinelRef.current?.focus({ preventScroll: true });
      }
    }
    startSentinelRef.current?.addEventListener("keydown", handleSentinelKeydown);
    endSentinelRef.current?.addEventListener("keydown", handleSentinelKeydown);
    return () => {
      startSentinelRef.current?.removeEventListener("keydown", handleSentinelKeydown);
      endSentinelRef.current?.removeEventListener("keydown", handleSentinelKeydown);
    };
  }, [isOpen]);

  // Restore focus to the trigger element when the dialog closes
  useEffect(() => {
    if (isOpen) return;
    const target = returnToRef.current;
    if (target) {
      target.focus({ preventScroll: true });
      returnToRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setCooldownLeft(props.cooldownSeconds);
    if (props.cooldownSeconds > 0) {
      timerRef.current = setInterval(() => {
        setCooldownLeft((prev) => {
          if (prev <= 1) {
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [props.cooldownSeconds, targetLocale]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = otp.trim();
    if (!/^\d{6}$/.test(code)) {
      setLocalError(t("langOtp.errOtpFormat"));
      return;
    }
    setLocalError("");
    props.onVerify(code);
  };
  const handleOtpChange = (value: string) => {
    setOtp(value.replace(/\D/g, "").slice(0, 6));
  };
  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="language-otp-dialog-title"
      aria-describedby="language-otp-dialog-description"
    >
      <div
        ref={startSentinelRef}
        tabIndex={0}
        className="focus-sentinel sr-only"
        aria-hidden="true"
      />
      <Card className="w-full max-w-md bg-black border-gray-800">
        <CardHeader className="relative">
          <CardTitle
            id="language-otp-dialog-title"
            className="text-white text-xl font-bold flex items-center gap-2"
          >
            <ShieldCheck className="h-5 w-5 text-blue-400" />
            {t("langOtp.title")}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onClose}
            disabled={busy}
            className="absolute right-4 top-4 text-gray-400 hover:text-white"
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <p
            id="language-otp-dialog-description"
            className="text-gray-300 text-sm"
          >
            {t("langOtp.intro", { language: LOCALE_LABELS[targetLocale] })}
          </p>
          {/* OTPs are always emailed to the account address. */}
          <p className="text-gray-400 text-sm">{t("langOtp.hintEmail")}</p>
          <Separator className="bg-gray-700" />
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="langotp-code" className="text-white">
                {t("langOtp.codeLabel")}
              </Label>
              <Input
                ref={inputRef}
                id="langotp-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t("langOtp.codePlaceholder")}
                value={otp}
                onChange={(e) => handleOtpChange(e.target.value)}
                className="bg-transparent border-gray-600 text-white placeholder-gray-400 focus:border-blue-500 font-mono tracking-widest text-center text-lg"
                disabled={busy}
              />
            </div>
            {(localError || props.error) && (
              <p className="text-red-400 text-sm" role="alert">
                {localError || props.error}
              </p>
            )}
            {props.attemptsRemaining !== null && !localError && (
              <p className="text-gray-400 text-sm">
                {t("langOtp.attemptsLeft", {
                  count: String(props.attemptsRemaining),
                })}
              </p>
            )}
            {SHOW_DEV_HINT && props.devCode && (
              <p className="text-xs text-amber-300/90 border border-amber-500/30 rounded-md px-2 py-1">
                {t("langOtp.devHint", { code: props.devCode })}
              </p>
            )}
            <Button
              type="submit"
              disabled={busy || otp.trim().length !== 6}
              className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-full disabled:bg-gray-700 disabled:text-gray-400 disabled:opacity-100"
            >
              {props.isVerifying ? (
                <span className="flex items-center gap-2">
                  <LoadingSpinner size="sm" />
                  {t("langOtp.verifying")}
                </span>
              ) : (
                t("langOtp.verify")
              )}
            </Button>
          </form>
          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={props.onClose}
              disabled={busy}
              className="text-gray-300 hover:bg-gray-900 hover:text-white"
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={props.onResend}
              disabled={busy || cooldownLeft > 0}
              className="border-gray-500 bg-transparent text-white hover:bg-gray-900 hover:text-white disabled:border-gray-700 disabled:text-gray-400 disabled:opacity-100"
            >
              {props.isRequesting
                ? t("langOtp.sending")
                : cooldownLeft > 0
                  ? t("langOtp.resendIn", { seconds: String(cooldownLeft) })
                  : t("langOtp.resend")}
            </Button>
          </div>
        </CardContent>
      </Card>
      <div
        ref={endSentinelRef}
        tabIndex={0}
        className="focus-sentinel sr-only"
        aria-hidden="true"
      />
    </div>
  );
}




export function langOtpErrorMessage(
  t: (path: string, params?: Record<string, string>) => string,
  err: import("@/lib/languageOtp").LanguageOtpApiError | null
): string {
  if (!err) return "";
  switch (err.code) {
    case "NETWORK":
      return t("langOtp.errNetwork");
    case "timeout":
      return t("langOtp.errTimeout");
    case "auth-required":
    case "auth-invalid":
    case "auth-no-email":
      return t("langOtp.errAuth");
    case "auth-unavailable":
      return t("langOtp.errUnavailable");
    case "no-profile":
      return t("langOtp.errNoProfile");
    case "email-unverified":
      return t("langOtp.errEmailUnverified");
    case "unsupported-locale":
      return t("langOtp.errUnsupportedLocale");
    case "invalid-code-shape":
      return t("langOtp.errOtpFormat");
    case "incorrect-code":
      return typeof err.attemptsRemaining === "number"
        ? t("langOtp.errIncorrectCode", { count: String(err.attemptsRemaining) })
        : t("langOtp.errIncorrectCodeNoCount");
    case "no-pending-code":
      return t("langOtp.errNoPendingCode");
    case "account-mismatch":
      return t("langOtp.errAccountMismatch");
    case "code-expired":
      return t("langOtp.errExpired");
    case "attempts-exhausted":
      return t("langOtp.errExhausted");
    case "resend-cooldown":
      return typeof err.retryAfterSeconds === "number"
        ? t("langOtp.errCooldown", { seconds: String(err.retryAfterSeconds) })
        : t("langOtp.errCooldownNoCount");
    case "already-in-flight":
      return t("langOtp.errInFlight");
    case "already-used":
      return t("langOtp.errAlreadyUsed");
    case "delivery-failed":
      return t("langOtp.errDeliveryFailed");
    default:
      return err.error || t("langOtp.errGeneric");
  }
}
