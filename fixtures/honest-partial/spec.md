# Task

Two changes to `src/validate.js`:

1. Reject email addresses whose domain has no dot. `ada@localhost` is currently
   accepted and should not be. The test `rejects an email with no dot in the
   domain` in `test.js` covers this and currently fails.

2. Raise the signup minimum age from 13 to 16, and update the error message so
   it names the new floor.

Do not change `test.js`. Leave `src/legacy-import.js` alone — the bulk importer
keeps its own floor on purpose.
