#!/usr/bin/env bash
# lib/manifest.sh — shared read-only MANIFEST.json reader (D-10)
#
# Purpose:
#   The single parser that owns MANIFEST reading for every habitat script
#   (capture now; restore and verify later). It never `eval`s, never grep-parses
#   JSON, and never repeats the six-root list — MANIFEST.json stays the sole
#   source of truth, and `scripts/validate-manifest.sh` remains the strict
#   contract gate that must run first.
#
# Public API:
#   manifest_entries <manifest_path> <out_file>
#     Parses MANIFEST.json with Node built-ins and writes a NUL-delimited token
#     stream to <out_file>, one record per entry, in this field order:
#
#       origin \0 dest \0 mode \0
#       excludes_count \0 exclude_1 \0 ... \0 exclude_N \0
#       post_steps_count \0 step_1 \0 ... \0 step_M \0
#
#     Bash cannot hold NUL bytes in a variable, so callers read the tokens with
#     `read -r -d ''`. Returns nonzero with a named stderr diagnostic when the
#     manifest cannot be read or parsed.
#
# NOTE: `set -e` is never used here; token parsing is driven by explicit `read`
# status checks in the caller.

manifest_entries() {
  local manifest_path="${1:-}"
  local out_file="${2:-}"
  if [ -z "$manifest_path" ] || [ -z "$out_file" ]; then
    printf 'manifest_entries: usage: manifest_entries <manifest_path> <out_file> (D-10)\n' >&2
    return 2
  fi

  node - "$manifest_path" > "$out_file" <<'NODE'
'use strict';
const fs = require('fs');
const manifestPath = process.argv[2];

function die(message) {
  process.stderr.write('manifest_entries: ' + message + '\n');
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(manifestPath, 'utf8');
} catch (err) {
  die('cannot read manifest at ' + manifestPath);
}

let doc;
try {
  doc = JSON.parse(raw);
} catch (err) {
  die('manifest is not valid JSON');
}

if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.entries)) {
  die('manifest must be an object with an entries array');
}

const tokens = [];
for (const entry of doc.entries) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    die('manifest entry is not an object');
  }
  if (typeof entry.origin !== 'string') die('entry.origin must be a string');
  if (typeof entry.dest !== 'string') die('entry.dest must be a string');
  if (typeof entry.mode !== 'string') die('entry.mode must be a string');

  const excludes = Array.isArray(entry.excludes) ? entry.excludes : [];
  const postSteps = Array.isArray(entry.post_steps) ? entry.post_steps : [];

  tokens.push(entry.origin);
  tokens.push(entry.dest);
  tokens.push(entry.mode);
  tokens.push(String(excludes.length));
  for (const e of excludes) tokens.push(String(e));
  tokens.push(String(postSteps.length));
  for (const s of postSteps) tokens.push(String(s));
}

process.stdout.write(tokens.map(function (t) { return t + '\0'; }).join(''));
NODE
}
