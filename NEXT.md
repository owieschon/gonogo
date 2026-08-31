# NEXT

Titles only. Nothing here is started, and nothing here should be started before
the judge in `v0` has real calibration data behind it.

- Panel mode: run the same evidence past Claude, Codex and Qwen — the agreement
  maths is already per rater pair, so this is two backends and a flag
- Naive baseline comparison: one-prompt judge versus the structured pipeline,
  scored on the same eval set
- N-run compare and rank mode: several agents on one spec, ordered
- Superset workspace adapter
- Superset Pages publishing for verdict HTML
- MCP server wrapper
- Spec-quality versus judge-confidence correlation, once real run data exists
- Verdict-versus-outcome analysis: do no-go verdicts predict PRs that get
  reworked, once enough `outcome` events exist
- Judge-awareness measurement: compare runs with `disclosure: mentioned` against
  `disclosure: none` on the same tasks
