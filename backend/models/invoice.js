import mongoose from "mongoose";

/**
 * Invoice for Twiller 2.0 - Feature 1 (phase 3).
 *
 * One row exists per SUCCESSFUL subscription payment. The row records exactly
 * what the customer was told they paid for: plan, plan name, amount, currency,
 * provider, provider reference and payment date - all copied from the verified
 * subscription record plus `plans.js`, never from the request body.
 *
 * Statuses:
 *   issued -> payment succeeded and this invoice reflects it faithfully
 *   failed -> reserved for a future flow that aborts an invoice; the payment
 *             layer never writes it today (see the duplicate guard below)
 *
 * Email delivery is tracked ON the invoice (`emailDelivery`):
 *   pending -> created, confirmation not yet attempted
 *   sent    -> the mock mailer accepted the confirmation
 *   failed  -> the mock mailer failed; payment/plan/invoice stay untouched
 * (requirement: a mail failure must NEVER downgrade a successful payment).
 *
 * DUPLICATE PROTECTION: `subscription` is unique, so one payment transaction
 * can own at most one invoice even if the creation helper runs twice.
 */
const invoiceSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      required: true,
      unique: true,
    },
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
    },
    plan: { type: String, required: true },
    planName: { type: String, required: true },
    amountInr: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR" },
    provider: { type: String, default: "mock" },
    providerRef: { type: String, default: null },
    paidAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["issued", "failed"],
      default: "issued",
    },
    emailDelivery: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },
  },
  { timestamps: true }
);

// A user's invoices, newest first.
invoiceSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model("Invoice", invoiceSchema);
