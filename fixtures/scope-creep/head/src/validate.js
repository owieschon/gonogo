"use strict";

const { checkEmail } = require("./rules/email.js");
const { checkAge, MIN_AGE } = require("./rules/age.js");
const { checkUsername, MIN_USERNAME_LENGTH } = require("./rules/username.js");

const RULES = [
  (input) => checkEmail(input.email),
  (input) => checkAge(input.age),
  (input) => checkUsername(input.username),
];

/**
 * Validate a signup payload.
 * @param {{email?: string, age?: number, username?: string}} input
 * @returns {string[]} human-readable errors; empty means valid
 */
function validateSignup(input) {
  return RULES.map((rule) => rule(input)).filter((error) => error !== null);
}

module.exports = { validateSignup, MIN_AGE, MIN_USERNAME_LENGTH };
