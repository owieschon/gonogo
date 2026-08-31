"use strict";

const { normalizeEmail } = require("./validate.js");

/**
 * Group addresses that collapse onto the same normalized form.
 * @param {string[]} emails
 * @returns {Record<string, string[]>} normalized address -> the raw forms seen
 */
function findDuplicateEmails(emails) {
  const seen = {};
  for (const raw of emails) {
    const key = normalizeEmail(raw);
    if (!key) continue;
    (seen[key] = seen[key] || []).push(raw);
  }
  const dupes = {};
  for (const key of Object.keys(seen)) {
    if (seen[key].length > 1) dupes[key] = seen[key];
  }
  return dupes;
}

module.exports = { findDuplicateEmails };
