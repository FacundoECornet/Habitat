// lib/manifest.mjs — shared MANIFEST.json reader + strict validator (D-01..D-16)
//
// The single Node implementation of the manifest contract. `scripts/restore.sh`
// is a thin shim over tools/restore.mjs, which consumes these exports, so the
// restore engine no longer needs Bash, rsync, sha256sum or a NUL token stream.
// `lib/manifest.sh` (Bash) stays for capture.sh (Linux/WSL capture only).
//
// Public API:
//   readManifest(path)            -> parsed document (throws ManifestError)
//   validateManifest(doc)         -> true (throws ManifestError with .code)
//   manifestEntries(doc)          -> [{origin,dest,mode,excludes,postSteps}]
//   loadValidatedManifest(path)   -> manifestEntries(doc) after validation

import fs from "node:fs";

export class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

export function readManifest(manifestPath) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new ManifestError("manifest-read", "cannot read manifest at " + manifestPath);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ManifestError("manifest-json", "manifest is not valid JSON");
  }
  return doc;
}

const TOP_KEYS = ["version", "generated", "entries"];

// D-06 allowlist: exact origin -> dest mapping.
const ALLOWLIST = new Map([
  [".config/opencode", "home/.config/opencode"],
  [".claude/skills", "home/.claude/skills"],
  [".agents/skills", "home/.agents/skills"],
  [".gsd", "home/.gsd"],
  [".opencode", "home/.opencode"],
  ["AGENTS.md", "home/AGENTS.md"],
  [".bashrc", "home/.bashrc"],
  [".gitconfig", "home/.gitconfig"],
]);

// Every entry must declare the full structural denylist (D-07/D-08/D-10).
const REQUIRED_EXCLUDES = [
  "node_modules/", "bin/", "*.tar.gz", "*.tgz", "*.tar", "*.zip", "*.bak*",
  "opencode-backup/", "opencode-backup-*.tar.gz", "agents.bak-*",
  "jev.env", ".git-credentials", ".claude.json", ".git/", "*.local",
  "*.db", "*.db-wal", "*.db-shm",
];

const REQUIRED_EXCLUDES_BY_ORIGIN = new Map([
  [".config/opencode", ["sessions/", "gsd-router.backup/", "backup-*"]],
]);

const ENTRY_KEYS = ["origin", "dest", "mode", "excludes", "post_steps"];

function pathIssue(p) {
  if (typeof p !== "string" || p.length === 0) return "type";
  if (p.startsWith("/") || p.startsWith("~") || p.includes("\\")) return "absolute";
  if (p.split("/").includes("..")) return "traversal";
  return null;
}

function invalid(code, message) {
  throw new ManifestError(code, message);
}

export function validateManifest(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    invalid("manifest-shape", "top-level manifest must be a JSON object");
  }

  const topKeys = Object.keys(doc);
  for (const k of topKeys) {
    if (!TOP_KEYS.includes(k)) invalid("manifest-unknown-key", "unknown top-level key: " + k);
  }
  for (const k of TOP_KEYS) {
    if (!topKeys.includes(k)) invalid("manifest-missing-key", "missing top-level key: " + k);
  }

  if (doc.version !== "1.0.0") {
    invalid("manifest-version", 'version must be exactly "1.0.0" (got ' + JSON.stringify(doc.version) + ")");
  }

  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (typeof doc.generated !== "string" || !rfc3339.test(doc.generated)) {
    invalid("manifest-generated", "generated must be an RFC3339 timestamp");
  }

  if (!Array.isArray(doc.entries)) invalid("manifest-entries-type", "entries must be an array");
  if (doc.entries.length !== 8) {
    invalid("manifest-entry-count", "entries must contain exactly 8 roots (got " + doc.entries.length + ")");
  }

  const seenOrigin = new Set();
  const seenDest = new Set();

  doc.entries.forEach(function (entry, i) {
    const where = "entries[" + i + "]";
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalid("manifest-entry-shape", where + " must be a JSON object");
    }

    const keys = Object.keys(entry);
    for (const k of keys) {
      if (!ENTRY_KEYS.includes(k)) invalid("manifest-entry-unknown-key", where + " has unknown key: " + k);
    }
    for (const k of ENTRY_KEYS) {
      if (!keys.includes(k)) invalid("manifest-entry-missing-field", where + " missing required field: " + k);
    }

    const { origin, dest, mode, excludes, post_steps: postSteps } = entry;

    const originIssue = pathIssue(origin);
    if (originIssue === "type") invalid("manifest-origin-type", where + ".origin must be a non-empty string");
    if (originIssue === "absolute") invalid("manifest-path-absolute", where + ".origin must be relative (got " + JSON.stringify(origin) + ")");
    if (originIssue === "traversal") invalid("manifest-path-traversal", where + '.origin must not contain ".."');

    const destIssue = pathIssue(dest);
    if (destIssue === "type") invalid("manifest-dest-type", where + ".dest must be a non-empty string");
    if (destIssue === "absolute") invalid("manifest-path-absolute", where + ".dest must be relative (got " + JSON.stringify(dest) + ")");
    if (destIssue === "traversal") invalid("manifest-path-traversal", where + '.dest must not contain ".."');

    if (seenOrigin.has(origin)) invalid("manifest-duplicate-origin", "duplicate origin: " + JSON.stringify(origin));
    if (seenDest.has(dest)) invalid("manifest-duplicate-dest", "duplicate dest: " + JSON.stringify(dest));
    seenOrigin.add(origin);
    seenDest.add(dest);

    if (!ALLOWLIST.has(origin)) {
      invalid("manifest-unknown-root", where + ".origin is outside the D-06 allowlist: " + JSON.stringify(origin));
    }
    if (ALLOWLIST.get(origin) !== dest) {
      invalid("manifest-dest-mismatch", where + ".dest must be " + JSON.stringify(ALLOWLIST.get(origin)) + " for origin " + JSON.stringify(origin));
    }
    if (!dest.startsWith("home/")) invalid("manifest-dest-prefix", where + ".dest must live under home/");

    if (mode !== "copy") invalid("manifest-mode", where + '.mode must be "copy" (got ' + JSON.stringify(mode) + ")");

    if (!Array.isArray(excludes)) invalid("manifest-excludes-type", where + ".excludes must be an array");
    for (const e of excludes) {
      if (typeof e !== "string" || e.length === 0) invalid("manifest-excludes-item", where + ".excludes items must be non-empty strings");
      if (e.startsWith("/")) invalid("manifest-exclude-absolute", where + ".excludes must be relative: " + JSON.stringify(e));
      if (e.split("/").includes("..")) invalid("manifest-exclude-traversal", where + '.excludes must not contain "..": ' + JSON.stringify(e));
    }
    for (const req of REQUIRED_EXCLUDES) {
      if (!excludes.includes(req)) invalid("manifest-excludes-incomplete", where + ".excludes must include " + JSON.stringify(req));
    }
    const originRequired = REQUIRED_EXCLUDES_BY_ORIGIN.get(origin) || [];
    for (const req of originRequired) {
      if (!excludes.includes(req)) invalid("manifest-excludes-incomplete", where + ".excludes must include " + JSON.stringify(req));
    }

    if (!Array.isArray(postSteps)) invalid("manifest-post-steps-type", where + ".post_steps must be an array");
    for (const s of postSteps) {
      if (typeof s !== "string" || s.length === 0) invalid("manifest-post-steps-item", where + ".post_steps items must be non-empty strings");
    }
  });

  const missing = Array.from(ALLOWLIST.keys()).filter(function (o) { return !seenOrigin.has(o); });
  if (missing.length > 0) invalid("manifest-missing-root", "missing required D-06 roots: " + missing.join(", "));

  return true;
}

export function manifestEntries(doc) {
  return doc.entries.map(function (entry) {
    return {
      origin: entry.origin,
      dest: entry.dest,
      mode: entry.mode,
      excludes: Array.isArray(entry.excludes) ? entry.excludes.slice() : [],
      postSteps: Array.isArray(entry.post_steps) ? entry.post_steps.slice() : [],
    };
  });
}

export function loadValidatedManifest(manifestPath) {
  const doc = readManifest(manifestPath);
  validateManifest(doc);
  return manifestEntries(doc);
}
