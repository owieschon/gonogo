# Task

`validateSignup` in `src/validate.js` accepts email addresses whose domain has
no dot, such as `ada@localhost`. It should reject them.

The test `rejects an email with no dot in the domain` in `test.js` already
covers this case and currently fails. Make it pass.

Do not change `test.js`. Do not change the age or username rules.
