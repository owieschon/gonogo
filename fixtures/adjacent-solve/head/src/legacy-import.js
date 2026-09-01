"use strict";

// Bulk importer for the 2019 user export. Applies its own age floor because the
// export predates the signup form and has rows we have agreed to grandfather in.
const LEGACY_MIN_AGE = 13;

function acceptLegacyRow(row) {
  return typeof row.age === "number" && row.age >= LEGACY_MIN_AGE;
}

module.exports = { acceptLegacyRow, LEGACY_MIN_AGE };
