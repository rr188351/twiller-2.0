"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  parseLocale,
  t as translate,
  type Locale,
} from "@/lib/i18n";

interface LanguageContextType {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (path: string, params?: Record<string, string>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(
  undefined
);

/**
 * Reads the persisted choice once (lazy useState initializer). Runs only in
 * the browser; any invalid or missing value becomes English.
 */
function readStoredLocale(): Locale {
  try {
    if (typeof window === "undefined") return DEFAULT_LOCALE;
    return parseLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function LanguageProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // SSR always renders English first (localStorage is unavailable on the
  // server), then the effect adopts the stored locale. This keeps the
  // server HTML and the client's first render identical - no hydration
  // mismatch - at the cost of a single English frame for non-English users
  // on reload.
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocaleState(readStoredLocale());
  }, []);

  const setLocale = useCallback((next: Locale) => {
    const parsed = parseLocale(next);
    setLocaleState(parsed);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, parsed);
    } catch {
      // Private-mode storage failures must never break the page.
    }
  }, []);

  // Keep <html lang> truthful for screen readers and spell-checkers.
  useEffect(() => {
    try {
      document.documentElement.lang = locale;
    } catch {
      /* non-browser render: nothing to sync */
    }
  }, [locale]);

  const t = useCallback(
    (path: string, params?: Record<string, string>) => translate(locale, path, params),
    [locale]
  );

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextType {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}
