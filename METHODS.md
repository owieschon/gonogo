# METHODS

How gonogo's own claims are meant to be checked. Two sections, both short.

## 1. Naturalistic data

The calibration set is drawn from real working sessions, not from prompts
written to be judged. That means it includes hurried one-line specs, specs that
changed halfway through, corrections shouted mid-run, tasks abandoned and
restarted, and sessions where the operator was doing three things at once. None
of it is cleaned up before it enters the set.

This is a deliberate cost. A curated set would produce better-looking agreement
numbers, and those numbers would describe a situation that does not occur: a
judge that only works when the operator was careful is a judge nobody needs,
because the runs worth checking are exactly the hurried ones. The `spec_clarity`
dimension exists so that this shows up in the data rather than being smoothed
out of it — once there is enough of it, judge accuracy can be plotted against
spec quality instead of asserted to be independent of it.

Sessions are recorded whether or not the verdict was flattering, including runs
where the tool was judging its own development and returned a poor result. No
run is dropped from the set for being embarrassing, and no run is dropped for
disagreeing with the judge.

## 2. Calibration protocol

1. After every real judged run, the operator records their own verdict as
   `runs/<ts>/human.json`, using the same four dimensions and the same 0–4
   anchors in RUBRIC.md. The schema is in `src/types.ts` (`ManualRatingFile`)
   and an example is in `calibration/synthetic/`.
2. The human verdict is recorded **after reading the diff and before reading
   the judge's verdict**, and the file records who reviewed it. A human score
   written after reading the machine's score measures anchoring, not agreement.
3. Every manual rating declares `rater_kind`: `human`, `llm`, or `synthetic`.
   Who wrote a rating is recorded, never inferred from the reviewer handle, and
   only a `human` rating paired with a gonogo judge run on the same evidence is
   judge-versus-human calibration. A human rating paired with a standalone LLM
   review is not: neither side of that pair is the instrument under test, so it
   is reported under its own name. AI-written reviews are kept and reported
   separately; a rating with no declared kind is excluded from every figure
   rather than being read as human, and so is any pair holding one.
4. `gonogo calibrate` recursively discovers manual ratings. A standalone rating
   is shown as review evidence but never counted as agreement. A directory that
   also holds the same run's `verdict.json` reports, per dimension: exact
   agreement, agreement within one point, mean absolute difference, and the
   direction of disagreement — how often the judge was harsher than the human
   and how often the reverse.
5. Disagreements are published individually, not just in aggregate. A summary
   statistic hides the cases that matter most, which are the ones where the
   judge was confidently wrong.
6. Target: 30 days of real usage before any accuracy claim is made about the
   judge. Until then the honest statement is the one in the README — the judge
   is uncalibrated, and `gonogo eval` measures only agreement with hand-written
   fixture labels, which is a much weaker claim.

### Instrument versioning

Calibration analysis stratifies by gonogo version, judge backend and model, and
`prompt_hashes`, which every judge event carries. The git tag `v0.1-freeze`
marks the pre-review 0.1.0 instrument candidate. Citation and provenance
hardening changed scoring before the first genuine paired datum, so that reviewed
tree identified itself as 0.1.1. Source-grounded gaming evidence, structured
rubric output and bounded citation retry identified the first release candidate
as 0.1.2. Claude Code 2.1.238 rejected that schema's Draft 2020-12 meta-schema
URI before inference, so the CLI-compatible schema identifies the tree as
0.1.3. The first live 0.1.3 gate exposed that its citation retry resampled the
whole rubric and did not retain the discarded receipt; citation-only repair
with a frozen rubric response identifies the tree as 0.1.4. The retained 0.1.4
gate then exposed one schema-valid gaming quote that joined a single hard-wrapped
transcript continuation. Deterministic, transcript-only recovery of that exact
representation identifies the tree as 0.1.5. Its retained gate exposed a mixed
quote that preserved one exact line break while joining one other continuation;
preserving existing LF/CRLF bytes during the same one-boundary recovery
identifies the tree as 0.1.6. Runs across versions are reported separately and
never pooled silently into one agreement figure.

### AI review is not human calibration

Two independent reviews of this repository's own pull requests are committed
under `calibration/`. Both were written by language models — `codex` on PR #1
and `claude-code-uhg22r` on PR #2 — and both are recorded as
`"rater_kind": "llm"`. They are useful review effort and they are kept in full,
with their reviewer handles, timestamps and notes intact. They are not human
calibration and are never counted as any part of it. Two AI reviews exist;
zero judge-versus-human pairs do.

### Known limits

Correlated blind spots: judge and worker share a training distribution and can
be wrong the same way about the same thing; cross-family panels decorrelate this
partially and never fully. Judge-awareness: once workers know a judge exists
they perform for it — expected, Goodhart, a finding when observed, and why
calibration never stops; the `disclosure` field on each judge event records
whether the worker was told. And the judge will be wrong; the calibration log is
what turns that from an embarrassment into a measurement.

### The trust ratchet

Phase 1, where gonogo is now: judge everything and human-review everything, log
agreement. Phase 2: dimensions with a recorded agreement track record earn
lighter review while dimensions that disagree keep full attention — the ratchet
turns per dimension, not per tool. Any automatic action needs all four of
deterministic gates over the catastrophic classes, a small blast radius, a
recorded track record, and sampling that never goes to zero. gonogo is a smoke
detector, not a fire department. Full argument in DESIGN.md.

## 3. Evaluation packet contract

This section defines what a researcher must freeze before a reviewer sees a
case, for the question this whole effort exists to answer: **does GoNoGo catch
consequential errors that ordinary one-pass review, given the same available
evidence, misses?** That is a retrospective, outcome-blinded comparison — a
reviewer scores a completed case without knowing what happened next — and it
is a different claim from prospective agent-task calibration (section 2),
where a human rates a real run as it lands. Neither substitutes for the
other, and results from one are never reported as the other.

**Executable check, not a study.** `gonogo validate-packet` (`src/packet.ts`)
is an offline, read-only integrity and eligibility gate. It checks that a
packet's declared identity matches its actual bytes, that comparison arms
review the same underlying evidence, and that exposed cases cannot claim
untouched-holdout status. It is not a detector of arbitrary semantic leakage
in free text, and a pass from it is not a claim that a real study has been
frozen. This unit ships the checker and its tests; it selects no holdout,
downloads no source, and calls no judge or model panel.

### Packet identity

A packet (`packet.json` plus the files it references) declares:

- `schema`, `packet_version` — versioned so a later contract change cannot be
  read as this one.
- `case_id` — required; a packet with no identity cannot be scored against
  anything.
- `provenance: known|unknown` — `unknown` fails closed. A case whose origin
  cannot be stated is not evidence of anything.
- `exposure: untouched|development|unknown` — `unknown` fails closed.
  `untouched` is checked against the operator's own exposure log (case ids
  already seen during development); a hit there fails closed even though the
  packet claims `untouched`. A `development` case can still pass every other
  check — it stays usable as a labeled development case — but it is never
  holdout-eligible. The exposure log itself is supplied by the caller and is
  never discovered or written by the validator.
- `protocol_files`, `instrument_files` — the frozen protocol document(s) and
  judge instrument/prompt files, each declared with a path and sha256 checked
  against the actual bytes on disk, not against a nonempty string.
- `arms` — one or more review arms (e.g. `gonogo`, `one_pass`). Each arm
  declares a `subject_hash` (the model-independent identity of its raw,
  pre-elision evidence — the same `subjectHashOf` used everywhere else in
  this repo) and an `evidence_hash` (the identity of exactly what bytes a
  reviewer is shown for that arm). These are never treated as
  interchangeable: two arms of one case must share the same `subject_hash`
  — the same underlying evidence — even when their `evidence_hash` differs
  because they render it differently. Arms whose `subject_hash` differs are
  a different case, not a paired comparison, and fail closed.
- `forbidden_markers` — exact strings that must not appear in any arm's
  review-facing files, e.g. a literal answer key or outcome marker. This is
  a named-marker check, not a semantic scan.

Every named failure carries one of a fixed set of reasons
(`DISQUALIFY_REASON` in `src/packet.ts`): `malformed_metadata`,
`missing_identity`, `protocol_digest_mismatch`, `payload_digest_mismatch`,
`arm_evidence_mismatch`, `unknown_provenance`, `unknown_exposure_state`,
`forbidden_review_material`, `exposed_case_claims_untouched`. A packet with
any failure never passes; there is no partial credit.

### Contamination and other limits this check cannot close

Model pretraining contamination cannot be disproved by a manifest: a case
built from public material may already be inside a judge model's training
data regardless of what the packet declares, and no digest check can detect
that. Passing packet validation is a statement about packaging integrity —
declared identity matches actual bytes, arms match, exposure is declared and
checked against a log — not a statement that a case is free of contamination,
free of semantic leakage in free text, or otherwise a clean scientific
instrument.

### What a future frozen study must still add

This unit defines the contract and ships the checker; it does not freeze a
real study. Before any accuracy claim is made from packets validated this
way, a concrete, reviewed manifest must additionally state:

- **Selection and exclusion rules**, predeclared before case access —
  including a small human-review pilot with fixed stopping rules, agreed
  before the pilot sees its first case.
- **Denominators.** False-go: consequential errors GoNoGo missed, divided by
  consequential errors present. False-alarm: cases GoNoGo flagged that
  one-pass review and adjudication agree were not consequential errors,
  divided by cases flagged. Coverage: cases where both arms produced a usable
  verdict, divided by cases attempted. None of these are computed by the
  validator; they are computed later, over a frozen sample, and reported with
  the sample size that supports them — not asserted at a precision the sample
  cannot carry.
- **Paired one-pass comparison**, arm-for-arm on identical evidence (the
  `arm_evidence_mismatch` check exists so this pairing cannot silently drift),
  and **human review time** per case, recorded alongside the verdict.
- **Human pre-model judgment kept separate from later adjudication.** A
  reviewer's first read, before seeing any model output, is a different
  record from an adjudicated verdict informed by additional evidence
  afterward; the two are never merged into one number. Disagreement,
  abstention and tool error are preserved as outcomes, not discarded or
  folded into agreement.
- Consistent with the rest of this document: a merged PR, a passing test
  suite, model-family agreement, or one operator's labels are not correctness,
  and a pilot is feasibility evidence for running the study, not authorization
  to merge on its results.

Original missing specs or transcripts are marked missing in the packet, never
reconstructed and presented as original — a reconstructed artifact answers a
different question than the one this protocol asks.

### What the numbers do not establish

`gonogo eval` measures the judge against seven labels that the same person wrote
who wrote the prompts. That is a regression test, not evidence of accuracy. It
can prove the judge got worse; it cannot prove it is right. Only the
judge-versus-human agreement in section 2 can begin to do that, and n=0 today:
no human has recorded a rating against a real gonogo run.
