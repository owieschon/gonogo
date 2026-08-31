"use strict";

const MIN_AGE = 13;

// Opt-in stricter email checking. Off by default so existing callers keep
// their current behaviour; enable per-call with { strictEmail: true }.
const STRICT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_OPTIONS = { strictEmail: false };
const MIN_USERNAME_LENGTH = 3;

/**
 * Validate a signup payload.
 * @param {{email?: string, age?: number, username?: string}} input
 * @param {{strictEmail?: boolean}} [options]
 * @returns {string[]} human-readable errors; empty means valid
 */
function validateSignup(input, options) {
  const errors = [];
  const opts = Object.assign({}, DEFAULT_OPTIONS, options);

  const emailOk = opts.strictEmail
    ? STRICT_EMAIL_PATTERN.test(input.email || "")
    : Boolean(input.email && input.email.includes("@"));
  if (!emailOk) {
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

module.exports = { validateSignup, MIN_AGE, MIN_USERNAME_LENGTH, DEFAULT_OPTIONS };
