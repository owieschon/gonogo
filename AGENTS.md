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
    ./bin/gonogo eval --k 3           # live judge over all six fixtures
    ./bin/gonogo eval --k 1 --only merged-but-wrong    # fast loop while iterating
    ./bin/gonogo eval --replay        # score committed fixture verdicts, no judge calls
    ./bin/gonogo calibrate            # judge-vs-human agreement
    ./scripts/self-judge.sh --spec SPEC.md             # judge this repo's own diff

`bun` and the `claude` CLI must both be on PATH for a live run. `--replay` needs
neither, which is why CI uses it.

## Layout

    bin/gonogo          bash launcher over src/cli.ts
    src/evidence.ts     git diff, changed files, test run, transcript -> Evidence
    src/rubric.ts       the two passes, JSON parsing, verdict arithmetic
    src/report.ts       verdict.json -> self-contained verdict.html
    src/eval.ts         accuracy and variance over fixtures/
    src/calibrate.ts    judge-vs-human agreement
    src/judges/         JudgeBackend interface; claude.ts is the only real one
    prompts/            every judge prompt, versioned, hashed into provenance
    fixtures/           six labeled cases; _base/ is the shared starting repo
    audits/             self-judge verdicts on this repo's own changes
    calibration/        the human-verdict schema and synthetic demo data
    runs/               gitignored output of `gonogo judge`

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
4. **Do not tune a prompt against one fixture.** Six is already a small set;
   fitting it exactly is how you get a judge that works on nothing else. If you
   want a new behaviour pinned, add a fixture with a `core_check`.
5. **Do not edit `fixtures/*/replay/`.** Those are recorded verdicts. Regenerate
   them with `gonogo eval --k 3 --write-replay` against a live judge and say so
   in the commit message.
6. **Self-judge substantive changes.** Run `scripts/self-judge.sh` before merge
   and commit the verdict under `audits/`. Commit the verdict you got, not the
   one you wanted.
7. Conventional commits, small logical units. Commit messages are read by
   strangers; so is every fixture and every prompt.
8. No secrets, no employer or client references, anywhere. This repo is public.

## Judge backends

`src/judges/` defines `JudgeBackend { name, invoke(promptFile, attachments) }`.
`claude.ts` shells out to `claude -p --output-format json` with settings, MCP
servers and tools switched off — a judge needs none of them and they cost about
34k prompt tokens per call. `codex` and `qwen` are deliberate stubs that throw;
implementing them is panel mode, which is in NEXT.md and not in scope until the
single-backend judge is calibrated.
