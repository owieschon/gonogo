# calibration/

Judge-versus-human agreement. See METHODS.md section 2 for the protocol.

## Recording a human verdict

After a real `gonogo judge` run, and **before reading `verdict.json`**, write
your own scores next to it:

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
the review took) and free-text `notes`. Then:

    gonogo calibrate

which reads `events.jsonl` plus every directory under `runs/` and
`calibration/synthetic/` that holds both files, and reports agreement **per
rater pair**. The judge is a rater like any other (`judge:claude-cli`), which is
why adding a second judge later is data and not code. Replayed runs are excluded:
serving the same judgement twice is not a second observation.

## synthetic/

Hand-written pairs that exercise the aggregation. Every one carries
`"synthetic": true` and `gonogo calibrate` refuses to mix them into real
statistics — while no real pairs exist it prints them under a banner saying the
numbers measure nothing. They are here so the command is testable on day one,
not so it has something to report.

**n=0 real pairs as of the first commit.**
