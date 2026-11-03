"use client";

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  sendEmailVerification,
  signOut,
  // Aliased: the AuthContext exposes its own `updateProfile` (the backend PATCH),
  // so Firebase's display-name updater must not collide with it.
  updateProfile as updateFirebaseProfile,
} from "firebase/auth";
import React, { createContext, useContext, useState, useEffect } from "react";
import { auth } from "./firebase";
import axiosInstance from "../lib/axiosInstance";
import { describeAuthError } from "../lib/axiosInstance";

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
  // Internship Feature 1 (phase 4) - active subscription plan id. Optional
  // with "free" fallback so older profiles keep working.
  plan?: string;
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
    // Internship Feature 4 (phase 2) - normalised phone number (digits only).
    // Optional so callers that never touch the phone keep compiling.
    phone?: string;
  }) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
  googlesignin: () => void;
  // Internship Feature 1 (phase 4) - refetch the server profile so the UI
  // shows a newly activated plan without a full page reload.
  refreshUser: () => Promise<void>;
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

  // Secured backend routes answer with structured auth failures
  // (401 auth-invalid / auth-unavailable / auth-conflict / email-unverified,
  // 403 identity-mismatch, 503 auth-unavailable). Translate those first.
  if (error && typeof error === "object" && "response" in error) {
    const d = describeAuthError(error);
    if (d.status && d.message) {
      return new Error(d.message);
    }
  }

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

  if (code === "auth/weak-password") {
    return new Error(
      "That password is too weak. Firebase requires at least 6 characters - please choose a longer password."
    );
  }

  // The Email/Password provider is switched off for this Firebase project.
  if (code === "auth/operation-not-allowed") {
    return new Error(
      "Email/password sign-up is disabled for this Firebase project. Enable the Email/Password provider in Firebase Console -> Authentication -> Sign-in method."
    );
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
    // Check for existing session. The interceptor attaches the Firebase ID
    // token, so the backend resolves the profile from the VERIFIED token
    // (UID-first, verified-email fallback) - never from a client email param.
    const unsubcribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser?.email) {
        try {
          const res = await axiosInstance.get("/loggedinuser");

          if (res.data) {
            setUser(res.data);
            localStorage.setItem("twitter-user", JSON.stringify(res.data));
          }
        } catch (err: any) {
          // A signed-in Firebase user may still have no usable Twiller profile:
          //   - "email-unverified": an older profile is waiting to be linked
          //   - "no-profile":       no Twiller profile exists for this account yet
          // Both are EXPECTED business states, not application errors. Handle
          // them without a console stack trace and without fabricating a
          // logged-in user (user stays null so the app shows the auth/landing
          // screen and the user can complete registration).
          const errCode = err?.response?.data?.code;
          if (errCode === "email-unverified" || errCode === "no-profile") {
            setUser(null);
            localStorage.removeItem("twitter-user");
          } else {
            console.error("Failed to fetch user profile:", err);
          }
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
      // The axios interceptor attaches the freshly signed-in Firebase token,
      // so the backend resolves this profile from the verified token. No
      // client-supplied email is sent as identity.
      const res = await axiosInstance.get("/loggedinuser");
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
      // The backend deliberately refuses to link an unverified email to an
      // existing MongoDB profile. Send Firebase's verification email instead
      // of presenting this expected policy response as a generic login error.
      const responseCode = error?.response?.data?.code;
      if (responseCode === "email-unverified") {
        const firebaseUser = auth.currentUser;
        if (firebaseUser && !firebaseUser.emailVerified) {
          try {
            await sendEmailVerification(firebaseUser);
            throw new Error(
              "Your email is not verified yet. We sent a verification link to your inbox. Open that link, then sign in again. Check Spam/Junk if you don't see it."
            );
          } catch (verificationError: any) {
            if (verificationError instanceof Error && verificationError.message.startsWith("Your email is not verified yet.")) {
              throw verificationError;
            }
            if (verificationError?.code === "auth/too-many-requests") {
              throw new Error("Firebase is temporarily limiting verification emails. Wait a few minutes and try again, or use the latest verification email already in your inbox.");
            }
            throw new Error("Your email is not verified. We couldn't send a verification email automatically. Use Firebase's verification email flow and try again after verifying your address.");
          }
        }
      }
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
      // Best-effort: mirror the chosen display name onto the Firebase account
      // and send Firebase's verification email. Both are non-fatal - a failure
      // here must NOT abort Twiller profile registration below. Sending the
      // verification email at sign-up is what makes the French (email OTP)
      // language switch possible later; login() can also resend it on demand.
      try {
        if (displayName && !user.displayName) {
          await updateFirebaseProfile(user, { displayName });
        }
      } catch {
        /* non-fatal: the Twiller profile keeps the display name anyway */
      }
      try {
        await sendEmailVerification(user);
      } catch {
        /* non-fatal: the user can trigger another verification email from login */
      }
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

  // Internship Feature 1 (phase 4) - refetch the profile using the EXISTING
  // /loggedinuser pattern (same call login() and onAuthStateChanged use).
  // Deliberately swallows failures: the caller already shows its own payment
  // state, and a refresh must never freeze or break the page.
  const refreshUser = async () => {
    // The interceptor attaches the Firebase token; the backend resolves the
    // profile from the verified token. No client email is sent as identity.
    try {
      const res = await axiosInstance.get("/loggedinuser");
      if (res.data) {
        setUser(res.data);
        localStorage.setItem("twitter-user", JSON.stringify(res.data));
      }
    } catch (error) {
      console.error("Failed to refresh user profile:", error);
    }
  };

  const updateProfile = async (profileData: {
    displayName: string;
    bio: string;
    location: string;
    website: string;
    avatar: string;
    phone?: string;
  }) => {
    if (!user) return;

    // Same permanent-spinner defect that affected login/signup: without a
    // finally block a failed request left isLoading stuck on true, which
    // freezes the whole app on Mainlayout's spinner.
    setIsLoading(true);
    try {
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
    } catch (error: any) {
      // Re-thrown so the caller (Editprofile) can show the real reason
      // instead of failing silently.
      throw toFriendlyAuthError(error);
    } finally {
      setIsLoading(false);
    }
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
        // Token attached by the interceptor; the backend resolves the profile
        // from the verified token (UID-first, verified-email fallback).
        const res = await axiosInstance.get("/loggedinuser");
        userData = res.data;
      } catch (err: any) {
        // No profile yet (or unverified email on first link) - register.
        // The token is attached by the interceptor; a verified Google email
        // links/creates the profile safely, an unverified one is rejected
        // by the backend with a clear "verify your email" error.
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
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
