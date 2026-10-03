"use client";

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import React, { createContext, useContext, useState, useEffect } from "react";
import { auth } from "./firebase";
import axiosInstance from "../lib/axiosInstance";

interface User {
  _id: string;
  username: string;
  displayName: string;
  avatar: string;
  bio?: string;
  joinedDate: string;
  email: string;
  website: string;
  location: string;
  // Internship features (optional on older profiles so nothing breaks).
  phone?: string;
  notificationsEnabled?: boolean;
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (
    email: string,
    password: string,
    username: string,
    displayName: string
  ) => Promise<void>;
  updateProfile: (profileData: {
    displayName: string;
    bio: string;
    location: string;
    website: string;
    avatar: string;
  }) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
  googlesignin: () => void;
}

/**
 * Turns a raw Firebase / axios failure into a message that tells the user what
 * actually went wrong.
 *
 * This exists because the original UI showed one generic
 * "Authentication failed. Please try again." for EVERY failure, which made a
 * wrong password indistinguishable from a stopped backend - the main reason
 * the login problem was so hard to diagnose.
 *
 * The function preserves the original Firebase error so nothing about the
 * authentication architecture changes.
 */
function toFriendlyAuthError(error: any): Error {
  const rawMessage: string = error?.message || String(error || "");
  const code: string = error?.code || "";

  if (rawMessage.startsWith("ACCOUNT_NO_TWILLER_PROFILE")) {
    return new Error(
      "Signed in with Firebase, but no Twiller profile exists for this email. Create the account through the Sign up form first."
    );
  }

  // Firebase rejected the credentials (wrong email/password, or the account
  // does not exist in the CURRENTLY CONFIGURED Firebase project).
  if (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found" ||
    code === "auth/invalid-email"
  ) {
    return new Error(
      "Incorrect email or password. If you recently created a new Firebase project, make sure the NEXT_PUBLIC_FIREBASE_* values in twiller/.env.local match it."
    );
  }

  if (code === "auth/email-already-in-use") {
    return new Error("An account with that email already exists. Try signing in instead.");
  }

  if (code === "auth/too-many-requests") {
    return new Error("Too many attempts. Please wait a moment and try again.");
  }

  // Axios could not reach the backend at all.
  if (code === "ERR_NETWORK" || rawMessage.includes("Network Error")) {
    return new Error(
      "Cannot reach the Twiller backend. Make sure it is running (cd backend && npm start, port 5000)."
    );
  }

  return error instanceof Error ? error : new Error(rawMessage || "Authentication failed.");
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check for existing session
    const unsubcribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser?.email) {
        try {
          const res = await axiosInstance.get("/loggedinuser", {
            params: { email: firebaseUser.email },
          });

          if (res.data) {
            setUser(res.data);
            localStorage.setItem("twitter-user", JSON.stringify(res.data));
          }
        } catch (err) {
          console.log("Failed to fetch user:", err);
        }
      } else {
        setUser(null);
        localStorage.removeItem("twitter-user");
      }
      setIsLoading(false);
    });
    return () => unsubcribe();
  }, []);

  /**
   * LOGIN RELIABILITY FIX
   * --------------------
   * `login` used to have no try/catch/finally, so when Firebase rejected the
   * credentials `setIsLoading(false)` was never reached and `isLoading` stayed
   * `true` FOREVER. `Mainlayout` renders a full-screen spinner while
   * `isLoading` is true, so a single failed login left the whole app stuck on
   * a spinner with no way out except reloading - which repeated the failure.
   * That is the "stuck in a login/reload loop" symptom.
   *
   * The same defect existed in `signup`. Both are fixed here with try/finally,
   * and the errors are re-thrown with a clear message so the UI can explain
   * what actually went wrong instead of a generic "Authentication failed".
   */
  const login = async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const usercred = await signInWithEmailAndPassword(auth, email, password);
      const firebaseuser = usercred.user;
      const res = await axiosInstance.get("/loggedinuser", {
        params: { email: firebaseuser.email },
      });
      if (!res.data) {
        // Firebase accepted the credentials but Twiller has no profile for
        // this email. Without this the app would silently stay on the landing
        // page forever, because `user` would never be set.
        throw new Error(
          "ACCOUNT_NO_TWILLER_PROFILE: Firebase accepted these credentials, but no Twiller profile exists for this email address."
        );
      }
      setUser(res.data);
      localStorage.setItem("twitter-user", JSON.stringify(res.data));
    } catch (error: any) {
      throw toFriendlyAuthError(error);
    } finally {
      // ALWAYS clear the spinner, whatever happened.
      setIsLoading(false);
    }
  };

  const signup = async (
    email: string,
    password: string,
    username: string,
    displayName: string
  ) => {
    setIsLoading(true);
    // Same spinner-stuck defect as `login`, fixed the same way.
    try {
      const usercred = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );
      const user = usercred.user;
      const newuser: any = {
        username,
        displayName,
        avatar: user.photoURL || "https://images.pexels.com/photos/1139743/pexels-photo-1139743.jpeg?auto=compress&cs=tinysrgb&w=400",
        email: user.email,
      };
      const res = await axiosInstance.post("/register", newuser);
      if (res.data) {
        setUser(res.data);
        localStorage.setItem("twitter-user", JSON.stringify(res.data));
      }
    } catch (error: any) {
      throw toFriendlyAuthError(error);
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setUser(null);
    await signOut(auth);
    localStorage.removeItem("twitter-user");
  };

  const updateProfile = async (profileData: {
    displayName: string;
    bio: string;
    location: string;
    website: string;
    avatar: string;
  }) => {
    if (!user) return;

    setIsLoading(true);
    // Mock API call - in real app, this would call an API
    // await new Promise((resolve) => setTimeout(resolve, 1000));

    const updatedUser: User = {
      ...user,
      ...profileData,
    };
    const res = await axiosInstance.patch(
      `/userupdate/${user.email}`,
      updatedUser
    );
    if (res.data) {
      setUser(updatedUser);
      localStorage.setItem("twitter-user", JSON.stringify(updatedUser));
    }

    setIsLoading(false);
  };
  const googlesignin = async () => {
    setIsLoading(true);

    try {
      const googleauthprovider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, googleauthprovider);
      const firebaseuser = result.user;

      if (!firebaseuser?.email) {
        throw new Error("No email found in Google account");
      }

      let userData;

      try {
        const res = await axiosInstance.get("/loggedinuser", {
          params: { email: firebaseuser.email },
        });
        userData = res.data;
      } catch (err: any) {
        const newuser: any = {
          username: firebaseuser.email.split("@")[0],
          displayName: firebaseuser.displayName || "User",
          avatar: firebaseuser.photoURL || "https://images.pexels.com/photos/1139743/pexels-photo-1139743.jpeg?auto=compress&cs=tinysrgb&w=400",
          email: firebaseuser.email,
        };

        const registerRes = await axiosInstance.post("/register", newuser);
        userData = registerRes.data;
      }

      if (userData) {
        setUser(userData);
        localStorage.setItem("twitter-user", JSON.stringify(userData));
      } else {
        throw new Error("Login/Register failed: No user data returned");
      }
    } catch (error: any) {
      console.error("Google Sign-In Error:", error);
      alert(error.response?.data?.message || error.message || "Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        login,
        signup,
        updateProfile,
        logout,
        isLoading,
        googlesignin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
