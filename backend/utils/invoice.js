/**
 * Invoice helpers for Twiller 2.0 - Feature 1 (phase 3).
 *
 * INVOICE NUMBERS
 * ---------------
 * Format: `INV-<IST-year>-<6 random base36 chars>`, e.g. `INV-2026-A3K9Q2`.
 * The year comes from `getIstParts()` so invoices are grouped by the same
 * IST calendar the billing period uses. Uniqueness does NOT rely on
 * timestamps or counters (both collide under rapid requests): the suffix is
 * 36^6 ~ 2.1 billion crypto-random values, and the `invoiceNumber` unique
 * index is the final backstop - MongoDB rejects any accidental duplicate and
 * `createInvoice()` below retries with a fresh number rather than failing.
 *
 * Never derived from passwords, OTPs, emails or any other sensitive data.
 */

import crypto from "node:crypto";
import { getIstParts } from "./istTime.js";
import Invoice from "../models/invoice.js";

export const INVOICE_PREFIX = "INV";
export const INVOICE_EMAIL_FROM = process.env.MAIL_FROM || "Twiller <no-reply@twiller.local>";

function randomSuffix() {
  const bytes = crypto.randomBytes(4);
  const value = bytes.readUInt32BE(0) % 36 ** 6;
  return value.toString(36).toUpperCase().padStart(6, "0");
}

/**
 * Builds one candidate invoice number. Pure and deterministic enough for
 * tests (`getIstParts(date)` pins the year); uniqueness comes from the
 * random suffix plus the DB unique index.
 */
export function buildInvoiceNumber(now = new Date()) {
  const { year } = getIstParts(now);
  return `${INVOICE_PREFIX}-${year}-${randomSuffix()}`;
}

/**
 * Creates the single invoice for a SUCCESSFUL subscription transaction.
 * Idempotent by transaction: `subscription` is unique, so if this row already
 * exists (e.g. the caller retried) the existing invoice is returned and no
 * duplicate is ever created. Called with retries on the rare case where a
 * freshly generated number collides with another row.
 *
 * @param {{userId:ObjectId, subscriptionId:ObjectId, plan:object, provider:string, providerRef:string, paidAt:Date}} data
 */
export async function createInvoice({ userId, subscriptionId, plan, provider, providerRef, paidAt }) {
  const existing = await Invoice.findOne({ subscription: subscriptionId });
  if (existing) return { invoice: existing, created: false };

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const invoice = await Invoice.create({
        user: userId,
        subscription: subscriptionId,
        invoiceNumber: buildInvoiceNumber(paidAt),
        plan: plan.id,
        planName: plan.name,
        amountInr: plan.priceInr,
        currency: "INR",
        provider,
        providerRef,
        paidAt,
        status: "issued",
        emailDelivery: "pending",
      });
      return { invoice, created: true };
    } catch (error) {
      // 11000 = another row already owns this number; retry with a new one.
      if (error?.code === 11000) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export default { buildInvoiceNumber, createInvoice, INVOICE_PREFIX };
