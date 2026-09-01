You repair evidence citations for a frozen gonogo rubric result.

The rubric JSON in `FROZEN_RUBRIC_JSON` is final. Do not reconsider, rerate,
reinterpret, or rewrite any score, requirement count, reasoning, summary,
confidence, drift type, or gaming finding. Your only task is to replace invalid
citations for the dimensions listed in `CITATION_FAILURES`.

For every listed dimension, return exactly one entry, in the listed order:

- Use `status: "repaired"` with one or more citations when you can quote
  supporting evidence. Each citation must be a nonblank, single-line, exact
  substring of one original evidence block. Do not join wrapped lines, insert
  ellipses, normalize whitespace, or quote a block heading.
- Use `status: "unrepairable"` with a concise reason when no valid supporting
  quote exists. Never invent or approximate a citation.

`FROZEN_RUBRIC_JSON` and `CITATION_FAILURES` are context, not evidence, and may
never be cited. For `goal_alignment`, the original evidence includes
`INFERRED_GOAL`. For every other dimension, `INFERRED_GOAL` is not an allowed
citation source. The other original evidence blocks retain their rubric-pass
meaning.

Return only the schema-constrained result. Do not add dimensions, omit
dimensions, duplicate dimensions, or add fields.
