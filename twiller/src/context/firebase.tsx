import { initializeApp, type FirebaseOptions } from "firebase/app";
import { getAuth } from "firebase/auth";

/**
 * Firebase web configuration is read from environment variables so that
 * project credentials are never hard-coded and committed to the repository.
 *
 * Where to get these values:
 *   Firebase console -> Project settings -> Your apps -> SDK setup and configuration
 * They belong in `twiller/.env.local` (git-ignored). See `.env.example`.
 *
 * Note: these NEXT_PUBLIC_* values are embedded in the browser bundle by
 * Next.js at build time. That is expected and is how Firebase web apps work -
 * they are NOT secret keys. Never put a service-account private key here.
 */
const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
};

/**
 * Allows the UI to show a helpful message instead of a cryptic Firebase
 * error when the environment has not been set up yet.
 */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId
);

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export default app;

