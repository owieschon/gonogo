# AGENTS.md

Instructions for any coding agent working in this repository. This describes
what exists today, not what is planned; if something here is wrong, fixing it is
part of your change.

## What this repo is

`gonogo` is a CLI that renders an independent verdict on a completed coding-agent
task. It is not a self-verification tool: the agent that did the work never
grades it. If you are an agent changing this repo, you are the subject of the
tool, not its operator.

## Commands

    bun install                       # once
    bunx tsc --noEmit                 # typecheck; must be clean before you push
    ./bin/gonogo judge --spec <f> --repo <p> --base <ref>
    ./bin/gonogo eval --k 3           # live judge over all seven fixtures
    ./bin/gonogo eval --k 1 --only merged-but-wrong    # fast loop while iterating
    ./bin/gonogo eval --replay        # serve recorded judge output, no judge calls
    ./bin/gonogo eval --k 3 --record  # live run, recording output for CI
    ./bin/gonogo outcome --task t1 --run <judge-run> --pr <url> --state merged
    bun test                          # invariant tests; must pass before you push
    ./bin/gonogo calibrate --repo <p> # judge-vs-human agreement for target repo
    ./scripts/self-judge.sh --spec SPEC.md             # judge this repo's own diff

`bun` and the `claude` CLI must both be on PATH for a live run. `--replay` needs
neither, which is why CI uses it.

## Layout

    bin/gonogo          bash launcher over src/cli.ts
    src/evidence.ts     git diff, changed files, commits, test run -> Evidence
    src/blind.ts        the branded BlindPacket that makes I2 a compile error
    src/events.ts       event schema, append, read, v1 -> v2 migration
    src/replay.ts       content-addressed record/replay cache
    src/rubric.ts       the two passes, JSON parsing, verdict arithmetic
    src/report.ts       verdict.json -> self-contained verdict.html
    src/eval.ts         accuracy and variance over fixtures/
    src/calibrate.ts    judge-vs-human agreement
    src/judges/         JudgeBackend interface; claude.ts is the only real one
    prompts/            every judge prompt, versioned, hashed into provenance
    fixtures/           seven labeled cases; _base/ is the shared starting repo
    replay/             recorded judge output, content-addressed
    events.jsonl        append-only event log; eval and calibrate read it
    audits/             self-judge verdicts on this repo's own changes
    calibration/        human review records plus the synthetic demo data
    runs/               gitignored output of `gonogo judge`; excluded from later evidence

## Invariants

DESIGN.md states why gonogo is shaped the way it is. These seven are law. Any
pull request that touches `prompts/` or `src/evidence.ts` **must state which
invariants it affects** and **must pass `gonogo eval`**.

- **I1 Separation** — the worker never grades itself; never the same session,
  context or stake.
- **I2 Blind-first** — the goal-inference pass never sees the spec, enforced by
  the type system: `blindAttachments` takes a branded `BlindPacket` and the only
  constructor copies two fields. `src/invariants.test.ts` proves it.
- **I3 Evidence over testimony** — transcript and commit-message statements are
  claims to verify. Cite the evidence, never the claim.
- **I4 Anchor low** — where an L1 fact settles a sub-question (did it compile,
  did tests run, what changed), use the fact; the judge interprets the residue.
- **I5 Minimum, abstention, no averaging** — overall is the minimum; thin
  evidence abstains; an abstention caps the verdict at `inconclusive`.
- **I6 Calibration over belief** — judge-versus-human agreement is the only
  trust currency. Never claim accuracy the calibration log does not show.
- **I7 Provenance** — model version, prompt hashes, evidence hash, tool version
  on every verdict and every event.

Breaking one of these is not a trade-off to weigh against convenience. If a
change seems to require it, the change is wrong or DESIGN.md is, and settling
which comes before the code.

## The event log

`events.jsonl` at the repo root is append-only and is the substrate `eval` and
`calibrate` read. One event per judge invocation, per rater, per recorded
outcome. `schema_version` is 2; `src/events.ts` migrates v1 on read.

- Judge events (`kind: fixture | real`) carry scores, verdict, `drift_type`,
  `attempted_gaming`, `disclosure`, prompt and evidence hashes, latency, tokens
  and cost, and `rater_id: judge:<backend>`.
- Rater events (`kind: rater`) are a human — or later another judge — scoring
  the same `run_id`. Agreement is computed per rater pair, which is why panel
  mode will be data and not code.
- Outcome events (`kind: outcome`) record what happened to the work:
  `gonogo outcome --task <id> --run <judge-run> --pr <url> --state merged`.
  A supplied run must resolve to a real judge event carrying the same task id.
  Recorded by hand.

`calibrate` also discovers `human.json` recursively under a target repository's
`runs/` and `calibration/`. A standalone rating is printed with its notes but
never counted as agreement; only a same-run, same-evidence pair is calibration.

Never rewrite history in the log. Never add a field without bumping
`EVENT_SCHEMA_VERSION` and extending `migrateEvent`. The event log emits zero
telemetry. A live judge call still sends its documented evidence packet to the
configured judge CLI; README.md states that boundary for operators.

## Record and replay

`--record` writes raw judge output to `replay/`, keyed by backend, instrument,
requested model, prompt hash, evidence hash and sample index. Existing receipts
are immutable; recording reuses an exact hit and writes only misses. `--replay`
serves the receipt back and invokes no judge. Replay tests the pipeline, not the
model: an edited prompt changes the key, so replay misses loudly rather than
serving stale output — that is a prompt to re-record, not a verdict on the new
prompt. If record-on-miss combines one cached pass with one live pass, the run is
marked replayed and excluded from calibration; usage counts only the live work
performed in that run.

## Rules

1. **RUBRIC.md is the specification.** The code implements that document. If
   they disagree, the document is right and the code has a bug. Change the
   document deliberately and in its own commit, never as a side effect.
2. **No prompt text in source files.** Every judge prompt lives in `prompts/*.md`.
   Their sha256 goes into each verdict's provenance, so an inline string silently
   breaks reproducibility.
3. **Run `gonogo eval` before proposing a prompt change, and again after.**
   A prompt change is only kept if the numbers improve or hold. Record both
   numbers as one line in `EVAL_LOG.md` — including changes you tried and
   reverted, which are the useful half of that file.
4. **Do not tune a prompt against one fixture.** Seven is already a small set;
   fitting it exactly is how you get a judge that works on nothing else. If you
   want a new behaviour pinned, add a fixture with a `core_check`.
5. **Do not hand-edit `replay/` or `events.jsonl`.** The cache is recorded judge
   output; regenerate it with `gonogo eval --k 3 --record` against a live judge
   and say so in the commit message. The log is append-only.
6. **Self-judge substantive changes.** Run `scripts/self-judge.sh` before merge
   and commit the verdict under `audits/`. Commit the verdict you got, not the
   one you wanted.
7. Conventional commits, small logical units. Commit messages are read by
   strangers; so is every fixture and every prompt.
8. No secrets, no employer or client references, anywhere. This repo is public.
9. Exit codes are the integration surface: 0 go or go-with-notes, 1 hold or
   no-go, 2 inconclusive, 3 tool error. Do not add gating flags.

## Judge backends

`src/judges/` defines `JudgeBackend { name, invoke(promptFile, attachments) }`.
`claude.ts` shells out to `claude -p --output-format json` with settings, MCP
servers and tools switched off — a judge needs none of them and they cost about
34k prompt tokens per call. `codex` and `qwen` are deliberate stubs that throw;
implementing them is panel mode, which is in NEXT.md and not in scope until the
single-backend judge is calibrated.
