"use client";

/**
 * NotificationsPage - Internship Feature 3 (notification list).
 *
 * WHY THIS EXISTS
 * ---------------
 * The sidebar's "Notifications" tab previously fell through to the default
 * branch in Mainlayout, which renders the FEED - so every ordinary tweet looked
 * like a notification. This view renders ONLY the recorded matches of the alert
 * rule (cricket OR science), newest first, with the FULL tweet text and a click
 * that opens the tweet in the feed.
 */

import React, { useEffect, useState } from "react";
import { Bell, Trash2 } from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { useLanguage } from "@/context/LanguageContext";
import {
  getNotificationRecords,
  clearNotificationRecords,
  subscribeNotificationLog,
  openTweet,
  type NotificationRecord,
} from "@/lib/tweetNotifications";

export default function NotificationsPage() {
  const { t } = useLanguage();
  const [records, setRecords] = useState<NotificationRecord[]>([]);

  // Load once, then stay in sync with the store (including other tabs' writes
  // through the storage event handled inside the store's subscribers).
  useEffect(() => {
    const sync = () => setRecords(getNotificationRecords());
    sync();
    return subscribeNotificationLog(sync);
  }, []);

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 bg-black/90 backdrop-blur-md border-b border-gray-800 z-10">
        <div className="px-4 py-3 flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold text-white">{t("notif.title")}</h1>
          {records.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => clearNotificationRecords()}
              className="text-gray-300 hover:bg-gray-900 hover:text-white shrink-0"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {t("notif.clearAll")}
            </Button>
          )}
        </div>
        <p className="px-4 pb-3 text-xs text-gray-500">{t("notif.subtitle")}</p>
      </div>

      {records.length === 0 ? (
        <Card className="bg-black border-none">
          <CardContent className="py-12 text-center">
            <Bell className="h-10 w-10 text-gray-600 mx-auto mb-3" />
            <h3 className="text-xl font-bold text-white mb-2">
              {t("notif.emptyTitle")}
            </h3>
            <p className="text-gray-400 text-sm">{t("notif.emptyHint")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="divide-y divide-gray-800">
          {records.map((record) => (
            <button
              key={record.tweetId}
              type="button"
              onClick={() => openTweet(record.tweetId)}
              className="w-full text-left px-4 py-3 hover:bg-gray-950/60 transition-colors"
            >
              <div className="flex items-start gap-3">
                <Bell className="h-5 w-5 text-blue-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-white font-semibold text-sm">
                    {record.authorName}
                  </p>
                  {/* The FULL tweet text - never truncated by this view. */}
                  <p className="text-gray-200 text-sm whitespace-pre-wrap break-words">
                    {record.content}
                  </p>
                  <p className="text-gray-500 text-xs mt-1">
                    {new Date(record.tweetTimestamp || record.recordedAt).toLocaleString()}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
