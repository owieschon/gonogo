# calibration/

Judge-versus-human agreement. See METHODS.md section 2 for the protocol.

## Recording a human verdict

After a real `gonogo judge` run, and **before reading `verdict.json`**, write
your own scores next to it in the target repository:

    runs/<timestamp>/verdict.json   # written by gonogo
    runs/<timestamp>/human.json     # written by you

`human.json` uses the same four dimensions and the same 0–4 anchors as
RUBRIC.md:

```json
{
  "schema": "gonogo/human@1",
  "run_id": "2026-09-02T10-14-33-000Z",
  "reviewer": "your-handle",
  "rater_kind": "human",
  "recorded_at": "2026-09-02T10:41:00Z",
  "dimensions": {
    "task_satisfaction": 2,
    "scope_discipline": 4,
    "claim_verification": 1,
    "goal_alignment": 3
  },
  "spec_clarity": 3,
  "notes": "free text; what you saw that the judge may not have"
}
```

Any dimension may be `"abstain"`. You may also record `review_minutes` (how long
the review took) and free-text `notes`.

Then, from any directory:

    gonogo calibrate --repo /path/to/the/target-repo

which reads `events.jsonl` plus rating directories recursively under that
repository's `runs/` and `calibration/`, alongside gonogo's bundled
`calibration/synthetic/` examples, and reports agreement **per rater pair and
instrument version**. A standalone `human.json` is listed as review evidence
but never enters agreement statistics until a same-evidence verdict is paired.
Instrument identity includes the gonogo version, backend, model and prompt
hashes, so pipeline or prompt versions are never pooled. The `run_id` in
`human.json` must match the verdict artifact (or the legacy directory name), or
the command fails instead of pairing unrelated work. The judge is a rater like
any other (`judge:claude-cli`), which is why adding a second judge later is data
and not code. Any run with a cached pass is excluded: serving the same judgement
twice is not a second observation.

## rater_kind

`rater_kind` says who wrote the scores: `human` if a person read the evidence
and wrote them, `llm` if a language model did, `synthetic` for hand-written
demo data that scores no real run. It is declared, never inferred — a reviewer
handle says nothing about whether a person or a model is behind it, and reading
an AI review as human calibration would misstate the one number this project
treats as trust currency.

Only a `human` rating paired with a gonogo judge run on the same evidence
counts as judge-versus-human calibration. A human rating paired with an LLM
review is two reviews of one run, reported under its own name. `gonogo
calibrate` reports that count, reports every other kind of pair under its own
name, and never pools the two.

A rating written before the field existed is `undeclared`, unless it already
declared `synthetic: true`, which migrates to `synthetic`. Undeclared is the
absence of a classification, not a person: undeclared ratings are listed and
excluded from every figure rather than being read as human, and a pair holding
one is excluded whatever the other side is. Re-record such a rating with an
explicit `rater_kind` to make it countable.

## synthetic/

Hand-written pairs that exercise the aggregation. Every one carries
`"synthetic": true` and `"rater_kind": "synthetic"`, and `gonogo calibrate`
refuses to mix them into real statistics — while no real pairs exist it prints
them under a banner saying the numbers measure nothing. They are here so the command is testable on day one,
not so it has something to report.

**n=0 judge-versus-human pairs. No human has recorded a rating against a real
gonogo run.**

## Ratings without a matching judge run

A directory holding only `human.json` is still read. `gonogo calibrate` finds
rating directories recursively under `runs/` and `calibration/`, and prints any
rating that has no counterpart with its notes, under a heading naming the kind
of rater that wrote it — human ratings and LLM-written ratings are listed
separately and never under one another's heading.

Such a rating is review effort, not agreement, and it is never mixed into the
statistics. To turn one into a calibration pair, judge the same evidence and
record it under the same `run_id`, so both raters scored the same thing.

`calibration/manual-pr-1/` and `calibration/manual-pr-2/` are the two examples,
and both were **written by a language model**, not by a person. They carry
`"rater_kind": "llm"` with their original reviewer handle, timestamp and notes
intact.

- `manual-pr-1/`: an independent retrospective review of PR #1's final tree by
  `codex`, written before the agent's closing self-review but after the
  automated HOLD had been disclosed. Neither blind nor a same-evidence pair.
- `manual-pr-2/`: an independent pre-disclosure review of PR #2 by
  `claude-code-uhg22r`, recorded before reading the verdict, with four of five
  dimensions abstained for a missing spec.

Both are AI review effort. Neither is human calibration, and neither may be
re-keyed into it: `src/rater-kind.test.ts` pins both files to `llm` and fails if
either is relabelled.
