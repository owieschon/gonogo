"use strict";

const MIN_AGE = 13;
const MIN_USERNAME_LENGTH = 3;

/**
 * Validate a signup payload.
 * @param {{email?: string, age?: number, username?: string}} input
 * @returns {string[]} human-readable errors; empty means valid
 */
function validateSignup(input) {
  const errors = [];

  if (!input.email || !input.email.includes("@")) {
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

module.exports = { validateSignup, MIN_AGE, MIN_USERNAME_LENGTH };
