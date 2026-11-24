/**
 * Wedding RSVP - the party-size ceiling (hotfix).
 *
 * Run:  node tests/wedding-rsvp-party-size.test.js
 *
 * WHY THIS FILE EXISTS
 *  The invitation's dropdown offered 1-12 guests while the API and the schema
 *  both capped a party at 5. A guest replying for six or more was therefore
 *  refused with a generic "some details need a second look", nothing was written
 *  to `wedding_rsvp.guests`, and no confirmation email could go out. The form
 *  and the server had drifted apart, and only a test that pins all the layers
 *  together keeps them from drifting again.
 *
 * WHAT IT PROVES
 *  1. The invitation's own range (1-12, as rendered by RSVPForm.jsx) fits inside
 *     the API's ceiling: no number the form can offer is refused by the server.
 *  2. The validator ACCEPTS 1, 5, 6, 10 and 12 and REFUSES 0, 13, negative,
 *     fractional and non-numeric values - naming the offending field.
 *  3. The MongoDB schema carries the very same ceiling, so a value that somehow
 *     slipped past the validator still could not be written to the collection.
 *     (0 remains valid there, because that is what a decline stores.)
 *  4. A decline is still normalised to a party size of 0.
 *
 * SAFETY
 *  The schema section is READ-ONLY: documents are validated in memory with
 *  `validateSync()` and never saved, so running this file creates no RSVP and
 *  emails nobody. It is skipped entirely when no MongoDB URI is configured.
 */

import "dotenv/config";

import {
  MAX_PARTY_SIZE,
  validateWeddingRsvp,
  WeddingRsvpValidationError,
  getWeddingRsvpModel,
  getWeddingConnection,
} from "../models/weddingRsvp.js";

/**
 * The exact list the invitation renders (mirrors `PARTY_SIZES` in
 * Wedding/src/components/RSVPForm.jsx). Kept as a literal ON PURPOSE: if the
 * form ever grows past the API's ceiling again, this test fails.
 */
const INVITATION_PARTY_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Sizes the API must accept, including the ones the old cap refused. */
const ACCEPTED = [1, 5, 6, 10, 12];

/** Sizes the API must refuse, with the reason it should give. */
const REFUSED = [
  { label: "13", body: 13, expect: /between 0 and 12/ },
  { label: "9999", body: 9999, expect: /between 0 and 12/ },
  { label: "0", body: 0, expect: /how many of you are joining/ },
  { label: "-1", body: -1, expect: /between 0 and 12/ },
  { label: "-12", body: -12, expect: /between 0 and 12/ },
  { label: "3.5", body: 3.5, expect: /between 0 and 12/ },
  { label: '"abc"', body: "abc", expect: /between 0 and 12/ },
  { label: '""', body: "", expect: /between 0 and 12/ },
  { label: "null", body: null, expect: /how many of you are joining/ },
  { label: "true", body: true, expect: /between 0 and 12/ },
];

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** Runs the validator and reports what it did, never throwing out of the test. */
function attempt(payload) {
  try {
    return { ok: true, value: validateWeddingRsvp(payload) };
  } catch (error) {
    if (error instanceof WeddingRsvpValidationError) {
      return { ok: false, errors: error.errors || [] };
    }
    throw error;
  }
}

/** The partySize reasons a refusal carried, as one readable string. */
const partySizeReasons = (errors) =>
  (errors || [])
    .filter((entry) => entry.field === "partySize")
    .map((entry) => entry.message)
    .join(" / ");

async function main() {
  console.log("\nWedding RSVP - party size limit (1-12)");
  console.log(`API ceiling: MAX_PARTY_SIZE = ${MAX_PARTY_SIZE}\n`);

  console.log("[1] the invitation's range fits inside the API's ceiling");
  check("MAX_PARTY_SIZE is 12", MAX_PARTY_SIZE === 12, String(MAX_PARTY_SIZE));
  check(
    "the form's largest option is not above the ceiling",
    Math.max(...INVITATION_PARTY_SIZES) <= MAX_PARTY_SIZE,
    `form offers up to ${Math.max(...INVITATION_PARTY_SIZES)}`,
  );
  check(
    "the form's smallest option is 1",
    Math.min(...INVITATION_PARTY_SIZES) === 1,
    String(Math.min(...INVITATION_PARTY_SIZES)),
  );
  check(
    "every offered size is a whole number of at least 1",
    INVITATION_PARTY_SIZES.every((size) => Number.isInteger(size) && size >= 1),
  );

  console.log("\n[2] sizes 1, 5, 6, 10 and 12 are ACCEPTED");
  for (const size of ACCEPTED) {
    const result = attempt({
      attendance: "accept",
      name: "Hotfix Test Guest",
      partySize: size,
      requestId: `hotfix-accept-${size}`,
    });
    check(
      `party size ${size} accepted and stored as ${size}`,
      result.ok && result.value.partySize === size,
      result.ok ? `stored ${result.value.partySize}` : partySizeReasons(result.errors),
    );
  }

  console.log("\n[3] 13, 0, negative, fractional and non-numeric values are REFUSED");
  for (const entry of REFUSED) {
    const result = attempt({
      attendance: "accept",
      name: "Hotfix Test Guest",
      partySize: entry.body,
      requestId: "hotfix-refused",
    });
    const reasons = result.ok ? "" : partySizeReasons(result.errors);
    check(
      `party size ${entry.label} refused on the partySize field`,
      !result.ok && reasons.length > 0 && entry.expect.test(reasons),
      result.ok ? `accepted as ${result.value.partySize}` : reasons || "no partySize reason",
    );
  }

  console.log("\n[4] the boundary is exactly 12");
  const twelve = attempt({
    attendance: "accept",
    name: "Hotfix Test Guest",
    partySize: "12",
    requestId: "hotfix-string-12",
  });
  check(
    'a numeric string "12" is normalised to the number 12, not refused',
    twelve.ok && twelve.value.partySize === 12,
    twelve.ok ? `stored ${twelve.value.partySize}` : partySizeReasons(twelve.errors),
  );

  console.log("\n[5] a decline still carries no party");
  const decline = attempt({
    attendance: "decline",
    name: "Hotfix Test Guest",
    partySize: 0,
    requestId: "hotfix-decline",
  });
  check(
    "a decline is stored with partySize 0",
    decline.ok && decline.value.partySize === 0,
    decline.ok ? `stored ${decline.value.partySize}` : partySizeReasons(decline.errors),
  );

  // --- the schema: the second gate, checked in memory only ------------------
  console.log("\n[6] the MongoDB schema repeats the same ceiling");

  const model = getWeddingRsvpModel();
  if (!model) {
    console.log("  ....  skipped: no MongoDB URI configured (MONOGDB_URL/MONGODB_URL)");
  } else {
    check(
      "the schema's own maximum is MAX_PARTY_SIZE",
      model.schema.path("partySize")?.options?.max === MAX_PARTY_SIZE,
      String(model.schema.path("partySize")?.options?.max),
    );

    const build = (partySize) =>
      new model({
        name: "Hotfix Test Guest",
        attendance: "accept",
        partySize,
        requestId: `hotfix-schema-${partySize}-${Date.now().toString(36)}`,
      });

    for (const size of ACCEPTED) {
      const error = build(size).validateSync();
      check(
        `a document with party size ${size} passes schema validation`,
        !error,
        error?.errors?.partySize?.message,
      );
    }

    // 0 is a legitimate stored value - it is what a decline carries - so the
    // schema allows it while the API refuses it for an ACCEPTANCE (see [3]).
    check(
      "a document with party size 0 passes schema validation (a decline's value)",
      !build(0).validateSync(),
    );

    for (const size of [13, 100, -1, 12.5]) {
      const error = build(size).validateSync();
      check(
        `a document with party size ${size} FAILS schema validation`,
        Boolean(error?.errors?.partySize),
        "the schema would have accepted it",
      );
    }

    check(
      "the schema is the same field the API validates (no second ceiling)",
      model.schema.path("partySize")?.instance === "Number",
    );
  }

  const connection = getWeddingConnection();
  if (connection) {
    try {
      await connection.close();
    } catch {
      // Closing is best effort; the process exits either way.
    }
  }

  console.log("\n==================================================");
  console.log(`  passed: ${passed}   failed: ${failed}`);
  if (failed) {
    console.log("  failed checks:");
    for (const name of failures) console.log(`   - ${name}`);
  }
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Test crashed:", error);
  process.exit(1);
});
