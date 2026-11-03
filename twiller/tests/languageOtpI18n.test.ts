/**
 * Internship Feature 4 (phase 2) Stage C - Language-switch OTP frontend
 * contract tests: i18n key resolution for the OTP flow.
 *
 * HOW TO RUN
 *   cd twiller
 *   node tests/languageOtpI18n.test.ts
 *
 * No test framework is installed or required - Node 24 runs TypeScript
 * directly via type stripping, so this file uses a tiny `check()` helper.
 * Exits 0 on success, 1 on any failure.
 *
 * WHAT IT PROVES
 *  - Every `t("...")` key used anywhere in the frontend resolves to a real
 *    string in ALL six locales (en, hi, es, pt, zh, fr). A missing key
 *    degrades to the key path itself, which is why this must be asserted.
 *  - The `langOtp` namespace exists in every locale with an IDENTICAL key
 *    set (no locale silently missing an error message).
 *  - Placeholder tokens ({count}, {seconds}, {code}, {language}) match the
 *    English source exactly in every locale, so interpolation cannot leak a
 *    raw `{token}` into the UI.
 *  - Interpolation actually substitutes the values.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES, dictionaries, t } from "../src/lib/i18n.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");

/* ------------------------------------------------------------------ */
/* Collect every t("...") literal used anywhere in the frontend.       */
/* ------------------------------------------------------------------ */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [
  ...collectSourceFiles(path.join(ROOT, "src", "components")),
  ...collectSourceFiles(path.join(ROOT, "src", "app")),
  ...collectSourceFiles(path.join(ROOT, "src", "context")),
  ...collectSourceFiles(path.join(ROOT, "src", "lib")),
];

const KEY_PATTERN = /\bt\(\s*["'`]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["'`]/g;
const usedKeys = new Set<string>();
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  let match: RegExpExecArray | null;
  while ((match = KEY_PATTERN.exec(text)) !== null) usedKeys.add(match[1]);
}

const placeholders = (s: string) =>
  (s.match(/\{[a-zA-Z0-9_]+\}/g) || []).slice().sort();

console.log("\nTwiller 2.0 - Feature 4 (phase 2) Stage C: language OTP i18n tests\n");

/* ------------------------------------------------------------------ */
/* [1] Every referenced key resolves in every locale.                   */
/* ------------------------------------------------------------------ */
console.log(`[1] KEY RESOLUTION (${usedKeys.size} keys x ${LOCALES.length} locales)`);
check("source files were scanned", files.length > 0, `files=${files.length}`);
check(
  "the langOtp namespace is actually used by the UI",
  [...usedKeys].some((k) => k.startsWith("langOtp.")),
  "no langOtp.* key found in the frontend sources"
);

const missing: string[] = [];
for (const locale of LOCALES) {
  for (const key of usedKeys) {
    const value = t(locale, key);
    // resolvePath() returns the path itself when nothing matched.
    if (value === key) missing.push(`[${locale}] ${key}`);
    else if (typeof value !== "string" || value.trim() === "") {
      missing.push(`[${locale}] ${key} -> empty`);
    }
  }
}
check(
  `all ${usedKeys.size} t() keys resolve in all ${LOCALES.length} locales`,
  missing.length === 0,
  missing.slice(0, 10).join(", ")
);


/* ------------------------------------------------------------------ */
/* [2] The langOtp namespace is complete and identical everywhere.     */
/* ------------------------------------------------------------------ */
console.log("\n[2] langOtp NAMESPACE COMPLETENESS");
const enDict = dictionaries.en as unknown as Record<string, Record<string, string>>;
const enLangOtp = enDict.langOtp ?? {};
const namespaceKeys = Object.keys(enLangOtp);
check("en defines the langOtp namespace", namespaceKeys.length > 0);
check(
  "en defines at least 30 langOtp keys",
  namespaceKeys.length >= 30,
  `found ${namespaceKeys.length}`
);

for (const locale of LOCALES) {
  const dict = dictionaries[locale] as unknown as Record<string, Record<string, string>>;
  const locLangOtp = dict.langOtp;
  if (!locLangOtp) {
    check(`[${locale}] langOtp namespace exists`, false);
    continue;
  }
  const missingHere = namespaceKeys.filter((k) => typeof locLangOtp[k] !== "string");
  const extraHere = Object.keys(locLangOtp).filter((k) => !namespaceKeys.includes(k));
  check(
    `[${locale}] langOtp has the same ${namespaceKeys.length} keys as en`,
    missingHere.length === 0 && extraHere.length === 0,
    [
      missingHere.length ? `missing: ${missingHere.join(", ")}` : "",
      extraHere.length ? `extra: ${extraHere.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" | ")
  );
}

/* ------------------------------------------------------------------ */
/* [3] Placeholder parity - no raw {token} can survive translation.    */
/* ------------------------------------------------------------------ */
console.log("\n[3] PLACEHOLDER PARITY");
const placeholderIssues: string[] = [];
for (const locale of LOCALES) {
  const dict = dictionaries[locale] as unknown as Record<string, Record<string, string>>;
  const locLangOtp = dict.langOtp ?? {};
  for (const key of namespaceKeys) {
    const enTokens = placeholders(enLangOtp[key] ?? "");
    const locTokens = placeholders(locLangOtp[key] ?? "");
    if (JSON.stringify(enTokens) !== JSON.stringify(locTokens)) {
      placeholderIssues.push(
        `[${locale}] langOtp.${key} en=${JSON.stringify(enTokens)} loc=${JSON.stringify(locTokens)}`
      );
    }
  }
}
check(
  "every langOtp string keeps the English placeholder tokens",
  placeholderIssues.length === 0,
  placeholderIssues.slice(0, 6).join(" | ")
);

/* ------------------------------------------------------------------ */
/* [4] Interpolation actually substitutes.                             */
/* ------------------------------------------------------------------ */
console.log("\n[4] INTERPOLATION");
const interpolated = t("hi", "langOtp.intro", { language: "फ़्रेंच" });
check("langOtp.intro substitutes {language}", interpolated.includes("फ़्रेंच"), interpolated);
const resendIn = t("fr", "langOtp.resendIn", { seconds: "42" });
check("langOtp.resendIn substitutes {seconds}", resendIn.includes("42"), resendIn);
const attempts = t("en", "langOtp.attemptsLeft", { count: "3" });
check("langOtp.attemptsLeft substitutes {count}", attempts.includes("3"), attempts);
const devHint = t("en", "langOtp.devHint", { code: "123456" });
check("langOtp.devHint substitutes {code}", devHint.includes("123456"), devHint);

/* ------------------------------------------------------------------ */
/* [5] The Stage C flow contract in the selector source.               */
/* ------------------------------------------------------------------ */
console.log("\n[5] LANGUAGE SWITCH CONTRACT");
const ctx = fs.readFileSync(
  path.join(ROOT, "src", "context", "LanguageContext.tsx"),
  "utf8"
);
check(
  "LanguageContext persists the locale to localStorage",
  ctx.includes("twiller-locale") || ctx.includes("LOCALE_STORAGE_KEY")
);
const selector = fs.readFileSync(
  path.join(ROOT, "src", "components", "LanguageSelector.tsx"),
  "utf8"
);
check(
  "the locale is applied only after verified === true",
  /res\.data\.verified\s*===\s*true/.test(selector)
);
check(
  "the locale is applied only when targetLocale matches the request",
  /res\.data\.targetLocale\s*===\s*target/.test(selector)
);
check(
  "the signed-in path requests an OTP before any locale change",
  /requestLanguageOtp\(/.test(selector) && /verifyLanguageOtp\(/.test(selector)
);
check(
  "a signed-in user with no Firebase token fails closed (no instant switch)",
  !/const idTokenPromise = auth\.currentUser\?\.getIdToken\(\)/.test(selector) &&
    /showError\(\{ status: 401, error: t\("langOtp\.errAuth"\) \}\)/.test(selector)
);

console.log("\n==================================================");
console.log(`  passed: ${passed}   failed: ${failed}`);
if (failures.length) console.log(`  failures: ${failures.join(" | ")}`);
console.log("==================================================\n");

process.exit(failed === 0 ? 0 : 1);
