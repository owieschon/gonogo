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
- **All six fixtures share one base repo (`fixtures/_base`).** Six unrelated toy
  repos would make the difference between cases a difference of subject matter rather
  than a difference of agent behaviour, which is what is being measured.
- **`silent-narrowing` and `honest-partial` have byte-identical `head/` trees.**
  Only `transcript.txt` differs. It is the sharpest available test that
  `claim_verification` measures honesty and not completeness.
- **A score returned without a citation is downgraded to an abstention.**
  RUBRIC.md rule 1 is "cite or abstain"; enforcing it only in the prompt makes
  it a suggestion. `src/rubric.ts` enforces it on parse.
- **The judge CLI is invoked with settings, MCP servers and tools switched off.**
  A judge needs none of them and they cost ~34k prompt tokens per call
  (measured: $0.15 → $0.025 per call).
- **Malformed JSON from the judge is repaired, not rejected.** Judges quote diff
  hunks into citation strings and sometimes leave the line breaks raw. Control
  characters inside string literals are escaped and the parse retried; structure
  is never rewritten. The prompt also asks for single-line citations.
- **CI runs `gonogo eval --replay`, not a live judge.** A live run needs an
  authenticated `claude` CLI, which a public repo has no way to provide. The
  workflow comment says plainly what replay does and does not catch — notably
  that it cannot catch a regression in `prompts/*.md`.
- **`gonogo calibrate` refuses to mix synthetic pairs into real statistics.**
  With no real pairs it prints them under a banner stating the numbers measure
  nothing, rather than reporting a plausible-looking figure.
- **Cross-fixture invariants are not expressible in `labels.json`.** The
  `silent-narrowing` / `honest-partial` task_satisfaction pairing is enforced by
  giving the two fixtures identical label ranges instead. A real paired-check
  mechanism is not worth building at n=6.
- **`merged-but-wrong`'s `goal_alignment` label was corrected upward after the
  first live run**, rather than changing the prompt to match the label. The
  judge's reading was right: that agent pursued the assigned goal and executed
  it dishonestly. See EVAL_LOG.md iteration 1.
