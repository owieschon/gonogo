# Native input adapters

Add two input modes to the existing `gonogo judge` pipeline. They collect
native metadata and then use the same evidence collector, prompts, rubric,
verdict arithmetic, reports, events, and exit codes as an explicit-input run.

## Superset workspace

- `gonogo judge --workspace <id>` resolves the local worktree, task/workspace
  identity, assigned task, base commit, and available terminal transcript from
  Superset's supported CLI surfaces.
- An explicit `--spec`, `--repo`, `--base`, `--transcript`, or `--task` wins
  over the discovered value. If Superset cannot expose the assigned task, fail
  and require `--spec`; do not infer it from a workspace name.
- Include a live, no-judge integration check. It is intentionally skipped in
  public CI, where Superset is not installed and no live workspace exists.

## GitHub pull request

- `gonogo judge --pr <url|number>` judges a clean local checkout at the exact
  remote PR head. The linked closing issue defines the assigned spec, the PR
  body is worker testimony, and the PR base OID is the diff base.
- If no closing issue defines the task, fail and require `--spec` rather than
  treating implementer-authored PR text as ground truth.
- For stacked work, stop at the first detected unjudged dependency. A public
  adapter that cannot prove a current dependency verdict must fail closed.

## Boundaries

- Adapter transcript bytes participate in the complete model-independent
  `subject_hash` before rendering or truncation.
- Do not change prompts, scoring, fixture labels, judge backends, or event
  schema. Do not add merge automation or a second verdict path.
- Keep private QC procedure, inspection ledgers, and campaign findings outside
  this public repository.
