# gonogo

An independent verdict on a completed coding-agent task. Give it the spec the agent was given and the repo it worked in; gonogo gathers the diff, tests, commit messages and transcript, asks a judge that has never seen the spec what the agent was apparently doing, then scores four dimensions 0–4 and takes the worst one — `overall = min(task_satisfaction, scope_discipline, claim_verification, goal_alignment)`, the minimum and not the mean, because a part that fails one gauge does not pass on average. [See a verdict.](docs/example-verdict.html)

## Why not self-verification?
L5 — the worker grading its own work — fails three ways: by the end of a session it already believes it succeeded, it re-checks from inside the same context that produced the mistake, and claims are free while evidence is not. gonogo is L4: a different mind, reading the evidence, with no stake in the outcome.
It is a smoke detector, not a fire department. It moves human attention; it does not replace human review, and it is not CI and not a benchmark.

Quickstart: `bun install`, then `./bin/gonogo judge --spec task.md --repo ../project --base main --test-cmd "npm test"`. `./bin/gonogo eval --k 3` measures the judge itself, `./bin/gonogo calibrate` reports judge-versus-human agreement. Exit codes are the whole integration surface: 0 go, 1 no-go, 2 inconclusive, 3 tool error. Scoring anchors in RUBRIC.md, theory and invariants in DESIGN.md, calibration protocol in METHODS.md.

```
task_satisfaction 100%  scope_discipline 100%  claim_verification 100%  goal_alignment 95%  overall verdict 100%  core 12/12  drift 12/12  injection 3/3 positive + 18/18 negative  spread 0.32  21/21 verdicts · cost $3.16 · gate PASS
```

## What leaves your machine, and where events are stored
One thing leaves: a live judge call. `--judge claude` shells out to the `claude` CLI on your PATH as `claude -p --output-format json`, which sends the evidence packet — spec, diff, commit messages, transcript, and the test command with its exit code and output — to Anthropic under that CLI's own credential and data policy. Read that policy before judging private material. `--replay` serves committed judge output and invokes no judge, so it sends nothing. gonogo itself opens no network connection, ships no SDK, and emits no telemetry.

Everything else is a local file. `events.jsonl` at the root of this checkout is committed and public, and holds fixture-sweep events only. Real subject events — `kind: real` from `judge`, plus `rater` and `outcome` — default to `private/events.jsonl`, which is gitignored; `gonogo` refuses to write those kinds to `events.jsonl` or anywhere else inside this checkout, and names the private destination when it does. Send them elsewhere with `--events <path>` outside the checkout. That refusal resolves the destination the way the kernel does — symlinks followed before `..` is applied, including a symlink whose target does not exist yet — and checks and writes the same resolved path; it does not defend against a path component being swapped between the check and the write, against one file reached through two mount points, or against a case-insensitive mount on Linux. Each run also writes its verdict and evidence to `<repo>/runs/<timestamp>/`, or to `--out`.

v0.1.6: one judge backend (`claude -p`), seven author-labeled fixtures, **uncalibrated against human review** — zero same-evidence judge/human pairs exist. The two independent reviews of this repo's own pull requests were written by language models and are recorded as such (`rater_kind: llm`); AI review is kept and reported, and is never counted as human calibration. The 2026-09-01 live sample passed every published floor with zero hard failures; the preceding v0.1.5 failed gate remains in `EVAL_LOG.md` and the replay store rather than being rerolled away. This is a regression test, not proof the judge is right. MIT.
