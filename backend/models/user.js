import mongoose from "mongoose";
const UserSchema = mongoose.Schema({
  username: { type: String, required: true },
  displayName: { type: String, required: true },
  avatar: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  // Added for Internship Features 2, 4, 5 and 6 (mobile OTP and phone-based
  // password recovery). Optional so that every existing user document keeps
  // working unchanged - MongoDB simply reports "" for older records.
  phone: { type: String, default: "" },
  // Internship Feature 3 - browser notifications for tweets containing both
  // "cricket" and "science". Defaults to true so existing users keep the same
  // behaviour without needing to change anything.
  notificationsEnabled: { type: Boolean, default: true },
  // Internship Feature 1 (phase 1) - subscription plan id, e.g. "free",
  // "bronze", "silver" or "gold" as defined in backend/utils/plans.js.
  // Optional with no stored value so that EVERY pre-existing document keeps
  // working with no migration: lookups treat "no stored plan" as "free".
  // Phase 2 will add richer subscription state (cycle, payment records); the
  // plan id remains the only user-level field phase 1 needs.
  plan: { type: String, default: "" },
  bio: { type: String, default: "" },
  location: { type: String, default: "" },
  website: { type: String, default: "" },
  joinedDate: { type: Date, default: Date.now() },
  // Firebase identity mapping (secure auth integration).
  //
  // Both fields are OPTIONAL with empty-string defaults so that EVERY
  // pre-existing user document keeps working with no data migration:
  // legacy records simply carry "" (no Firebase account bound yet) and the
  // identity-mapping code treats "" as "unbound". Existing _ids, tweets,
  // likes, retweets, subscriptions and invoices are never touched.
  //
  // `firebaseUid`   - UID from the verified Firebase ID token. It becomes the
  //                   PRIMARY identity key: lookups check it before email.
  // `firebaseProjectId` - project the UID was minted in, so a UID reused
  //                   across projects can never be matched by UID alone.
  firebaseUid: { type: String, default: "" },
  firebaseProjectId: { type: String, default: "" },
});

// Sparse indexes: only documents that actually carry a value are indexed, so
// the 30+ legacy records (empty values) stay untouched and no index churn is
// forced on them. UID lookups become O(1) once a user is bound.
UserSchema.index({ firebaseUid: 1 }, { sparse: true });
UserSchema.index({ firebaseProjectId: 1 }, { sparse: true });
UserSchema.index({ firebaseProjectId: 1, firebaseUid: 1 }, { sparse: true });

export default mongoose.model("User", UserSchema);
