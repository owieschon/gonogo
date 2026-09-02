# SPEC — calibration provenance

The brief this session was assigned, frozen into the repository before review so
that a reviewer or a judge can score the work against the request instead of
abstaining for want of one. The review of PR #2 named the missing session spec
as its reason for four abstentions and asked for exactly this.

## Objective

Make gonogo incapable of presenting AI-written ratings as human calibration,
while preserving the current scoring instrument. This is an honesty correction
to an existing capability, not a new research project.

## Requirements

1. Inspect the current main, open pull requests, remote branches, calibration
   files, event schema, `calibrate` behaviour, README, METHODS and tests before
   editing. Reuse existing work rather than duplicating it.
2. Add an explicit typed rater kind at every boundary where a manual rating
   enters or is recorded. Human and LLM ratings stay separate in storage,
   validation, aggregation, display and compatibility behaviour.
3. `calibrate` must never pool or label an LLM rater as human on an id
   convention. The current human-pair count is reported as the evidence says,
   including zero.
4. Relabel the two existing AI-authored manual reviews without erasing their
   provenance, and add an executable rule preventing them from being re-keyed
   into human calibration.
5. Define backward compatibility deliberately. A legacy record without a rater
   kind must not silently become human; choose a safe explicit classification
   or rejection, and test it.
6. Do not alter rubric prompts, dimension definitions, scoring, verdict
   thresholds, model choice, or retained failed eval receipts. No reruns to
   seek a better result.
7. Keep one review decision: calibration provenance. No event-log privacy
   guards, adapters, Pages, skill work or unrelated documentation cleanup on
   this branch.
8. Add focused regression tests, and run the typecheck, the full deterministic
   test suite, the replay evaluation gate the repository requires, and a
   secret and privacy scan. Validate fixture and emitted schemas.
9. Use plain factual prose. Claim no human calibration before a blind human
   rating exists. State AI review and human calibration separately.
10. Commit and push the branch `hardening/calibration-provenance` to
    `owieschon/gonogo` and open a review pull request there only. Do not merge
    and do not publish elsewhere.
11. Continue autonomously through evidence-supported corrections. Stop only for
    credentials, paid usage, destructive action, external communication, or a
    product decision the existing method does not determine.

## Done

The false-human path is closed across schema, CLI and documentation; legacy
behaviour is safe; AI provenance is retained; the current n is truthful; the
scoring instrument is unchanged; the relevant checks pass; the diff is minimal;
origin is synchronized; and a user-owned review pull request is ready.
