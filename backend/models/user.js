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
  bio: { type: String, default: "" },
  location: { type: String, default: "" },
  website: { type: String, default: "" },
  joinedDate: { type: Date, default: Date.now() },
});

export default mongoose.model("User", UserSchema);
