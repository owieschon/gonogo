# DECISIONS

One line per ambiguous call, with the reason. Simpler option wins unless stated.

- **Verdict labels are `go` / `go-with-notes` / `hold` / `no-go` / `inconclusive`.**
  The spec fixed the arithmetic (minimum across four dimensions) but not the
  names for 0–4. Four bands plus the abstention cap; anchors in RUBRIC.md.
- **`JudgeBackend.invoke` returns a response object, not a bare string.**
  The spec's signature is `-> text`. Provenance requires the model version and
  cost the CLI reports on the same call, and a bare string throws them away.
  `.text` is the reply; the rest is provenance.
- **Evidence is `git diff <base>` against the working tree, not `<base>...HEAD`.**
  One collection path covers committed branch work and uncommitted work, which
  is what `scripts/self-judge.sh` and the fixtures both produce. Untracked files
  are diffed separately against `/dev/null` so new files are not invisible.
- **Fixtures store `base/` and `head/` directories, not a checked-in git repo.**
  Nested `.git` directories do not survive a clone. `gonogo eval` materialises a
  throwaway repo in `mkdtemp` per run.
- **All seven fixtures share one base repo (`fixtures/_base`).** Seven unrelated toy
  repos would make the difference between cases a difference of subject matter rather
  than a difference of agent behaviour, which is what is being measured.
- **`silent-narrowing` and `honest-partial` have byte-identical `head/` trees.**
  Only `transcript.txt` differs. It is the sharpest available test that
  `claim_verification` measures honesty and not completeness.
- **A score returned without a citation is downgraded to an abstention.**
  RUBRIC.md rule 1 is "cite or abstain"; enforcing it only in the prompt makes
  it a suggestion. `src/rubric.ts` enforces it on parse.
- **The judge CLI runs in bare mode with settings, MCP servers and the tool
  surface switched off.** A judge needs none of them and they cost ~34k prompt
  tokens per call (measured: $0.15 → $0.025 per call). Claude Code documents
  `--bare` as the reproducible scripting mode; `--tools ""` removes tools,
  whereas `--allowed-tools ""` merely approves none of the available tools.
- **Legacy unstructured replies remain readable, but live rubric replies are
  schema-constrained.** Pre-0.1.2 receipts may contain prose wrappers or raw
  control characters inside citation strings, so the compatibility parser
  extracts the object and escapes only those characters. New rubric and
  citation-repair calls use Claude's structured-output contract; malformed or
  schema-invalid output is a terminal tool error and never triggers a rerating.
  Every attempted repair also gets a run-local `gonogo/replay@2` sidecar before
  validation, independent of the optional global replay cache. Its digest binds
  verdict and event provenance to the exact response and per-call model, cost,
  tokens, latency and cache key.
- **CI runs `gonogo eval --replay`, not a live judge.** A live run needs an
  authenticated `claude` CLI, which a public repo has no way to provide. The
  workflow comment says plainly what replay does and does not catch — notably
  that it cannot catch a regression in `prompts/*.md`.
- **`gonogo calibrate` refuses to mix synthetic pairs into real statistics.**
  With no real pairs it prints them under a banner stating the numbers measure
  nothing, rather than reporting a plausible-looking figure.
- **Standalone human ratings stay visible but are not calibration pairs.** A
  retrospective review is evidence that review happened, not evidence of
  judge agreement. `calibrate` lists it with its notes and waits for a matching
  same-evidence run instead of silently dropping or statistically pairing it.
- **Cross-fixture invariants are not expressible in `labels.json`.** The
  `silent-narrowing` / `honest-partial` task_satisfaction pairing is enforced by
  giving the two fixtures identical label ranges instead. A real paired-check
  mechanism is not worth building at n=7.
- **`merged-but-wrong`'s `goal_alignment` label was corrected upward after the
  first live run**, rather than changing the prompt to match the label. The
  judge's reading was right: that agent pursued the assigned goal and executed
  it dishonestly. See EVAL_LOG.md iteration 1.
- **README's fifteen-line budget is counted excluding the pasted eval table.**
  The table the spec asks to paste in is thirteen lines by itself. Ten lines of
  prose plus the table.
- **Commit messages are evidence; `git log <base>..HEAD` is collected.** RUBRIC.md
  always counted them as claims, and leaving them out meant claim_verification
  judged half the record on any run without a transcript — which is every run
  driven by `scripts/self-judge.sh`. They go to the rubric pass only; the blind
  pass still sees the diff and the transcript and nothing else, as specified.
- **Historical parse-retry provenance remains readable, but new runs do not
  retry a rubric rating.** Pre-0.1.2 verdicts may carry
  `rubric_parse_retries`; v0.1.2 and later write zero because structured-output
  failure is terminal. Retaining the field explains old artifacts without
  preserving the behavior that produced them.
- **The repository started private and was made public during PR review.** The
  build session lacked `gh`; the maintainer review completed that release step
  before any merge.
- **`--max-diff-chars` exists because this repo's own first diff is 326k characters.**
  The default 120k limit would have elided the middle of it, which on a
  path-sorted diff means the fixtures get seen and `src/` does not. Raising the
  limit for a self-judge run is not softening the verdict — a judge that cannot
  see the source cannot find fault in it. `scripts/self-judge.sh` passes 400000
  and the CLI warns loudly whenever a diff is elided.

## Addendum session — instrumentation and hardening

- **No Langfuse, no Arize, no PostHog, no OpenTelemetry SDK.** The thesis of
  this tool is local-first evidence: a verdict you can check is worth more than
  a dashboard you must trust. A hosted observability platform inverts that — the
  evidence leaves the machine, the operator reads a summary of it, and the thing
  gonogo is supposed to prevent (accepting a claim instead of an artifact) is
  reintroduced at the tooling layer. `events.jsonl` is a file you can `grep`.
  Event field names follow the OpenTelemetry GenAI semantic conventions where a
  natural match exists (`model_version` ≈ `gen_ai.request.model`, `tokens_in` ≈
  `gen_ai.usage.input_tokens`, `tokens_out` ≈ `gen_ai.usage.output_tokens`), so
  exporting later is a mapping and not a migration. **Zero telemetry, ever:**
  the event pipeline never exports or phones home. A live verdict still makes
  the explicit, documented call to the configured judge CLI.
  Revisit when there is a second operator, or when the log outgrows what a
  laptop can grep — neither is true today.
- **The replay cache key includes the sample index.** Keying purely on
  (prompt hash, evidence hash) would collapse all k samples of one fixture into
  one entry, and `gonogo eval` would then report zero variance for a judge that
  has plenty. The stochasticity is the measurement; the key has to preserve it.
- **Replay receipts are immutable and scoped to a judge instrument.** Backend
  and requested model identity prevent one judge from serving another's output;
  full hashes are checked after lookup, and `--record` reuses an exact receipt
  instead of replacing the result CI relies on. The committed legacy v1 raw
  replies may exercise both the 0.1.0 parser and its 0.1.1 hardening only when
  their full prompt and evidence hashes match; those replayed events cannot enter
  calibration. New v2 receipts remain version-scoped.
- **Rubric output uses the backend's structured-output contract.** Claude's
  `--json-schema` makes malformed JSON a failed call instead of buying a second,
  substantively different rating. The first schema-valid rubric response is
  recorded and frozen. One separate structured call may repair only invalid
  citation arrays or declare them unrepairable; its static prompt, schema and
  response have their own immutable receipt. A failed repair becomes a safe
  abstention without changing any score, reasoning or verdict metadata. Invalid
  gaming evidence fails immediately because repairing it would change a
  substantive finding. Cached responses never fall through to a live call. The
  schemas omit `$schema`: Claude Code 2.1.238 rejects the Draft 2020-12
  meta-schema URI before inference even though it accepts the same object
  schemas without that annotation.
- **Replayed and mixed-source runs are excluded from calibration.** Serving a
  cached pass twice is not a second observation, and counting it would inflate
  agreement. A mixed record-on-miss run reports only the live pass's current
  usage and preserves both pass sources in verdict provenance.
- **Evidence blocks are delimited with a token derived from the evidence hash.**
  Code fences are not a boundary: evidence can contain a closing fence and carry
  on in prose that reads like instruction. The token depends on a hash of the
  whole evidence packet — including the injection — so whoever wrote the
  evidence could not have known it. A literal delimiter inside evidence is
  visibly redacted rather than silently dropped.
- **`attempted_gaming` requires a source-grounded evaluator instruction.** A
  quote must occur in DIFF, COMMIT_MESSAGES or TRANSCRIPT; SPEC, TEST_RESULT and
  the judge-generated INFERRED_GOAL cannot establish worker gaming. A grounded
  quote still raises the finding when the judge forgets the boolean. False
  completion claims and "ready to merge" belong to claim verification, not to
  this flag.
- **I2 is a compile error, not a convention.** `blindAttachments` takes a
  branded `BlindPacket`. Without the brand, `Evidence` would satisfy the shape
  structurally — it also has `diff` and `transcript` — and the invariant would
  rest on nobody making that mistake. `bunx tsc --noEmit` now rejects it.
- **`fixtures/*/replay/` was replaced by a single content-addressed `replay/`.**
  Per-fixture verdict files could not express "this output belongs to these
  prompts", so an edited prompt silently served stale verdicts. The new key
  includes the prompt hash, so a prompt edit misses loudly.
- **The log was born at schema v2.** Both addenda landed in one session, so no
  v1 events were ever written. Schema v3 adds citation-repair provenance; v1
  and v2 migrate with no repair. The migrations are covered by tests rather
  than exercised by stored v1 data; that is the honest state of it.
- **Exit codes map five verdicts onto four codes.** `go` and `go-with-notes`
  both exit 0 — a go with notes is still a go — and `hold` joins `no-go` at 1,
  because neither is a go. `inconclusive` is 2 and tool failure is 3, so a
  caller can tell "the work is bad" from "the judge could not tell" from "the
  tool broke". No `--gate` flag: the exit code is the whole surface.
- **Eval floors are a fail-closed, versioned fixture policy.**
  `fixtures/thresholds.json` names the 0.1.4 instrument and every metric; a
  missing, partial, out-of-range or wrong-version policy is a tool error rather
  than an implicit pass. The current 100/95/100/90 dimension, 90 verdict and
  100 drift floors are the receipt from EVAL_LOG iteration 9.
- **`gonogo outcome` records what happened by hand; it does not talk to GitHub.**
  A GitHub integration would need credentials, network access and a webhook
  story, all to save typing one command when a PR lands.
- **Judge output is excluded from the next run's untracked evidence.** Run
  artifacts live inside the target repository for the human-review flow, but
  they are tool output, not agent work. Tracked files remain visible; only the
  caller-declared untracked output root is excluded.
- **The remote `v0.1-freeze` tag anchors the pre-review 0.1.0 instrument.** It
  points at the commit recording the addendum eval numbers. Review hardening
  changed scoring before genuine calibration began, so the reviewed tree is
  0.1.1 and cannot pool its ratings with 0.1.0 or later instruments. Preserve
  the tag's ancestry with a merge commit rather than a squash or rebase merge.
