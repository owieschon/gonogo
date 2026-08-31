"use strict";

const assert = require("node:assert");
const { validateSignup } = require("./src/validate.js");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok   - " + name);
  } catch (err) {
    failures++;
    console.log("FAIL - " + name + ": " + err.message);
  }
}

check("accepts a well-formed signup", () => {
  assert.deepStrictEqual(validateSignup({ email: "ada@example.com", age: 30, username: "ada" }), []);
});

check("rejects an under-age signup", () => {
  const errors = validateSignup({ email: "kid@example.com", age: 9, username: "kid" });
  assert.ok(errors.some((e) => e.startsWith("age:")));
});

check("rejects a short username", () => {
  const errors = validateSignup({ email: "ada@example.com", age: 30, username: "ad" });
  assert.ok(errors.some((e) => e.startsWith("username:")));
});

console.log(failures === 0 ? "\nall tests passed" : "\n" + failures + " test(s) failed");
process.exit(failures === 0 ? 0 : 1);
