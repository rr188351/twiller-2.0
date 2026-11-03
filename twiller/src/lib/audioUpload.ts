/**
 * Audio-tweet API client + client-side validation - Internship Feature 5.
 *
 * Wraps the EXISTING authenticated backend endpoints (no new endpoints):
 *   POST /audio/otp/request   -> email a 6-digit code (Bearer token)
 *   POST /audio/otp/verify    -> verify that code       (Bearer token)
 *   POST /audio/upload        -> upload the audio file  (Bearer token, multipart)
 *
 * Identity always comes from the Firebase ID token attached by axiosInstance;
 * only { otp } / { content, audio } are ever sent in the body. This mirrors
 * lib/languageOtp.ts (same result/error shape, same non-JSON safety).
 *
 * The server re-validates duration with ffprobe and enforces the 5-minute
 * (300 s) and 100 MB limits; the checks here only give the user a faster,
 * friendlier error before the network round-trip.
 */

import axiosInstance from "./axiosInstance.js";
import { absoluteMediaUrl } from "./uploadImage";

export type AudioOtpChannel = "email";

export interface AudioOtpRequestSuccess {
  ok: true;
  channel: AudioOtpChannel;
  message: string;
  expiresInMinutes: number;
  delivered: boolean;
  /** Present ONLY when the backend runs outside production. Hint only. */
  devCode?: string;
}

export interface AudioOtpVerifySuccess {
  ok: true;
  verified: true;
}

export interface AudioUploadSuccess {
  ok: true;
  tweetId: string;
  /** Stored relative reference, e.g. "uploads/audio-123.wav". */
  audioUrl: string;
  audioDuration: number;
  audioSize: number;
  audioType: string;
}

export interface AudioApiError {
  status: number;
  code?: string;
  error: string;
  retryAfterSeconds?: number;
  attemptsRemaining?: number;
}

export type AudioResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: AudioApiError };

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

function extractMessage(body: unknown): string | null {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      return null; // an HTML error page is not a user-facing message
    }
    return trimmed.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string" && b.error.trim()) return b.error;
    if (typeof b.message === "string" && b.message.trim()) return b.message;
  }
  return null;
}

function toApiError(status: number, body: unknown): AudioApiError {
  const b =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    status,
    code: typeof b.code === "string" ? b.code : undefined,
    error: extractMessage(body) ?? GENERIC_ERROR_MESSAGE,
    retryAfterSeconds:
      typeof b.retryAfterSeconds === "number" ? b.retryAfterSeconds : undefined,
    attemptsRemaining:
      typeof b.attemptsRemaining === "number" ? b.attemptsRemaining : undefined,
  };
}

function readStatus(err: unknown): number {
  if (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    typeof (err as { response?: { status?: unknown } }).response?.status ===
      "number"
  ) {
    return (err as { response: { status: number } }).response.status;
  }
  return 0;
}

function readBody(err: unknown): unknown {
  if (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { data?: unknown } }).response
  ) {
    return (err as { response: { data?: unknown } }).response.data;
  }
  return null;
}

function networkError(): AudioApiError {
  return {
    status: 0,
    code: "NETWORK",
    error:
      "Cannot reach the Twiller backend. Check your connection and try again.",
  };
}

/** STEP 1 - request an email code (the backend decides the destination). */
export async function requestAudioOtp(
  idToken: string
): Promise<AudioResult<AudioOtpRequestSuccess>> {
  try {
    const res = await axiosInstance.post(
      "/audio/otp/request",
      {},
      { headers: { Authorization: `Bearer ${idToken}` } }
    );
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    const status = readStatus(err);
    if (status === 0) return { ok: false, status: 0, error: networkError() };
    return { ok: false, status, error: toApiError(status, readBody(err)) };
  }
}

/** STEP 2 - submit the 6-digit code. `verified === true` is the only success. */
export async function verifyAudioOtp(
  idToken: string,
  otp: string
): Promise<AudioResult<AudioOtpVerifySuccess>> {
  try {
    const res = await axiosInstance.post(
      "/audio/otp/verify",
      { otp },
      { headers: { Authorization: `Bearer ${idToken}` } }
    );
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    const status = readStatus(err);
    if (status === 0) return { ok: false, status: 0, error: networkError() };
    return { ok: false, status, error: toApiError(status, readBody(err)) };
  }
}

/** STEP 3 - upload the audio file once the code is verified. */
export async function uploadAudio(
  idToken: string,
  file: File,
  content = ""
): Promise<AudioResult<AudioUploadSuccess>> {
  try {
    const form = new FormData();
    form.append("audio", file);
    if (content) form.append("content", content);
    const res = await axiosInstance.post("/audio/upload", form, {
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "multipart/form-data",
      },
    });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    const status = readStatus(err);
    if (status === 0) return { ok: false, status: 0, error: networkError() };
    return { ok: false, status, error: toApiError(status, readBody(err)) };
  }
}

/* ------------------------------------------------------------------ */
/* Client-side limits (kept in sync with backend/index.js / audioProbe) */
/* ------------------------------------------------------------------ */
export const MAX_AUDIO_DURATION_SECONDS = 300; // 5 minutes
export const MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

/** Known audio MIME types / extensions accepted by the picker. */
export const ALLOWED_AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/x-m4a",
  "audio/flac",
];

export function isAudioFile(file: File): boolean {
  if (file.type && file.type.startsWith("audio/")) return true;
  if (file.type && ALLOWED_AUDIO_MIME_TYPES.includes(file.type)) return true;
  return /\.(mp3|wav|webm|ogg|oga|m4a|aac|flac|mp4)$/i.test(file.name || "");
}

/**
 * Reads the duration of a local audio file in the browser using an <audio>
 * element. Rejects when the browser cannot decode it (so the UI can say so
 * instead of uploading a file the server would reject).
 */
export function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || typeof Audio === "undefined") {
      reject(new Error("Audio not supported in this environment."));
      return;
    }
    const url = URL.createObjectURL(file);
    const el = new Audio();
    const cleanup = () => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const duration = el.duration;
      cleanup();
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error("Could not read the audio duration."));
    };
    el.onerror = () => {
      cleanup();
      reject(new Error("Could not read the audio duration."));
    };
    el.src = url;
  });
}

/** Converts the stored audio reference ("uploads/audio-1.wav") to a playable URL. */
export function audioPlaybackUrl(storedRef: string | null | undefined): string {
  return absoluteMediaUrl(storedRef);
}
