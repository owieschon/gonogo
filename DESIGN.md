# DESIGN

Why gonogo is shaped the way it is. RUBRIC.md says how work is scored; this says
why there is a judge at all, and what must stay true of it. The invariants below
are law. A change that breaks one is not an improvement to gonogo, it is a
different tool wearing its name.

## The verification hierarchy

Verification sources, ranked by independence from the worker that did the work:

- **L1 — World adjudication.** Compilers, tests, runtime behaviour. Deterministic.
  No mind involved, so no mind to persuade.
- **L2 — Structural constraints.** Human judgment encoded once and applied
  forever without a mind: lints, CI gates, banned patterns, type systems.
- **L3 — Independent human judgment.** Ground truth. Does not scale, which is
  the entire problem.
- **L4 — Independent LLM judgment.** A different mind reading the evidence.
- **L5 — Self-judgment.** The worker attesting its own work.

The industry ships L5 and calls it verification. An agent finishes a task,
writes "all tests pass, ready to merge", and that sentence is treated as a
result rather than as a claim. gonogo exists to make **L4 rigorous**: anchored
in L1 wherever a deterministic fact can settle a sub-question, calibrated
against L3, and never confused with L2. gonogo is not CI. It does not gate.

## Why L5 fails

- **Motivated cognition.** By the end of a session the worker already believes
  it succeeded. Its transcript is not a record of what happened; it is the
  rationalisation that accompanied it.
- **Shared context.** The worker verifies from inside the same narrative that
  produced the mistake. If it misread the spec at the start, it misreads the
  spec again when checking.
- **Goodhart under self-report.** Claims are free and evidence is expensive. A
  process that accepts claims will get claims, optimised.

## Invariants

These are law, not style.

- **I1 — Separation.** The worker never grades itself. gonogo may share a model
  family with the worker, but never its session, its context, or its stake in
  the outcome.
- **I2 — Blind-first.** The goal-inference pass runs before the judge sees the
  spec, and is enforced in code: the blind packet is a distinct type built from
  the evidence with the spec absent by construction, not a prompt that politely
  declines to mention it.
- **I3 — Evidence over testimony.** Transcript and commit-message statements are
  **claims to verify**, never evidence of success — that is what
  `claim_verification` is for. Diff, test output and runtime artifacts outrank
  anything the worker said about them.
- **I4 — Anchor low.** Wherever an L1 fact can decide a sub-question — did the
  tests run, what changed, did it compile — the pipeline uses the fact and the
  judge interprets only the residue. The judge is asked the questions no
  compiler can answer, and no others.
- **I5 — Minimum, abstention, no averaging.** The overall verdict is the minimum
  across dimensions. Thin evidence produces an abstention, and an abstention
  caps the verdict at `inconclusive`. Nothing averages past a failure.
- **I6 — Calibration over belief.** gonogo never asks to be trusted; it asks to
  be measured. Judge-versus-human agreement per dimension is the only trust
  currency it accepts. A thermometer is trusted because it was calibrated, not
  because it seems smart.
- **I7 — Provenance.** Every verdict is reproducible: model version, prompt file
  hashes, tool version, evidence hashes, timestamps.

## Known limits

- **Correlated blind spots.** The judge and the worker share a training
  distribution and can be wrong in the same way about the same thing. A
  cross-family panel decorrelates this partially and never fully. L1 anchoring
  and L3 sampling bound the damage; nothing removes it.
- **Judge-awareness.** Once workers know a judge exists, they will perform for
  it. This is expected — it is Goodhart, not betrayal — it is a research finding
  the moment it is observed, and it is why calibration never stops. Judge events
  record whether the worker was told it would be judged, so the effect can be
  measured rather than argued about.
- **The judge will be wrong.** Not might be. The calibration log is what turns
  that from an embarrassment into a measurement.

## The trust ratchet

Trust is earned differentially, per dimension, and never fully.

- **Phase 1.** Judge everything *and* human-review everything. Log agreement.
  This is where gonogo is today: n=0 real pairs.
- **Phase 2.** Dimensions with a recorded agreement track record earn lighter
  human review. Dimensions that disagree keep full attention. The ratchet turns
  per dimension, not per tool.
- **Endpoint.** Any automatic action — auto-merge above all — requires all four
  of: deterministic gates covering the catastrophic classes, a small blast
  radius, a recorded agreement track record for the dimensions being relied on,
  and permanent sampling that never goes to zero.

gonogo is a smoke detector, not a fire department. It changes where scarce human
attention goes. It does not replace the gates.
