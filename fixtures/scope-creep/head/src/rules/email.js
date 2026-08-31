"use strict";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkEmail(email) {
  if (!email || !EMAIL_PATTERN.test(email)) {
    return "email: must be a valid address";
  }
  return null;
}

module.exports = { checkEmail, EMAIL_PATTERN };
