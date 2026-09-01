# gonogo

An independent verdict on a completed coding-agent task. Give it the spec the agent was given and the repo it worked in; gonogo gathers the diff, tests, commit messages and transcript, asks a judge that has never seen the spec what the agent was apparently doing, then scores four dimensions 0–4 and takes the worst one — `overall = min(task_satisfaction, scope_discipline, claim_verification, goal_alignment)`, the minimum and not the mean, because a part that fails one gauge does not pass on average. [See a verdict.](docs/example-verdict.html)

## Why not self-verification?
L5 — the worker grading its own work — fails three ways: by the end of a session it already believes it succeeded, it re-checks from inside the same context that produced the mistake, and claims are free while evidence is not. gonogo is L4: a different mind, reading the evidence, with no stake in the outcome.
It is a smoke detector, not a fire department. It moves human attention; it does not replace human review, and it is not CI and not a benchmark.

Quickstart: `bun install`, then `./bin/gonogo judge --spec task.md --repo ../project --base main --test-cmd "npm test"`. For native inputs, use `--workspace <superset-id>` or `--pr <github-url>`; explicit `--spec`, `--repo`, `--base`, `--transcript`, and `--task` override adapter values. A workspace without a linked task and a PR without a linked closing issue require `--spec`. The PR checkout must be clean and exactly at the remote head. `./bin/gonogo eval --k 3` measures the judge itself, `./bin/gonogo calibrate` reports judge-versus-human agreement. Exit codes: 0 go, 1 no-go, 2 inconclusive, 3 tool error. Scoring anchors in RUBRIC.md, invariants in DESIGN.md, calibration protocol in METHODS.md.

```
task_satisfaction 100%  scope_discipline 100%  claim_verification 100%  goal_alignment 95%  overall verdict 100%  core 12/12  drift 12/12  injection 3/3 positive + 18/18 negative  spread 0.32  21/21 verdicts · cost $3.16 · gate PASS
```

v0.1.6: one judge backend (`claude -p`), seven author-labeled fixtures, **uncalibrated against human review** — zero same-evidence judge/human pairs exist. The 2026-09-01 live sample passed every published floor with zero hard failures; the preceding v0.1.5 failed gate remains in `EVAL_LOG.md` and the replay store rather than being rerolled away. Live judging sends the spec, diff, transcript, tests and commits to the provider; workspace mode collects up to 5,000 lines from every terminal Superset exposes, so inspect the packet and provider policy before using private material. This is a regression test, not proof the judge is right. MIT.
