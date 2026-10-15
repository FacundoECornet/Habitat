#!/usr/bin/env bash
# restore.sh — manifest-driven, fail-closed, idempotent $HOME restore
#
# What it does:
#   Reads MANIFEST.json through the shared lib/manifest.sh reader (D-10), runs
#   the strict manifest validator first, preflights every repo payload root and
#   the canonical $HOME boundary, then materializes each approved destination
#   under $HOME by copying repo bytes only. Existing destination files are
#   never silently overwritten: a changed file (content checksum + executable
#   bit) or a file/dir/symlink type blocker is renamed aside to a per-run
#   sibling `<path>.backup-YYYYMMDD-HHMMSS` and logged to stdout plus the
#   persistent $HOME/.habitat/restore.log (D-01..D-04). Machine-local files
#   (`*.local`), manifest-excluded paths, and orphan destination files are
#   preserved (D-13/D-14). Declared `npm ci` post-steps run only when
#   node_modules or the stored package/lock fingerprint is stale, using fixed
#   argv only (never `eval`) (D-09/D-11/D-12). Partial failures accumulate:
#   unrelated entries still run and the final exit is nonzero with named
#   `restore: <code> (...)` diagnostics (D-08/D-10).
#
# Front-door decisions honored:
#   D-01 sibling .backup-YYYYMMDD-HHMMSS    D-02 checksum + exec bit only
#   D-03 stdout + persistent log            D-04 backup exact blocker, no follow
#   D-05 no-op rerun summary                D-06 read-only dry-run 0/1 contract
#   D-07 equality matches capture           D-08 accumulate failures
#   D-09 conditional npm ci                 D-10 files first, npm failure continues
#   D-11 never copy node_modules            D-12 missing node/npm fail-closed
#   D-13 skip machine-local (*.local)       D-14 preserve orphans, no destructive delete
#   D-15 mkdir parents, exec bit only       D-16 fail-closed preflight, no /mnt/c drvfs
#
# Safety:
#   Restore writes only manifest destinations under $HOME. It never stages,
#   commits, pushes, changes ownership, deletes destination files, or logs
#   file contents. Dry-run creates no destination state, log, backup, or npm
#   process.
#
# Usage:
#   scripts/restore.sh [--dry-run]
#
# NOTE: `set -e` is deliberately omitted — rsync, sha256sum, and `read` exit
# statuses are handled explicitly. Only `set -u` and `set -o pipefail` are on.

set -u
set -o pipefail

# --- argument parsing -------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      printf 'Usage: restore.sh [--dry-run]\n'
      exit 0
      ;;
    *)
      printf 'restore: unknown-argument (%s)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

# --- required runtime -------------------------------------------------------
[ -n "${BASH_VERSION:-}" ] || {
  printf 'restore: bash-required\n' >&2
  exit 2
}
for tool in git node rsync sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || {
    case "$tool" in
      rsync)     printf 'restore: rsync required (copy engine) — install rsync via your package manager and retry\n' >&2 ;;
      node)      printf 'restore: node required (manifest parser) — install Node.js and retry\n' >&2 ;;
      git)       printf 'restore: git required (repository root) — install Git and retry\n' >&2 ;;
      sha256sum) printf 'restore: sha256sum required (content equality) — install coreutils and retry\n' >&2 ;;
    esac
    exit 2
  }
done

# --- resolve repository root + $HOME ----------------------------------------
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$repo_root" ] || repo_root="$(cd "$script_dir/.." && pwd)"
manifest_path="$repo_root/MANIFEST.json"

[ -n "${HOME:-}" ] || {
  printf 'restore: home-unset — HOME must point at the live ecosystem root (D-16)\n' >&2
  exit 2
}
home_real="$(realpath "$HOME" 2>/dev/null || true)"
[ -n "$home_real" ] || {
  printf 'restore: home-unresolved (cannot canonicalize HOME: %s) (D-16)\n' "$HOME" >&2
  exit 2
}
case "$home_real" in
  /mnt/c|/mnt/c/*)
    printf 'restore: home-on-drvfs (%s) — refusing before any write (D-16)\n' "$home_real" >&2
    exit 2
    ;;
esac

# --- strict validator before any persistent mutation (D-16) -----------------
validator="$script_dir/validate-manifest.sh"
[ -f "$validator" ] || {
  printf 'restore: validator-missing (expected scripts/validate-manifest.sh)\n' >&2
  exit 2
}
if ! bash "$validator" "$manifest_path"; then
  printf 'restore: manifest-invalid — refusing before any write (D-16)\n' >&2
  exit 2
fi

# --- consume the shared manifest reader (D-10) ------------------------------
lib="$script_dir/../lib/manifest.sh"
[ -f "$lib" ] || {
  printf 'restore: manifest-library-missing (expected lib/manifest.sh)\n' >&2
  exit 2
}
# shellcheck source=../lib/manifest.sh
. "$lib"
command -v manifest_entries >/dev/null 2>&1 || {
  printf 'restore: manifest-reader-undefined (lib/manifest.sh)\n' >&2
  exit 2
}

# --- scratch workspace + trap cleanup ---------------------------------------
git_dir="$(git -C "$repo_root" rev-parse --absolute-git-dir 2>/dev/null || true)"
[ -n "$git_dir" ] || git_dir="$repo_root"
work="$(mktemp -d "$git_dir/.habitat-restore.XXXXXX")" || {
  printf 'restore: workdir-failed (cannot create temporary workspace)\n' >&2
  exit 2
}
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

tokens="$work/manifest.tokens"
if ! manifest_entries "$manifest_path" "$tokens"; then
  printf 'restore: manifest-parse-failed\n' >&2
  exit 2
fi

# --- read the NUL-delimited token stream into parallel arrays ---------------
# Fail closed (WR-03): a truncated scratch stream must never look like a clean
# end of stream. EOF is accepted only where a *new origin* is expected; any
# missing or non-numeric field, exclude, or post-step token is a parse failure.
origins=(); dests=(); modes=(); src_types=()
postfiles=()
entry_count=0
parse_truncated() {
  printf 'restore: manifest-token-truncated\n' >&2
  exit 2
}
# Reject exclude patterns whose shape rsync interprets differently from the
# in-process matcher (WR-01/WR-03): rsync comments (`#`), include rules (`!`),
# and any internal slash — including a slash before a trailing slash — anchor
# the pattern to the transfer root. Both `sub/dir` and `a/b/` are rejected
# before any destination/log write; only slash-free names (`node_modules/`,
# `sessions/`, `*.local`) are supported.
validate_exclude() {
  local pat="$1" core
  case "$pat" in
    '#'*) printf 'restore: exclude-pattern-unsupported (%s: leading # is an rsync comment) (WR-01)\n' "$pat" >&2; exit 2 ;;
    '!'*) printf 'restore: exclude-pattern-unsupported (%s: leading ! is an rsync include rule) (WR-01)\n' "$pat" >&2; exit 2 ;;
  esac
  core="$pat"
  case "$core" in */) core="${core%/}" ;; esac
  case "$core" in
    */*) printf 'restore: exclude-pattern-unsupported (%s: internal slash anchors the pattern) (WR-01/WR-03)\n' "$pat" >&2; exit 2 ;;
  esac
  return 0
}
exec 3< "$tokens" || {
  printf 'restore: manifest-parse-failed (cannot open token stream)\n' >&2
  exit 2
}
while IFS= read -r -d '' origin <&3; do
  IFS= read -r -d '' dest <&3 || parse_truncated
  IFS= read -r -d '' mode <&3 || parse_truncated
  IFS= read -r -d '' excount <&3 || parse_truncated
  case "$excount" in ''|*[!0-9]*) parse_truncated ;; esac

  exf="$work/excludes.$entry_count"
  : > "$exf"
  i=0
  while [ "$i" -lt "$excount" ]; do
    IFS= read -r -d '' tok <&3 || parse_truncated
    validate_exclude "$tok"
    printf '%s\n' "$tok" >> "$exf"
    i=$((i + 1))
  done

  IFS= read -r -d '' pscount <&3 || parse_truncated
  case "$pscount" in ''|*[!0-9]*) parse_truncated ;; esac
  psf="$work/poststeps.$entry_count"
  : > "$psf"
  i=0
  while [ "$i" -lt "$pscount" ]; do
    IFS= read -r -d '' tok <&3 || parse_truncated
    printf '%s\n' "$tok" >> "$psf"
    i=$((i + 1))
  done

  origins+=("$origin")
  dests+=("$dest")
  modes+=("$mode")
  postfiles+=("$psf")
  entry_count=$((entry_count + 1))
done
exec 3<&-

if [ "$entry_count" -eq 0 ]; then
  printf 'restore: manifest-empty (no entries parsed)\n' >&2
  exit 2
fi

# --- headless preflight: every repo payload root present, readable, typed ---
# Runs to completion BEFORE any destination write so a wrong-machine or
# unmounted payload can never produce a partial restore (D-16 / Pitfall 1).
preflight_problems=0
for ((idx = 0; idx < entry_count; idx++)); do
  src="$repo_root/${dests[$idx]}"
  if [ -d "$src" ]; then
    src_types[$idx]="dir"
  elif [ -f "$src" ]; then
    src_types[$idx]="file"
  else
    printf 'restore: origin-missing (%s) — refusing before any write (D-16)\n' "${dests[$idx]}" >&2
    src_types[$idx]="missing"
    preflight_problems=$((preflight_problems + 1))
    continue
  fi
  if [ ! -r "$src" ]; then
    printf 'restore: origin-unreadable (%s) — refusing before any write (D-16)\n' "${dests[$idx]}" >&2
    preflight_problems=$((preflight_problems + 1))
  fi
done
if [ "$preflight_problems" -ne 0 ]; then
  printf 'restore: preflight-failed (%d) — no destination writes performed\n' "$preflight_problems" >&2
  exit 2
fi

# --- persistent log (real run only; never in dry-run) (D-03) ----------------
log_file="$HOME/.habitat/restore.log"
if [ "$DRY_RUN" -eq 0 ]; then
  habitat_dir="$HOME/.habitat"
  if [ -L "$habitat_dir" ]; then
    printf 'restore: log-unwritable (%s is a symlink) — refusing before replacement (D-03)\n' "$habitat_dir" >&2
    exit 2
  fi
  mkdir -p "$habitat_dir" || {
    printf 'restore: log-unwritable (cannot create %s) (D-03)\n' "$habitat_dir" >&2
    exit 2
  }
  if [ -L "$log_file" ]; then
    printf 'restore: log-unwritable (%s is a symlink) — refusing before replacement (D-03)\n' "$log_file" >&2
    exit 2
  fi
  : >> "$log_file" 2>/dev/null || {
    printf 'restore: log-unwritable (%s) — refusing before replacement (D-03)\n' "$log_file" >&2
    exit 2
  }
fi

# --- shared run state -------------------------------------------------------
STAMP="$(date -u +%Y%m%d-%H%M%S)"
fail_count=0
total_added=0
total_changed=0
total_skipped=0
total_backup=0
action_needed=0
ENT_ADDED=0
ENT_CHANGED=0
ENT_SKIPPED=0

record_failure() { printf '%s\n' "$1" >&2; fail_count=$((fail_count + 1)); }

# Persist one escaped record per event (WR-04): `printf %q` keeps a path that
# contains a newline (or other control byte) inside a single physical log line.
log_line() {
  [ "$DRY_RUN" -eq 0 ] || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(printf '%q' "$1")" >> "$log_file"
}

# --- equality: full content checksum + executable bit only (D-02/D-07) ------
file_equal() {
  local sh dh sx dx
  sh="$(sha256sum -- "$1" 2>/dev/null)" || return 2
  dh="$(sha256sum -- "$2" 2>/dev/null)" || return 2
  sh="${sh%% *}"
  dh="${dh%% *}"
  sx=0; [ -x "$1" ] && sx=1
  dx=0; [ -x "$2" ] && dx=1
  [ "$sh" = "$dh" ] && [ "$sx" -eq "$dx" ] && return 0
  return 1
}

# --- rsync-parity glob-style exclusion matcher (WR-04/WR-05) ----------------
# Only two pattern shapes reach this matcher (validate_exclude rejects the
# rest before any write):
#   `name`            Glob-match against any single path component, file or
#                     directory — equivalent to rsync's final-component match
#                     plus its "excluding a directory excludes its contents".
#   `name/`           Same, but the component must be a directory in the source
#                     (rsync trailing-slash directory-only semantics). The
#                     source root is required for that check; without it the
#                     pattern degrades to component-name matching.
is_excluded() {
  local rel="$1" exf="$2" srcroot="${3:-}" pat d comp rest prefix
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    case "$pat" in
      */)
        d="${pat%/}"
        rest="$rel"; prefix=""
        while :; do
          comp="${rest%%/*}"
          [ -n "$comp" ] || break
          prefix="${prefix:+$prefix/}$comp"
          case "$comp" in $d)
            if [ -n "$srcroot" ] && [ ! -d "$srcroot/$prefix" ]; then
              : # name matches but the component is not a directory
            else
              return 0
            fi
            ;;
          esac
          case "$rest" in */*) rest="${rest#*/}" ;; *) break ;; esac
        done
        ;;
      *)
        rest="$rel"
        while :; do
          comp="${rest%%/*}"
          [ -n "$comp" ] || break
          case "$comp" in $pat) return 0 ;; esac
          case "$rest" in */*) rest="${rest#*/}" ;; *) break ;; esac
        done
        ;;
    esac
  done < "$exf"
  return 1
}

# Machine-local when *any* path component ends in `.local` (IN-02), so a file
# below an excluded `nested.local/` component is reported, not silently dropped.
_machine_local() {
  local rel="$1" comp rest
  rest="$rel"
  while [ -n "$rest" ]; do
    comp="${rest%%/*}"
    case "$comp" in
      *.local) return 0 ;;
    esac
    case "$rest" in
      */*) rest="${rest#*/}" ;;
      *) break ;;
    esac
  done
  return 1
}

# --- per-entry mutation action log (CR-01 rollback) --------------------------
# Every `mv` and `mkdir` performed while processing one entry is recorded so a
# later refusal (e.g. backup-name collision) can roll the entry back before
# rsync — earlier destinations must never be left displaced from their
# original paths. Kinds: `mv <from>␟<to>` and `mkdir <path>`.
ENTRY_KIND=()
ENTRY_ARG=()
entry_act_reset() { ENTRY_KIND=(); ENTRY_ARG=(); }
entry_act_mv() { ENTRY_KIND+=("mv"); ENTRY_ARG+=("$1"$'\x1f'"$2"); }
entry_act_mkdir() { ENTRY_KIND+=("mkdir"); ENTRY_ARG+=("$1"); }

# Undo every recorded action in reverse order. A rollback that cannot restore
# a moved object reports it and keeps the backup (never clobbers an occupied
# destination path). Empty directories created by the entry are removed; a
# non-empty one is left in place (rsync never ran, so that means foreign
# content appeared meanwhile) and reported.
rollback_entry() {
  local i n kind arg from to problems=0
  n=${#ENTRY_KIND[@]}
  for ((i = n - 1; i >= 0; i--)); do
    kind="${ENTRY_KIND[$i]}"
    arg="${ENTRY_ARG[$i]}"
    case "$kind" in
      mv)
        from="${arg%%$'\x1f'*}"
        to="${arg#*$'\x1f'}"
        if [ -e "$from" ] || [ -L "$from" ]; then
          record_failure "restore: rollback-occupied ($from) — backup kept at $to (CR-01)"
          problems=$((problems + 1))
        elif [ -e "$to" ] || [ -L "$to" ]; then
          if mv -- "$to" "$from"; then
            printf 'restore: rollback (%s -> %s)\n' "$(printf '%q' "$to")" "$(printf '%q' "$from")"
            log_line "rollback ${to} -> ${from}"
          else
            record_failure "restore: rollback-failed ($to -> $from) (CR-01)"
            problems=$((problems + 1))
          fi
        else
          record_failure "restore: rollback-missing ($to) (CR-01)"
          problems=$((problems + 1))
        fi
        ;;
      mkdir)
        rmdir -- "$arg" 2>/dev/null || {
          record_failure "restore: rollback-dir-nonempty ($arg) (CR-01)"
          problems=$((problems + 1))
        }
        ;;
    esac
  done
  entry_act_reset
  [ "$problems" -eq 0 ]
}

# --- backup an exact blocker to a per-run sibling name (D-01/D-04) ----------
# `mv` moves the named object itself (symlink link, directory, or file) and
# never dereferences it. A pre-existing backup name is never overwritten.
backup_path() {
  local target="$1" b
  b="${target}.backup-${STAMP}"
  if [ -e "$b" ] || [ -L "$b" ]; then
    record_failure "restore: backup-collision ($b exists) — refusing to overwrite (D-01)"
    return 1
  fi
  if ! mv -- "$target" "$b"; then
    record_failure "restore: backup-failed ($target)"
    return 1
  fi
  entry_act_mv "$target" "$b"
  printf 'restore: backup (%s -> %s)\n' "$(printf '%q' "$target")" "$(printf '%q' "$b")"
  log_line "backup ${target} -> ${b}"
  total_backup=$((total_backup + 1))
  return 0
}

# --- create a destination directory, backing up any blocking component ------
# Walks every component from $HOME down with lstat semantics so a symlinked
# parent can never redirect a later write (D-04/Pitfall 3).
ensure_dir() {
  local target="$1" rel cur comp parts
  [ "$target" = "$HOME" ] && return 0
  rel="${target#"$HOME"/}"
  [ "$rel" = "$target" ] && rel="$target"
  IFS='/' read -r -a parts <<< "$rel"
  cur="$HOME"
  if [ "${#parts[@]}" -gt 0 ]; then
    for comp in "${parts[@]}"; do
      [ -n "$comp" ] || continue
      cur="$cur/$comp"
      if [ -L "$cur" ]; then
        backup_path "$cur" || return 1
        mkdir -- "$cur" || { record_failure "restore: mkdir-failed ($cur)"; return 1; }
        entry_act_mkdir "$cur"
      elif [ -e "$cur" ]; then
        if [ ! -d "$cur" ]; then
          backup_path "$cur" || return 1
          mkdir -- "$cur" || { record_failure "restore: mkdir-failed ($cur)"; return 1; }
          entry_act_mkdir "$cur"
        fi
      else
        mkdir -- "$cur" || { record_failure "restore: mkdir-failed ($cur)"; return 1; }
        entry_act_mkdir "$cur"
      fi
    done
  fi
  return 0
}

# --- real-run: classify + backup a single destination path ------------------
_inspect_real() {
  local s="$1" d="$2"
  if [ -L "$d" ]; then
    backup_path "$d" || return 1
    ENT_CHANGED=$((ENT_CHANGED + 1)); return 0
  fi
  if [ -e "$d" ]; then
    if [ -d "$d" ]; then
      backup_path "$d" || return 1
      ENT_CHANGED=$((ENT_CHANGED + 1)); return 0
    fi
    if [ -f "$d" ]; then
      if file_equal "$s" "$d"; then ENT_SKIPPED=$((ENT_SKIPPED + 1)); return 0; fi
      backup_path "$d" || return 1
      ENT_CHANGED=$((ENT_CHANGED + 1)); return 0
    fi
    backup_path "$d" || return 1
    ENT_CHANGED=$((ENT_CHANGED + 1)); return 0
  fi
  ENT_ADDED=$((ENT_ADDED + 1))
  return 0
}

# --- dry-run: read-only classification of a single destination path ---------
_inspect_dry() {
  local s="$1" d="$2" disp
  disp="${d#"$HOME"/}"
  if [ -L "$d" ] || { [ -e "$d" ] && [ ! -f "$d" ]; }; then
    ENT_CHANGED=$((ENT_CHANGED + 1)); action_needed=1
    printf '  changed %s\n' "$disp"; return 0
  fi
  if [ -f "$d" ]; then
    if file_equal "$s" "$d"; then
      ENT_SKIPPED=$((ENT_SKIPPED + 1))
    else
      ENT_CHANGED=$((ENT_CHANGED + 1)); action_needed=1
      printf '  changed %s\n' "$disp"
    fi
    return 0
  fi
  ENT_ADDED=$((ENT_ADDED + 1)); action_needed=1
  printf '  added %s\n' "$disp"
  return 0
}

# --- real-run: copy a directory entry, preserving orphans (D-14) ------------
# Walks payload directories *and* files so an empty directory cannot bypass
# blocker inspection (CR-02). Any failed backup/parent inspection aborts the
# whole entry BEFORE rsync, so a refused backup can never fall through to a
# copy that destroys the destination (CR-01).
_entry_dir_real() {
  local src="$1" dst_dir="$2" exf="$3" sfile rel dfile aborted=0
  ensure_dir "$dst_dir" || return 1
  local list="$work/src.list"
  if ! find "$src" -mindepth 1 \( -type f -o -type d \) -print0 > "$list" 2>/dev/null; then
    record_failure "restore: enumerate-failed ($src)"
    return 1
  fi
  while IFS= read -r -d '' sfile <&4; do
    rel="${sfile#"$src"/}"
    if is_excluded "$rel" "$exf" "$src"; then
      if _machine_local "$rel"; then
        printf 'skipped machine-local: %s\n' "$(printf '%q' "$dst_dir/$rel")"
        ENT_SKIPPED=$((ENT_SKIPPED + 1))
      fi
      continue
    fi
    dfile="$dst_dir/$rel"
    if [ -d "$sfile" ]; then
      ensure_dir "$dfile" || { aborted=1; continue; }
      continue
    fi
    ensure_dir "$(dirname "$dfile")" || { aborted=1; continue; }
    _inspect_real "$sfile" "$dfile" || { aborted=1; continue; }
  done 4< "$list"

  if [ "$aborted" -ne 0 ]; then
    # CR-01: undo every move/mkdir made so far so a later refusal can never
    # leave earlier destinations displaced; only then fail the entry.
    if rollback_entry; then
      record_failure "restore: entry-blocked ($dst_dir) — backup refused; destination left untouched (D-01/D-04)"
    else
      record_failure "restore: entry-blocked ($dst_dir) — backup refused; rollback incomplete, see diagnostics (D-01/D-04/CR-01)"
    fi
    return 1
  fi

  # D-15: transfer bytes without `-p` (full mode bits) so a checksum-equal
  # destination keeps its non-executable permission bits.
  if ! rsync -r --no-links --checksum --no-owner --no-group --no-times \
      --exclude-from="$exf" "$src/" "$dst_dir/"; then
    record_failure "restore: copy-failed ($dst_dir)"
    return 1
  fi

  # Apply only the source executable bit; other destination mode bits stay.
  while IFS= read -r -d '' sfile <&5; do
    [ -d "$sfile" ] && continue
    rel="${sfile#"$src"/}"
    is_excluded "$rel" "$exf" && continue
    dfile="$dst_dir/$rel"
    [ -e "$dfile" ] || continue
    if [ -x "$sfile" ]; then
      chmod a+x -- "$dfile" 2>/dev/null || true
    else
      chmod a-x -- "$dfile" 2>/dev/null || true
    fi
  done 5< "$list"
  return 0
}

# --- dry-run: read-only walk of a directory entry ---------------------------
_entry_dir_dry() {
  local src="$1" dst_dir="$2" exf="$3" sfile rel dfile disp
  local list="$work/src.list"
  if ! find "$src" -mindepth 1 \( -type f -o -type d \) -print0 > "$list" 2>/dev/null; then
    record_failure "restore: enumerate-failed ($src)"
    return 1
  fi
  while IFS= read -r -d '' sfile <&4; do
    rel="${sfile#"$src"/}"
    if is_excluded "$rel" "$exf" "$src"; then
      if _machine_local "$rel"; then
        printf '  skipped machine-local %s\n' "$(printf '%q' "$dst_dir/$rel")"
        ENT_SKIPPED=$((ENT_SKIPPED + 1))
      fi
      continue
    fi
    dfile="$dst_dir/$rel"
    if [ -d "$sfile" ]; then
      # A converged real directory is a no-op; a symlink/file blocker is drift.
      if [ -L "$dfile" ] || { [ -e "$dfile" ] && [ ! -d "$dfile" ]; }; then
        ENT_CHANGED=$((ENT_CHANGED + 1)); action_needed=1
        disp="${dfile#"$HOME"/}"
        printf '  changed %s\n' "$disp"
      fi
      continue
    fi
    _inspect_dry "$sfile" "$dfile"
  done 4< "$list"
  return 0
}

# --- real-run: copy a single-file root without trailing-slash semantics -----
_entry_file_real() {
  local src="$1" dst="$2"
  ensure_dir "$(dirname "$dst")" || { rollback_entry || true; return 1; }
  _inspect_real "$src" "$dst" || { rollback_entry || true; return 1; }
  if ! rsync --no-links --checksum --no-owner --no-group --no-times "$src" "$dst"; then
    record_failure "restore: copy-failed ($dst)"
    return 1
  fi
  # D-15: apply only the source executable bit.
  if [ -x "$src" ]; then
    chmod a+x -- "$dst" 2>/dev/null || true
  else
    chmod a-x -- "$dst" 2>/dev/null || true
  fi
  return 0
}

_entry_file_dry() {
  _inspect_dry "$1" "$2"
}

# --- npm staleness fingerprint (D-09/D-11) ----------------------------------
npm_digest() {
  sha256sum -- "$1" "$2" 2>/dev/null | sha256sum 2>/dev/null | cut -d' ' -f1
}

npm_lock_path() {
  local dest_dir="$1"
  if [ -f "$dest_dir/package-lock.json" ]; then printf '%s\n' "$dest_dir/package-lock.json"; return 0; fi
  if [ -f "$dest_dir/npm-shrinkwrap.json" ]; then printf '%s\n' "$dest_dir/npm-shrinkwrap.json"; return 0; fi
  return 1
}

# returns 0 when an install is needed (missing modules or stale fingerprint)
npm_install_needed() {
  local dest_dir="$1" nm marker pkg lock cur prev
  nm="$dest_dir/node_modules"
  marker="$nm/.habitat-restore-fingerprint"
  pkg="$dest_dir/package.json"
  lock="$(npm_lock_path "$dest_dir" || true)"
  if [ ! -d "$nm" ] || [ ! -f "$marker" ]; then return 0; fi
  if [ -n "$lock" ] && [ -f "$pkg" ]; then
    cur="$(npm_digest "$pkg" "$lock")"
    prev="$(cat "$marker" 2>/dev/null || true)"
    [ "$cur" = "$prev" ] && return 1
    return 0
  fi
  return 0
}

# --- fixed post-step dispatch: `npm ci` only, never `eval` (RST-04) ---------
npm_gate() {
  local dest_dir="$1" dest="$2" pkg lock nm marker missing tool
  pkg="$dest_dir/package.json"
  lock="$(npm_lock_path "$dest_dir" || true)"
  nm="$dest_dir/node_modules"
  marker="$nm/.habitat-restore-fingerprint"

  if ! npm_install_needed "$dest_dir"; then
    printf 'npm ci: up-to-date (%s)\n' "$dest"
    log_line "npm-ci up-to-date ${dest}"
    return 0
  fi

  missing=0
  for tool in node npm; do
    command -v "$tool" >/dev/null 2>&1 || missing=1
  done
  if [ "$missing" -ne 0 ]; then
    record_failure "restore: npm required ($dest) — install Node.js/npm and retry (D-12)"
    return 0
  fi
  if [ ! -f "$pkg" ] || [ -z "$lock" ]; then
    record_failure "restore: npm-inputs-missing ($dest) — package.json and package-lock.json are required (D-09)"
    return 0
  fi
  if ( cd "$dest_dir" && npm ci ); then
    mkdir -p "$nm" 2>/dev/null || true
    npm_digest "$pkg" "$lock" > "$marker" 2>/dev/null || true
    printf 'npm ci: installed (%s)\n' "$dest"
    log_line "npm-ci installed ${dest}"
  else
    record_failure "restore: npm-failed ($dest) — retry npm ci by hand (D-10)"
  fi
  return 0
}

_real_post_steps() {
  local dst_dir="$1" dest="$2" psf="$3" step
  [ -s "$psf" ] || return 0
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    case "$step" in
      'npm ci') npm_gate "$dst_dir" "$dest" ;;
      *) record_failure "restore: post-step-unsupported ($step for $dest) (RST-04)" ;;
    esac
  done < "$psf"
  return 0
}

_dry_post_steps() {
  local dst_dir="$1" dest="$2" psf="$3" step
  [ -s "$psf" ] || return 0
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    case "$step" in
      'npm ci')
        if npm_install_needed "$dst_dir"; then
          printf 'npm ci: would-run (%s)\n' "$dest"; action_needed=1
        else
          printf 'npm ci: up-to-date (%s)\n' "$dest"
        fi
        ;;
      *) printf 'restore: post-step-unsupported (%s for %s)\n' "$step" "$dest"; action_needed=1 ;;
    esac
  done < "$psf"
  return 0
}

# --- per-entry driver -------------------------------------------------------
process_entry() {
  local idx="$1"
  local origin="${origins[$idx]}"
  local dest="${dests[$idx]}"
  local type="${src_types[$idx]}"
  local src="$repo_root/$dest"
  local dst="$HOME/$origin"
  local exf="$work/excludes.$idx"
  local psf="${postfiles[$idx]}"

  ENT_ADDED=0; ENT_CHANGED=0; ENT_SKIPPED=0
  entry_act_reset
  printf '[entry %s -> %s]\n' "$origin" "$dest"

  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$type" = "file" ]; then
      _entry_file_dry "$src" "$dst"
    else
      _entry_dir_dry "$src" "$dst" "$exf"
    fi
    printf 'added=%s changed=%s skipped=%s\n' "$ENT_ADDED" "$ENT_CHANGED" "$ENT_SKIPPED"
    _dry_post_steps "$dst" "$dest" "$psf"
  else
    local entry_failed=0
    if [ "$type" = "file" ]; then
      # WR-02: the file-entry helpers already emit named diagnostics
      # (backup-collision, backup-failed, mkdir-failed, copy-failed); no
      # blanket duplicate message here.
      _entry_file_real "$src" "$dst" || entry_failed=1
    else
      _entry_dir_real "$src" "$dst" "$exf" || entry_failed=1
    fi
    if [ "$entry_failed" -eq 0 ]; then
      # A refused entry must never be summarized as a no-op (CR-01).
      if [ "$ENT_ADDED" -eq 0 ] && [ "$ENT_CHANGED" -eq 0 ]; then
        printf 'up-to-date, skipped %s files\n' "$ENT_SKIPPED"
      else
        printf 'added=%s changed=%s skipped=%s\n' "$ENT_ADDED" "$ENT_CHANGED" "$ENT_SKIPPED"
      fi
      # WR-01: post-steps (npm ci) only run for an entry whose files were
      # fully placed; a failed entry never dispatches dependency installs.
      _real_post_steps "$dst" "$dest" "$psf"
    else
      printf 'restore: entry-failed (%s) — post-steps skipped (WR-01)\n' "$dest"
    fi
  fi

  total_added=$((total_added + ENT_ADDED))
  total_changed=$((total_changed + ENT_CHANGED))
  total_skipped=$((total_skipped + ENT_SKIPPED))
  return 0
}

# ================= dry-run: read-only preview (D-06) ========================
if [ "$DRY_RUN" -eq 1 ]; then
  printf 'restore: dry-run — read-only preview (D-06)\n'
  for ((idx = 0; idx < entry_count; idx++)); do
    process_entry "$idx"
  done
  printf 'restore: total added=%s changed=%s skipped=%s backups=%s\n' \
    "$total_added" "$total_changed" "$total_skipped" "$total_backup"
  if [ "$action_needed" -eq 0 ]; then
    printf 'restore: converged\n'
    exit 0
  fi
  printf 'restore: drift (action needed)\n'
  exit 1
fi

# ================= real restore: copy, then conditional npm =================
printf 'restore: restoring into %s\n' "$home_real"
for ((idx = 0; idx < entry_count; idx++)); do
  process_entry "$idx"
done

printf 'restore: total added=%s changed=%s skipped=%s backups=%s\n' \
  "$total_added" "$total_changed" "$total_skipped" "$total_backup"
log_line "complete added=${total_added} changed=${total_changed} skipped=${total_skipped} backups=${total_backup} errors=${fail_count}"

if [ "$fail_count" -eq 0 ]; then
  printf 'restore: complete\n'
  exit 0
fi
printf 'restore: failed (%d errors)\n' "$fail_count" >&2
exit 1
