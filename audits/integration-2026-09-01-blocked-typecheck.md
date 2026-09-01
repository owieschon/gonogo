# Successor-G integration gate receipt

- Task: `adapter-with-judge-hardening`
- Recorded: `2026-09-01T14:06:40Z`
- Starting adapter SHA: `06677f6413b8eeb089814f795fa440e2d2eec66c`
- Hardening SHA: `fe7a5d267d3fa1ba21775823f49698b8e66023c9`
- Merge SHA: `8bc8ceb8f69829284d67ec06ad850e5d08a8050b`
- Instrument version at gate: `0.1.6`

The complete deterministic test command passed on the merge commit:

    bun test

Result: 135 passed, 0 failed, 565 expectations across 9 files.

The first TypeScript gate command was then run once:

    bunx tsc --noEmit

It exited nonzero with this exact output:

    error TS2688: Cannot find type definition file for 'bun-types'.
      The file is in the program because:
        Entry point of type library 'bun-types' specified in compilerOptions

`node_modules/` was absent because dependencies had not been installed in this
worktree. The successor-G contract requires a fail-stop on any red prerequisite,
so this execution did not install dependencies and rerun the red gate. It also
did not run the checked-in replay gate, integrated self-judge, version bump, or
paid live eval. No prompt, fixture, threshold, label, or backend was changed.

Smallest next decision: explicitly authorize a fresh successor execution that
runs `bun install` before the deterministic gates and permits a new typecheck.
