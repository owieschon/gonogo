# G2 dependency-first integration gate receipt

- Task: `adapter-with-judge-hardening`
- Execution: `g2-dependency-first`
- Recorded: `2026-09-01T14:44:30Z`
- Branch: `integration/adapter-with-judge-hardening`
- Starting and gate HEAD: `6538cacb916bd58a3a6dad8d25f2449f966b4ee8`
- Adapter ancestor: `06677f6413b8eeb089814f795fa440e2d2eec66c`
- Hardening ancestor: `fe7a5d267d3fa1ba21775823f49698b8e66023c9`
- Merge ancestor: `8bc8ceb8f69829284d67ec06ad850e5d08a8050b`
- Instrument version at gate: `0.1.6`

The branch, HEAD, all three ancestors, clean index/worktree, and remote branch
at the same SHA were verified before changing state. The original G1 receipt at
`audits/integration-2026-09-01-blocked-typecheck.md` was not changed; its Git
blob remains `a7831577ac066597e065dbd70996d66b19e69d58`.

The authorized first state-changing command ran exactly once:

    bun install

It exited 0 under Bun 1.4.0, installed five packages including
`@types/bun@1.4.0` and `typescript@5.9.3`, and created the ignored
`node_modules/` directory. Neither `bun.lock` nor `package.json` changed.
`bun.lock` retained SHA-256
`e9ccb1b5aed32694d42433676d62cabbe9c2bd44db6cfca1228610c60fbaf3c1`.

The first deterministic gate command then passed:

    bun test

Result: 135 passed, 0 failed, 565 expectations across 9 files.

The TypeScript gate command then passed with no output:

    bunx tsc --noEmit

The checked-in replay gate was the first red gate:

    ./bin/gonogo eval --replay

It exited 3. Its exact output was:

```text
  replay adjacent-solve run 1/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/598662e9b8850e05-1.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay adjacent-solve run 2/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/598662e9b8850e05-2.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay adjacent-solve run 3/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/598662e9b8850e05-3.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay clean-pass run 1/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/af54dd4ce32f641c-1.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay clean-pass run 2/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/af54dd4ce32f641c-2.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay clean-pass run 3/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/af54dd4ce32f641c-3.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay gamed-judge run 1/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/11e5c800ad82c607-1.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay gamed-judge run 2/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/11e5c800ad82c607-2.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay gamed-judge run 3/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/11e5c800ad82c607-3.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay honest-partial run 1/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/b2cd1658f14b7cbb-1.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay honest-partial run 2/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/b2cd1658f14b7cbb-2.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay honest-partial run 3/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/b2cd1658f14b7cbb-3.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay merged-but-wrong run 1/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/bc37b9e70eab0424-1.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay merged-but-wrong run 2/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/bc37b9e70eab0424-2.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay merged-but-wrong run 3/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/bc37b9e70eab0424-3.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay scope-creep run 1/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/27f2190d591648cc-1.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay scope-creep run 2/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/27f2190d591648cc-2.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay scope-creep run 3/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/27f2190d591648cc-3.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay silent-narrowing run 1/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/0fe834477101a31d-1.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay silent-narrowing run 2/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/0fe834477101a31d-2.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  replay silent-narrowing run 3/3
    run failed: no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/0fe834477101a31d-3.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
gonogo: no judge events for this sweep in /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/events.jsonl. First error:
no recorded judge output at /Users/owieschon/.superset/worktrees/03f19dc8-78cc-45c9-814e-9925cfba68fb/integration/adapter-with-judge-hardening/replay/v2/5e4b5e254a1ba6ad/48375b8b1e5a9551/598662e9b8850e05-1.json for backend claude-cli, instrument 0.1.6, and backend-selected model.
  --replay serves recorded output only. Either the prompt, evidence, backend,
  model, or instrument changed, or this sample was never recorded. Re-record
  with --record against a live judge.
```

Accounting: 21 replay samples were scheduled and observed as cache misses; no
provider call was made, no tokens were consumed, provider-reported and
API-equivalent cost were both $0, no judge event was appended, and no verdict
was produced. Existing pinned 0.1.6 receipts remain untouched. The failed
unpinned lookup used replay identity prefix `5e4b5e254a1ba6ad`; the checked-in
0.1.6 `claude-sonnet-5` receipts use identity prefix `337bde4aa4b42180`.

The fail-stop contract ended the execution here. It did not run the 0.1.7
version reconciliation, final deterministic suite, final typecheck, integrated
self-judge, paid live evaluation, integrity/secret/scope/diff checks, commit, or
push of product changes. The only post-failure repository action is the audit
commit retaining this receipt on the integration branch. It created no PR and
performed no merge.

Smallest next decision: authorize a fresh successor execution whose replay gate
explicitly pins the receipt model, for example
`GONOGO_CLAUDE_MODEL=claude-sonnet-5 ./bin/gonogo eval --replay`. This G2
execution must not rerun it.
