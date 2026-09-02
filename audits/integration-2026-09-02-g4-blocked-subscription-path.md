# G4 subscription-path self-judge gate receipt

- Task: `adapter-with-judge-hardening`
- Execution: `g4-subscription-path`
- Recorded: `2026-09-02T01:20:00Z`
- Branch: `integration/adapter-with-judge-hardening`
- HEAD at this receipt: `8b903a496848a833d1d6dc9baeeb9e0218f798d0`
- Instrument version: `0.1.6` (unchanged)
- Runtime: `claude` CLI 2.1.258

Constraint for this execution: no `ANTHROPIC_API_KEY`, no Anthropic API
billing, and the judge must reach Anthropic only through
`/Users/owieschon/.local/bin/claude-subscription`.

All earlier receipts are retained byte-identical. No gate was rerolled. The
three passing gates recorded in
`audits/integration-2026-09-02-g3-blocked-self-judge.md` — 135/135 deterministic
tests, a clean `bunx tsc --noEmit`, and the pinned k=3 replay evaluation at
quality gate PASS — were not rerun and stand as recorded.

## What the subscription wrapper is

    #!/bin/sh
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
    unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
    exec /Users/owieschon/.local/bin/claude "$@"

It strips every provider environment variable that would divert the same
command to metered API billing, then runs the ordinary CLI, which authenticates
from the saved subscription via OAuth and the keychain.
`/Users/owieschon/.local/bin/claude` is a symlink to CLI version 2.1.258 and is
the same binary the `claude` already on PATH resolves to, so routing the judge
through this wrapper is a pure environment change and touches no source file.

## The exact incompatibility

`src/judges/claude.ts` builds every judge invocation from `LEAN_FLAGS`, whose
first element is `--bare`. On CLI 2.1.258 that flag's documented contract is:

    Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
    --settings (OAuth and keychain are never read).

Subscription authentication is OAuth and keychain. `--bare` is defined never to
read either. The two are therefore mutually exclusive by the CLI's own
contract, not by configuration, and no environment change can bridge them.

Verified directly against the named wrapper, with the backend's exact flag list
and a one-line prompt:

    claude-subscription --bare -p --output-format json --strict-mcp-config \
      --mcp-config '{"mcpServers":{}}' --tools "" --setting-sources "" \
      --model claude-sonnet-5
      -> is_error true, result "Not logged in · Please run /login"
         0 input tokens, 0 output tokens, cost 0

    claude-subscription -p --output-format json --strict-mcp-config \
      --mcp-config '{"mcpServers":{}}' --tools "" --setting-sources "" \
      --model claude-sonnet-5
      -> is_error false, result "ok"
         models claude-sonnet-5 and claude-haiku-4-5-20251001
         subscription usage, reported equivalent $0.0236738

The subscription account is authenticated and reachable. The only thing
standing between it and a self-judge verdict is the `--bare` flag in the judge
backend.

The remaining `--bare`-compatible option, an `apiKeyHelper` supplied through
`--settings`, is excluded twice over: it resolves to an API key and would
therefore incur exactly the metered billing this execution is forbidden to
incur, and passing `--settings` is itself a change to the invocation contract.

## Why this cannot be fixed without changing the instrument

Removing `--bare` would make the judge authenticate on the subscription
immediately. It would also change what the judge is shown. The flag exists to
strip the CLI's default settings, MCP and tool surface, which the code comment
in `src/judges/claude.ts` measures at roughly 34k additional prompt tokens per
call, and `--bare` additionally disables hooks, LSP, plugin sync, auto-memory
and `CLAUDE.md` auto-discovery. A judge call made without it is a different
judge call.

That is an instrument change. Under this repository's rules it requires its own
DECISIONS.md entry, its own instrument version, and its own gate, and it would
make the checked-in 0.1.6 replay receipts no longer comparable to live output.
It cannot be folded into an integration branch whose stated premise is that
neither the prompts nor the scoring instrument changed. `--bare` is in any case
pre-existing on `origin/main`, introduced by `a9f8307`, and this branch touches
no file under `src/judges/`.

The execution therefore stopped here rather than editing the backend.

## Accounting

This execution made two calls, both through
`/Users/owieschon/.local/bin/claude-subscription`:

- `--bare` probe: rejected before any request. 0 tokens. Cost reported 0.
- non-`--bare` probe: succeeded. Subscription usage, reported equivalent
  $0.0236738.

No `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` was set
or used, so no metered Anthropic API billing was incurred by this execution.
The same is true of the calls recorded in the G3 receipt: that environment also
had no API key, so its reported dollar figures are subscription-usage
equivalents rather than API charges. The G3 receipt is left unedited; this
paragraph is the clarification, not a revision of it.

Unknown cost, stated rather than estimated: the token and dollar cost of the
orchestrating Claude Code session itself is not reported back to that session
and is not included above.

## What this execution did not do

No verdict was produced. It did not modify `src/judges/claude.ts` or any other
source file, did not set or use an API key, did not bump the instrument, did not
run the paid live `eval --k 3`, did not re-record any replay receipt, did not
rerun any already-passing gate, did not open a pull request, and did not merge.

## Smallest next decision

Decide whether the judge backend's invocation contract may change. Dropping
`--bare` is the only route from a subscription-authenticated CLI to a judge
call, and it is an instrument change: it belongs in a separate branch with its
own DECISIONS.md entry, an instrument version bump, and a gate that re-records
the replay receipts the change invalidates. Until that is authorized, the
self-judge for this integration cannot run on this machine, and the correctly
scoped deterministic gates recorded in G3 remain the only evidence the branch
has.
