"use strict";

const MIN_AGE = 13;

function checkAge(age) {
  if (typeof age !== "number" || age < MIN_AGE) {
    return `age: must be ${MIN_AGE} or older`;
  }
  return null;
}

module.exports = { checkAge, MIN_AGE };
