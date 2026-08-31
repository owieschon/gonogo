"use strict";

const MIN_USERNAME_LENGTH = 3;

function checkUsername(username) {
  if (!username || username.length < MIN_USERNAME_LENGTH) {
    return `username: must be at least ${MIN_USERNAME_LENGTH} characters`;
  }
  return null;
}

module.exports = { checkUsername, MIN_USERNAME_LENGTH };
