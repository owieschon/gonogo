# PR #11 — evidence the self-judge was not shown

**This file was written after the verdict and the judge never saw it.** It does
not revise, soften, or replace anything. The verdict on
`bfe53bb43d362c50e3d732bd48738a0c06d6e2fe` is `hold`, overall 2/4, with
`claim_verification` 2, and it stands exactly as recorded in
[`pr11-post-merge-self-judge-verdict.json`](pr11-post-merge-self-judge-verdict.json).
Nothing below is offered as proof that the finding was wrong.

## Why the judge could not see it

`scripts/self-judge.sh` hard-codes its `--test-cmd` as:

    bunx tsc --noEmit && ./bin/gonogo eval --replay --k 3 --events "$out/eval-events.jsonl"

That is a typecheck and the fixture replay gate. **It does not run `bun test`.**
So the `TEST_RESULT` in the evidence packet could not contain an execution of
`src/packet.test.ts` or `src/packet-cli.test.ts` — the two suites this change
added — no matter what state they were in. The judge said so and was right:

> the supplied TEST_RESULT only shows a typecheck and an unrelated self-judge
> replay run rather than the new packet test suite actually executing

That is a coverage limitation of the self-judge instrument, not a defect this
branch introduced. It is recorded here and left alone; changing the script would
be a source change this audit is not scoped to make.

The second half of the same finding is that the commit messages rest on probe
receipts the commits themselves place outside the repository. Those receipts
exist, they predate this audit, and the decisive excerpts are below.

## The separate test result, at the judged source

Run at `bfe53bb` (tree `ad3bfee436e132c65c62dc7ce10505a3b03ac4e0`, identical to
PR #11 head `39289c5`) after `bun install --frozen-lockfile`:

    $ bun test
     273 pass
     0 fail
     889 expect() calls
    Ran 273 tests across 14 files.

    $ bun test src/packet.test.ts src/packet-cli.test.ts
     61 pass
     0 fail
     128 expect() calls
    Ran 61 tests across 2 files.

The suites themselves are in the reviewed source, not in this audit:
`src/packet.test.ts` (47 tests) and `src/packet-cli.test.ts` (14 tests) at
`39289c557b3e5d52191197462e87550fe005617e`.

## Before/after receipts

All rounds below predate the merge and are reproduced here, not re-run. Each
names the source it ran against. Rounds 0-2 were produced by the implementing
session; round 3's before side comes from an independent OpenAI reviewer's probe
and a controller probe, not from the implementer.

Fixed-width blocks quote receipt output, but they are summarized and abridged
where reformatted for width — not universally exact excerpts. Prose descriptions
and rewritten headings are this file's summary of the receipt, not its output.

### Round 0 — missing feature, not a behaviour

Before `aabd63fc0b35a02a090e837779feccece05dcc38`, the first run of the contract
tests:

    error: Cannot find module './packet.ts' from '<worktree>/src/packet.test.ts'
     0 pass
     1 fail

**Caveat: this is a missing-feature failure.** `src/packet.ts` did not exist
yet. It shows the tests were written first; it does not reproduce any defective
behaviour, and it must not be read as one.

### Round 1 — the first behavioural before/after

New regression tests added on top of `aabd63f`, run before the fix:

    (fail) a packet with no protocol, instrument or review files never passes as untouched
      Expected: false   Received: true
    (fail) a malformed null entry in a declared file list is a named refusal, not a thrown error
      TypeError: null is not an object (evaluating 'f.path')
     11 pass  2 fail

Direct probe of the same two conditions, before:

    EMPTY_REVIEW_AND_NO_PROTOCOL {"ok":true,...,"holdout_eligible":true}
    NULL_ENTRY_THREW TypeError: null is not an object (evaluating 'f.path')

After the fix, committed as `c9f81c1850032c50d388a4ca44f69b0dbc5e1dc1`:

    EMPTY_REVIEW_AND_NO_PROTOCOL {"ok":false,"failures":[
      {"reason":"missing_identity","detail":"packet.json protocol_files declares no frozen protocol document"},
      {"reason":"missing_identity","detail":"packet.json instrument_files declares no frozen judge instrument"},
      {"reason":"missing_identity","detail":"a: review_files declares nothing shown to the reviewer"}]}
    NULL_ENTRY {"ok":false,"failures":[
      {"reason":"malformed_metadata","detail":"protocol_files: a declared file entry is not an object"},...]}

This one is a genuine behavioural before/after: same probe, same two inputs,
accept-and-throw before, named refusals after.

### Round 2 — six acceptance gaps

Before: run against a retained copy of `src/packet.ts` as it stood at `c9f81c1`,
**not against a checkout of that commit**. Summarising the receipt: five
scenarios returned `ok:true` — self-consistent protocol pin with no external
truth; unrelated `review_files` across arms with a matching `subject_hash`; a
declared path escaping the packet directory; a non-string `forbidden_markers`
entry silently dropped; and an omitted exposure log, which the probe reached by
**simulating the old CLI's empty-set default in-process, not by running an
old-CLI subprocess**. One threw, verbatim:

    GAP 5: malformed SubjectInput (missing `test`) crashes instead of refusing
    THREW: TypeError: undefined is not an object (evaluating 'input.test.command')

After, at `4a16ee0ef1315ddbd7b9dac1d7d0b8edc9a67bb0`:

    bun test — 36 pass, 0 fail, 78 expect() calls, 2 files

The after side here is a test-suite result, not the same probe re-run, so it is
weaker evidence than round 1's paired probe.

### Round 3 — seven gaps, and why the obvious re-run proves nothing

Before, at `4a16ee0`, from the independent OpenAI reviewer's probe and a controller
probe, both run unmodified:

    EXTRA PAYLOAD KEY                          {"ok":true,"holdout_eligible":true}
    PROVENANCE/CONTENT CONTRADICTION           {"ok":true,"holdout_eligible":true}
    DUPLICATE ARM NAMES AND FILE DECLARATIONS  {"ok":true,"holdout_eligible":true}
    INSTRUCTIONS CHANGE WITHOUT EVIDENCE_HASH CHANGE
      {"first":{"ok":true},"second":{"ok":true},"evidence_hash_unchanged":true}
    OMITTED EXTERNAL EXPECTATION               {"ok":true,"holdout_eligible":true}

and, from the real CLI, a self-pinned protocol with a bare-array exposure log
was accepted where it should have failed (summary: the receipt records
`"pass":1` alongside the CLI's then-current array-only exposure-log message).

**Caveat, and it is the important one.** Re-running those same unmodified probes
against the corrected head is *not* isolated proof of any of these fixes. Both
probes build their exposure record in the pre-round-3 shape, with no `complete`
field, and one writes a bare-array exposure log. Under the correction every
scenario in them now fails closed on `exposure_record_incomplete` or the CLI's
schema rejection **regardless of whether the specific targeted defect was
fixed** — the new gate fires first and masks everything behind it. That re-run
receipt exists and is retained privately with this caveat attached to it; it is
not cited here as evidence.

The isolated proof is a separately named, schema-adapted probe that supplies a
valid, complete exposure record so that gate cannot mask anything, confirms an
unmodified control packet still passes, then mutates exactly one dimension at a
time. Run on the tree committed as `ee124c2bde221adf5b56d6f9dc0a390528a0743d`:

    CONTROL: unmodified valid packet must pass
      {"ok":true,"holdout_eligible":true,"subject_hash":"dc130bec...bda500"}
    FINDING 1 (extra payload key)              {"ok":false,"reasons":["malformed_metadata"]}
    FINDING 4 (provenance contradiction)       {"ok":false,"reasons":["malformed_metadata","malformed_metadata"]}
    FINDING 6 (duplicate arm/file names)       {"ok":false,"reasons":["malformed_metadata","malformed_metadata"]}
    FINDING 2 (self-pinned protocol, real CLI) exit 3 — "--expected-protocol local file ... must not
                                               be the packet's own file, or a symlink/hard-link alias of it"
    FINDING 3 (exposure log missing `complete`, real CLI)
                                               exit 3 — "must declare \"complete\": true or false"
    FINDING 2 (pin covers an undeclared path)  {"ok":false,"reasons":["protocol_digest_mismatch"]}
    FINDING 5 (stale evidence_hash after changed instruction bytes)
      before {"ok":true,...}  after_stale_hash {"ok":false,"reasons":["payload_digest_mismatch"]}
      subject_hash unchanged throughout

Two limits on that block. The probe's own heading for FINDING 3 says "valid
external pin", and **that label is wrong**: the trusted copy it pins against is
written inside the packet directory. Exposure-log completeness is parsed and
rejected before the pin is examined, so the scenario still demonstrates what it
names — the `complete` field being required — but it is not evidence about
external pinning. The real-CLI tests at `src/packet-cli.test.ts:123` and `:272`
at `39289c5` use independently created external trusted copies to cover
incomplete exposure and undeclared expected paths. The controller assertive
probe separately exercises `validatePacket` in-process; it is not a CLI
subprocess receipt.
And because the probe was adapted to the new exposure schema, this is a
**schema-adapted control, not a like-for-like re-run** of the before probe; the
`CONTROL` line is there so the reader can see the adapted probe still admits a
valid packet rather than failing everything by construction.

## What this file does not establish

- It was not in evidence. `claim_verification` 2 is not answered by it.
- Every probe uses synthetic temporary data. No real case, holdout, outcome,
  judge run, model result or tracked event log was touched by any of them.
- Rounds 2 and 3 compare across differently shaped programs, and one round-2
  scenario is simulated rather than reproduced against the old CLI, as flagged
  above. Only round 1 is a paired, identical-probe before/after.
- One model review is not human calibration.
- No product source, prompt, rubric, threshold, fixture, replay receipt or model
  result was changed to produce this file, and no earlier commit was rewritten.

## Sanitization

Quoted output is abridged and reformatted where noted: random temporary directories are shortened to
`<tmp>`, the worktree path in the round-0 error to `<worktree>`, long hashes to
their first and last bytes, and repeated `failures` entries elided with `...`.
Scenario headings in rounds 2 and 3 are this file's labels, not receipt output.
No reason name, digest, verdict, count or finding was altered. The unedited
originals are retained privately with the rest of this audit's receipts. These
receipts carry no cost, token or usage figures; the one field redacted anywhere
in this audit is `provenance.cost_usd` in the public verdict copy.
