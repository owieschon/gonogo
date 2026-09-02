# SPEC — real-event-privacy, review correction

The brief this session was assigned, frozen into the repository before review so
that a reviewer or a judge scores the work against the request rather than
abstaining for want of one. It supersedes nothing: it is the correction round on
`hardening/real-event-privacy` (PR #5), whose first round is the five commits up
to `07ec4e5a`.

## The defect being corrected

The destination boundary added in `d7cad60` decided policy on a lexically
normalized path and then performed every filesystem operation on the path as
typed. `path.resolve` collapses `..` before any symlink is followed, so with a
symlink pointing into this checkout:

    ln -s <checkout>/private /tmp/escape
    gonogo judge ... --events /tmp/escape/../events.jsonl

the boundary saw `/tmp/events.jsonl` — outside the checkout, allowed — while
`open(2)` followed the symlink first and appended a `real` subject event to the
committed `events.jsonl` at the checkout root. Reproduced against `07ec4e5a`
before any correction was written.

## Objective

Make the file the boundary checks and the file the boundary writes the same
file, prove it, and describe the result without overclaiming. This is a
correction to an existing guard, not a new capability.

## Requirements

1. Reproduce the symlink-plus-`..` bypass against `07ec4e5a` before correcting
   it.
2. Normalize the destination exactly once. That one string is what the policy
   decision uses and what every read, existence check, directory creation and
   append uses. The checked file and the written file must be the same file.
3. Add regression coverage proving the bypass cannot append to the tracked
   `events.jsonl`, and that an allowed write lands at the validated
   destination.
4. Test the CLI's new default routes rather than passing `--events` in every
   case.
5. Use the canonical path comparison in the `calibrate` private-log hint.
6. Correct `AGENTS.md` and the pull request text: the four synthetic rater rows
   in the tracked log are calibration fixtures, not this repository's
   self-judgements.
7. State the boundary honestly. Do not claim it closes final-component TOCTOU,
   alternate mount aliases, or case-insensitive filesystems on Linux unless
   those are implemented and proven. Do not add device-number logic.
8. Change no prompt, rubric, dimension, score, threshold, model or unrelated
   event semantic. Preserve fixture and replay compatibility, and preserve
   every commit and every retained failed receipt.
9. Run the focused and full deterministic tests, the typecheck, the replay
   evaluation gate, a diff and scope scan, and a secret scan.
10. Run the required self-judge exactly once against this spec and retain the
    first result whatever it says. No reroll.
11. Commit and push `hardening/real-event-privacy`, rebased on the corrected
    head of `hardening/calibration-provenance`, and update the existing
    user-owned PR #5 only. Do not merge and do not publish elsewhere.

## Where this run's own output goes

`scripts/self-judge.sh` writes the verdict, the evidence packet and the raw
judge passes to `<repo>/runs/<timestamp>/` — the subject repository's own
`runs/` directory, which is gitignored — unless the operator passes `--out`,
in which case they go exactly where `--out` names. The judge event itself is a
`kind: real` subject event and goes to the destination this branch made the
default, `private/events.jsonl`, which is gitignored, or to an explicit
`--events` path outside the checkout. Only the verdict a session chooses to
copy under `audits/` becomes part of the committed repository.

## Done

The bypass is reproduced and closed; one normalization serves the decision and
every filesystem operation; the regression tests fail against `07ec4e5a` and
pass against the correction; the CLI defaults are covered without `--events`;
the `calibrate` hint compares canonically; the synthetic rater rows are
described correctly; the unclosed cases are named as unclosed; the scoring
instrument, the fixtures and the replay store are unchanged; the deterministic
gates pass; one self-judge verdict exists and is committed unedited; and PR #5
is updated on the corrected base without being merged.

## Second correction round — the dangling final symlink

Review of the corrected boundary found a second way past it, verified before
this round began.

`canonicalPath` runs `realpath` on each prefix and keeps the lexical spelling
when that fails. `realpath` fails on a symlink whose target does not exist, so
a dangling link kept its own spelling. A link outside the checkout pointing at
a path inside it was therefore approved as "outside the checkout", and
`appendFileSync` then followed the link and created its target inside the
public checkout. Reproduced against the restacked head `2b57307`: the link
resolved to itself, `isPublishedLocation` was false, the write succeeded, and
the target existed inside the checkout afterwards holding the `real` event.

### Requirements

1. Reproduce the dangling-final-symlink bypass before correcting it.
2. Resolve such a component instead of keeping its spelling: read the link and
   continue the walk at the target, so the destination the policy decides on is
   the file `open(2)` will create. A link chain that never resolves is refused.
3. Add regression coverage that fails before the correction and proves the
   public-checkout target remains absent.
4. Preserve the symlink-plus-`..` regression, the explicit private and outside
   destinations, the tracked-log protection, the CLI defaults, the canonical
   `calibrate` comparison and the replay fixtures.
5. Claim nothing more. Final-component TOCTOU, alternate mount aliases,
   case-insensitive filesystems on Linux and the `runs/` output remain
   unclosed and are still named as unclosed.
6. Change no prompt, rubric, dimension, score, threshold, model or unrelated
   event semantic, and add no dependency. Preserve every commit, every earlier
   receipt and both failed self-judge attempts. No further self-judge is run
   this round.
