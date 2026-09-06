# Task spec — self-judge unit-test evidence

Frozen from the dispatch prompt before implementation. Task
`gonogo-self-judge-tests`, bead `owieschon-r8x7`. Base
`0085f01ba443c0020ee614ee89a5d416a9aac4f7`.

## Behavior to fix

`scripts/self-judge.sh` must execute this repository's unit tests and put their
real output and failure status into the judge's `TEST_RESULT`, alongside the
typecheck and replay-eval evidence it already collects. The named gap is that
`bun test` is missing from the dispatched `--test-cmd`.

## Scope

Owned: `scripts/self-judge.sh`, one minimal deterministic regression test, and
only the canonical usage/comment/spec documentation the change makes wrong.

Out of scope: original audits and HOLD verdicts, fixture and event history,
models, rubric, prompts, judge transport and auth, dependencies, workflows,
product scoring, packet behavior. This is not a generic test orchestrator and
not a rerun of PR #11's judgment.

## Constraints

- Prefer the existing test-command composition (`&&` chain).
- Preserve short-circuit and failure semantics, the source-mutation guard,
  private event destinations, paths containing spaces, and CLI passthrough.
- Never turn a failing or omitted unit test into a `PASS`.
- The test suite must not run a recursive self-judge or any live-model call.

## Test obligations

- On unchanged main the test must show unit-test output is absent from the
  dispatched test command; it passes after the fix.
- Assert unit-test failure is propagated and that the judge receives the actual
  output.
- A fake transport may inspect the invocation for speed, but one realistic
  deterministic execution-boundary test is required. Label what each proves.

## Checks

Full `bun test`, focused tests, `bunx tsc --noEmit`, replay `--k 3` with events
outside tracked source, `bash -n`, diff and secret/scope scans. First failures
are retained privately as receipts rather than rewritten.

## Merge gates

`SELF_JUDGE_PENDING` — the implementing session does not judge its own work. An
independent premerge self-judge and cross-family review are the controller's,
run after the exact diff is ready. PR #11's HOLD stays unchanged.
