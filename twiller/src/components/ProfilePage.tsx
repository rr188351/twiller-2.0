"use client";

import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  Calendar,
  MapPin,
  Link as LinkIcon,
  MoreHorizontal,
  Camera,
  Settings,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
// Internship Feature 4 (phase 1) - localized strings.
import { useLanguage } from "@/context/LanguageContext";
import { Button } from "./ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import TweetCard from "./TweetCard";
import { Card, CardContent } from "./ui/card";
import Editprofile from "./Editprofile";
// Internship Feature 3 - enable/disable browser notifications from the profile.
import NotificationSettings from "./NotificationSettings";
// Internship Feature 2 - the user's own login history.
import LoginHistory from "./LoginHistory";
import axiosInstance from "@/lib/axiosInstance";
import { OPEN_PROFILE_EDIT_EVENT } from "@/lib/profileEvents";

interface Tweet {
  id: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatar: string;
    verified?: boolean;
  };
  content: string;
  timestamp: string;
  likes: number;
  retweets: number;
  comments: number;
  liked?: boolean;
  retweeted?: boolean;
  image?: string;
}
const tweets: Tweet[] = [
  {
    id: "1",
    author: {
      id: "1",
      username: "elonmusk",
      displayName: "Elon Musk",
      avatar:
        "https://images.pexels.com/photos/2379005/pexels-photo-2379005.jpeg?auto=compress&cs=tinysrgb&w=400",
      verified: true,
    },
    content:
      "Just had an amazing conversation about the future of AI. The possibilities are endless!",
    timestamp: "2h",
    likes: 1247,
    retweets: 324,
    comments: 89,
    liked: false,
    retweeted: false,
  },
  {
    id: "2",
    author: {
      id: "1",
      username: "sarahtech",
      displayName: "Sarah Johnson",
      avatar:
        "https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg?auto=compress&cs=tinysrgb&w=400",
      verified: false,
    },
    content:
      "Working on some exciting new features for our app. Can't wait to share what we've been building! 🚀",
    timestamp: "4h",
    likes: 89,
    retweets: 23,
    comments: 12,
    liked: true,
    retweeted: false,
  },
  {
    id: "3",
    author: {
      id: "4",
      username: "designguru",
      displayName: "Alex Chen",
      avatar:
        "https://images.pexels.com/photos/1681010/pexels-photo-1681010.jpeg?auto=compress&cs=tinysrgb&w=400",
      verified: true,
    },
    content:
      "The new design system is finally complete! It took 6 months but the results are incredible. Clean, consistent, and accessible.",
    timestamp: "6h",
    likes: 456,
    retweets: 78,
    comments: 34,
    liked: false,
    retweeted: true,
    image:
      "https://images.pexels.com/photos/196645/pexels-photo-196645.jpeg?auto=compress&cs=tinysrgb&w=800",
  },
];
export default function ProfilePage() {
  const {
    user,
    emailVerified,
    resendVerificationEmail,
    refreshEmailVerification,
  } = useAuth();
  const [activeTab, setActiveTab] = useState("posts");
  const [showEditModal, setShowEditModal] = useState(false);
  const [tweets, setTweets] = useState<any>([]);
  // Email-verification button state. Declared BEFORE the early return below so
  // the hook order stays identical on every render.
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState("");
  const [verifyError, setVerifyError] = useState("");
  // Internship Feature 4 (phase 1).
  const { t } = useLanguage();
  const [loading, setloading] = useState(false);

  // Internship Feature 4 (phase 2) - the language dialog's "Add phone number"
  // action lands here and opens the edit modal. Declared BEFORE the early
  // return below so the hook order stays identical on every render.
  useEffect(() => {
    const openEdit = () => setShowEditModal(true);
    window.addEventListener(OPEN_PROFILE_EDIT_EVENT, openEdit);
    return () => window.removeEventListener(OPEN_PROFILE_EDIT_EVENT, openEdit);
  }, []);

  if (!user) return null;

  /**
   * Sends/resends Firebase's OWN verification email. The account can never be
   * marked verified from here - only Firebase's trusted state can do that.
   */
  const handleVerifyEmail = async () => {
    setVerifyBusy(true);
    setVerifyMessage("");
    setVerifyError("");
    try {
      const result = await resendVerificationEmail();
      setVerifySent(true);
      setVerifyMessage(
        result === "already-verified"
          ? t("profile.verifyEmailVerified")
          : t("profile.verifyEmailSent")
      );
    } catch {
      setVerifyError(t("profile.verifyEmailError"));
    } finally {
      setVerifyBusy(false);
    }
  };

  /** Re-reads Firebase's verification state - no sign-out needed. */
  const handleRecheckVerification = async () => {
    setVerifyBusy(true);
    setVerifyMessage("");
    setVerifyError("");
    try {
      const verified = await refreshEmailVerification();
      if (verified) {
        setVerifyMessage(t("profile.verifyEmailThanks"));
      } else {
        setVerifyError(t("profile.verifyEmailNotVerified"));
      }
    } catch {
      setVerifyError(t("profile.verifyEmailError"));
    } finally {
      setVerifyBusy(false);
    }
  };

  const fetchTweets = async () => {
    try {
      setloading(true);
      const res = await axiosInstance.get("/post");
      setTweets(res.data);
    } catch (error) {
      console.error(error);
    } finally {
      setloading(false);
    }
  };
  useEffect(() => {
    fetchTweets();
  }, []);
  // Filter tweets by current user
  const userTweets = tweets.filter((tweet: any) => tweet.author._id === user._id);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="sticky top-0 bg-black/90 backdrop-blur-md border-b border-gray-800 z-10">
        <div className="flex items-center px-4 py-3 space-x-8">
          <Button
            variant="ghost"
            size="sm"
            className="p-2 rounded-full hover:bg-gray-900"
          >
            <ArrowLeft className="h-5 w-5 text-white" />
          </Button>
          <div>
            <h1 className="text-xl font-bold text-white">{user.displayName}</h1>
            <p className="text-sm text-gray-400">{userTweets.length} {t("profile.postsCountSuffix")}</p>
          </div>
        </div>
      </div>

      {/* Cover Photo */}
      <div className="relative">
        <div className="h-48 bg-gradient-to-r from-blue-600 to-purple-600 relative">
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-4 right-4 p-2 rounded-full bg-black/50 hover:bg-black/70"
          >
            <Camera className="h-5 w-5 text-white" />
          </Button>
        </div>

        {/* Profile Picture */}
        <div className="absolute -bottom-16 left-4">
          <div className="relative">
            <Avatar className="h-32 w-32 border-4 border-black">
              <AvatarImage src={user.avatar} alt={user.displayName} />
              <AvatarFallback className="text-2xl">
                {user.displayName[0]}
              </AvatarFallback>
            </Avatar>
            <Button
              variant="ghost"
              size="sm"
              className="absolute bottom-2 right-2 p-2 rounded-full bg-black/70 hover:bg-black/90"
            >
              <Camera className="h-4 w-4 text-white" />
            </Button>
          </div>
        </div>

        {/* Edit Profile Button */}
        <div className="flex justify-end p-4">
          <Button
            variant="outline"
            className="border-gray-600 text-white bg-gray-950 font-semibold rounded-full px-6"
            onClick={() => setShowEditModal(true)}
          >
            {t("profile.editProfile")}
          </Button>
        </div>
      </div>

      {/* Profile Info */}
      <div className="px-4 pb-4 mt-12">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h1 className="text-2xl font-bold text-white">
              {user.displayName}
            </h1>
            <p className="text-gray-400">@{user.username}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="p-2 rounded-full hover:bg-gray-900"
          >
            <MoreHorizontal className="h-5 w-5 text-gray-400" />
          </Button>
        </div>

        {user.bio && (
          <p className="text-white mb-3 leading-relaxed">{user.bio}</p>
        )}

        {/* Email verification - sends Firebase's own verification LINK. It is
            deliberately separate from Twiller's custom email OTP flow and can
            never verify the account by itself. */}
        <div className="mb-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
          <p className="text-sm text-gray-300">
            {emailVerified
              ? t("profile.verifyEmailVerified")
              : t("profile.verifyEmailNotVerified")}
          </p>
          {!emailVerified && (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={verifyBusy}
                onClick={handleVerifyEmail}
                className="border-gray-600 text-white bg-gray-950 font-semibold rounded-full px-4 disabled:opacity-60"
              >
                {verifyBusy
                  ? t("forgot.verifying")
                  : verifySent
                    ? t("profile.verifyEmailResendBtn")
                    : t("profile.verifyEmailBtn")}
              </Button>
              {verifySent && (
                <button
                  type="button"
                  disabled={verifyBusy}
                  onClick={handleRecheckVerification}
                  className="text-xs text-blue-400 hover:text-blue-300 font-medium disabled:opacity-60"
                >
                  {t("profile.verifyEmailRecheck")}
                </button>
              )}
            </div>
          )}
          {verifyMessage && (
            <p role="status" className="mt-1 text-xs text-green-400">
              {verifyMessage}
            </p>
          )}
          {verifyError && (
            <p role="alert" className="mt-1 text-xs text-red-400">
              {verifyError}
            </p>
          )}
        </div>

        <div className="flex items-center space-x-4 text-gray-400 text-sm mb-3">
          <div className="flex items-center space-x-1">
            <MapPin className="h-4 w-4" />
            <span>{user.location ? user.location : t("profile.defaultLocation")}</span>
          </div>
          <div className="flex items-center space-x-1">
            <LinkIcon className="h-4 w-4" />
            <span className="text-blue-400">
              {user.website ? user.website : "example.com"}
            </span>
          </div>
          <div className="flex items-center space-x-1">
            <Calendar className="h-4 w-4" />
            <span>
              {t("profile.joinedPrefix")}{" "}
              {user.joinedDate &&
                new Date(user.joinedDate).toLocaleDateString("en-us", {
                  month: "long",
                  year: "numeric",
                })}
            </span>
          </div>
        </div>
      </div>

      {/* Internship Feature 3 - notification preference */}
      <NotificationSettings />
      {/* Internship Feature 2 - who/where/when signed in. */}
      <LoginHistory />

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-5 bg-transparent border-b border-gray-800 rounded-none h-auto">
          <TabsTrigger
            value="posts"
            className="data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:border-b-2 data-[state=active]:border-blue-500 data-[state=active]:rounded-none text-gray-400 hover:bg-gray-900/50 py-4 font-semibold"
          >
            {t("profile.posts")}
          </TabsTrigger>
          <TabsTrigger
            value="replies"
            className="data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:border-b-2 data-[state=active]:border-blue-500 data-[state=active]:rounded-none text-gray-400 hover:bg-gray-900/50 py-4 font-semibold"
          >
            {t("profile.replies")}
          </TabsTrigger>
          <TabsTrigger
            value="highlights"
            className="data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:border-b-2 data-[state=active]:border-blue-500 data-[state=active]:rounded-none text-gray-400 hover:bg-gray-900/50 py-4 font-semibold"
          >
            {t("profile.highlights")}
          </TabsTrigger>
          <TabsTrigger
            value="articles"
            className="data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:border-b-2 data-[state=active]:border-blue-500 data-[state=active]:rounded-none text-gray-400 hover:bg-gray-900/50 py-4 font-semibold"
          >
            {t("profile.articles")}
          </TabsTrigger>
          <TabsTrigger
            value="media"
            className="data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:border-b-2 data-[state=active]:border-blue-500 data-[state=active]:rounded-none text-gray-400 hover:bg-gray-900/50 py-4 font-semibold"
          >
            {t("profile.media")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="posts" className="mt-0">
          <div className="divide-y divide-gray-800">
            { loading ? (
              <Card className="bg-black border-none">
                <CardContent className="py-12 text-center">
                  <div className="text-gray-400">
                    <h3 className="text-2xl font-bold mb-2">
                      {t("profile.postsTabEmpty")}
                    </h3>
                    <p>When you post, it will show up here.</p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              userTweets.map((tweet:any) => (
                <TweetCard key={tweet._id} tweet={tweet} />
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="replies" className="mt-0">
          <Card className="bg-black border-none">
            <CardContent className="py-12 text-center">
              <div className="text-gray-400">
                <h3 className="text-2xl font-bold mb-2">
                  {t("profile.repliesTabEmpty")}
                </h3>
                <p>When you reply to a post, it will show up here.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="highlights" className="mt-0">
          <Card className="bg-black border-none">
            <CardContent className="py-12 text-center">
              <div className="text-gray-400">
                <h3 className="text-2xl font-bold mb-2">
                  {t("profile.mediaTabEmpty")}
                </h3>
                <p>{t("profile.mediaTabHint")}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="articles" className="mt-0">
          <Card className="bg-black border-none">
            <CardContent className="py-12 text-center">
              <div className="text-gray-400">
                <h3 className="text-2xl font-bold mb-2">
                  {t("profile.articlesTabEmpty")}
                </h3>
                <p>When you write articles, they will show up here.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="media" className="mt-0">
          <Card className="bg-black border-none">
            <CardContent className="py-12 text-center">
              <div className="text-gray-400">
                <h3 className="text-2xl font-bold mb-2">
                  {t("profile.mediaTabEmpty")}
                </h3>
                <p>{t("profile.mediaTabHint")}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <Editprofile
        isopen={showEditModal}
        onclose={() => setShowEditModal(false)}
      />
    </div>
  );
}
