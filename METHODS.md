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
3. `gonogo calibrate` aggregates every directory that holds both a
   `verdict.json` and a `human.json` and reports, per dimension: exact
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

### What the numbers do not establish

`gonogo eval` measures the judge against six labels that the same person wrote
who wrote the prompts. That is a regression test, not evidence of accuracy. It
can prove the judge got worse; it cannot prove it is right. Only the
judge-versus-human agreement in section 2 can begin to do that, and n=0 today.
