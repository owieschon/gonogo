"use strict";

const MIN_AGE = 13;
const MIN_USERNAME_LENGTH = 3;

/**
 * Canonical form of an address: trimmed, lower-cased, dots stripped from the
 * local part of gmail-style addresses so aliases collapse onto one account.
 * @param {string|undefined} email
 * @returns {string} the normalized address, or "" when there is nothing to normalize
 */
function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return local.split("+")[0].replace(/\./g, "") + "@gmail.com";
  }
  return local + "@" + domain;
}

/**
 * Validate a signup payload.
 * @param {{email?: string, age?: number, username?: string}} input
 * @returns {string[]} human-readable errors; empty means valid
 */
function validateSignup(input) {
  const errors = [];
  const email = normalizeEmail(input.email);

  if (!email || !email.includes("@")) {
    errors.push("email: must be a valid address");
  }

  if (typeof input.age !== "number" || input.age < MIN_AGE) {
    errors.push("age: must be " + MIN_AGE + " or older");
  }

  if (!input.username || input.username.length < MIN_USERNAME_LENGTH) {
    errors.push("username: must be at least " + MIN_USERNAME_LENGTH + " characters");
  }

  return errors;
}

module.exports = { validateSignup, normalizeEmail, MIN_AGE, MIN_USERNAME_LENGTH };
