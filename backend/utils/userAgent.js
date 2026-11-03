/**
 * User-Agent parsing + trusted-proxy-aware client IP resolution.
 *
 * WHY HAND-ROLLED
 * ---------------
 * No user-agent parser is installed, and the brief says to avoid unnecessary
 * dependency/lockfile changes, so this is a small, conservative, documented
 * parser.
 *
 * SECURITY POSTURE
 * ----------------
 * The User-Agent is NEVER treated as proof of identity. It only *categorises*
 * an already Firebase-authenticated session for the assignment's browser and
 * device rules. Anything unrecognised (or missing) becomes `browser: "Unknown"`
 * and `deviceCategory: "desktop"`, so an unparseable UA can never be mistaken
 * for a mobile device and can never lock a user out.
 */

/** Most specific tokens first - "Edg/" must win over "Chrome/". */
const BROWSER_PATTERNS = [
  { name: "Edge", re: /Edg[A-Z]?\//i }, // Chromium Edge (Edg/, EdgA/, EdgiOS/)
  { name: "Edge", re: /Edge\//i }, // legacy EdgeHTML
  { name: "Opera", re: /OPR\/|Opera/i },
  { name: "Samsung Internet", re: /SamsungBrowser\//i },
  { name: "Firefox", re: /Firefox\/|FxiOS\//i },
  { name: "Chrome", re: /Chrome\/|CriOS\//i },
  { name: "Safari", re: /Safari\//i },
];

const OS_PATTERNS = [
  { name: "Windows", re: /Windows NT|Windows Phone/i },
  { name: "Android", re: /Android/i },
  { name: "iOS", re: /iPhone|iPad|iPod/i },
  { name: "ChromeOS", re: /CrOS/i },
  { name: "macOS", re: /Mac OS X|Macintosh/i },
  { name: "Linux", re: /Linux/i },
];

export const DEVICE_CATEGORIES = ["desktop", "mobile", "tablet", "unknown"];

/**
 * Parses a User-Agent header into browser / OS / device category.
 * Never throws. A non-string, empty or malformed value degrades to
 * Unknown/desktop rather than failing the request.
 *
 * @param {unknown} userAgent
 * @returns {{browser:string, os:string, deviceCategory:string, userAgent:string}}
 */
export function parseUserAgent(userAgent) {
  const raw = typeof userAgent === "string" ? userAgent : "";

  let browser = "Unknown";
  for (const pattern of BROWSER_PATTERNS) {
    if (pattern.re.test(raw)) {
      browser = pattern.name;
      break;
    }
  }

  let os = "Unknown";
  for (const pattern of OS_PATTERNS) {
    if (pattern.re.test(raw)) {
      os = pattern.name;
      break;
    }
  }

  // Tablets report "Android" WITHOUT "Mobile", or an explicit tablet token.
  const isTablet =
    /iPad|Tablet|PlayBook|Silk/i.test(raw) ||
    (/Android/i.test(raw) && !/Mobile/i.test(raw));
  const isMobile =
    !isTablet &&
    /Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(raw);

  const deviceCategory = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";

  return {
    browser,
    os,
    deviceCategory,
    // Kept short so a hostile UA cannot bloat a database row.
    userAgent: raw.slice(0, 300),
  };
}

/** Strips the IPv6-mapped prefix Node reports for IPv4 clients. */
function normaliseIp(value) {
  const ip = String(value || "").trim();
  if (!ip) return "unknown";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Resolves the client IP.
 *
 * ONLY Express's `req.ip` is used, because Express applies the `trust proxy`
 * setting configured in index.js. Raw `x-forwarded-for` / `x-real-ip` headers
 * are never read directly: a client could otherwise set them to any value it
 * liked and spoof both the stored history and any IP-based rule.
 *
 * @returns {string} IPv4/IPv6 literal, or "unknown"
 */
export function resolveClientIp(req) {
  try {
    if (req?.ip) return normaliseIp(req.ip);
    return normaliseIp(req?.socket?.remoteAddress);
  } catch {
    return "unknown";
  }
}

export default { parseUserAgent, resolveClientIp, DEVICE_CATEGORIES };
