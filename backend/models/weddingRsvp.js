import crypto from "node:crypto";
import mongoose from "mongoose";

/**
 * Wedding RSVP storage.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The royal wedding invitation website is a STATIC React app (GitHub Pages), so
 * it has no server of its own. A guest's reply travels here, to the existing
 * Twiller Express API, and is stored permanently.
 *
 * Two deliberate design choices:
 *
 *   1. ITS OWN DATABASE, NOT TWILLER'S.
 *      Replies are written to a dedicated database ("wedding_rsvp") and
 *      collection ("guests"). The couple's guest list can therefore never mix
 *      with Twiller's users, tweets, OTPs or invoices, and it can be exported,
 *      archived or dropped on its own without touching a single Twiller
 *      document.
 *
 *      The rest of the backend reaches its application database through the
 *      default mongoose connection (see utils/dbName.js). Feeding a different
 *      `dbName` into THAT connection would carry every Twiller collection with
 *      it, so this module opens its own connection to the SAME cluster and pins
 *      it to the RSVP database. The default connection is never touched.
 *
 *   2. IDEMPOTENT WRITES (requestId).
 *      A guest on a flaky connection, or one who taps "Send" twice, must never
 *      end up on the guest list twice. The browser sends a `requestId` that is
 *      stable for one reply, and a unique index turns a repeated POST into a
 *      no-op that returns the record already stored instead of creating a
 *      second one.
 *
 * SECURITY: no credential, URI or driver error ever leaves this module. A
 * storage failure is reported to the route as "unavailable", never echoed.
 */

/** The database that holds wedding data only - never Twiller's application db. */
export const WEDDING_RSVP_DB_NAME =
  (process.env.WEDDING_RSVP_DB || "").trim() || "wedding_rsvp";

/** The collection inside that database. */
export const WEDDING_RSVP_COLLECTION = "guests";

/** The only two replies the invitation form can send. */
export const ATTENDANCE_VALUES = ["accept", "decline"];

/** Marks the origin of a record, so a future guest list stays distinguishable. */
export const WEDDING_RSVP_SOURCE = "wedding_invitation";

/** Field limits, mirrored exactly by the validation below. */
export const MAX_NAME_LENGTH = 80;
/** The most names one public response may carry. */
export const MAX_PUBLIC_GUEST_NAMES = 500;
export const MAX_MESSAGE_LENGTH = 400;
/**
 * The largest party an acceptance may declare, 1-12 for an acceptance and 0 for
 * a decline. The invitation's dropdown offers exactly this range, this validator
 * enforces it, and the schema below repeats it - so the three can never drift
 * into the situation where the form offers a number the API quietly refuses.
 */
export const MAX_PARTY_SIZE = 12;
export const MAX_REQUEST_ID_LENGTH = 64;
/** An address is optional, but it can never be longer than this. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * A pragmatic address check.
 *
 * It is deliberately conservative about what it ACCEPTS - letters, digits and
 * ordinary address punctuation only. That conservatism is also the security
 * property: no space, comma, semicolon, angle bracket or quote can pass, so a
 * submitted "address" can never smuggle in a second recipient or a mail header.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
/** A real TLD: two or more letters at the end of the domain. */
const EMAIL_TLD_PATTERN = /\.[A-Za-z]{2,}$/;

/**
 * The exact body keys this endpoint accepts. Anything else is a rejection: a
 * malformed client (or a script probing the API) should not be able to write
 * arbitrary fields into the guest list.
 */
const ALLOWED_FIELDS = new Set([
  "attendance",
  "name",
  "email",
  "partySize",
  "message",
  "requestId",
  "capturedAt",
  "source",
]);

/** An idempotency key: short, URL-safe and impossible to confuse with a name. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const WeddingRsvpSchema = new mongoose.Schema(
  {
    // The guest's name. Required for an acceptance (enforced below for a
    // decline too, to keep every record identifiable); stored trimmed.
    name: { type: String, default: "", trim: true, maxlength: MAX_NAME_LENGTH },
    // "accept" | "decline" - the one field with no sensible default.
    attendance: {
      type: String,
      required: true,
      enum: ATTENDANCE_VALUES,
    },
    // How many are joining, 1-12 for an acceptance and 0 for a decline.
    partySize: { type: Number, default: 0, min: 0, max: MAX_PARTY_SIZE },
    // The guest's email, when they chose to give one. Empty is the normal case:
    // the reply is complete and valid without it.
    email: { type: String, default: "", trim: true, maxlength: MAX_EMAIL_LENGTH },
    // What happened to the courtesy confirmation email. Recording it is what
    // guarantees a retried submission never posts a second copy.
    confirmationEmail: {
      sent: { type: Boolean, default: false },
      sentAt: { type: Date, default: null },
      provider: { type: String, default: "" },
    },
    // The optional note for the couple.
    message: { type: String, default: "", trim: true, maxlength: MAX_MESSAGE_LENGTH },
    // Idempotency key. Unique: a retried submission resolves to this document.
    requestId: {
      type: String,
      required: true,
      trim: true,
      maxlength: MAX_REQUEST_ID_LENGTH,
      unique: true,
    },
    // Always the server's own constant - never a client-supplied value.
    source: { type: String, default: WEDDING_RSVP_SOURCE, immutable: true },
    // When the guest actually pressed "Send", as reported by their browser.
    // `createdAt` (below) is when the write reached MongoDB.
    capturedAt: { type: Date, default: null },
  },
  {
    // createdAt / updatedAt, written by mongoose itself.
    timestamps: true,
    versionKey: false,
    collection: WEDDING_RSVP_COLLECTION,
  }
);

// The two indexes the couple's own guest list needs: newest first, and "how
// many are coming". `requestId` already carries its own unique index.
WeddingRsvpSchema.index({ createdAt: -1 });
WeddingRsvpSchema.index({ attendance: 1 });

/** Thrown for a submission the server refuses. Carries per-field reasons. */
export class WeddingRsvpValidationError extends Error {
  constructor(errors) {
    super("Invalid wedding RSVP submission.");
    this.name = "WeddingRsvpValidationError";
    this.code = "validation-error";
    this.statusCode = 400;
    this.errors = errors;
  }
}

/** Thrown when the reply is valid but could not be stored. */
export class WeddingRsvpUnavailableError extends Error {
  constructor() {
    super("Wedding RSVP storage is unavailable.");
    this.name = "WeddingRsvpUnavailableError";
    this.code = "storage-unavailable";
    this.statusCode = 503;
  }
}

/** The wedding database connection, opened once and reused. */
let weddingConnection = null;

/**
 * The connection to the wedding database.
 *
 * @returns {import("mongoose").Connection|null} null when no MongoDB URI is
 * configured, so the route can answer "unavailable" instead of throwing.
 */
export function getWeddingConnection() {
  if (weddingConnection) return weddingConnection;

  const uri = (process.env.MONOGDB_URL || process.env.MONGODB_URL || "").trim();
  if (!uri) return null;

  try {
    weddingConnection = mongoose.createConnection(uri, {
      // The whole point of this module: a database of its own.
      dbName: WEDDING_RSVP_DB_NAME,
      // A guest is waiting on the response, so fail fast rather than hang, and
      // keep the pool small - the free Atlas tier does not need a second big one.
      serverSelectionTimeoutMS: 8000,
      bufferTimeoutMS: 12000,
      maxPoolSize: 5,
      minPoolSize: 0,
    });
  } catch (error) {
    // A configuration the driver refuses outright (an impossible database name,
    // for instance) degrades to "unavailable" rather than throwing into a
    // request: the read route answers 503 and the guest sees a retry line.
    console.warn(
      `[wedding-rsvp] could not open the wedding connection: ${error?.name || "Error"}`
    );
    return null;
  }

  weddingConnection.on("connected", () => {
    console.log(
      `[wedding-rsvp] connected (database="${WEDDING_RSVP_DB_NAME}", collection="${WEDDING_RSVP_COLLECTION}")`
    );
  });

  // A wedding-database problem must never take the Twiller API down with it, so
  // it is logged (driver message only - no URI, no credentials) and swallowed;
  // the guest is told to retry by the route.
  weddingConnection.on("error", (error) => {
    console.warn(
      `[wedding-rsvp] connection error: ${error?.message || "unknown error"}`
    );
  });

  return weddingConnection;
}

/** The compiled model, or null when there is no connection to bind it to. */
let weddingRsvpModel = null;

/**
 * Indexes are built ONCE per process, awaited before the first write.
 *
 * mongoose would otherwise build them in the background on connection, which
 * leaves a short window - right after a cold start - where a repeated
 * submission could be stored twice because the unique index does not exist yet.
 * Awaiting it here closes that window deterministically.
 *
 * It is never fatal: the duplicate pre-check in `saveWeddingRsvp` already keeps
 * repeats out, so a failed build (for instance a legacy duplicate in the
 * collection) is reported and skipped rather than stopping the couple from
 * receiving replies.
 */
let indexesReady = null;

function ensureIndexes(WeddingRsvp) {
  if (!indexesReady) {
    indexesReady = Promise.resolve()
      .then(() => WeddingRsvp.createIndexes())
      .catch((error) => {
        console.warn(
          `[wedding-rsvp] index build skipped: ${error?.name || "Error"}`
        );
        return null;
      });
  }
  return indexesReady;
}

/**
 * @returns {import("mongoose").Model|null}
 */
export function getWeddingRsvpModel() {
  if (weddingRsvpModel) return weddingRsvpModel;

  const connection = getWeddingConnection();
  if (!connection) return null;

  weddingRsvpModel = connection.model("WeddingRsvp", WeddingRsvpSchema);
  return weddingRsvpModel;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and normalises the OPTIONAL guest email.
 *
 * An empty value is not an error - it is simply "the guest chose not to give
 * one", which is the default and the most common case. Only a value that was
 * actually supplied is held to the format.
 *
 * @param {unknown} value
 * @returns {{provided: boolean, value: string, valid: boolean, reason?: string}}
 */
export function normaliseWeddingEmail(value) {
  if (value === undefined || value === null) {
    return { provided: false, value: "", valid: true };
  }
  if (typeof value !== "string") {
    return { provided: true, value: "", valid: false, reason: "Must be text." };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    // Whitespace only is the same as leaving it empty, not a validation error.
    return { provided: false, value: "", valid: true };
  }

  if (trimmed.length > MAX_EMAIL_LENGTH) {
    return {
      provided: true,
      value: "",
      valid: false,
      reason: `Must be ${MAX_EMAIL_LENGTH} characters or fewer.`,
    };
  }

  // Stored lower-case: an address is case-insensitive in practice, and this
  // keeps two spellings of the same mailbox from looking like two people.
  const address = trimmed.toLowerCase();
  const [localPart, domain] = address.split("@");

  const wellFormed =
    address.split("@").length === 2 &&
    Boolean(localPart) &&
    Boolean(domain) &&
    !localPart.startsWith(".") &&
    !localPart.endsWith(".") &&
    !address.includes("..") &&
    EMAIL_PATTERN.test(address) &&
    EMAIL_TLD_PATTERN.test(address);

  if (!wellFormed) {
    return {
      provided: true,
      value: "",
      valid: false,
      reason: "Please check the email address.",
    };
  }

  return { provided: true, value: address, valid: true };
}

/**
 * Validates EVERYTHING before a byte reaches MongoDB.
 *
 * The route deliberately trusts nothing the browser sent - the frontend's own
 * validation is a convenience for the guest, not a security boundary.
 *
 * @param {unknown} body the parsed JSON request body
 * @returns {{name: string, attendance: string, partySize: number, message: string, requestId: string, capturedAt: Date|null, source: string}}
 * @throws {WeddingRsvpValidationError}
 */
export function validateWeddingRsvp(body) {
  if (!isPlainObject(body)) {
    throw new WeddingRsvpValidationError([
      { field: "body", message: "A JSON object is required." },
    ]);
  }

  /** @type {{field: string, message: string}[]} */
  const errors = [];
  const push = (field, message) => {
    errors.push({ field, message });
  };

  // --- No unexpected fields ------------------------------------------------
  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) {
    push(unknown[0], "Unexpected field.");
  }

  // --- attendance: accept | decline ---------------------------------------
  const rawAttendance = body.attendance;
  const attendance =
    typeof rawAttendance === "string" ? rawAttendance.trim().toLowerCase() : "";
  const attendanceValid = ATTENDANCE_VALUES.includes(attendance);
  if (!attendanceValid) {
    push("attendance", `Must be one of: ${ATTENDANCE_VALUES.join(", ")}.`);
  }

  // --- name ---------------------------------------------------------------
  let name = "";
  if (body.name !== undefined && typeof body.name !== "string") {
    push("name", "Must be text.");
  } else {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length > MAX_NAME_LENGTH) {
      push("name", `Must be ${MAX_NAME_LENGTH} characters or fewer.`);
    }
  }
  // A joyful reply must say who it is from. (A decline may arrive anonymously.)
  if (attendanceValid && attendance === "accept" && !name) {
    push("name", "Please tell us who is replying.");
  }

  // --- partySize: 1-12 when accepting, 0 when declining --------------------
  let partySize = 0;
  if (body.partySize !== undefined && body.partySize !== null) {
    const raw = body.partySize;
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : Number.NaN;

    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PARTY_SIZE) {
      push(
        "partySize",
        `Must be a whole number between 0 and ${MAX_PARTY_SIZE}.`
      );
    } else {
      partySize = parsed;
    }
  }
  if (
    attendanceValid &&
    attendance === "accept" &&
    partySize < 1 &&
    !errors.some((entry) => entry.field === "partySize")
  ) {
    push("partySize", "Let us know how many of you are joining.");
  }
  // Normalised, not trusted: a decline never carries a party size.
  if (attendanceValid && attendance === "decline") {
    partySize = 0;
  }

  // --- message ------------------------------------------------------------
  let message = "";
  if (body.message !== undefined && body.message !== null) {
    if (typeof body.message !== "string") {
      push("message", "Must be text.");
    } else {
      message = body.message.trim();
      if (message.length > MAX_MESSAGE_LENGTH) {
        push("message", `Must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
      }
    }
  }

  // --- email: optional, but never trusted when present --------------------
  const email = normaliseWeddingEmail(body.email);
  if (!email.valid) {
    push("email", email.reason || "Please check the email address.");
  }

  // --- requestId: the idempotency key -------------------------------------
  let requestId = "";
  if (
    body.requestId !== undefined &&
    body.requestId !== null &&
    body.requestId !== ""
  ) {
    if (
      typeof body.requestId !== "string" ||
      !REQUEST_ID_PATTERN.test(body.requestId.trim())
    ) {
      push(
        "requestId",
        "Must be 8-64 characters of letters, digits, dashes or underscores."
      );
    } else {
      requestId = body.requestId.trim();
    }
  }
  // A client that sends no key still gets one, so every stored record carries a
  // stable identity for a future retry.
  if (!requestId) {
    requestId = crypto.randomUUID();
  }

  // --- capturedAt: when the guest pressed "Send" --------------------------
  let capturedAt = null;
  if (
    body.capturedAt !== undefined &&
    body.capturedAt !== null &&
    body.capturedAt !== ""
  ) {
    if (typeof body.capturedAt !== "string") {
      push("capturedAt", "Must be an ISO date string.");
    } else {
      const parsed = new Date(body.capturedAt);
      if (Number.isNaN(parsed.getTime())) {
        push("capturedAt", "Must be a valid ISO date string.");
      } else {
        capturedAt = parsed;
      }
    }
  }

  // --- source: accepted, then overwritten by the server's own constant -----
  if (body.source !== undefined && typeof body.source !== "string") {
    push("source", "Must be text.");
  }

  if (errors.length) {
    throw new WeddingRsvpValidationError(errors);
  }

  return {
    name,
    attendance,
    partySize,
    message,
    email: email.value,
    requestId,
    capturedAt,
    source: WEDDING_RSVP_SOURCE,
  };
}

/**
 * Validates and stores one RSVP.
 *
 * Resolves ONLY once MongoDB has confirmed the write, so the route can never
 * tell a guest their reply was saved when it was not.
 *
 * @param {unknown} body the parsed JSON request body
 * @returns {Promise<{id: string, duplicate: boolean, createdAt: Date|null}>}
 * @throws {WeddingRsvpValidationError|WeddingRsvpUnavailableError}
 */
export async function saveWeddingRsvp(body) {
  const record = validateWeddingRsvp(body);

  const WeddingRsvp = getWeddingRsvpModel();
  if (!WeddingRsvp) throw new WeddingRsvpUnavailableError();

  // The unique index must exist before the first write, or a replay arriving
  // during a cold start could be stored twice.
  await ensureIndexes(WeddingRsvp);

  try {
    // Idempotency, first line of defence: a reply already on file is returned
    // rather than stored a second time. This also covers the first moments after
    // a cold start, before MongoDB has finished building the unique index.
    const alreadyStored = await WeddingRsvp.findOne({ requestId: record.requestId })
      .lean()
      .catch(() => null);

    if (alreadyStored) {
      return {
        id: String(alreadyStored._id),
        duplicate: true,
        createdAt: alreadyStored.createdAt ?? null,
        name: alreadyStored.name ?? "",
        attendance: alreadyStored.attendance ?? "",
        email: alreadyStored.email ?? "",
        // Whether the courtesy email already went out for this reply. The route
        // uses it so a retry can never post a second copy.
        confirmationSent: Boolean(alreadyStored.confirmationEmail?.sent),
      };
    }

    const created = await WeddingRsvp.create(record);
    return {
      id: String(created._id),
      duplicate: false,
      createdAt: created.createdAt ?? null,
      name: created.name ?? "",
      attendance: created.attendance ?? "",
      email: created.email ?? "",
      confirmationSent: false,
    };
  } catch (error) {
    // A repeated submission is a SUCCESS, not a failure: the guest's reply is
    // stored, it is simply the document already on file.
    if (error?.code === 11000) {
      const existing = await WeddingRsvp.findOne({ requestId: record.requestId })
        .lean()
        .catch(() => null);

      if (existing) {
        return {
          id: String(existing._id),
          duplicate: true,
          createdAt: existing.createdAt ?? null,
          name: existing.name ?? "",
          attendance: existing.attendance ?? "",
          email: existing.email ?? "",
          confirmationSent: Boolean(existing.confirmationEmail?.sent),
        };
      }
      return {
        id: "",
        duplicate: true,
        createdAt: null,
        name: record.name,
        attendance: record.attendance,
        email: record.email,
        confirmationSent: true,
      };
    }

    // Should be unreachable (validateWeddingRsvp runs first), but if a document
    // is ever refused by mongoose it is reported as a rejection rather than a
    // success - a guest must never be told a bad record was saved.
    if (error?.name === "ValidationError") {
      throw new WeddingRsvpValidationError([
        {
          field: "record",
          message: "The submission could not be stored as sent.",
        },
      ]);
    }

    // Never leak a driver or database error to the caller.
    console.warn(`[wedding-rsvp] write failed: ${error?.name || "Error"}`);
    throw new WeddingRsvpUnavailableError();
  }
}

/**
 * Records that the courtesy confirmation was sent.
 *
 * This flag is the reason a retry can never produce a second email: the route
 * reads it before it considers sending at all, and writes it only after the
 * provider accepted the message.
 *
 * Deliberately best-effort: if the flag write fails the reply is still stored
 * and still a success, and the log line below is the only trace. It can never
 * throw into the route.
 *
 * @param {string} id the stored RSVP's id
 * @param {{provider?: string}} [meta]
 * @returns {Promise<boolean>} whether the flag was written
 */
export async function markWeddingConfirmationSent(id, { provider = "" } = {}) {
  const WeddingRsvp = getWeddingRsvpModel();
  if (!WeddingRsvp || !id) return false;

  try {
    await WeddingRsvp.updateOne(
      { _id: id },
      { $set: { confirmationEmail: { sent: true, sentAt: new Date(), provider } } }
    );
    return true;
  } catch (error) {
    console.warn(
      `[wedding-rsvp] could not record the confirmation email: ${error?.name || "Error"}`
    );
    return false;
  }
}

/**
 * The PUBLIC guest wall: the display names of the guests who accepted.
 *
 * This is the only read path into the wedding RSVP collection, and it is
 * deliberately the narrowest thing that can still render the wall:
 *
 *   · `attendance: "accept"` is the filter, applied BY MONGO, so a regret can
 *     never reach the public list - not even if the caller asks for it;
 *   · the projection carries `name` and nothing else, so email, message, party
 *     size, request id, ids and timestamps are never even read from the disk,
 *     let alone returned;
 *   · the order is the order in which people replied, which is the order the
 *     couple would want to read them in.
 *
 * @param {{limit?: number}} [options]
 * @returns {Promise<string[]>} clean display names, oldest reply first
 * @throws {WeddingRsvpUnavailableError}
 */
export async function listAcceptedGuestNames({ limit = MAX_PUBLIC_GUEST_NAMES } = {}) {
  const WeddingRsvp = getWeddingRsvpModel();
  if (!WeddingRsvp) throw new WeddingRsvpUnavailableError();

  const safeLimit =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, MAX_PUBLIC_GUEST_NAMES)
      : MAX_PUBLIC_GUEST_NAMES;

  let docs;
  try {
    docs = await WeddingRsvp.find(
      // Server-side filter: only acceptances, and only ones that carry a name.
      { attendance: "accept", name: { $nin: ["", null] } },
      // Server-side projection: `name`, and nothing else. Never `_id`.
      { name: 1, _id: 0 }
    )
      .sort({ createdAt: 1 })
      .limit(safeLimit)
      .lean();
  } catch (error) {
    // A database problem is reported as "unavailable" - the driver's own
    // message is never forwarded to a public caller.
    console.warn(`[wedding-guests] read failed: ${error?.name || "Error"}`);
    throw new WeddingRsvpUnavailableError();
  }

  return docs
    .map((doc) => String(doc?.name ?? "").trim().slice(0, MAX_NAME_LENGTH))
    .filter(Boolean);
}

/**
 * The largest reply list the administrator's viewer will ever be handed. A
 * wedding does not have more than this many answers; the cap simply bounds one
 * response's size.
 */
export const MAX_ADMIN_REPLIES = 2000;

/**
 * The ADMINISTRATOR's view: every reply, with the four fields the viewer shows.
 *
 * This is the second read path into the collection, and it exists only behind
 * the admin token check in `index.js`. It is deliberately still narrow:
 *
 *   · both acceptances and regrets are returned, because the couple's own viewer
 *     is meant to show every answer they received;
 *   · the projection is server-side and fixed - name, party size, message and the
 *     write time. An email, a request id, a confirmation-email record, an object
 *     id or a source marker is never read, let alone returned;
 *   · newest first, which is the order the couple reads them in;
 *   · fields are trimmed and length-capped exactly like the public wall, so a
 *     stored value can never be longer than what the schema allowed.
 *
 * @param {{limit?: number}} [options]
 * @returns {Promise<Array<{name: string, partySize: number, message: string, rsvpDate: string|null}>>}
 * @throws {WeddingRsvpUnavailableError}
 */
export async function listWeddingReplies({ limit = MAX_ADMIN_REPLIES } = {}) {
  const WeddingRsvp = getWeddingRsvpModel();
  if (!WeddingRsvp) throw new WeddingRsvpUnavailableError();

  const safeLimit =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, MAX_ADMIN_REPLIES)
      : MAX_ADMIN_REPLIES;

  let docs;
  try {
    docs = await WeddingRsvp.find(
      {},
      // `createdAt` is when the write reached MongoDB; `capturedAt` is only a
      // fallback for a record that somehow carries no write time.
      { name: 1, partySize: 1, message: 1, createdAt: 1, capturedAt: 1, _id: 0 }
    )
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean();
  } catch (error) {
    console.warn(`[wedding-replies] read failed: ${error?.name || "Error"}`);
    throw new WeddingRsvpUnavailableError();
  }

  return docs.map((doc) => {
    const when =
      doc?.createdAt instanceof Date
        ? doc.createdAt
        : doc?.capturedAt instanceof Date
          ? doc.capturedAt
          : null;

    return {
      name: String(doc?.name ?? "").trim().slice(0, MAX_NAME_LENGTH),
      partySize: Number.isInteger(doc?.partySize) ? doc.partySize : 0,
      message: String(doc?.message ?? "").trim().slice(0, MAX_MESSAGE_LENGTH),
      rsvpDate: when ? when.toISOString() : null,
    };
  });
}

export default {
  WEDDING_RSVP_DB_NAME,
  WEDDING_RSVP_COLLECTION,
  WEDDING_RSVP_SOURCE,
  ATTENDANCE_VALUES,
  MAX_NAME_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PARTY_SIZE,
  MAX_REQUEST_ID_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PUBLIC_GUEST_NAMES,
  MAX_ADMIN_REPLIES,
  getWeddingConnection,
  getWeddingRsvpModel,
  normaliseWeddingEmail,
  validateWeddingRsvp,
  saveWeddingRsvp,
  listAcceptedGuestNames,
  listWeddingReplies,
  markWeddingConfirmationSent,
  WeddingRsvpValidationError,
  WeddingRsvpUnavailableError,
};

