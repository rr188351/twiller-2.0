/**
 * Image upload client - Internship Feature 4 (phase 1).
 *
 * Replaces the previous direct-to-imgbb upload (which embedded a hardcoded
 * third-party API key in the bundle) with the project's OWN authenticated
 * backend endpoint, `POST /image/upload`. That endpoint already enforced the
 * type/size rules server-side (JPEG/PNG/WebP/GIF, 5 MB) through Twiller's
 * existing multer instance; the UI now uses the same path.
 *
 * The backend returns a relative `path` (e.g. "/uploads/images/image-1.jpg").
 * We resolve it against the configured backend base so the SAME absolute URL
 * works in development AND after deployment, and so previously-stored absolute
 * imgbb URLs keep rendering unchanged.
 */

// `.js` extension on purpose: mirrors languageOtp.ts and keeps the module
// importable by the Node-based tests as well as the Next.js bundler.
import axiosInstance from "./axiosInstance.js";

/** The configured backend base URL (no trailing slash), or "" if unset. */
function backendBase(): string {
  const base = (axiosInstance.defaults.baseURL as string | undefined) || "";
  return base.replace(/\/+$/, "");
}

/**
 * Turns a stored media reference into an absolute URL.
 * - already-absolute http(s) URLs (e.g. legacy imgbb images) are returned as-is
 * - relative paths are prefixed with the configured backend base
 */
export function absoluteMediaUrl(pathOrUrl: string | null | undefined): string {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = backendBase();
  const clean = pathOrUrl.replace(/^\/+/, "");
  return base ? `${base}/${clean}` : `/${clean}`;
}

export interface UploadImageOutcome {
  /** Relative path served by the backend, e.g. "/uploads/images/image-1.jpg". */
  path: string;
  /** Absolute URL computed from the configured backend base. */
  url: string;
}

/**
 * Uploads one image file to the authenticated backend endpoint and returns
 * the stored reference. Throws on any failure so the caller can surface a
 * clear, translated message.
 */
export async function uploadImage(file: File): Promise<UploadImageOutcome> {
  const form = new FormData();
  form.append("image", file);
  const res = await axiosInstance.post("/image/upload", form, {
    // axios lets the browser set the multipart boundary itself; this explicit
    // type is stripped by axios for FormData bodies.
    headers: { "Content-Type": "multipart/form-data" },
  });
  const path: string =
    (res.data && (res.data.path || res.data.url)) || "";
  return { path, url: absoluteMediaUrl(path) };
}

/** Client-side mirror of the server limits (kept in sync with backend/index.js). */
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
