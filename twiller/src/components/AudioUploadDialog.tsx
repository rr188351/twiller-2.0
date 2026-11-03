"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Music, Upload, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import LoadingSpinner from "./loading-spinner";
import { useLanguage } from "@/context/LanguageContext";
import { auth } from "@/context/firebase";
import {
  requestAudioOtp,
  verifyAudioOtp,
  uploadAudio,
  isAudioFile,
  readAudioDuration,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_AUDIO_SIZE_BYTES,
  type AudioApiError,
} from "@/lib/audioUpload";

interface AudioUploadDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the created tweet after a successful upload. */
  onPosted: (tweet: unknown) => void;
}

type Phase = "pick" | "code" | "ready";

/** Maps a backend audio error to a translated message (never a raw token). */
function audioErrorMessage(
  t: (path: string, params?: Record<string, string>) => string,
  err: AudioApiError | null
): string {
  if (!err) return "";
  switch (err.code) {
    case "NETWORK":
      return t("upload.audioFailed");
    case "upload-window-closed":
      return t("upload.audioWindowClosed");
    case "otp-required":
      return t("upload.audioOtpRequired");
    case "no-file":
      return t("upload.audioNoFile");
    case "invalid-audio-file":
      return t("upload.audioBadType");
    default:
      return err.error || t("upload.audioFailed");
  }
}

export default function AudioUploadDialog({
  isOpen,
  onClose,
  onPosted,
}: AudioUploadDialogProps) {
  const { t } = useLanguage();
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [otp, setOtp] = useState("");
  const [devCode, setDevCode] = useState<string | undefined>(undefined);
  const [verified, setVerified] = useState(false);
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("pick");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  // Creates (and revokes the previous) object URL so the <audio> preview never
  // leaks memory. Revoked again on unmount below.
  const setPreview = useCallback((next: File | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = next ? URL.createObjectURL(next) : null;
    setPreviewUrl(previewUrlRef.current);
  }, []);

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    []
  );

  // Reset every time the dialog is (re)opened.
  useEffect(() => {
    if (isOpen) {
      setFile(null);
      setDuration(null);
      setContent("");
      setOtp("");
      setDevCode(undefined);
      setVerified(false);
      setExpiresInMinutes(null);
      setError("");
      setBusy(false);
      setPhase("pick");
      setPreview(null);
    }
  }, [isOpen, setPreview]);

  // NOTE: the three useCallback hooks below MUST run before the
  // `if (!isOpen) return null` guard further down. Otherwise closing the dialog
  // would execute fewer hooks than opening it, and React would report
  // "change in the order of Hooks called by AudioUploadDialog".
  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    if (!picked) return;
    setError("");
    setVerified(false);
    setPhase("pick");
    if (!isAudioFile(picked)) {
      setFile(null);
      setDuration(null);
      setPreview(null);
      setError(t("upload.audioBadType"));
      return;
    }
    if (picked.size > MAX_AUDIO_SIZE_BYTES) {
      setFile(null);
      setDuration(null);
      setPreview(null);
      setError(t("upload.audioTooLarge"));
      return;
    }
    try {
      const seconds = await readAudioDuration(picked);
      if (seconds > MAX_AUDIO_DURATION_SECONDS) {
        setFile(null);
        setDuration(null);
        setPreview(null);
        setError(t("upload.audioTooLong"));
        return;
      }
      setFile(picked);
      setDuration(seconds);
      setPreview(picked);
    } catch {
      setFile(null);
      setDuration(null);
      setPreview(null);
      setError(t("upload.audioDurationUnknown"));
    }
  };

  const token = async (): Promise<string | null> =>
    auth.currentUser?.getIdToken().catch(() => null) ?? null;

  const handleRequestCode = useCallback(async () => {
    setError("");
    const idToken = await token();
    if (!idToken) {
      setError(t("upload.audioFailed"));
      return;
    }
    setBusy(true);
    try {
      const res = await requestAudioOtp(idToken);
      if (res.ok) {
        setDevCode(res.data.devCode);
        setExpiresInMinutes(res.data.expiresInMinutes ?? null);
        setPhase("code");
      } else {
        setError(audioErrorMessage(t, res.error));
      }
    } finally {
      setBusy(false);
    }
  }, [t]);

  const handleVerify = useCallback(async () => {
    setError("");
    const idToken = await token();
    if (!idToken) {
      setError(t("upload.audioFailed"));
      return;
    }
    setBusy(true);
    try {
      const res = await verifyAudioOtp(idToken, otp);
      if (res.ok && res.data.ok === true && res.data.verified === true) {
        setVerified(true);
        setPhase("ready");
        setOtp("");
      } else if (!res.ok) {
        setError(audioErrorMessage(t, res.error));
      } else {
        setError(t("upload.audioFailed"));
      }
    } finally {
      setBusy(false);
    }
  }, [otp, t]);

  const handleUpload = useCallback(async () => {
    if (!file) {
      setError(t("upload.audioNoFile"));
      return;
    }
    setError("");
    const idToken = await token();
    if (!idToken) {
      setError(t("upload.audioFailed"));
      return;
    }
    setBusy(true);
    try {
      const res = await uploadAudio(idToken, file, content);
      if (res.ok && res.data.ok === true) {
        onPosted({ _id: res.data.tweetId, audioUrl: res.data.audioUrl });
        onClose();
      } else if (!res.ok) {
        setError(audioErrorMessage(t, res.error));
      } else {
        setError(t("upload.audioFailed"));
      }
    } finally {
      setBusy(false);
    }
  }, [content, file, onClose, onPosted, t]);

  // Every hook above now runs unconditionally on every render, so bailing out
  // when the dialog is closed can no longer change the hook order.
  if (!isOpen) return null;

  const minutesLabel = expiresInMinutes ?? 10;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <Card className="w-full max-w-lg bg-black border-gray-800 text-white max-h-[90vh] overflow-y-auto">
        <CardHeader className="relative border-b border-gray-800 pb-4">
          <div className="flex items-center gap-2">
            <Music className="h-5 w-5 text-blue-400" />
            <CardTitle className="text-white text-lg">
              {t("upload.audioTitle")}
            </CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("common.close")}
            className="absolute right-2 top-2 text-gray-400 hover:text-white"
            onClick={onClose}
            disabled={busy}
          >
            <X className="h-5 w-5" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-4 pt-4">
          {/* 1. Choose a file - client-side type/size checks mirror the server */}
          <div className="space-y-2">
            <Label htmlFor="audioFile" className="text-white">
              {t("upload.audioChoose")}
            </Label>
            <input
              ref={fileInputRef}
              id="audioFile"
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={onFileChange}
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              className="w-full border-gray-500 bg-transparent text-white hover:bg-gray-900 hover:text-white disabled:border-gray-700 disabled:text-gray-400 disabled:opacity-100"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <Upload className="mr-2 h-4 w-4" />
              {file ? file.name : t("upload.audioChoose")}
            </Button>
            {file && duration !== null && (
              <p className="text-sm text-gray-400">
                {Math.round(duration)}s ·{" "}
                {(file.size / (1024 * 1024)).toFixed(1)} MB
              </p>
            )}
          </div>

          {/* 2. Local preview of the chosen file */}
          {previewUrl && (
            <audio controls src={previewUrl} className="w-full" />
          )}

          {/* 3. Optional caption */}
          {file && (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("composer.placeholder")}
              className="bg-transparent border-gray-600 text-white placeholder-gray-500 resize-none min-h-[70px]"
              disabled={busy}
            />
          )}

          {/* 4. Email verification code (backend OTP gate) */}
          {file && (
            <div className="space-y-2">
              {!verified ? (
                <>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-gray-400" />
                    <Label htmlFor="audioOtp" className="text-white">
                      {t("upload.audioCodeLabel")}
                    </Label>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      id="audioOtp"
                      value={otp}
                      onChange={(e) => setOtp(e.target.value)}
                      inputMode="numeric"
                      maxLength={6}
                      className="bg-transparent border-gray-600 text-white"
                      disabled={busy}
                    />
                    <Button
                      type="button"
                      onClick={handleVerify}
                      disabled={busy || otp.trim().length !== 6}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded-full shrink-0 disabled:bg-gray-700 disabled:text-gray-400 disabled:opacity-100"
                    >
                      {busy ? (
                        <LoadingSpinner size="sm" />
                      ) : (
                        t("upload.audioVerify")
                      )}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-400">
                      {phase !== "pick" && expiresInMinutes
                        ? t("upload.audioCodeSent", {
                            minutes: String(minutesLabel),
                          })
                        : ""}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleRequestCode}
                      disabled={busy}
                      className="text-blue-400 hover:bg-gray-900 hover:text-blue-300 text-sm disabled:text-gray-500"
                    >
                      {busy ? (
                        <LoadingSpinner size="sm" />
                      ) : (
                        t("upload.audioRequestCode")
                      )}
                    </Button>
                  </div>
                  {devCode && (
                    <p className="text-xs text-amber-300">
                      {t("langOtp.devHint", { code: devCode })}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-green-400">
                  {t("upload.audioVerified")}
                </p>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={busy}
              className="text-gray-300 hover:bg-gray-900 hover:text-white"
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleUpload}
              disabled={busy || !file || !verified}
              className="bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-full px-6"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <LoadingSpinner size="sm" />
                  {t("upload.audioUploading")}
                </span>
              ) : (
                t("upload.audioUpload")
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}