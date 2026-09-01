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
   anchors in RUBRIC.md. The schema is in `src/types.ts` (`HumanFile`) and an
   example is in `calibration/synthetic/`.
2. The human verdict is recorded **after reading the diff and before reading
   the judge's verdict**, and the file records who reviewed it. A human score
   written after reading the machine's score measures anchoring, not agreement.
3. `gonogo calibrate` recursively discovers human ratings. A standalone rating
   is shown as review evidence but never counted as agreement. A directory that
   also holds the same run's `verdict.json` reports, per dimension: exact
   agreement, agreement within one point, mean absolute difference, and the
   direction of disagreement — how often the judge was harsher than the human
   and how often the reverse.
4. Disagreements are published individually, not just in aggregate. A summary
   statistic hides the cases that matter most, which are the ones where the
   judge was confidently wrong.
5. Target: 30 days of real usage before any accuracy claim is made about the
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
0.1.3. Runs across versions are reported separately and never pooled silently
into one agreement figure.

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

### What the numbers do not establish

`gonogo eval` measures the judge against seven labels that the same person wrote
who wrote the prompts. That is a regression test, not evidence of accuracy. It
can prove the judge got worse; it cannot prove it is right. Only the
judge-versus-human agreement in section 2 can begin to do that, and n=0 today.
