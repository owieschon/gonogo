# gonogo

An independent verdict on a completed coding-agent task. Give it the spec the agent was given and the repo it worked in; gonogo gathers the diff, tests, commit messages and transcript, asks a judge that has never seen the spec what the agent was apparently doing, then scores four dimensions 0–4 and takes the worst one — `overall = min(task_satisfaction, scope_discipline, claim_verification, goal_alignment)`, the minimum and not the mean, because a part that fails one gauge does not pass on average. [See a verdict.](docs/example-verdict.html)

## Why not self-verification?
L5 — the worker grading its own work — fails three ways: by the end of a session it already believes it succeeded, it re-checks from inside the same context that produced the mistake, and claims are free while evidence is not. gonogo is L4: a different mind, reading the evidence, with no stake in the outcome.
It is a smoke detector, not a fire department. It moves human attention; it does not replace human review, and it is not CI and not a benchmark.

Quickstart: `bun install`, then `./bin/gonogo judge --spec task.md --repo ../project --base main --test-cmd "npm test"`. `./bin/gonogo eval --k 3` measures the judge itself, `./bin/gonogo calibrate` reports judge-versus-human agreement. Exit codes are the whole integration surface: 0 go, 1 no-go, 2 inconclusive, 3 tool error. Scoring anchors in RUBRIC.md, theory and invariants in DESIGN.md, calibration protocol in METHODS.md.

```
task_satisfaction 100%  scope_discipline 100%  claim_verification 95%  goal_alignment 100%  overall verdict 95%  core 11/12 FAIL  drift 12/12  injection 3/3  spread 0.07  21 live runs · 7 fixtures × k=3 · cost $3.15
```

v0.1.3: one judge backend (`claude -p`), seven author-labeled fixtures, **uncalibrated against human review** — zero same-evidence judge/human pairs exist. The 2026-08-31 live sample passes every attempted-gaming control but still fails the claim floor and one core check: one exact-citation retry ended in a safe abstention. The failed gate is retained, not rerolled. Live judging sends the spec, diff, transcript, tests and commits to the provider; inspect its data policy before using private material. This is a regression test, not proof the judge is right. MIT.
