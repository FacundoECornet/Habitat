#!/usr/bin/env bash
# validate-manifest.sh — strict copy-only manifest contract validator
#
# Usage: scripts/validate-manifest.sh [manifest-path]
# With no argument, validates <repo-root>/MANIFEST.json.
#
# Fail-closed: exits nonzero with a named diagnostic (`INVALID: <code>`) on any
# contract violation. Accepts only a syntactically valid JSON manifest whose
# entries match the exact six-entry allowlist with copy-only mode.
#
# Zero dependencies beyond Bash and Node.js built-ins (no jq, no packages).

set -u
set -o pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -ge 1 ]; then
  manifest_path="$1"
else
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$repo_root" ] || repo_root="$(cd "$script_dir/.." && pwd)"
  manifest_path="$repo_root/MANIFEST.json"
fi

node - "$manifest_path" <<'NODE'
'use strict';
const fs = require('fs');

const manifestPath = process.argv[2];

function invalid(code, message) {
  process.stderr.write('INVALID: ' + code + ' — ' + message + '\n');
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(manifestPath, 'utf8');
} catch (err) {
  invalid('manifest-read', 'cannot read manifest at ' + manifestPath);
}

let doc;
try {
  doc = JSON.parse(raw);
} catch (err) {
  invalid('manifest-json', 'manifest is not valid JSON');
}

if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
  invalid('manifest-shape', 'top-level manifest must be a JSON object');
}

const TOP_KEYS = ['version', 'generated', 'entries'];
const topKeys = Object.keys(doc);
for (const k of topKeys) {
  if (!TOP_KEYS.includes(k)) invalid('manifest-unknown-key', 'unknown top-level key: ' + k);
}
for (const k of TOP_KEYS) {
  if (!topKeys.includes(k)) invalid('manifest-missing-key', 'missing top-level key: ' + k);
}

if (doc.version !== '1.0.0') {
  invalid('manifest-version', 'version must be exactly "1.0.0" (got ' + JSON.stringify(doc.version) + ')');
}

const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
if (typeof doc.generated !== 'string' || !rfc3339.test(doc.generated)) {
  invalid('manifest-generated', 'generated must be an RFC3339 timestamp');
}

if (!Array.isArray(doc.entries)) invalid('manifest-entries-type', 'entries must be an array');
// allowlist: exact origin -> dest mapping.
const ALLOWLIST = new Map([
  ['.config/opencode', 'home/.config/opencode'],
  ['.claude/skills', 'home/.claude/skills'],
  ['.agents/skills', 'home/.agents/skills'],
  ['.gsd', 'home/.gsd'],
  ['AGENTS.md', 'home/AGENTS.md'],
  ['.bashrc', 'home/.bashrc']
]);
if (doc.entries.length !== ALLOWLIST.size) {
  invalid('manifest-entry-count', 'entries must contain exactly ' + ALLOWLIST.size + ' roots (got ' + doc.entries.length + ')');
}

// Every entry must declare the full structural denylist.
const REQUIRED_EXCLUDES = [
  'node_modules/', '*.tar.gz', '*.tgz', '*.tar', '*.zip', '*.bak*',
  '*.backup-*',
  'opencode-backup/', 'opencode-backup-*.tar.gz', 'agents.bak-*',
  'jev.env', '.git-credentials', '.claude.json', '.git/', '*.local',
  '*.db', '*.db-wal', '*.db-shm'
];

// Per-origin extras (Phase 3 Option-A runtime exclusions, decisions 03-03).
const REQUIRED_EXCLUDES_BY_ORIGIN = new Map([
  ['.config/opencode', ['bin/', 'sessions/', 'gsd-router.backup/', 'backup-*', 'gsd-install-state.json']],
  ['.claude/skills', ['bin/']],
  ['.gsd', ['bin/']]
]);

const ENTRY_KEYS = ['origin', 'dest', 'mode', 'excludes', 'post_steps'];

function pathIssue(p) {
  if (typeof p !== 'string' || p.length === 0) return 'type';
  if (p.startsWith('/') || p.startsWith('~') || p.includes('\\')) return 'absolute';
  if (p.split('/').includes('..')) return 'traversal';
  return null;
}

const seenOrigin = new Set();
const seenDest = new Set();

doc.entries.forEach(function (entry, i) {
  const where = 'entries[' + i + ']';
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    invalid('manifest-entry-shape', where + ' must be a JSON object');
  }

  const keys = Object.keys(entry);
  for (const k of keys) {
    if (!ENTRY_KEYS.includes(k)) invalid('manifest-entry-unknown-key', where + ' has unknown key: ' + k);
  }
  for (const k of ENTRY_KEYS) {
    if (!keys.includes(k)) invalid('manifest-entry-missing-field', where + ' missing required field: ' + k);
  }

  const origin = entry.origin;
  const dest = entry.dest;
  const mode = entry.mode;
  const excludes = entry.excludes;
  const postSteps = entry.post_steps;

  const originIssue = pathIssue(origin);
  if (originIssue === 'type') invalid('manifest-origin-type', where + '.origin must be a non-empty string');
  if (originIssue === 'absolute') invalid('manifest-path-absolute', where + '.origin must be relative (got ' + JSON.stringify(origin) + ')');
  if (originIssue === 'traversal') invalid('manifest-path-traversal', where + '.origin must not contain ".."');

  const destIssue = pathIssue(dest);
  if (destIssue === 'type') invalid('manifest-dest-type', where + '.dest must be a non-empty string');
  if (destIssue === 'absolute') invalid('manifest-path-absolute', where + '.dest must be relative (got ' + JSON.stringify(dest) + ')');
  if (destIssue === 'traversal') invalid('manifest-path-traversal', where + '.dest must not contain ".."');

  if (seenOrigin.has(origin)) invalid('manifest-duplicate-origin', 'duplicate origin: ' + JSON.stringify(origin));
  if (seenDest.has(dest)) invalid('manifest-duplicate-dest', 'duplicate dest: ' + JSON.stringify(dest));
  seenOrigin.add(origin);
  seenDest.add(dest);

  if (!ALLOWLIST.has(origin)) {
    invalid('manifest-unknown-root', where + '.origin is outside the allowlist: ' + JSON.stringify(origin));
  }
  if (ALLOWLIST.get(origin) !== dest) {
    invalid('manifest-dest-mismatch', where + '.dest must be ' + JSON.stringify(ALLOWLIST.get(origin)) + ' for origin ' + JSON.stringify(origin));
  }
  if (!dest.startsWith('home/')) invalid('manifest-dest-prefix', where + '.dest must live under home/');

  if (mode !== 'copy') invalid('manifest-mode', where + '.mode must be "copy" (got ' + JSON.stringify(mode) + ')');

  if (!Array.isArray(excludes)) invalid('manifest-excludes-type', where + '.excludes must be an array');
  for (const e of excludes) {
    if (typeof e !== 'string' || e.length === 0) invalid('manifest-excludes-item', where + '.excludes items must be non-empty strings');
    if (e.startsWith('/')) invalid('manifest-exclude-absolute', where + '.excludes must be relative: ' + JSON.stringify(e));
    if (e.split('/').includes('..')) invalid('manifest-exclude-traversal', where + '.excludes must not contain "..": ' + JSON.stringify(e));
  }
  for (const req of REQUIRED_EXCLUDES) {
    if (!excludes.includes(req)) invalid('manifest-excludes-incomplete', where + '.excludes must include ' + JSON.stringify(req));
  }
  const originRequired = REQUIRED_EXCLUDES_BY_ORIGIN.get(origin) || [];
  for (const req of originRequired) {
    if (!excludes.includes(req)) invalid('manifest-excludes-incomplete', where + '.excludes must include ' + JSON.stringify(req));
  }

  if (!Array.isArray(postSteps)) invalid('manifest-post-steps-type', where + '.post_steps must be an array');
  for (const s of postSteps) {
    if (typeof s !== 'string' || s.length === 0) invalid('manifest-post-steps-item', where + '.post_steps items must be non-empty strings');
  }
});

const missing = Array.from(ALLOWLIST.keys()).filter(function (o) { return !seenOrigin.has(o); });
if (missing.length > 0) invalid('manifest-missing-root', 'missing required roots: ' + missing.join(', '));

process.stdout.write('VALID: ' + doc.entries.length + ' entries\n');
process.exit(0);
NODE
