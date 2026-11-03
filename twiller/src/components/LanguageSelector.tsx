"use client";

import React, { useCallback, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  LOCALES,
  LOCALE_LABELS,
  type Locale,
} from "@/lib/i18n";
import { useLanguage } from "@/context/LanguageContext";
import { useAuth } from "@/context/AuthContext";
import { auth } from "@/context/firebase";
import {
  requestLanguageOtp,
  verifyLanguageOtp,
  type LanguageOtpApiError,
  type LanguageOtpChannel,
} from "@/lib/languageOtp";
import LanguageOtpDialog, {
  langOtpErrorMessage,
} from "./LanguageOtpDialog";
// Internship Feature 4 (phase 2) - lets the dialog send the user to the profile
// editor (to add a phone number) without threading props through Mainlayout.
import { OPEN_PROFILE_EDIT_EVENT } from "@/lib/profileEvents";

/**
 * Language selector - Internship Feature 4 (phase 1).
 *
 * Rendered TWICE from existing UI: once inside the logged-in Sidebar (so an
 * authenticated user can switch without logging out) and once on the
 * logged-out Landing page (so language is choosable before signup/login).
 * Both instances share the same LanguageContext, so switching updates the
 * currently rendered page immediately, and the choice persists in
 * localStorage ("twiller-locale") across refreshes and navigation.
 */
export default function LanguageSelector({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useLanguage();
  const { user } = useAuth();
  const triggerRef = useRef<HTMLDivElement | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [target, setTarget] = useState<Locale | null>(null);
  const [channel, setChannel] = useState<LanguageOtpChannel>("sms");
  const [devCode, setDevCode] = useState<string | undefined>(undefined);
  // "sent" | "mock" | "failed" as reported by the backend, so the dialog can be
  // honest about whether a real SMS/e-mail actually went out.
  const [deliveryStatus, setDeliveryStatus] = useState<"sent" | "mock" | "failed">("sent");
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [dialogError, setDialogError] = useState("");
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  // True when the backend refused because the profile has no phone number.
  const [needsPhoneSetup, setNeedsPhoneSetup] = useState(false);

  const showError = useCallback(
    (err: LanguageOtpApiError | null) => {
      setDialogError(langOtpErrorMessage(t, err));
      setNeedsPhoneSetup(err?.code === "phone-setup-required");
    },
    [t]
  );

  const issueCode = useCallback(
    async (next: Locale, idToken: string) => {
      setIsRequesting(true);
      try {
        const res = await requestLanguageOtp(idToken, next);
        if (res.ok) {
          setChannel(res.data.channel);
          setDevCode(res.data.devCode);
          setDeliveryStatus(res.data.deliveryStatus ?? "sent");
          setCooldownSeconds(0);
          setAttemptsRemaining(null);
          setDialogError("");
          setNeedsPhoneSetup(false);
          setDialogOpen(true);
        } else {
          setCooldownSeconds(
            typeof res.error.retryAfterSeconds === "number"
              ? res.error.retryAfterSeconds
              : 0
          );
          setAttemptsRemaining(null);
          showError(res.error);
          setDialogOpen(true);
        }
      } catch {
        showError({ status: 0, error: t("langOtp.errGeneric") });
        setDialogOpen(true);
      } finally {
        setIsRequesting(false);
      }
    },
    [showError, t]
  );

  const pick = useCallback(
    async (next: Locale) => {
      if (next === locale) return;
      const firebaseUser = auth.currentUser;
      // The Twiller profile (user) and the Firebase session (auth.currentUser)
      // are two views of the same session: either one present means SIGNED IN.
      const signedIn = Boolean(user ?? firebaseUser);
      if (!signedIn) {
        // Logged-out visitors keep the instant, device-local switch.
        setLocale(next);
        return;
      }
      // Signed in: open the OTP dialog immediately so any failure below is
      // VISIBLE to the user instead of silently falling back to a free switch.
      setTarget(next);
      setDevCode(undefined);
      setCooldownSeconds(0);
      setDialogError("");
      setAttemptsRemaining(null);
      setDialogOpen(true);
      if (!firebaseUser) {
        // Signed in per the app's auth state, but Firebase has no user object
        // (session revoked / not rehydrated). Fail CLOSED: no instant switch.
        showError({ status: 401, error: t("langOtp.errAuth") });
        return;
      }
      const token = await firebaseUser
        .getIdToken()
        .then((t) => t)
        .catch(() => null);
      if (!token) {
        showError({ status: 401, error: t("langOtp.errAuth") });
        return;
      }
      void issueCode(next, token);
    },
    [issueCode, locale, setLocale, showError, t, user]
  );

  const handleVerify = useCallback(
    async (otp: string) => {
      if (!target) return;
      const token = await auth.currentUser?.getIdToken().catch(() => null);
      if (!token) {
        showError({ status: 401, error: t("langOtp.errAuth") });
        return;
      }
      setIsVerifying(true);
      try {
        const res = await verifyLanguageOtp(token, target, otp);
        if (
          res.ok &&
          res.data.ok === true &&
          res.data.verified === true &&
          res.data.targetLocale === target
        ) {
          setLocale(target);
          setDialogOpen(false);
          setTarget(null);
          setDevCode(undefined);
          setDialogError("");
          setAttemptsRemaining(null);
        } else if (res.ok) {
          showError({ status: res.status, error: t("langOtp.errGeneric") });
        } else {
          setAttemptsRemaining(
            typeof res.error.attemptsRemaining === "number"
              ? res.error.attemptsRemaining
              : null
          );
          setCooldownSeconds(
            typeof res.error.retryAfterSeconds === "number"
              ? res.error.retryAfterSeconds
              : 0
          );
          showError(res.error);
        }
      } catch {
        showError({ status: 0, error: t("langOtp.errGeneric") });
      } finally {
        setIsVerifying(false);
      }
    },
    [showError, setLocale, t, target]
  );

  const handleResend = useCallback(async () => {
    if (!target) return;
    const token = await auth.currentUser?.getIdToken().catch(() => null);
    if (!token) {
      showError({ status: 401, error: t("langOtp.errAuth") });
      return;
    }
    await issueCode(target, token);
  }, [issueCode, showError, t, target]);

  const handleClose = useCallback(() => {
    if (isRequesting || isVerifying) return;
    setDialogOpen(false);
    setTarget(null);
    setDevCode(undefined);
    setDialogError("");
    setAttemptsRemaining(null);
    setCooldownSeconds(0);
    setNeedsPhoneSetup(false);
  }, [isRequesting, isVerifying]);

  /**
   * "Add phone number" action from the dialog: close it and ask the app to show
   * the profile editor. Reuses the existing state-based navigation (no router).
   */
  const handleFixPhone = useCallback(() => {
    setDialogOpen(false);
    setTarget(null);
    setDevCode(undefined);
    setDialogError("");
    setAttemptsRemaining(null);
    setCooldownSeconds(0);
    setNeedsPhoneSetup(false);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(OPEN_PROFILE_EDIT_EVENT));
    }
  }, []);

  return (
    <>
      <DropdownMenu>
      <div ref={triggerRef}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            aria-label={t("nav.language")}
            className={
              compact
                ? "w-full justify-start text-xl py-6 px-4 rounded-full hover:bg-gray-900 text-white hover:text-white font-normal"
                : "rounded-full border-gray-600 text-white hover:bg-gray-900 font-semibold"
            }
          >
            <Globe className={compact ? "mr-4 h-7 w-7" : "mr-2 h-5 w-5"} />
            {compact ? (
              <span className="flex-1 text-left">{t("nav.language")}</span>
            ) : (
              LOCALE_LABELS[locale]
            )}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent className="bg-black border-gray-800" align={compact ? "start" : "center"}>
        {LOCALES.map((code) => (
          <DropdownMenuItem
            key={code}
            onClick={() => pick(code)}
            aria-checked={locale === code}
            role="menuitemradio"
            className={`text-white hover:bg-gray-900 cursor-pointer ${
              locale === code ? "font-bold" : "font-normal"
            }`}
          >
            {LOCALE_LABELS[code]}
            {locale === code ? " ✓" : ""}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
      </DropdownMenu>
      {target && (
        <LanguageOtpDialog
          isOpen={dialogOpen}
          targetLocale={target}
          channel={channel}
          devCode={devCode}
          deliveryStatus={deliveryStatus}
          isRequesting={isRequesting}
          isVerifying={isVerifying}
          cooldownSeconds={cooldownSeconds}
          error={dialogError}
          attemptsRemaining={attemptsRemaining}
          needsPhoneSetup={needsPhoneSetup}
          onFixPhone={handleFixPhone}
          onVerify={handleVerify}
          onResend={handleResend}
          onClose={handleClose}
          triggerRef={triggerRef}
        />
      )}
    </>
  );
}
