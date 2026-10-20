#!/usr/bin/env bash
# install-hooks.sh — activate the versioned .githooks gate, repository-local
#
# What it does:
# Resolves the Git work-tree that contains this script, sets the LOCAL
# `core.hooksPath` to `.githooks`, verifies the setting, and marks the
# pre-commit hook executable.
#
# Policy:
# Repository-local configuration ONLY. Global Git config is never written, so
# unrelated repositories are never affected. Fails with a named error outside
# a Git work tree or on any configuration failure.
#
# Usage:
# bash scripts/install-hooks.sh

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'install-hooks: not inside an existing Git work tree\n' >&2
  exit 1
}
[ -n "$ROOT" ] || {
  printf 'install-hooks: could not resolve the Git work-tree root\n' >&2
  exit 1
}

HOOK="$ROOT/.githooks/pre-commit"
[ -f "$HOOK" ] || {
  printf 'install-hooks: missing versioned hook at .githooks/pre-commit\n' >&2
  exit 1
}

git -C "$ROOT" config --local core.hooksPath .githooks || {
  printf 'install-hooks: failed to set repository-local core.hooksPath\n' >&2
  exit 1
}

chmod +x "$HOOK" || {
  printf 'install-hooks: failed to mark pre-commit executable\n' >&2
  exit 1
}

CONFIGURED="$(git -C "$ROOT" config --local --get core.hooksPath 2>/dev/null || true)"
[ "$CONFIGURED" = ".githooks" ] || {
  printf 'install-hooks: verification failed, core.hooksPath=%s\n' "$CONFIGURED" >&2
  exit 1
}

printf 'install-hooks: core.hooksPath=%s (repository-local)\n' "$CONFIGURED"
