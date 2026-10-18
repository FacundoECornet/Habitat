#!/usr/bin/env bash
# restore.sh — thin Bash shim over the single cross-platform Node engine.
#
# The real implementation lives in tools/restore.mjs (D-01: one engine on every
# platform). This shim exists so existing callers, docs, and the developer-side
# Bash test suites keep invoking `scripts/restore.sh` unchanged.
#
# Usage: scripts/restore.sh [--dry-run] [--verify] [--no-models] [--no-cli]

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="$script_dir/../tools/restore.mjs"

if [ ! -f "$engine" ]; then
  printf 'restore: engine-missing (expected tools/restore.mjs)\n' >&2
  exit 2
fi

exec node "$engine" "$@"
