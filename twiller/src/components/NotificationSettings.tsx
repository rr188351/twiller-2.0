"use client";

/**
 * NotificationSettings - Internship Feature 3 (profile setting).
 *
 * WHY IT LIVES HERE
 * -----------------
 * `ProfilePage` already renders the profile header, profile info and a tab
 * bar. Adding one compact card just above the tab bar is the smallest place
 * that is genuinely "profile/settings" without inventing a settings router or
 * changing the existing layout.
 *
 * HOW THE PERMISSION PROMPT IS HANDLED (requirement: never spam the user)
 * ----------------------------------------------------------------------
 *  - "default" -> we call `requestPermission()` ONLY from this toggle click,
 *    i.e. a real user gesture. Browsers ignore prompts that are not
 *    user-initiated, and auto-prompting on page load is bad practice.
 *  - "granted" -> notifications simply work.
 *  - "denied"  -> we never ask again. We show instructions for re-enabling
 *    notifications in the browser's own site settings instead.
 *
 * PERSISTENCE
 * -----------
 * The preference is saved through Twiller's EXISTING `PATCH /userupdate/:email`
 * route. No new backend endpoint, collection or dependency was added.
 */

import React, { useEffect, useState } from "react";
import { Bell, BellOff, Check } from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import LoadingSpinner from "./loading-spinner";
import { useAuth } from "@/context/AuthContext";
import axiosInstance from "@/lib/axiosInstance";
import {
  getPermissionState,
  requestNotificationPermission,
  type PermissionState,
} from "@/lib/tweetNotifications";

export default function NotificationSettings() {
  const { user } = useAuth();

  const [enabled, setEnabled] = useState(true);
  const [permission, setPermission] = useState<PermissionState>("default");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");

  // Seed the local state from the profile once the user is available.
  useEffect(() => {
    if (user) {
      setEnabled(user.notificationsEnabled !== false);
      setPermission(getPermissionState());
    }
  }, [user]);

  if (!user) return null;

  const handleToggle = async () => {
    if (isSaving) return;
    const nextValue = !enabled;

    setMessage("");
    setIsSaving(true);

    try {
      // Only ask the browser when the user is actively turning them ON.
      if (nextValue && permission === "default") {
        const result = await requestNotificationPermission();
        setPermission(result);
      }

      // Persist through the existing profile update route.
      await axiosInstance.patch(`/userupdate/${user.email}`, {
        notificationsEnabled: nextValue,
      });

      setEnabled(nextValue);

      if (nextValue && permission === "denied") {
        setMessage(
          "Notifications are still blocked in your browser. Turn them on for this site in your browser settings, then try again."
        );
      } else if (nextValue && permission === "unsupported") {
        setMessage("This browser does not support notifications.");
      } else if (nextValue && permission === "granted") {
        setMessage("You will be notified when a tweet mentions cricket and science.");
      }
    } catch (error: any) {
      setMessage(
        error?.response?.data?.error || "Could not save your preference. Please try again."
      );
    } finally {
      setIsSaving(false);
    }
  };

  const isBlocked = permission === "denied";
  const isUnsupported = permission === "unsupported";

  return (
    <Card className="bg-black border-gray-800 border-x-0 rounded-none">
      <CardContent className="p-4 flex items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {enabled && !isBlocked ? (
            <Bell className="h-5 w-5 text-blue-400 mt-0.5 shrink-0" />
          ) : (
            <BellOff className="h-5 w-5 text-gray-500 mt-0.5 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-white font-semibold text-sm">Cricket &amp; Science alerts</p>
            <p className="text-gray-400 text-xs mt-0.5">
              Get a browser notification when a new tweet contains both
              &ldquo;cricket&rdquo; and &ldquo;science&rdquo;.
            </p>
            {message && <p className="text-blue-300 text-xs mt-1">{message}</p>}
            {isUnsupported && (
              <p className="text-amber-300 text-xs mt-1">
                This browser does not support the Notification API.
              </p>
            )}
          </div>
        </div>

        <Button
          variant={enabled && !isBlocked ? "outline" : "default"}
          size="sm"
          onClick={handleToggle}
          disabled={isSaving}
          aria-pressed={enabled}
          aria-label="Toggle cricket and science notifications"
          className={
            enabled && !isBlocked
              ? "border-gray-600 text-white bg-gray-900 hover:bg-gray-800 shrink-0"
              : "bg-blue-500 hover:bg-blue-600 text-white shrink-0"
          }
        >
          {isSaving ? (
            <LoadingSpinner size="sm" />
          ) : enabled && !isBlocked ? (
            <>
              <Check className="h-4 w-4 mr-1" /> On
            </>
          ) : (
            "Off"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
