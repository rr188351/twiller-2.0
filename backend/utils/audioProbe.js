/**
 * Server-side audio duration probe for Twiller 2.0 Feature 5.
 *
 * Uses ffprobe (from ffmpeg) via Node's built-in child_process to measure the
 * real duration of an uploaded audio file. Client-supplied duration is NEVER
 * trusted - the probed value is the source of truth.
 *
 * PROBE DEPENDENCY
 * ----------------
 * ffprobe must be installed on the server and available on PATH, or the
 * FFPROBE_PATH environment variable must point at the ffprobe executable.
 *   Debian/Ubuntu: apt-get install ffmpeg
 *   macOS:         brew install ffmpeg
 *   Windows:       https://ffmpeg.org/download.html (add ffprobe.exe to PATH)
 *                  or set FFPROBE_PATH=C:\...\ffprobe.exe
 *
 * If ffprobe is unavailable, probeAudioDuration() returns { ok: false,
 * unavailable: true } and the caller must reject the upload - we never fall
 * back to client-supplied duration.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// Maximum audio duration in seconds (5 minutes), per the internship assignment.
export const MAX_AUDIO_DURATION_SECONDS = 300;

// Maximum time (ms) the ffprobe process is allowed to run before we kill it.
// ffprobe on a corrupt or huge file can otherwise hang indefinitely.
export const FFPROBE_TIMEOUT_MS = 10000;

/**
 * Resolve the ffprobe executable path.
 *
 * Resolution order:
 *   1. FFPROBE_PATH environment variable (explicit, operator-controlled)
 *   2. ffprobe on PATH (via `where` on Windows, `which` on POSIX)
 *
 * Never hardcodes a user-specific path.
 *
 * @returns {string|null} resolved ffprobe path, or null if not found
 */
function resolveFfprobePath() {
  // 1. Explicit environment override.
  const envPath = process.env.FFPROBE_PATH;
  if (envPath && envPath.trim()) {
    return envPath.trim();
  }

  // 2. Search PATH.
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(locator, ["ffprobe"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Probe an audio file's real duration in seconds using ffprobe.
 *
 * @param {string} filePath - absolute path to the audio file
 * @returns {Promise<{ ok: boolean, durationSeconds?: number, unavailable?: boolean, error?: string }>}
 */
export async function probeAudioDuration(filePath) {
  const ffprobePath = resolveFfprobePath();

  if (!ffprobePath) {
    return {
      ok: false,
      unavailable: true,
      error: "ffprobe is not installed on this server. Install ffmpeg to enable audio duration validation, or set FFPROBE_PATH to the ffprobe executable.",
    };
  }

  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        // Timeout so a hung ffprobe cannot block the request forever.
        timeout: FFPROBE_TIMEOUT_MS,
        killSignal: "SIGTERM",
      }
    );

    const duration = parseFloat(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, error: "Could not determine audio duration from file." };
    }

    return { ok: true, durationSeconds: duration };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    // Node's execFile rejects with a specific error when a process times out.
    if (err && err.killed) {
      return {
        ok: false,
        error: "ffprobe timed out while probing the audio file.",
      };
    }
    // BUGFIX: a missing / non-executable ffprobe (ENOENT) is an ENVIRONMENT
    // problem, not a bad audio file. Per this module's contract the caller must
    // answer 503 "unavailable" (never trust client duration, never mislabel the
    // upload as invalid).
    if (err && err.code === "ENOENT") {
      return {
        ok: false,
        unavailable: true,
        error:
          "ffprobe is not installed or not executable on this server. Install ffmpeg or set FFPROBE_PATH.",
      };
    }
    return {
      ok: false,
      error: `ffprobe failed: ${message}`,
    };
  }
}

export default { probeAudioDuration, MAX_AUDIO_DURATION_SECONDS, FFPROBE_TIMEOUT_MS };
