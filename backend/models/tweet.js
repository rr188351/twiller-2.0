import mongoose from "mongoose";
const TweetSchema = mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String, required: true },
  likes: { type: Number, default: 0 },
  retweets: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  retweetedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  image: { type: String, default: null },
  // Internship Feature 5 - audio tweets. Optional; existing text-only tweets
  // keep working unchanged (all fields default to null/undefined).
  audioUrl: { type: String, default: null },
  audioDuration: { type: Number, default: null }, // seconds, server-validated
  audioSize: { type: Number, default: null }, // bytes
  audioType: { type: String, default: null }, // MIME type, e.g. "audio/mpeg"
  timestamp: { type: Date, default: Date.now() },
});

export default mongoose.model("Tweet", TweetSchema);
