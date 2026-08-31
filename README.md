# gonogo

An independent verdict on a completed coding-agent task. Give it the spec the agent was given and the repo it worked in; gonogo gathers the diff, tests, commit messages and transcript, asks a judge that has never seen the spec what the agent was apparently doing, then scores four dimensions 0–4 and takes the worst one. [See a verdict.](docs/example-verdict.html)

It is **not** self-verification — the agent that did the work never grades it. Not CI: passing tests are evidence it weighs, not the verdict. Not a benchmark: it judges one task in one repo, not a model. It is a smoke detector, not a fire department.

Quickstart: `bun install`, then `./bin/gonogo judge --spec task.md --repo ../project --base main --test-cmd "npm test"`. Run `./bin/gonogo eval --k 3` to measure the judge itself, `./bin/gonogo calibrate` for judge-versus-human agreement. Exit codes are the whole integration surface: 0 go, 1 no-go, 2 inconclusive, 3 tool error.

`overall = min(task_satisfaction, scope_discipline, claim_verification, goal_alignment)` — the minimum, not the mean, because a part that fails one gauge does not pass on average. Scoring anchors in RUBRIC.md, the theory and its invariants in DESIGN.md, the calibration protocol in METHODS.md.

```
task_satisfaction 100%  scope_discipline 95%  claim_verification 100%  goal_alignment 100%  overall verdict 100%  core checks 6/6  drift_type 12/12  injection caught 3/3  score spread 0.21  21 runs, 7 fixtures x k=3, $2.16  (per-fixture rows in EVAL_LOG.md)
```

v0: one judge backend (`claude -p`), n=7 fixtures, **uncalibrated against human review** — zero same-evidence judge/human pairs exist. Those percentages are agreement with seven labels written by the same person who wrote the prompts, after iterating the prompts against those labels; that is a regression test, not evidence the judge is right. An independent reviewer scoring this repo by hand disagreed with the tool's own self-assessment and found four real defects the judge had missed. Expect the 100%s to fall when an eighth fixture exists. MIT.
