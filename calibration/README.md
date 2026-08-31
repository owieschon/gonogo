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
the review took) and free-text `notes`. Then, from any directory:

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

## synthetic/

Hand-written pairs that exercise the aggregation. Every one carries
`"synthetic": true` and `gonogo calibrate` refuses to mix them into real
statistics — while no real pairs exist it prints them under a banner saying the
numbers measure nothing. They are here so the command is testable on day one,
not so it has something to report.

**n=0 real pairs as of the first commit.**

## Ratings without a matching judge run

A directory holding only `human.json` is still read. `gonogo calibrate` finds
rating directories recursively under `runs/` and `calibration/`, and prints any
human rating that has no counterpart under "human ratings with nothing to
compare against", with its notes.

Such a rating is review effort, not agreement, and it is never mixed into the
statistics. To turn one into a calibration pair, judge the same evidence and
record it under the same `run_id`, so both raters scored the same thing.

`calibration/manual-pr-1/` is an example: an independent retrospective review
of PR #1's final tree. It was written before the agent's closing self-review but
after the automated HOLD had been disclosed, so it is neither blind nor a
same-evidence pair and is not calibration data.
