#!/usr/bin/env bash
#
# Run gonogo on this repository's own uncommitted or branch changes.
#
#   scripts/self-judge.sh --spec SPEC.md [--base main] [--out audits/<name>]
#
# The tool judges its own development. Commit the verdict you get.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
spec=""
base="main"
out=""
extra=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec) spec="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --out)  out="$2";  shift 2 ;;
    *)      extra+=("$1"); shift ;;
  esac
done

if [[ -z "$spec" ]]; then
  echo "usage: scripts/self-judge.sh --spec <file> [--base main] [--out <dir>]" >&2
  echo "  --spec is the task prompt this session was given. SPEC.md is session 001's." >&2
  exit 2
fi

if [[ -z "$out" ]]; then
  out="$root/runs/self-$(date -u +%Y%m%dT%H%M%SZ)"
fi

echo "self-judging $root against $base with spec $spec"
echo "the tool is the subject here, not the operator"

# --test-cmd is the repo's own gate: typecheck plus the fixture set in replay
# mode, so self-judging never spends a live judge call per fixture.
exec "$root/bin/gonogo" judge \
  --spec "$spec" \
  --repo "$root" \
  --base "$base" \
  --test-cmd "bunx tsc --noEmit && ./bin/gonogo eval --replay --k 3" \
  --max-diff-chars 400000 \
  --out "$out" \
  "${extra[@]}"
