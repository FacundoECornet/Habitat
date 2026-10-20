#!/usr/bin/env bash
# check-path-leaks.sh — fail-closed absolute-path portability scan
#
# What it does:
# Scans the staged Git index blobs plus tracked and untracked candidate files
# for machine-bound absolute paths from two families: the Linux home-root
# absolute-path family and the Windows-mounted user-profile absolute-path
# family. On any match it exits nonzero and reports ONLY the
# candidate path, the rule name, and the line number — never the matched text.
#
# Physical-tree mode (`--tree ROOT`):
# Walks every physical regular file under ROOT with a NUL-safe `find -type f`
# enumeration, including files Git would ignore, and skips symlinks. This is
# the post-copy / staged-payload gate: Git candidate enumeration can never
# prove a Git-ignored but copied file is clean. Enumeration, read, or grep
# errors block with a named `scan-failed` reason.
#
# Fail-closed policy:
# Only grep status 1 (no selected lines) is clean. Status 0 is a path leak.
# Any other grep status, a Git enumeration error, a failed indexed-blob read,
# an unreadable file, or a `find` enumeration error blocks with a named
# `scan-failed` reason.
#
# NUL-safe enumeration:
# Candidate paths are enumerated with Git `-z` output into a mktemp file so
# arbitrary path bytes (non-ASCII, tab, quote, backslash) survive intact;
# Bash cannot hold NUL bytes in a variable. A tracked path whose indexed blob
# cannot be read blocks as `scan-failed` rather than being silently skipped.
#
# Home-root refusal:
# In Git candidate mode only, a supplied repository root that resolves to
# $HOME is refused BEFORE any file traversal, so a home-rooted planning
# harness can never be scanned broadly. Physical-tree mode scans exactly the
# ROOT it is given (the payload boundary is never $HOME).
#
# Symlinks:
# Symlinks are never followed and never read; they are skipped.
#
# Bypass limitation:
# This is a normal-workflow gate, not a security boundary. It does not defend
# against a caller that deliberately supplies a different, unrelated root.
#
# Usage:
# scripts/check-path-leaks.sh [repo-root]
# scripts/check-path-leaks.sh --tree ROOT
#
# NOTE: `set -e` is deliberately omitted — grep exit statuses are handled
# explicitly. Only `set -u` and `set -o pipefail` are enabled.

set -u
set -o pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- detector expressions assembled from fragments --------------------------
# Neither family is written as a complete literal, so scanning this script's own
# source cannot self-match the detector.
F_SLASH='/'
F_HOME='home'
F_MNT='mnt'
F_C='c'
F_USERS='Users'
# A home-root login name starts with a letter or underscore (POSIX portable login
# names). Requiring that keeps repo-relative URLs such as .../blob/<sha>/home/.config/...
# from matching as a machine home, while /home/<user>/... still blocks.
F_LOGIN='[A-Za-z_][^[:space:]/]*'

REEN_HOME="${F_SLASH}${F_HOME}${F_SLASH}${F_LOGIN}"
REEN_WIN="${F_SLASH}${F_MNT}${F_SLASH}${F_C}${F_SLASH}${F_USERS}(/[^[:space:]]*)?"

RULE_NAMES=( 'home-absolute-path' 'windows-user-path' )
RULE_ERES=( "$REEN_HOME" "$REEN_WIN" )

# --- argument parsing: --tree ROOT selects physical-tree mode ---------------
MODE="git"
ROOT_INPUT=""
case "${1:-}" in
  --tree)
    MODE="tree"
    ROOT_INPUT="${2:-}"
    [ -n "$ROOT_INPUT" ] || {
      printf 'PATH LEAK: scan-failed (missing --tree root argument)\n' >&2
      exit 2
    }
    ;;
  '')
    ;;
  *)
    ROOT_INPUT="$1"
    ;;
esac

# --- resolve the root -------------------------------------------------------
if [ "$MODE" = "git" ] && [ -z "$ROOT_INPUT" ]; then
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

# --- git candidate mode preconditions ---------------------------------------
if [ "$MODE" = "git" ]; then
  # Refuse a home-rooted scan before any traversal (-04).
  if [ -n "${HOME:-}" ]; then
    HOME_REAL="$(cd "$HOME" 2>/dev/null && pwd -P)" || HOME_REAL="$HOME"
    if [ "$ROOT" = "$HOME_REAL" ]; then
      printf 'PATH LEAK: refusing to scan a repository root equal to HOME\n' >&2
      exit 2
    fi
  fi

  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    printf 'PATH LEAK: scan-failed (not a Git work tree: %s)\n' "$ROOT" >&2
    exit 2
  }
fi

# --- reporting: path, rule, line only; never the matched text ---------------
blocked=0
declare -A seen=()
report() { printf 'LEAK: rule=%s path=%s line=%s\n' "$1" "$2" "$3" >&2; }

scan_content() {
  local path="$1" content="$2" i name ere out rc ln lineno key
  # Normalize CRLF so line numbers and regex matching stay consistent.
  content="${content//$'\r'/}"
  for i in "${!RULE_NAMES[@]}"; do
    name="${RULE_NAMES[$i]}"
    ere="${RULE_ERES[$i]}"
    out="$(printf '%s\n' "$content" | grep -nE -I -- "$ere" 2>/dev/null)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      while IFS= read -r ln; do
        [ -n "$ln" ] || continue
        lineno="${ln%%:*}"
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

blocked_exit() {
  if [ "$blocked" -ne 0 ]; then
    printf 'check-path-leaks: scan BLOCKED. Remove machine-bound absolute paths; fix any scan errors.\n' >&2
    exit 1
  fi
  exit 0
}

# --- physical-tree mode: NUL-safe walk of regular files, Git-ignored included
if [ "$MODE" = "tree" ]; then
  TREE_LIST="$(mktemp)" || {
    printf 'PATH LEAK: scan-failed (cannot create tree candidate list)\n' >&2
    exit 2
  }
  cleanup_tree() { rm -f "$TREE_LIST"; }
  trap cleanup_tree EXIT

  if ! find "$ROOT" -type f -print0 > "$TREE_LIST" 2>/dev/null; then
    printf 'PATH LEAK: scan-failed (tree enumeration error: %s)\n' "$ROOT" >&2
    exit 2
  fi

  while IFS= read -r -d '' p; do
    [ -n "$p" ] || continue
    rel="${p#"$ROOT"/}"
    [ "$rel" = "$p" ] && rel="$p"
    if content="$(cat -- "$p" 2>/dev/null)"; then
      scan_content "$rel" "$content"
    else
      report 'scan-failed' "$rel" '?'
      blocked=1
    fi
  done < "$TREE_LIST"

  blocked_exit
fi

# --- git candidate mode: staged, tracked, and untracked candidate paths -----
# Bash variables truncate at the first NUL byte, so Git's NUL-delimited (-z)
# output cannot be held in a string variable. Enumerate into a mktemp file and
# preserve NUL boundaries through de-duplication (`sort -z -u`) and iteration
# (`read -r -d ''`). Every Git command's exit status is checked before its
# output is consumed; any failure blocks with a named scan-failed reason.
CAND_RAW="$(mktemp)" || {
  printf 'PATH LEAK: scan-failed (cannot create candidate list)\n' >&2
  exit 2
}
CAND_SORTED="$(mktemp)" || {
  printf 'PATH LEAK: scan-failed (cannot create candidate list)\n' >&2
  rm -f "$CAND_RAW"
  exit 2
}
cleanup_candidates() { rm -f "$CAND_RAW" "$CAND_SORTED"; }
trap cleanup_candidates EXIT

git -C "$ROOT" -c core.quotePath=false diff --cached --name-only --diff-filter=d -z > "$CAND_RAW" 2>/dev/null || {
  printf 'PATH LEAK: scan-failed (Git index enumeration error)\n' >&2
  exit 2
}
git -C "$ROOT" -c core.quotePath=false ls-files -z >> "$CAND_RAW" 2>/dev/null || {
  printf 'PATH LEAK: scan-failed (Git tracked enumeration error)\n' >&2
  exit 2
}
git -C "$ROOT" -c core.quotePath=false ls-files --others --exclude-standard -z >> "$CAND_RAW" 2>/dev/null || {
  printf 'PATH LEAK: scan-failed (Git untracked enumeration error)\n' >&2
  exit 2
}

# De-duplication is routed through `sort -z -u`, never `grep`, so a broken grep
# cannot silently suppress candidates while NUL boundaries are preserved.
sort -z -u "$CAND_RAW" > "$CAND_SORTED" 2>/dev/null || {
  printf 'PATH LEAK: scan-failed (candidate de-duplication error)\n' >&2
  exit 2
}

scan_path() {
  local path="$1" idx content full
  # Indexed candidate: the path resolves in the index, so `git show ":$path"`
  # MUST succeed. A failed indexed-blob read is a scan failure, never a silent
  # skip. Untracked candidates have no index blob and are read from the worktree.
  if git -C "$ROOT" ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    if idx="$(git -C "$ROOT" show ":$path" 2>/dev/null)"; then
      scan_content "$path" "$idx"
    else
      report 'scan-failed' "$path" '?'
      blocked=1
    fi
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

while IFS= read -r -d '' p; do
  [ -n "$p" ] || continue
  scan_path "$p"
done < "$CAND_SORTED"

blocked_exit
