"use client";
import { useAuth } from "@/context/AuthContext";
import React, { useEffect, useState } from "react";
import LoadingSpinner from "../loading-spinner";
import Sidebar from "./Sidebar";
import RightSidebar from "./Rightsidebar";
import ProfilePage from "../ProfilePage";
// Internship Feature 3 - used to switch back to Home when a notification is
// clicked while the user is on the Profile view. This reuses the existing
// `currentPage` state; no routing library is introduced.
import { OPEN_TWEET_EVENT } from "@/lib/tweetNotifications";

const Mainlayout = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuth();
  const [currentPage, setCurrentPage] = useState("home");

  // A clicked notification should always land the user on the feed.
  useEffect(() => {
    const goHome = () => setCurrentPage("home");
    window.addEventListener(OPEN_TWEET_EVENT, goHome);
    return () => window.removeEventListener(OPEN_TWEET_EVENT, goHome);
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
    <div className="min-h-screen bg-black text-white flex justify-center">
      <div className="w-20 sm:w-24 md:w-64 border-r border-gray-800">
        <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      </div>
      <main className="flex-1 max-w-2xl border-x border-gray-800">
        {currentPage ==="profile" ? <ProfilePage/> :children}
      </main>
      <div className="hidden lg:block w-80 p-4">
        <RightSidebar />
      </div>
    </div>
  );
};

export default Mainlayout;
