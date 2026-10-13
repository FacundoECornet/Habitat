#!/usr/bin/env bash
# check-path-leaks.sh — fail-closed absolute-path portability scan (D-13/D-14)
#
# What it does:
#   Scans the staged Git index blobs plus tracked and untracked candidate files
#   for machine-bound absolute paths from two families: the Linux home-root
#   absolute-path family and the Windows-mounted user-profile absolute-path
#   family. On any nonallowlisted match it exits nonzero and reports ONLY the
#   candidate path, the rule name, and the line number — never the matched text.
#
# Fail-closed policy:
#   Only grep status 1 (no selected lines) is clean. Status 0 is a path leak.
#   Any other grep status, a Git enumeration error, or an unreadable file blocks
#   with a named `scan-failed` reason.
#
# Home-root refusal:
#   A supplied repository root that resolves to $HOME is refused BEFORE any file
#   traversal, so a home-rooted planning harness can never be scanned broadly.
#
# Symlinks:
#   Worktree symlinks are never followed and never read; they are skipped.
#
# Bypass limitation:
#   This is a normal-workflow gate, not a security boundary. It does not defend
#   against a caller that deliberately supplies a different, unrelated root.
#
# Usage:
#   scripts/check-path-leaks.sh [repo-root]
#
# NOTE: `set -e` is deliberately omitted — grep exit statuses are handled
# explicitly. Only `set -u` and `set -o pipefail` are enabled.

set -u
set -o pipefail

# --- detector expressions assembled from fragments --------------------------
# Neither family is written as a complete literal, so scanning this script's own
# source cannot self-match the detector.
F_SLASH='/'
F_HOME='home'
F_MNT='mnt'
F_C='c'
F_USERS='Users'
F_NEVER='[^[:space:]/]+'

REEN_HOME="${F_SLASH}${F_HOME}${F_SLASH}${F_NEVER}"
REEN_WIN="${F_SLASH}${F_MNT}${F_SLASH}${F_C}${F_SLASH}${F_USERS}(/[^[:space:]]*)?"

RULE_NAMES=( 'home-absolute-path' 'windows-user-path' )
RULE_ERES=( "$REEN_HOME" "$REEN_WIN" )

# --- canonical documentation exceptions (exact path AND exact content) ------
# Only the locked planning docs may carry the intentional example of both
# families, and only on the exact line below. Whole files are never exempt.
H_EXAMPLE="${F_SLASH}${F_HOME}${F_SLASH}<user>"
W_EXAMPLE="${F_SLASH}${F_MNT}${F_SLASH}${F_C}${F_SLASH}${F_USERS}"
CANON_D13="- **D-13:** Absolute-path scan is fail-closed: \`grep -rEn\` over versioned files for \`${H_EXAMPLE}\` and \`${W_EXAMPLE}\`; capture aborts on hit; small allowlist for intentional refs only."

allowlist_check() {
  local path="$1" text="$2"
  case "$path" in
    .planning/phases/01-inventory-exclusions-manifest/01-CONTEXT.md|\
    .planning/phases/01-inventory-exclusions-manifest/01-RESEARCH.md)
      ;;
    *) return 1 ;;
  esac
  [ "$text" = "$CANON_D13" ] && return 0
  return 1
}

# --- resolve the repository root --------------------------------------------
ROOT_INPUT="${1:-}"
if [ -z "$ROOT_INPUT" ]; then
  ROOT_INPUT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    printf 'PATH LEAK: scan-failed (not inside a Git work tree)\n' >&2
    exit 2
  }
fi
[ -n "$ROOT_INPUT" ] || {
  printf 'PATH LEAK: scan-failed (empty repository root)\n' >&2
  exit 2
}

ROOT="$(cd "$ROOT_INPUT" 2>/dev/null && pwd -P)" || {
  printf 'PATH LEAK: scan-failed (root does not exist: %s)\n' "$ROOT_INPUT" >&2
  exit 2
}

# --- refuse a home-rooted scan before any traversal (T-01-04) ---------------
if [ -n "${HOME:-}" ]; then
  HOME_REAL="$(cd "$HOME" 2>/dev/null && pwd -P)" || HOME_REAL="$HOME"
  if [ "$ROOT" = "$HOME_REAL" ]; then
    printf 'PATH LEAK: refusing to scan a repository root equal to HOME (D-13/T-01-04)\n' >&2
    exit 2
  fi
fi

# --- must be a Git work tree ------------------------------------------------
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'PATH LEAK: scan-failed (not a Git work tree: %s)\n' "$ROOT" >&2
  exit 2
}

# --- enumerate staged, tracked, and untracked candidate paths ---------------
STAGED="$(git -C "$ROOT" diff --cached --name-only --diff-filter=ACMR 2>/dev/null)" || {
  printf 'PATH LEAK: scan-failed (Git index enumeration error)\n' >&2
  exit 2
}
TRACKED="$(git -C "$ROOT" ls-files 2>/dev/null)" || {
  printf 'PATH LEAK: scan-failed (Git tracked enumeration error)\n' >&2
  exit 2
}
UNTRACKED="$(git -C "$ROOT" ls-files --others --exclude-standard 2>/dev/null)" || {
  printf 'PATH LEAK: scan-failed (Git untracked enumeration error)\n' >&2
  exit 2
}

# `sed`/`sort` are used for de-duplication on purpose: routing this step through
# `grep` would let a broken grep silently suppress candidates. Empties dropped.
PATHS="$(printf '%s\n%s\n%s\n' "$STAGED" "$TRACKED" "$UNTRACKED" \
  | sed '/^[[:space:]]*$/d' | sort -u)"

# --- reporting: path, rule, line only; never the matched text ---------------
blocked=0
declare -A seen=()
report() { printf 'LEAK: rule=%s path=%s line=%s\n' "$1" "$2" "$3" >&2; }

scan_content() {
  local path="$1" content="$2" i name ere out rc ln lineno text key
  for i in "${!RULE_NAMES[@]}"; do
    name="${RULE_NAMES[$i]}"
    ere="${RULE_ERES[$i]}"
    out="$(printf '%s\n' "$content" | grep -nE -I -- "$ere" 2>/dev/null)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      while IFS= read -r ln; do
        [ -n "$ln" ] || continue
        lineno="${ln%%:*}"
        text="${ln#*:}"
        if allowlist_check "$path" "$text"; then
          continue
        fi
        key="${name}|${path}|${lineno}"
        [ -n "${seen[$key]:-}" ] && continue
        seen[$key]=1
        report "$name" "$path" "$lineno"
        blocked=1
      done <<< "$out"
    elif [ "$rc" -eq 1 ]; then
      :
    else
      report 'scan-failed' "$path" '?'
      blocked=1
      return
    fi
  done
}

scan_path() {
  local path="$1" idx content full
  # staged / tracked index blob
  if idx="$(git -C "$ROOT" show ":$path" 2>/dev/null)"; then
    scan_content "$path" "$idx"
  fi
  # tracked-modified / untracked worktree file (never a symlink)
  full="$ROOT/$path"
  if [ -f "$full" ] && [ ! -L "$full" ]; then
    if content="$(cat -- "$full" 2>/dev/null)"; then
      scan_content "$path" "$content"
    else
      report 'scan-failed' "$path" '?'
      blocked=1
    fi
  fi
}

while IFS= read -r p; do
  [ -n "$p" ] || continue
  scan_path "$p"
done <<< "$PATHS"

if [ "$blocked" -ne 0 ]; then
  printf 'check-path-leaks: scan BLOCKED (D-13). Remove machine-bound absolute paths; fix any scan errors.\n' >&2
  exit 1
fi
exit 0
