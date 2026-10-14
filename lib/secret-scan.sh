#!/usr/bin/env bash
# lib/secret-scan.sh — shared fragment-built secret detector (D-04/D-10)
#
# Purpose:
#   The single definition of habitat's five secret-signature classes, shared by
#   the staged-commit gate (.githooks/pre-commit) and, going forward, capture's
#   source-side pre-scan and post-copy gate. One fragment-built source means the
#   consumers cannot drift and neither this library nor its callers self-matches
#   its own detector (Phase 1 D-09; Phase 2 D-04/D-10).
#
# Public API:
#   RULE_NAMES[]                     — the five stable rule labels.
#   RULE_ERES[]                      — the matching ERE per label (same order).
#   secret_scan_content PATH CONTENT [ALLOWLIST_FUNCTION]
#                                    — scan one blob's text; ALLOWLIST_FUNCTION
#                                      PATH TEXT returns 0 to suppress a hit.
#   secret_scan_tree ROOT [ALLOWLIST_FUNCTION]
#                                    — NUL-safe walk of a physical tree; scans
#                                      every regular file, never follows symlinks.
#   SECRET_SCAN_BLOCKED              — 0 clean so far, 1 once any finding or
#                                      scan error has been reported.
#   secret_report RULE PATH LINE     — the default reporter (rule/path/line only);
#                                      consumers may override it before scanning.
#
# Fail-closed policy:
#   grep status 0 is a hit (block); status 1 alone is clean; any other status,
#   an unreadable blob, or an enumeration error reports `scan-failed` and blocks.
#
# Redaction:
#   Diagnostics carry ONLY rule, path, and line. Matched bytes are never printed.
#
# NOTE: `set -e` is deliberately omitted — grep exit statuses are handled
# explicitly. Sourcing this file only defines arrays and functions.

# --- load guard: sourcing twice is a no-op --------------------------------
if [ -n "${_SECRET_SCAN_LIB_LOADED:-}" ]; then
  return 0
fi
_SECRET_SCAN_LIB_LOADED=1

# --- detector expressions assembled from fragments -------------------------
# A complete signature is never written as a literal, so this library — and any
# source that embeds it — does not self-match when its own source is staged.
F_UND='_'
F_DASH='-'
F_APIKEY='apikey'
F_GH='gh'
F_GHL='[opusr]'
F_GHF='github'
F_PAT='pat'
F_OP='[op]'
F_XOXB='xoxb'
F_PKB='BEGIN'
F_PKS=' '
F_PKO='(RSA |EC |DSA |OPENSSH |ENCRYPTED )?'
F_PKE='PRIVATE KEY'
F_PKDL='-----'
F_BODY='[A-Za-z0-9]{16,}'
F_GHBODY='[A-Za-z0-9]{20,}'

R_APIKEY="${F_APIKEY}${F_UND}${F_BODY}"
# Provider-issued tokens: gh followed by one of o|p|u|s|r then underscore,
# then a token body.
R_GH="${F_GH}${F_GHL}${F_UND}${F_GHBODY}"
# Fine-grained personal access tokens: github + underscore + pat + underscore,
# then a token body.
R_GHPAT="${F_GHF}${F_UND}${F_PAT}${F_UND}${F_GHBODY}"
# Both alternatives report under the single stable `github-token` rule name.
R_GH_ALL="${R_GH}|${R_GHPAT}"
R_SK='sk'"${F_DASH}${F_BODY}"
R_XOXB="${F_XOXB}${F_DASH}${F_BODY}"
# Private-key detector anchored to real PEM header structure: the dashed
# delimiter (-----BEGIN ... PRIVATE KEY-----) matches actual PEM headers while
# tolerating ordinary prose that merely mentions the header words.
R_PK="${F_PKDL}${F_PKB}${F_PKS}${F_PKO}${F_PKE}${F_PKDL}"

RULE_NAMES=( 'apikey-marker' 'github-token' 'secret-key-prefix' 'slack-token' 'private-key-marker' )
RULE_ERES=( "${R_APIKEY}" "${R_GH_ALL}" "${R_SK}" "${R_XOXB}" "${R_PK}" )

# --- reporting (rule + path + line only; never matched bytes) ---------------
SECRET_SCAN_BLOCKED=0
secret_report() {
  printf 'BLOCKED: rule=%s path=%s line=%s\n' "$1" "$2" "$3" >&2
}

# --- content scan ----------------------------------------------------------
# secret_scan_content PATH CONTENT [ALLOWLIST_FUNCTION]
# Returns 0 when the scan completed (findings are signalled via
# SECRET_SCAN_BLOCKED); returns 1 on a scanner error.
secret_scan_content() {
  local path="${1:-}" content="${2:-}" allowlist_fn="${3:-}"
  local i name ere out rc ln lineno text
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
        if [ -n "$allowlist_fn" ] && "$allowlist_fn" "$path" "$text"; then
          continue
        fi
        secret_report "$name" "$path" "$lineno"
        SECRET_SCAN_BLOCKED=1
      done <<< "$out"
    elif [ "$rc" -eq 1 ]; then
      :
    else
      secret_report 'scan-failed' "$path" '?'
      SECRET_SCAN_BLOCKED=1
      return 1
    fi
  done
  return 0
}

# --- physical-tree scan ----------------------------------------------------
# secret_scan_tree ROOT [ALLOWLIST_FUNCTION]
# Enumerates regular files NUL-safely with `find -type f` (symlinks are never
# followed) into a mktemp file and scans each. Enumeration or read errors block
# with a named `scan-failed` reason rather than returning a clean result.
secret_scan_tree() {
  local root="${1:-}" allowlist_fn="${2:-}"
  if [ -z "$root" ] || [ ! -d "$root" ]; then
    secret_report 'scan-failed' "${root:-?}" '?'
    SECRET_SCAN_BLOCKED=1
    return 1
  fi
  local list
  list="$(mktemp)" || {
    secret_report 'scan-failed' "$root" '?'
    SECRET_SCAN_BLOCKED=1
    return 1
  }
  if ! find "$root" -type f -print0 > "$list" 2>/dev/null; then
    rm -f "$list"
    secret_report 'scan-failed' "$root" '?'
    SECRET_SCAN_BLOCKED=1
    return 1
  fi
  local f content
  while IFS= read -r -d '' f; do
    [ -n "$f" ] || continue
    if ! content="$(cat -- "$f" 2>/dev/null)" 2>/dev/null; then
      rm -f "$list"
      secret_report 'scan-failed' "$f" '?'
      SECRET_SCAN_BLOCKED=1
      return 1
    fi
    secret_scan_content "$f" "$content" "$allowlist_fn" || true
  done < "$list"
  rm -f "$list"
  return 0
}
