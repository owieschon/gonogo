# G3 dependency-installed integration gate receipt

- Task: `adapter-with-judge-hardening`
- Execution: `g3-install-then-gate`
- Recorded: `2026-09-02T01:09:10Z`
- Branch: `integration/adapter-with-judge-hardening`
- Starting HEAD: `7172fe30983bcb15dee0ab4e3ca811e79128ddc6`
- HEAD at the blocked live gate: `b77b5ba058db1f4ee8a44a1ff481e047723ec27a`
- Base for the live gate: `origin/main` = `9d3206db990e910e2ee8aa9e2085d76a156b0312`
- Instrument version at gate: `0.1.6` (unchanged)
- Runtime: Bun 1.4.0; `claude` CLI 2.1.258

Both earlier blocked receipts were left byte-identical. Their Git blobs are
still `a7831577ac066597e065dbd70996d66b19e69d58` (G1 typecheck) and
`c406ec6912c607ee35c49f72394f44d9f80595f4` (G2 replay). Nothing in this
execution rerolled, replaced, hid, or weakened any earlier result.

## Gate 1 — dependencies

    bun install

Exit 0. "Checked 5 installs across 6 packages (no changes)"; `node_modules/`
was already present from the G2 execution. Neither `package.json` nor
`bun.lock` changed; `bun.lock` still hashes to
`e9ccb1b5aed32694d42433676d62cabbe9c2bd44db6cfca1228610c60fbaf3c1`.

## Gate 2 — deterministic suite (PASS)

    bun test

135 pass, 0 fail, 565 expect() calls across 9 files. This reproduces the count
recorded in the G1 receipt.

## Gate 3 — typecheck (PASS)

    bunx tsc --noEmit

Exit 0, no output. The G1 receipt's `TS2688 Cannot find type definition file
for 'bun-types'` failure was caused solely by the absent `node_modules/`, as
that receipt stated. The G1 receipt is retained unchanged; this is a new run of
the same command after the dependency install it identified as the missing
prerequisite, not a reroll of the recorded failure.

## Gate 4 — checked-in replay evaluation (PASS)

The G2 execution ran this gate unpinned and it missed every receipt. That was
an invocation defect, not a code defect: replay identity includes the requested
model, the checked-in 0.1.6 receipts live under the `claude-sonnet-5` identity
prefix `337bde4aa4b42180`, and an unpinned run looks under
`5e4b5e254a1ba6ad`. `.github/workflows/ci.yml` pins the model for exactly this
reason. This execution ran the CI form:

    GONOGO_CLAUDE_MODEL=claude-sonnet-5 ./bin/gonogo eval --replay --k 3

Result, against the fail-closed floors in `fixtures/thresholds.json`:

    task_satisfaction    21/21  100%    floor >= 100%   PASS
    scope_discipline     21/21  100%    floor >=  95%   PASS
    claim_verification   21/21  100%    floor >= 100%   PASS
    goal_alignment       20/21   95.2%  floor >=  90%   PASS
    overall verdict      21/21  100%    floor >=  90%   PASS
    labelled drift       12/12  100%    floor >= 100%   PASS
    hard failures 0; required 0                         PASS
    quality gate: PASS

21 scheduled runs, 46 cached calls observed, 21 completed verdict events, 0
failed runs, 12.0s wall, 0.0s judge time. No judge was invoked. Provider cost
$0.0000; the recorded runs behind those receipts had cost $3.1622 when they
were originally recorded. The 21 replayed fixture events were appended to
`events.jsonl` and committed in `b77b5ba`. No receipt was written or edited.

## Gate 5 — self-judge (BLOCKED, no verdict produced)

Rule 6 of AGENTS.md requires a self-judge verdict for a substantive change. The
adapter half already has one (`audits/session-005-self-verdict.json`, verdict
`go`); the judge-hardening half has never been self-judged, so this was the one
live gate this execution was authorized to attempt. It was attempted once:

    GONOGO_CLAUDE_MODEL=claude-sonnet-5 ./scripts/self-judge.sh \
      --spec <concatenated SPEC-ADAPTERS.md + RUBRIC.md> \
      --base origin/main \
      --out runs/session-006-integration

The spec was the concatenation of the branch's two authorizing documents —
`SPEC-ADAPTERS.md` for the adapter half and `RUBRIC.md`, which Rule 1 names as
the specification, for the hardening half. Session 004 is the receipt for why a
spec narrower than the diff produces an inapplicable verdict. The concatenated
file is 15,093 bytes and hashes to
`d3dd854cc475ec7447e374d7776793cf6f02fb3ee985ba9ebcfe07e153200ffc`.

Evidence collection succeeded: 35 changed files, 440,024 characters of diff,
neither diff nor transcript truncated, subject hash
`d822021eaabfefca115090a5c80347193eb765377f20039ab05ca4c399c118b0`. The
embedded test command — typecheck plus the k=3 replay evaluation into the
run-local event file — exited 0.

The blind pass then failed at the backend with this exact output:

    gonogo: claude exited 1: Not logged in · Please run /login

The failure receipt is retained at
`runs/session-006-integration/evidence/calls/blind.failure.json` with
`stage: backend`, `receipt_sha256: null`, and the exact error string.
`runs/` is gitignored, so it is quoted here rather than committed.

### Diagnosis

`src/judges/claude.ts` invokes the CLI with `--bare` as its first flag. On
`claude` 2.1.258 the help text for that flag reads, in part:

    Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
    --settings (OAuth and keychain are never read).

This machine authenticates the CLI through OAuth/keychain and has no
`ANTHROPIC_API_KEY` set, so every `--bare` call is rejected before any request
is made. The cause was isolated by running the backend's exact flag list
against a one-line prompt and removing one flag at a time:

    --bare + lean flags        is_error true   "Not logged in"   $0
    --bare alone               is_error true   "Not logged in"   $0
    lean flags without --bare  is_error false  "ok"              $0.0236738

`--bare` is not part of this branch. It is present unchanged on `origin/main`,
was introduced by `a9f8307 fix(judge): isolate scripted Claude calls`, and this
branch touches no file under `src/judges/`. The session-005 self-judge ran
successfully on 2026-09-01 against `claude` 2.1.238; the CLI has since moved to
2.1.258. This is an environment/CLI-contract change, not a defect introduced by
the integration.

### Why it was not fixed here

Removing `--bare` would work, and it would also change the judge's context: the
flag's own code comment records that a non-bare call loads the CLI's default
tool and settings surface at roughly 34k additional prompt tokens per call. That
is a change to judge behaviour and therefore to the instrument, which under this
repository's rules belongs in its own DECISIONS.md entry, its own instrument
version, and its own gate — not silently inside an integration whose whole
premise is that neither the prompts nor the scoring instrument changed. No
prompt, fixture, threshold, label, schema, or backend was changed by this
execution.

## Accounting

Provider spend attributable to this execution, from provider-reported
`total_cost_usd` only:

- Self-judge blind pass: rejected before any request. 0 tokens, $0.0000.
- Three `--bare` isolation probes: rejected the same way. 0 tokens, $0.0000.
- One non-`--bare` isolation probe that succeeded: $0.0236738.
- One earlier diagnostic call made with the full default tool surface while
  checking whether the CLI could reach the API at all: $0.2844400, 2 input,
  103 output, 10,010 cache-read and 27,685 cache-creation tokens. This call
  was avoidable — the flag isolation above establishes the same fact for two
  cents — and is disclosed rather than omitted.

Total known provider spend: $0.3081138. No judge call was completed, no judge
event was appended by a live call, no verdict was produced, and no replay
receipt was written or modified.

Unknown costs, stated rather than estimated: the token and dollar cost of the
orchestrating Claude Code session itself (model `claude-opus-5[1m]`) is not
reported back to that session and is not included above. The `claude` CLI
reports no dollar amount for a request it rejects before sending, so the four
rejected calls are recorded as $0 on the provider's own accounting rather than
as an estimate.

## What this execution did not do

It did not bump the instrument to 0.1.7, did not run the paid live
`eval --k 3`, did not re-record any replay receipt, did not produce a
self-judge verdict, did not open a pull request, and did not merge. The
deferred 0.1.7 version bump and its paid live gate remain deferred, exactly as
DECISIONS.md and the last line of EVAL_LOG.md leave them.

## Smallest next decision

Make the judge backend able to authenticate on this machine, then rerun only
the self-judge. Either:

1. Provide `ANTHROPIC_API_KEY` in the environment for the self-judge
   invocation, which satisfies `--bare` on CLI 2.1.258 and needs no code
   change; or
2. Authorize a separate, self-contained change to `src/judges/claude.ts`'s
   invocation contract, with its own DECISIONS.md entry, instrument version,
   and gate, since dropping `--bare` changes what the judge is shown.

Option 1 is the smaller of the two and leaves the instrument untouched. Neither
should be folded into this integration branch without being asked for.
