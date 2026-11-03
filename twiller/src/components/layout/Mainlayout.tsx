"use client";
import { useAuth } from "@/context/AuthContext";
import React, { useEffect, useState } from "react";
import LoadingSpinner from "../loading-spinner";
import Sidebar from "./Sidebar";
import RightSidebar from "./Rightsidebar";
import ProfilePage from "../ProfilePage";
import SubscriptionPage from "../SubscriptionPage";
// Internship Feature 3 - the Notifications tab must show a dedicated list of
// genuine matches, NOT the feed (which is what the fall-through branch did).
import NotificationsPage from "../NotificationsPage";
// Internship Feature 2 - session gate (Chrome code + mobile IST window).
import DeviceGate from "../DeviceGate";
// Internship Feature 3 - used to switch back to Home when a notification is
// clicked while the user is on the Profile view. This reuses the existing
// `currentPage` state; no routing library is introduced.
import { OPEN_TWEET_EVENT } from "@/lib/tweetNotifications";
import { OPEN_PROFILE_EDIT_EVENT } from "@/lib/profileEvents";

const Mainlayout = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuth();
  const [currentPage, setCurrentPage] = useState("home");

  // A clicked notification should always land the user on the feed.
  useEffect(() => {
    const goHome = () => setCurrentPage("home");
    window.addEventListener(OPEN_TWEET_EVENT, goHome);
    return () => window.removeEventListener(OPEN_TWEET_EVENT, goHome);
  }, []);

  // Internship Feature 4 (phase 2) - the language-switch dialog's "Add phone
  // number" action switches to the Profile view; ProfilePage listens for the
  // same event and opens its edit modal.
  useEffect(() => {
    const goProfile = () => setCurrentPage("profile");
    window.addEventListener(OPEN_PROFILE_EDIT_EVENT, goProfile);
    return () => window.removeEventListener(OPEN_PROFILE_EDIT_EVENT, goProfile);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="text-white text-4xl font-bold mb-4">X</div>
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  // If user is not logged in → show children (like login/signup pages)
  if (!user) {
    return <>{children}</>;
  }

  return (
    <DeviceGate>
    <div className="min-h-screen bg-black text-white flex justify-center">
      <div className="w-20 sm:w-24 md:w-64 border-r border-gray-800">
        <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      </div>
      <main className="flex-1 max-w-2xl border-x border-gray-800">
        {/* Internship Feature 1 (phase 4) - renders the subscription page
            with the same `currentPage` pattern as the existing profile case. */}
        {currentPage ==="profile" ? <ProfilePage/> : currentPage ==="subscription" ? <SubscriptionPage/> : currentPage ==="notifications" ? <NotificationsPage/> :children}
      </main>
      <div className="hidden lg:block w-80 p-4">
        {/* Internship Feature 1 (phase 4) - the right-rail "Subscribe"
            button routes to the Subscription page via the same state-based
            navigation used everywhere else (no router introduced). */}
        <RightSidebar onSubscribe={() => setCurrentPage("subscription")} />
      </div>
    </div>
    </DeviceGate>
  );
};

export default Mainlayout;
