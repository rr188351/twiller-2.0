import mongoose from "mongoose";

/**
 * Subscription/payment transaction for Twiller 2.0 - Feature 1 (phase 2).
 *
 * WHY A SEPARATE COLLECTION
 * -------------------------
 * Phase 1 stores only the active `plan` id on the User document. That tells
 * the quota guard what the user may do, but it says nothing about HOW the
 * plan was obtained. Every payment attempt gets one row here so the money
 * trail is auditable independently of the user profile:
 *   pending   -> recorded before the provider is called
 *   success   -> provider approved AND the plan was stored on the user
 *   failed    -> provider declined; the user's plan is left unchanged
 *   cancelled -> payment was abandoned; the user's plan is left unchanged
 *
 * Phase 2 uses ONLY the mock provider (`provider: "mock"`). Later phases
 * reuse this same shape for Razorpay - only new provider-specific fields are
 * appended, this schema never has to be redesigned. No invoice, proration,
 * refund, renewal or webhook fields yet - deliberately minimal.
 */
const subscriptionSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // The requested plan id, e.g. "bronze". Validated against
    // backend/utils/plans.js BEFORE the row is created - arbitrary strings
    // can never become an active plan through this collection.
    plan: { type: String, required: true },
    // Snapshot of the plan price in INR at purchase time, taken server-side
    // from the plan definition. The client never supplies the amount.
    amountInr: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["pending", "success", "failed", "cancelled"],
      default: "pending",
    },
    // "mock" in phase 2; "razorpay" (or others) appended later.
    provider: { type: String, default: "mock" },
    // Vendor reference id once the provider responds; null while pending.
    providerRef: { type: String, default: null },
  },
  { timestamps: true }
);

// A user's payment history, newest first.
subscriptionSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model("Subscription", subscriptionSchema);
