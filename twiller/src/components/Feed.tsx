import React, { useEffect, useRef, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Card, CardContent } from "./ui/card";
import LoadingSpinner from "./loading-spinner";
import TweetCard from "./TweetCard";
import TweetComposer from "./TweetComposer";
import axiosInstance from "@/lib/axiosInstance";
// Internship Feature 3 - browser notifications. The feed already receives the
// full tweet text from the EXISTING `/post` endpoint, so no new backend route
// is needed: matching happens right here in the browser.
import {
  notifyIfMatching,
  seedExistingTweets,
  peekPendingTweetId,
  clearPendingTweetId,
  decideReveal,
  OPEN_TWEET_EVENT,
} from "@/lib/tweetNotifications";
import { useAuth } from "@/context/AuthContext";

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
      id: "2",
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
      id: "3",
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
const Feed = () => {
  const [tweets, setTweets] = useState<any>([]);
  // Internship Feature 3 - needed to read the user's notificationsEnabled
  // preference from their profile.
  const { user } = useAuth();
  const [loading, setloading] = useState(false);
  const [revealNotice, setRevealNotice] = useState("");
  // Internship Feature 3 - becomes true once the first /post fetch has
  // finished. Used to distinguish "tweet not rendered YET" (keep waiting)
  // from "tweet really not in the feed" (show the notice).
  const [hasLoaded, setHasLoaded] = useState(false);

  /**
   * Internship Feature 3 - scroll to a tweet and briefly highlight it.
   * `TweetCard` renders `id={`tweet-${tweet._id}`}`, so the tweet id is the
   * stable anchor. No routing is involved.
   *
   * Only called when `decideReveal` has already confirmed the element exists,
   * so this cannot show a false "not in your feed" message.
   */
  const revealTweet = (tweetId: string) => {
    const element = document.getElementById(`tweet-${tweetId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.add("ring-2", "ring-blue-500", "bg-blue-900/10");
    setTimeout(() => {
      element.classList.remove("ring-2", "ring-blue-500", "bg-blue-900/10");
    }, 3000);
    setRevealNotice("");
  };
  const fetchTweets = async () => {
    try {
      setloading(true);
      const res = await axiosInstance.get("/post");
      setTweets(res.data);
      // Internship Feature 3: mark the existing timeline as already seen so
      // old matching tweets never fire a notification on page load. Only
      // genuinely NEW tweets should notify from now on.
      seedExistingTweets(res.data);
    } catch (error) {
      console.error(error);
    } finally {
      setloading(false);
      // Marks the first fetch as finished, successful or not. The reveal
      // effect uses this to know when it is safe to report a missing tweet.
      setHasLoaded(true);
    }
  };
  useEffect(() => {
    fetchTweets();
  }, []);

  /**
   * Internship Feature 3 - handle "reveal this tweet" requests.
   *
   * TIMING FIX: the pending tweet id is now only cleared once `decideReveal`
   * says to. While the feed is still loading and the tweet has not rendered
   * yet, the decision is "wait" and the id is KEPT, so the retry below can
   * pick it up as soon as the tweets arrive. The "not in your feed" message
   * is only shown after the first fetch has finished and the tweet is still
   * genuinely absent. Two paths cover every case:
   *   a) the feed is already mounted -> the event fires immediately;
   *   b) the user was on the Profile view -> Mainlayout switches to Home, this
   *      feed mounts, and the pending id survives until the tweets render.
   */
  const tryRevealPending = () => {
    const decision = decideReveal(
      peekPendingTweetId(),
      hasLoaded,
      (id) => Boolean(document.getElementById(`tweet-${id}`))
    );

    if (decision.action === "reveal") {
      clearPendingTweetId();
      revealTweet(decision.tweetId);
    } else if (decision.action === "missing") {
      clearPendingTweetId();
      setRevealNotice("That tweet is not in your feed right now.");
      setTimeout(() => setRevealNotice(""), 4000);
    }
    // "wait" and "idle" -> do nothing; the id is kept and retried below.
  };

  // Always points at the latest closure so the single long-lived listener
  // never reads stale `tweets` or `hasLoaded` values.
  const tryRevealPendingRef = useRef(tryRevealPending);
  tryRevealPendingRef.current = tryRevealPending;

  // ONE window listener for the component's lifetime - no duplicates, no
  // re-registration on re-render.
  useEffect(() => {
    const onOpenTweet = () => tryRevealPendingRef.current();
    window.addEventListener(OPEN_TWEET_EVENT, onOpenTweet);
    return () => window.removeEventListener(OPEN_TWEET_EVENT, onOpenTweet);
  }, []);

  // Retry whenever the feed contents or the loading state change, so a
  // notification click made while the feed was still loading is honoured as
  // soon as the tweet renders.
  useEffect(() => {
    tryRevealPendingRef.current();
  }, [tweets, hasLoaded]);
  const handlenewtweet = (newtweet: any) => {
    setTweets((prev: any) => [newtweet, ...prev]);
    // Internship Feature 3: this is the single place a genuinely NEW tweet
    // enters the feed. It only raises a notification when the tweet contains
    // BOTH "cricket" and "science", the user has the setting switched on and
    // the browser permission is "granted". Never throws, so posting still
    // works even if notifications are unavailable.
    try {
      notifyIfMatching(newtweet, { enabled: user?.notificationsEnabled !== false });
    } catch (notificationError) {
      console.warn("Notification skipped:", notificationError);
    }
  };
  return (
    <div className="min-h-screen">
      {/* Internship Feature 3 - shown when a clicked tweet is not in the feed */}
      {revealNotice && (
        <div className="px-4 py-2 text-sm text-amber-300 bg-amber-900/20 border-b border-amber-900/40">
          {revealNotice}
        </div>
      )}
      <div className="sticky top-0 bg-black/90 backdrop-blur-md border-b border-gray-800 z-10">
        <div className="px-4 py-3">
          <h1 className="text-xl font-bold text-white">Home</h1>
        </div>

        <Tabs defaultValue="foryou" className="w-full">
          <TabsList className="grid w-full grid-cols-2 bg-transparent border-b border-gray-800 rounded-none h-auto">
            <TabsTrigger
              value="foryou"
              className="data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:border-b-1 data-[state=active]:border-blue-100 data-[state=active]:rounded-none text-gray-400 hover:bg-gray-900/50 py-4 font-semibold"
            >
              For you
            </TabsTrigger>
            <TabsTrigger
              value="following"
              className="data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:border-b-1 data-[state=active]:border-blue-100 data-[state=active]:rounded-none text-gray-400 hover:bg-gray-900/50 py-4 font-semibold"
            >
              Following
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <TweetComposer onTweetPosted={handlenewtweet}/>
      <div className="divide-y divide-gray-800">
        {loading ? (
          <Card className="bg-black border-none">
            <CardContent className="py-12 text-center">
              <div className="text-gray-400 mb-4">
                <LoadingSpinner size="lg" className="mx-auto mb-4" />
                <p>Loading tweets...</p>
              </div>
            </CardContent>
          </Card>
        ) : (
          tweets.map((tweet: any) => <TweetCard key={tweet._id} tweet={tweet} />)
        )}
      </div>
    </div>
  );
};

export default Feed;
