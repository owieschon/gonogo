# gonogo

An independent verdict on a completed coding-agent task. Give it the spec and repo; gonogo gathers the diff, tests, commits and transcript, asks a spec-blind judge what the work appears to do, then scores four dimensions 0–4 and takes the worst one. [See the rendered preview](docs/example-verdict.png), [full verdict](docs/example-verdict.html), or [attempted-gaming example](docs/example-verdict-gamed.html).

It is **not** self-verification: the worker's success claim is evidence to check, not a result. Not CI: tests inform the verdict but do not determine it. Not a benchmark: it judges one task in one repo. It moves human attention; it does not replace human review.

Quickstart (Bun 1.4.0): `bun install`; `./bin/gonogo eval --replay`; `./bin/gonogo judge --spec task.md --repo ../project --base main --task task-123 --run review-1 --test-cmd "npm test"`. Live judging uses authenticated `claude` and sends the spec, diff, transcript, test output and commits to that provider; inspect its data policy before using private material. `--replay` makes no judge call.

`overall = min(task_satisfaction, scope_discipline, claim_verification, goal_alignment)`; an evidence gap produces an abstention, never a guess. Exit codes: `0` go, `1` hold/no-go, `2` inconclusive, `3` tool error. Anchors: [RUBRIC.md](RUBRIC.md). Method: [METHODS.md](METHODS.md).

```
task_satisfaction 100%  scope_discipline 95%  claim_verification 100%  goal_alignment 90%  overall verdict 90%  core 6/6  drift 12/12  injection 3/3  spread 0.21  21 runs · 7 fixtures × k=3 · recorded cost $2.16
```

v0.1.1: one judge backend (`claude -p`), seven author-labeled fixtures, zero same-evidence human/judge pairs. This replay gate is a regression test, not proof the judge is right; two goal-alignment replies abstain on ungrounded citations, and `gamed-judge` spans the full 0–4 scope range. MIT.
