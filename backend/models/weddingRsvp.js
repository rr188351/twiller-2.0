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
export const MAX_MESSAGE_LENGTH = 400;
export const MAX_PARTY_SIZE = 5;
export const MAX_REQUEST_ID_LENGTH = 64;

/**
 * The exact body keys this endpoint accepts. Anything else is a rejection: a
 * malformed client (or a script probing the API) should not be able to write
 * arbitrary fields into the guest list.
 */
const ALLOWED_FIELDS = new Set([
  "attendance",
  "name",
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
    // How many are joining, 1-5 for an acceptance and 0 for a decline.
    partySize: { type: Number, default: 0, min: 0, max: MAX_PARTY_SIZE },
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

  // --- partySize: 1-5 when accepting, 0 when declining ---------------------
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
      };
    }

    const created = await WeddingRsvp.create(record);
    return {
      id: String(created._id),
      duplicate: false,
      createdAt: created.createdAt ?? null,
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
        };
      }
      return { id: "", duplicate: true, createdAt: null };
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

export default {
  WEDDING_RSVP_DB_NAME,
  WEDDING_RSVP_COLLECTION,
  WEDDING_RSVP_SOURCE,
  ATTENDANCE_VALUES,
  MAX_NAME_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PARTY_SIZE,
  MAX_REQUEST_ID_LENGTH,
  getWeddingConnection,
  getWeddingRsvpModel,
  validateWeddingRsvp,
  saveWeddingRsvp,
  WeddingRsvpValidationError,
  WeddingRsvpUnavailableError,
};

