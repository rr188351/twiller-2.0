"use client";

/**
 * LoginHistory - Internship Feature 2 (profile section).
 *
 * Shows the signed-in user's OWN login history: date/time, browser, operating
 * system, device category and IP address. The server scopes the query to the
 * verified Firebase token, so this component cannot request anyone else's data
 * (and it never sends a user id).
 */

import React, { useEffect, useState } from "react";
import { History, Monitor, Smartphone, Tablet } from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { useLanguage } from "@/context/LanguageContext";
import { useAuth } from "@/context/AuthContext";
import { fetchLoginHistory, type LoginHistoryEntry } from "@/lib/loginHistory";

function DeviceIcon({ category }: { category: string }) {
  if (category === "mobile") return <Smartphone className="h-4 w-4 text-blue-400" />;
  if (category === "tablet") return <Tablet className="h-4 w-4 text-blue-400" />;
  return <Monitor className="h-4 w-4 text-blue-400" />;
}

export default function LoginHistory() {
  const { t, locale } = useLanguage();
  const { user } = useAuth();
  const [entries, setEntries] = useState<LoginHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setIsLoading(true);
    fetchLoginHistory()
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        if (!cancelled) setError(t("login.genericError"));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!user) return null;

  const formatWhen = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    try {
      return date.toLocaleString(locale);
    } catch {
      return date.toISOString();
    }
  };

  return (
    <Card className="bg-black border-gray-800 border-x-0 rounded-none">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <History className="h-5 w-5 text-blue-400" />
          <p className="text-white font-semibold text-sm">{t("login.title")}</p>
        </div>
        <p className="text-gray-400 text-xs mb-3">{t("login.subtitle")}</p>

        {isLoading && <p className="text-gray-400 text-sm">{t("common.loading")}</p>}

        {!isLoading && error && <p className="text-red-400 text-sm">{error}</p>}

        {!isLoading && !error && entries.length === 0 && (
          <p className="text-gray-400 text-sm">{t("login.empty")}</p>
        )}

        {!isLoading && !error && entries.length > 0 && (
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="border border-gray-800 rounded-lg p-3 text-xs text-gray-300"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="flex items-center gap-1.5 text-white font-medium">
                    <DeviceIcon category={entry.deviceCategory} />
                    {entry.browser} · {entry.os}
                  </span>
                  <span
                    className={
                      entry.outcome === "allowed"
                        ? "text-green-400"
                        : entry.outcome === "blocked-mobile-window"
                        ? "text-amber-400"
                        : "text-gray-400"
                    }
                  >
                    {entry.outcome === "allowed"
                      ? t("login.outcomeAllowed")
                      : entry.outcome === "blocked-mobile-window"
                      ? t("login.outcomeBlocked")
                      : t("login.outcomeOtp")}
                  </span>
                </div>
                <div className="text-gray-400">
                  {t("login.device")}: {entry.deviceCategory} · {t("login.ip")}: {entry.ip}
                </div>
                <div className="text-gray-500">{formatWhen(entry.loggedInAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
