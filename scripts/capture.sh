#!/usr/bin/env bash
# capture.sh — manifest-driven capture, drift preview, read-only remote preflight
#
# What it does:
# Reads MANIFEST.json through the shared lib/manifest.sh reader, runs
# the strict manifest validator first, preflights every live origin, then
# mirrors each approved root into a restrictive same-filesystem staged
# candidate tree with rsync. The candidate is scanned by the shared secret
# detector (lib/secret-scan.sh) and the physical-tree path scanner
# (scripts/check-path-leaks.sh --tree) BEFORE the live repo `home/` is touched;
# only the exact scanned candidate bytes are promoted. The published
# `home/` is scanned again as a second gate, and any finding, scan error, or
# promotion failure restores the complete prior `home/` tree. With
# `--dry-run` it writes nothing and instead prints a per-entry drift report
# (added/changed/removed regular-file counts + signed net byte delta + the
# rsync itemized listing) and exits nonzero when drift exists.
#
# Front-door decisions honored:
# - exact mirror per entry (rsync --delete), refusing any bad origin
# - staged bytes are scanned before writing, and the physical tree is
# scanned again after the copy
# - dry-run prints a drift report and returns its own exit contract
# - rsync is required, there is no cp -a fallback
# - the remote preflight is read-only
# - only the payload is written: never stage, commit or push
# - the manifest is read through the shared parser
#
# Fail-closed policy:
# Only a fully validated manifest and every readable origin reach rsync.
# Every refusal prints a named `capture: <code> (...)` diagnostic to stderr
# and exits nonzero BEFORE any payload mutation or deletion.
#
# Scan scope:
# Diagnostics describe tested detector coverage (the five shared secret rules
# and the two absolute-path families), not exhaustive credential discovery.
#
# Safety:
# Capture writes only the manifest destinations, published as a whole scanned
# `home/` tree. It never runs `git add`, `git commit`, `git push`, or any
# remote-mutating command.
#
# Usage:
# scripts/capture.sh [--dry-run]
#
# NOTE: `set -e` is deliberately omitted — rsync and read exit statuses are
# handled explicitly. Only `set -u` and `set -o pipefail` are enabled.

set -u
set -o pipefail

# --- argument parsing -------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      printf 'Usage: capture.sh [--dry-run]\n'
      exit 0
      ;;
    *)
      printf 'capture: unknown-argument (%s)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

# --- required runtime -------------------------------------------------------
[ -n "${BASH_VERSION:-}" ] || {
  printf 'capture: bash-required\n' >&2
  exit 2
}
for tool in git node rsync; do
  command -v "$tool" >/dev/null 2>&1 || {
    case "$tool" in
      rsync) printf 'capture: rsync required — install rsync (e.g. sudo apt install rsync) and retry\n' >&2 ;;
      node)  printf 'capture: node required (manifest parser) — install Node.js and retry\n' >&2 ;;
      git)   printf 'capture: git required (repository root + remote report) — install Git and retry\n' >&2 ;;
    esac
    exit 2
  }
done

# --- resolve repository root (script location / Git) ------------------
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$repo_root" ] || repo_root="$(cd "$script_dir/.." && pwd)"
manifest_path="$repo_root/MANIFEST.json"

[ -n "${HOME:-}" ] || {
  printf 'capture: home-unset — HOME must point at the live ecosystem root\n' >&2
  exit 2
}

# --- run the strict manifest validator before parsing or mutation ----
validator="$script_dir/validate-manifest.sh"
[ -f "$validator" ] || {
  printf 'capture: validator-missing (expected scripts/validate-manifest.sh)\n' >&2
  exit 2
}
if ! bash "$validator" "$manifest_path"; then
  printf 'capture: manifest-invalid — refusing before any copy or delete\n' >&2
  exit 2
fi

# --- consume the shared manifest reader ------------------------------
lib="$script_dir/../lib/manifest.sh"
[ -f "$lib" ] || {
  printf 'capture: manifest-library-missing (expected lib/manifest.sh)\n' >&2
  exit 2
}
# shellcheck source=../lib/manifest.sh
. "$lib"
command -v manifest_entries >/dev/null 2>&1 || {
  printf 'capture: manifest-reader-undefined (lib/manifest.sh)\n' >&2
  exit 2
}

# --- shared secret detector + physical-tree path scanner -------------
secret_lib="$script_dir/../lib/secret-scan.sh"
[ -f "$secret_lib" ] || {
  printf 'capture: secret-detector-missing (expected lib/secret-scan.sh)\n' >&2
  exit 2
}
# shellcheck source=../lib/secret-scan.sh
. "$secret_lib"
command -v secret_scan_tree >/dev/null 2>&1 || {
  printf 'capture: secret-detector-undefined (lib/secret-scan.sh)\n' >&2
  exit 2
}
scanner="$script_dir/check-path-leaks.sh"
[ -f "$scanner" ] || {
  printf 'capture: path-scanner-missing (expected scripts/check-path-leaks.sh)\n' >&2
  exit 2
}

# --- same-filesystem staged workspace (so promotion is a rename) ------------
# The work tree lives beside the git directory so the staged candidate and the
# published home/ share a filesystem and promotion can be an atomic rename.
git_dir="$(git -C "$repo_root" rev-parse --absolute-git-dir 2>/dev/null || true)"
[ -n "$git_dir" ] || git_dir="$repo_root"
work="$(mktemp -d "$git_dir/.habitat-capture.XXXXXX")" || {
  printf 'capture: workdir-failed (cannot create temporary workspace)\n' >&2
  exit 2
}
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

tokens="$work/manifest.tokens"
if ! manifest_entries "$manifest_path" "$tokens"; then
  printf 'capture: manifest-parse-failed\n' >&2
  exit 2
fi

# --- read the NUL-delimited token stream into parallel arrays ---------------
origins=(); dests=(); modes=(); types=()
entry_count=0
exec 3< "$tokens" || {
  printf 'capture: manifest-parse-failed (cannot open token stream)\n' >&2
  exit 2
}
while IFS= read -r -d '' origin <&3; do
  IFS= read -r -d '' dest <&3 || break
  IFS= read -r -d '' mode <&3 || break
  IFS= read -r -d '' excount <&3 || break

  exf="$work/excludes.$entry_count"
  : > "$exf"
  i=0
  ok=1
  while [ "$i" -lt "$excount" ]; do
    if IFS= read -r -d '' tok <&3; then
      printf '%s\n' "$tok" >> "$exf"
    else
      ok=0
      break
    fi
    i=$((i + 1))
  done
  [ "$ok" -eq 1 ] || break

  IFS= read -r -d '' pscount <&3 || break
  i=0
  while [ "$i" -lt "$pscount" ]; do
    IFS= read -r -d '' tok <&3 || { ok=0; break; }
    i=$((i + 1))
  done
  [ "$ok" -eq 1 ] || break

  origins+=("$origin")
  dests+=("$dest")
  modes+=("$mode")
  entry_count=$((entry_count + 1))
done
exec 3<&-

if [ "$entry_count" -eq 0 ]; then
  printf 'capture: manifest-empty (no entries parsed)\n' >&2
  exit 2
fi

# --- read-only remote preflight -----------------------------
remote_preflight() {
  local names count
  names="$(git -C "$repo_root" remote 2>/dev/null | LC_ALL=C sort -u)"
  if [ -z "$names" ]; then
    printf 'REMOTE: none configured —  pending (no URL invented)\n'
    printf 'REMOTE: a listed URL alone does not prove provider visibility is Private; operator confirmation required\n'
    return 0
  fi
  count="$(printf '%s\n' "$names" | grep -c .)"
  printf 'REMOTE: %d configured\n' "$count"
  git -C "$repo_root" remote -v 2>/dev/null \
    | sed -E 's#(://)[^/@[:space:]]*@#\1***@#g' \
    | sed 's/^/REMOTE: /'
  if [ "$count" -gt 1 ]; then
    printf 'REMOTE: ambiguous — multiple remotes;  pending\n'
  fi
  printf 'REMOTE:  pending — URL listing does not prove provider visibility is Private\n'
  return 0
}
remote_preflight

# --- NUL-safe drift accounting for a directory entry ------------------------
# Compares a manifest-filtered source snapshot against the destination tree by
# relative path, content checksum, and executable bit. Prints
# "<added> <changed> <removed> <signed-delta-bytes>"
account_dir() {
  node - "$1" "$2" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const stageRoot = process.argv[2];
const dstRoot = process.argv[3];

function walk(root) {
  const map = new Map();
  let st;
  try { st = fs.lstatSync(root); } catch (err) { return map; }
  if (!st.isDirectory()) return map;
  const stack = [['', root]];
  while (stack.length) {
    const item = stack.pop();
    const rel = item[0];
    const abs = item[1];
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (err) { continue; }
    for (const d of ents) {
      const r = rel ? rel + '/' + d.name : d.name;
      const a = path.join(abs, d.name);
      let s;
      try { s = fs.lstatSync(a); } catch (err) { continue; }
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) { stack.push([r, a]); continue; }
      if (!s.isFile()) continue;
      let hash = '';
      try { hash = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex'); }
      catch (err) { hash = 'READ-ERROR'; }
      map.set(r, { size: s.size, exec: (s.mode & 0o111) !== 0, hash: hash });
    }
  }
  return map;
}

const src = walk(stageRoot);
const dst = walk(dstRoot);
let added = 0;
let changed = 0;
let removed = 0;
let delta = 0;

for (const [k, v] of src) {
  if (!dst.has(k)) { added++; delta += v.size; }
}
for (const [k, v] of dst) {
  if (!src.has(k)) { removed++; delta -= v.size; }
}
for (const [k, sv] of src) {
  if (dst.has(k)) {
    const dv = dst.get(k);
    if (sv.hash !== dv.hash || sv.exec !== dv.exec) {
      changed++;
      delta += sv.size - dv.size;
    }
  }
}

process.stdout.write(added + ' ' + changed + ' ' + removed + ' ' + delta + '\n');
NODE
}

# --- headless preflight: every origin present, readable, expected type ------
# Runs to completion BEFORE any rsync --delete so a wrong-machine run can never
# erase the payload to match an absent or unreadable source.
for ((idx = 0; idx < entry_count; idx++)); do
  origin="${origins[$idx]}"
  dest="${dests[$idx]}"
  src="$HOME/$origin"
  dst="$repo_root/$dest"

  if [ -d "$src" ]; then
    types[$idx]="dir"
  elif [ -f "$src" ]; then
    types[$idx]="file"
  else
    printf 'capture: origin-missing (%s) — refusing before any change\n' "$origin" >&2
    exit 2
  fi
  if [ ! -r "$src" ]; then
    printf 'capture: origin-unreadable (%s) — refusing before any change\n' "$origin" >&2
    exit 2
  fi
  if [ "${types[$idx]}" = "dir" ] && [ -f "$dst" ]; then
    printf 'capture: dest-type-mismatch (%s is a file; manifest expects a directory) — refusing\n' "$dest" >&2
    exit 2
  fi
  if [ "${types[$idx]}" = "file" ] && [ -d "$dst" ]; then
    printf 'capture: dest-type-mismatch (%s is a directory; manifest expects a file) — refusing\n' "$dest" >&2
    exit 2
  fi
done

# --- shared rsync comparison policy -----------------------------------------
# Git-representable equality: content checksum + executable bit only. Owner,
# group, and mtime are never compared, so a fresh checkout cannot report
# persistent phantom drift (RESEARCH Pitfall 3).
RS_DIR=(-r -p --no-links --checksum --no-owner --no-group --no-times --delete --delete-excluded)
RS_FILE=(-p --no-links --checksum --no-owner --no-group --no-times)

overall_drift=0

# ================= dry-run: read-only drift preview =============
if [ "$DRY_RUN" -eq 1 ]; then
  printf 'capture: dry-run — read-only drift preview\n'

  for ((idx = 0; idx < entry_count; idx++)); do
    origin="${origins[$idx]}"
    dest="${dests[$idx]}"
    type="${types[$idx]}"
    src="$HOME/$origin"
    dst="$repo_root/$dest"
    exf="$work/excludes.$idx"

    rflags=()
    if [ "$type" = "file" ]; then
      rflags=("${RS_FILE[@]}" "--exclude-from=$exf")
    else
      rflags=("${RS_DIR[@]}" "--exclude-from=$exf")
    fi

    # --- dry-run: itemize listing + NUL-safe accounting ---------------------
    itemize="$work/itemize.$idx"
    if [ "$type" = "file" ]; then
      if [ -d "$(dirname "$dst")" ]; then
        if ! rsync "${rflags[@]}" --dry-run --itemize-changes "$src" "$dst" > "$itemize" 2>/dev/null; then
          printf 'capture: rsync-failed (%s)\n' "$dest" >&2
          exit 2
        fi
      else
        : > "$itemize"
        if [ ! -e "$dst" ]; then
          printf '>f+++++++++ %s\n' "$(basename "$dest")" > "$itemize"
        fi
      fi
    else
      if ! rsync "${rflags[@]}" --dry-run --itemize-changes "$src/" "$dst/" > "$itemize" 2>/dev/null; then
        printf 'capture: rsync-failed (%s)\n' "$dest" >&2
        exit 2
      fi
    fi

    added=0
    changed=0
    removed=0
    delta=0
    # rsync writes informational notes (e.g. "skipping non-regular file") to
    # stdout alongside the itemize listing. Drift is decided only by real itemize
    # event lines, whose two leading status characters match [<>ch.*][fdLDS].
    has_itemize=0
    if grep -qE '^[<>ch.*][fdLDS]' "$itemize" 2>/dev/null; then
      has_itemize=1
    fi

    if [ "$has_itemize" -eq 1 ]; then
      if [ "$type" = "file" ]; then
        if [ ! -e "$dst" ]; then
          added=1
          delta="$(stat -c %s "$src")"
        elif cmp -s "$src" "$dst"; then
          if [ -x "$src" ] && [ ! -x "$dst" ] || [ ! -x "$src" ] && [ -x "$dst" ]; then
            changed=1
          fi
        else
          changed=1
          delta=$(( $(stat -c %s "$src") - $(stat -c %s "$dst") ))
        fi
      else
        stage="$work/stage.$idx"
        rm -rf "$stage"
        mkdir -p "$stage"
        if ! rsync -r -p --no-links --exclude-from="$exf" "$src/" "$stage/" 2>/dev/null; then
          printf 'capture: stage-failed (%s)\n' "$dest" >&2
          exit 2
        fi
        vals="$(account_dir "$stage" "$dst")" || {
          printf 'capture: account-failed (%s)\n' "$dest" >&2
          exit 2
        }
        if [ -z "$vals" ]; then
          printf 'capture: account-failed (%s)\n' "$dest" >&2
          exit 2
        fi
        read -r added changed removed delta <<< "$vals"
      fi
    fi

    printf '[entry %s -> %s]\n' "$origin" "$dest"
    printf 'added=%s changed=%s removed=%s delta=%s\n' "$added" "$changed" "$removed" "$delta"
    if [ -s "$itemize" ]; then
      sed 's/^/  /' "$itemize"
    fi

    if [ "$has_itemize" -eq 1 ] || [ "$added" -ne 0 ] || [ "$changed" -ne 0 ] || [ "$removed" -ne 0 ]; then
      overall_drift=1
    fi
  done

  if [ "$overall_drift" -eq 0 ]; then
    printf 'DRIFT: none\n'
    exit 0
  fi
  printf 'DRIFT: detected (repo differs from the machine)\n'
  exit 1
fi

# ================= real capture: stage, scan, promote, re-scan ==============
printf 'capture: capturing into %s\n' "$repo_root"

candidate_root="$work/candidate"
mkdir -p "$candidate_root" || {
  printf 'capture: stage-failed (cannot create candidate workspace)\n' >&2
  exit 2
}

# 1. Mirror every validated MANIFEST source into the staged candidate with the
# same filters and options as a real capture.
for ((idx = 0; idx < entry_count; idx++)); do
  origin="${origins[$idx]}"
  dest="${dests[$idx]}"
  type="${types[$idx]}"
  src="$HOME/$origin"
  dst="$candidate_root/$dest"
  exf="$work/excludes.$idx"

  if [ "$type" = "file" ]; then
    mkdir -p "$(dirname "$dst")"
    if ! rsync "${RS_FILE[@]}" "--exclude-from=$exf" "$src" "$dst"; then
      printf 'capture: rsync-failed (%s)\n' "$dest" >&2
      exit 2
    fi
  else
    mkdir -p "$dst"
    if ! rsync "${RS_DIR[@]}" "--exclude-from=$exf" "$src/" "$dst/"; then
      printf 'capture: rsync-failed (%s)\n' "$dest" >&2
      exit 2
    fi
  fi
done

# 2. Pre-scan the exact staged bytes (post-exclusion, including Git-ignored
# files) before touching the live repo home/. Any finding or scan
# error aborts with the live home/ left byte-for-byte unchanged.
pre_ok=1
SECRET_SCAN_BLOCKED=0
if ! secret_scan_tree "$candidate_root/home"; then pre_ok=0; fi
if [ "$SECRET_SCAN_BLOCKED" -ne 0 ]; then pre_ok=0; fi
if ! bash "$scanner" --tree "$candidate_root/home"; then pre_ok=0; fi
if [ "$pre_ok" -ne 1 ]; then
  printf 'capture: pre-scan-blocked — finding or scan error; live home/ left unchanged\n' >&2
  exit 1
fi
printf 'capture: pre-scan passed — tested detector coverage: 5 secret rules + 2 path families\n'

# 3. Promote ONLY the scanned candidate bytes. Snapshot the prior home/ first so
# a later post-scan or promotion failure can restore it exactly (-12).
prev_home="$work/prev-home"
had_prev=0
if [ -e "$repo_root/home" ]; then
  if ! mv -- "$repo_root/home" "$prev_home"; then
    printf 'capture: promote-failed (cannot snapshot prior home/)\n' >&2
    exit 2
  fi
  had_prev=1
fi

restore_prev_home() {
  if [ -e "$repo_root/home" ]; then rm -rf -- "$repo_root/home"; fi
  if [ "$had_prev" -eq 1 ] && [ -e "$prev_home" ]; then mv -- "$prev_home" "$repo_root/home"; fi
}

if ! mv -- "$candidate_root/home" "$repo_root/home"; then
  restore_prev_home
  printf 'capture: promote-failed (cannot publish scanned candidate; prior home/ restored)\n' >&2
  exit 2
fi

# 4. Post-copy re-scan of the physical published home/. Any finding or
# scan error rejects the published payload and restores the prior tree.
post_ok=1
SECRET_SCAN_BLOCKED=0
if ! secret_scan_tree "$repo_root/home"; then post_ok=0; fi
if [ "$SECRET_SCAN_BLOCKED" -ne 0 ]; then post_ok=0; fi
if ! bash "$scanner" --tree "$repo_root/home"; then post_ok=0; fi
if [ "$post_ok" -ne 1 ]; then
  restore_prev_home
  printf 'capture: post-scan-blocked — rejected published payload; prior home/ restored\n' >&2
  exit 1
fi
printf 'capture: post-scan passed — tested detector coverage: 5 secret rules + 2 path families\n'

printf 'capture: wrote payload only — review git status, then commit and push\n'
exit 0
