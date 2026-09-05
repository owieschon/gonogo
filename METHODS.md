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
packet's declared identity matches its actual bytes against an externally
supplied expectation (never only the packet's own say-so about itself), that
every comparison arm's declared review material references the exact same
evidence bytes, and that exposed or unverifiable cases cannot claim
untouched-holdout status. It verifies the declared references and the bytes
behind them — not that a reviewer actually opened, read, or obeyed any of
it; a passing packet says the *material was assembled correctly*, not that a
review happened. It is not a detector of arbitrary semantic leakage in free
text, and a pass from it is not a claim that a real study has been frozen.
This unit ships the checker and its tests; it selects no holdout, downloads
no source, and calls no judge or model panel.

### Packet identity

A packet (`packet.json` plus the files it references) declares:

- `schema`, `packet_version` — versioned so a later contract change cannot be
  read as this one.
- `case_id` — required; a packet with no identity cannot be scored against
  anything.
- `provenance: known|unknown` — `unknown` fails closed. A case whose origin
  cannot be stated is not evidence of anything. This is an operator
  attestation, not proof: the checker cannot verify that a claimed origin is
  true, only that one was declared.
- `exposure: untouched|development|unknown` — `unknown` fails closed.
  `untouched` is checked against the operator's own exposure record (case
  ids already seen during development, e.g. cases discussed, opened, or
  otherwise looked at before this contract existed); a hit there fails
  closed even though the packet claims `untouched`. The exposure record
  itself is a versioned object (`{"schema": "gonogo/exposure-log@1",
  "complete": true|false, "exposed_case_ids": [...], "covered_through"?:
  "YYYY-MM-DD"}`), not a bare array of ids: **omitting the exposure record
  is not the same as supplying an incomplete one, and supplying an
  incomplete one is not the same as supplying a complete one.** A caller who
  supplies no record gets `exposure_record_not_supplied`; one who supplies a
  record with `complete: false` (or no `complete` field at all — a bare
  array is refused outright as the wrong shape) gets
  `exposure_record_incomplete`; only an explicit `complete: true` can back
  an `untouched` decision. An optional `covered_through` date must reach at
  least the packet's own `data_cutoff` or the record is likewise
  `exposure_record_incomplete` for this packet's declared window — checked
  against the calendar, not by string prefix. None of this proves the
  record is historically true; it makes the operator's completeness claim
  explicit and fail-closed instead of implicit and silently assumed. A
  `development` case can still pass every other check — it stays usable as
  a labeled development case — but it is never holdout-eligible.
- `data_cutoff` — a real calendar date (`YYYY-MM-DD`, validated against the
  calendar, not merely pattern-matched — `2026-02-30` and trailing garbage
  after a valid-looking prefix are both refused) marking the declared
  boundary past which no material may enter what a reviewer sees.
- `evidence` — the one shared evidence collection every arm's declared review material must reference:
  - `payload_file` — a single file, declared with a path, sha256 and role
    (`review`), checked against actual bytes on disk. Its parsed content
    must have *exactly* the shape the rest of this repo hashes evidence as —
    exactly the keys `spec`/`diff`/`commitMessages`/`transcript`/`test`, no
    more and no fewer (nested `test` is likewise exactly `command`/
    `exitCode`/`output`); an extra top-level or nested key is refused even
    though `subjectHashOf` would silently ignore it, because a reviewer sees
    the whole file, not just the hashed tuple. `exitCode` must be a finite
    integer — a value like `1e309`, which JSON parses to `Infinity`, is
    refused rather than silently normalized away by `JSON.stringify`. A
    malformed payload is a named refusal, never a crash.
  - `subject_hash` — the model-independent identity of `payload_file`'s
    content (the same `subjectHashOf` used everywhere else in this repo),
    recomputed and checked, never trusted from the manifest alone.
  - `source` — `repo`, `base`, `head`: attested source identity. `base` and
    `head` must be full, unabbreviated 40-character commit hashes — a
    prefix is not an identity, since two different commits can share one.
  - `artifact_provenance` — per material (`spec`, `diff`, `commit_messages`,
    `transcript`, `test`), one of `original`, `missing`, or `reconstructed`.
    This is an attestation the checker cannot prove — but "missing" versus
    "present" is not: it is mechanically visible in `payload_file` itself,
    and a declaration that contradicts it is refused. `transcript`/`test`
    are nullable in the payload, so absence is `=== null`; `spec`/`diff`/
    `commitMessages` are required strings with no null case, so the
    documented representation of "missing" for them is the empty string
    `""` — declaring `missing` for a field that actually has content, or
    declaring anything else for a field that has none, both fail closed.
    An artifact that is honestly `missing` does not disqualify a case; one
    marked `reconstructed` is never eligible for untouched holdout, because
    reconstructed material is not the original evidence a genuine untouched
    case needs to rest on.
- `protocol_files`, `instrument_files` — the frozen protocol document(s) and
  judge instrument/prompt files. Each is checked two ways: against actual
  bytes on disk (not a nonempty string), and — for `protocol_files` only —
  against an **externally supplied pin** the caller computed independently
  of the packet (e.g. from their own trusted copy of this file), keyed by
  declared path. A packet cannot pass by only matching its own manifest's
  digest of itself; the CLI requires at least one `--expected-protocol
  <declaredPath>=<localTrustedFile>` and every declared protocol file must
  match a pin, not merely be internally self-consistent — and the match must
  be a real bijection: a pin naming a path `protocol_files` never declares
  is refused too, so a caller cannot believe a second frozen document is
  part of the packet while the packet silently disagrees. The local file
  behind a pin is also checked, canonically, to not be the packet's own
  file, a symlink alias of it, or a hard link to it (same device and
  inode) — the packet under test cannot supply its own external truth under
  a different name. This still cannot prove the reference's *historical*
  independence — it is a caller attestation that the file was not lifted
  from this packet, not a signing or provenance system.
- `arms` — one or more review arms (e.g. `gonogo`, `one_pass`), each with a
  **non-empty, unique** `name`. Each arm's declared `review_files` must
  equal, byte for byte, exactly `[evidence.payload_file]` — the same file
  `subject_hash` was computed from, not a second file that merely claims to
  represent it. This makes "the arms declare different review material," or
  "an arm's declared material is something other than what subject_hash
  covers," a structural refusal (`arm_evidence_mismatch`) rather than a gap
  left open by independently-declared, unlinked hashes — and it holds
  regardless of whether a reviewer ever actually opens the file.
  Arm-specific framing goes in a separate, optional `instructions_files`
  list — never in `review_files`. An arm's `evidence_hash` binds *both*
  lists together (review files and instruction files), so changed
  instruction bytes with a stale, un-recomputed `evidence_hash` fail closed
  exactly like changed review bytes would; two arms with the same shared
  evidence but different, correctly recomputed instructions legitimately
  carry different `evidence_hash` values, which stays valid. `subject_hash`
  is never widened to cover instructions — it stays the narrower identity of
  the raw evidence tuple alone.
- Every file everywhere (`protocol_files`, `instrument_files`,
  `review_files`, `instructions_files`) declares a `role`. `answer`,
  `outcome` and `post_cutoff` are real roles a packet can use elsewhere, but
  they may **never** appear in `review_files` or `instructions_files` — that
  is a structural refusal (`forbidden_review_material`), independent of
  whatever `forbidden_markers` does or does not name. A caller-chosen marker
  list that happens to be empty is not, by itself, a guarantee that answer
  or outcome material stays out; the role check is what actually enforces
  that boundary. One physical file (identified by device and inode, so a
  symlink or hard link alias cannot dodge this) is refused a second,
  conflicting role if it appears in a different list elsewhere in the same
  packet — a protocol file cannot separately be declared an instrument file.
  The same file appearing with the *same* role in more than one place (e.g.
  every arm's `review_files` pointing at the one shared evidence file)
  remains legitimate reuse, not a conflict. A duplicate declaration of the
  same physical file *within* one single list is refused regardless of
  role — a list is not a set here, and a repeated entry only pads or
  confuses it.
- `forbidden_markers` — exact strings that must not appear in any arm's
  review-facing or instruction files. This is a named-marker check, not a
  semantic scan; every entry must be a string, and a non-string entry is
  refused rather than silently dropped from the check.
- Every declared path is resolved and checked to stay inside the packet
  directory — a `..` escape, an absolute path, or a symlink whose real
  target is outside the packet is refused (`unsafe_path`) rather than
  followed.

Every named failure carries one of a fixed set of reasons
(`DISQUALIFY_REASON` in `src/packet.ts`): `malformed_metadata`,
`missing_identity`, `unsafe_path`, `protocol_digest_mismatch`,
`payload_digest_mismatch`, `unknown_provenance`, `unknown_exposure_state`,
`forbidden_review_material`, `exposed_case_claims_untouched`,
`exposure_record_not_supplied`, `exposure_record_incomplete`,
`arm_evidence_mismatch`. A packet with any failure never passes; there is no
partial credit.

### Contamination and other limits this check cannot close

Model pretraining contamination cannot be disproved by a manifest: a case
built from public material may already be inside a judge model's training
data regardless of what the packet declares, and no digest, role, or path
check can detect that. `provenance`, `source` and `artifact_provenance` are
operator attestations: the checker validates only that each declared value
has the required shape (e.g. `artifact_provenance` fields are one of
`original`/`missing`/`reconstructed`, `source.base`/`head` are full commit
hashes) — it does not and cannot verify that a declared value is true.
Passing packet validation is a statement about packaging integrity —
declared identity matches an external expectation, every arm's declared
review material references identical bytes, exposure was checked against a
supplied record, disallowed material roles are structurally absent — not a
statement that a case is free of contamination, free of semantic leakage in free text
hidden inside otherwise-legitimate review material, or otherwise a clean
scientific instrument.

### What a future frozen study must still add

This unit defines the contract and ships the checker; it does not freeze a
real study, select a real holdout, or run any real judgment. Before any
accuracy claim is made from packets validated this way, a concrete, reviewed
manifest must additionally state, with no real cases, selection, or
judgments made yet:

- **Feasibility-pilot default.** This rule is for a later reviewed
  inventory; no inventory or pilot is created by this change.
  1. Before selecting or reviewing pilot cases, freeze an inventory of
     unique case IDs, packet locations and packet-manifest SHA-256 digests.
     Record the inventory digest and protocol digest in the pilot record.
     Eligible candidates are evaluation packets declared development
     material or explicitly constructed synthetic evaluation packets.
     Synthetic rating files alone are not candidates.
  2. Sort inventory IDs by UTF-8 byte order and select the first 10, or all
     IDs if fewer exist. Keep that draw fixed. Exclude a selected case if
     its frozen manifest or declared file digests do not match, packet
     validation fails, provenance is unknown, source base/head cannot be
     resolved in the named repository, or its subject hash duplicates an
     earlier valid selected case. Keep the earlier ID for duplicates. Record
     every exclusion; do not replace excluded cases with later IDs.
  3. Review the remaining selected cases in that order. Preserve each
     human's pre-model acceptability label separately from later
     independent adjudication. A reversal occurs only when both labels are
     resolved and the final adjudicated acceptability label differs from
     the initial human label. Unresolved labels, abstentions and tool
     errors remain separate outcomes and are not counted as reversals.
  4. Stop after the second reversal or after every remaining selected case
     has been processed, whichever occurs first. An empty or exhausted draw
     is terminal. Report the draw size, exclusions, cases processed,
     unresolved outcomes, stopping reason and shortfall from 10. Review
     this feasibility result before freezing another inventory.

  This pilot measures feasibility of the comparison procedure, not
  permission for autonomous merging — see the denominator and
  paired-comparison requirements above.
- **Denominators, kept distinct and never inferred from one another.**
  *Error miss rate* — consequential errors GoNoGo failed to flag, divided by
  cases an independent adjudicator later confirms did contain a
  consequential error (the adjudicated-error population). *Unsafe-approval
  fraction* — among cases GoNoGo approved (a "go"-shaped verdict), the
  fraction an adjudicator later confirms should not have been approved.
  *False-positive rate* — among cases an independent adjudicator confirms
  were acceptable, the fraction GoNoGo flagged as a problem. The adjudicated
  reference for every one of these is independent judgment on additional
  evidence; **it is never defined as, or required to agree with, what the
  one-pass baseline reviewer said** — a baseline-agreement requirement would
  make the baseline the ground truth it is supposed to be compared against.
  *Coverage* — cases where every arm produced a usable verdict, divided by
  cases attempted, with abstentions and tool errors reported as their own
  outcomes, not silently folded into either "pass" or "fail." None of these
  are computed by the validator; they are computed later, over a frozen
  sample, and reported with the sample size that supports them — not
  asserted at a precision the sample cannot carry. Unresolved labels stay
  unresolved rather than being defaulted into either denominator.
- **Paired one-pass comparison**, arm-for-arm on identical evidence (the
  `arm_evidence_mismatch` check exists so this pairing cannot silently
  drift), and **human review time** per case, recorded alongside the
  verdict.
- **Human pre-model judgment kept separate from later adjudication.** A
  reviewer's first read, before seeing any model output, is a different
  record from an adjudicated verdict informed by additional evidence
  afterward; the two are never merged into one number, and the adjudicated
  verdict is never backdated to stand in for the reviewer's original,
  pre-model judgment.
- Consistent with the rest of this document: a merged PR, a passing test
  suite, model-family agreement, or one operator's labels are not
  correctness, and a pilot is feasibility evidence for running the study,
  not authorization to merge on its results.

Original missing specs or transcripts are marked `missing` in
`artifact_provenance`, never reconstructed and presented as `original` — a
reconstructed artifact answers a different question than the one this
protocol asks, which is why `reconstructed` disqualifies untouched-holdout
eligibility even when every digest check passes.

### What the numbers do not establish

`gonogo eval` measures the judge against seven labels that the same person wrote
who wrote the prompts. That is a regression test, not evidence of accuracy. It
can prove the judge got worse; it cannot prove it is right. Only the
judge-versus-human agreement in section 2 can begin to do that, and n=0 today:
no human has recorded a rating against a real gonogo run.
