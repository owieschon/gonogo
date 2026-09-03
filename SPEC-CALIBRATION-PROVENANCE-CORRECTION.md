# SPEC — calibration provenance, review correction

The brief for the correction session on `hardening/calibration-provenance`,
frozen before the self-judge so the verdict scores the work against the request.
It supplements `SPEC-CALIBRATION-PROVENANCE.md`, which specified the original
branch; this document specifies only the corrections applied on top of commit
`141d232`, and the self-judge for it is run with that commit as the base.

## Objective

Close two false-provenance paths that survived the first pass of the branch,
correct the documentation that described them wrongly, and pin both with
regressions. The scoring instrument is untouched.

## Findings this correction answers

Both were reproduced against the branch head before any edit.

1. `classifyPair` returned `judge-vs-human` whenever exactly one side of a pair
   declared `rater_kind: "human"`, without requiring the other side to be a
   gonogo judge run. A human rating recorded alongside a standalone LLM review
   of the same run was therefore printed as `judge-vs-human calibration pairs: 1`
   and tabled under `comparison: judge vs human (calibration)`. That is the
   false human-calibration claim the branch exists to prevent, reached by a
   different route.
2. `classifyPair` tested `synthetic` before `undeclared`, and `runCalibrate`
   split synthetic pairs off before applying the undeclared exclusion. A pair
   holding one rating whose author was never recorded was therefore scored in
   the synthetic table whenever the other side was synthetic, instead of being
   excluded and listed with its reason.
3. `AGENTS.md` stated the v1-v4 rater-event migration rule without its
   exception. `src/events.ts` migrates a legacy event that already declared
   `synthetic: true` to `rater_kind: "synthetic"`, not to `undeclared`.

## Requirements

1. A human rating paired with an LLM review that is not a judge run must carry
   a distinct pair class and a label that does not read as calibration, and must
   not be counted in the `judge-vs-human calibration pairs` headline.
2. Any pair holding an undeclared rating must be excluded from every figure and
   listed with its reason, including when the other rating is synthetic.
3. `AGENTS.md` must state the `synthetic: true` exception to the v1-v4
   migration rule, matching `src/events.ts`.
4. Add focused regressions for requirements 1 and 2, and pin the real-human
   headline guard and every currently reachable report branch that reads this
   classification.
5. Correct inaccurate wording in the pull request and in the documentation this
   classification governs. No unrelated cleanup.
6. Freeze these acceptance criteria before the self-judge runs.

## Out of scope

The rubric, prompts, dimension definitions, scores, verdict thresholds, judge
model and unrelated event semantics are unchanged. Committed fixture history and
every retained failed receipt are preserved. `events.jsonl` is appended to only.
No merge, no publication outside `owieschon/gonogo`, no Anthropic API billing.

## Done

Both false-provenance paths are closed in `src/calibrate.ts`; `AGENTS.md`,
`METHODS.md`, `DECISIONS.md` and `calibration/README.md` describe the behaviour
the code now has; regressions fail without the fixes; the typecheck, the full
deterministic test suite and the pinned `--replay --k 3` quality gate pass; the
diff touches nothing outside this decision; the branch is pushed; and pull
request #4 states the correction with its receipts.
