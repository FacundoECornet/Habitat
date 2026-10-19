// tools/restore.mjs — manifest-driven, fail-closed, idempotent $HOME restore
//
// The single cross-platform restore engine (D-01). `scripts/restore.sh` is a
// thin shim that execs this file; `tools/install.mjs` invokes it directly with
// the Node runtime. It needs only Node.js built-ins (no Bash, rsync, sha256sum,
// git nor a NUL token stream), so it runs natively on Windows.
//
// Contract preserved verbatim from the Bash original:
//   D-01 sibling .backup-YYYYMMDD-HHMMSS    D-02 checksum + exec bit only
//   D-03 stdout + persistent log            D-04 backup exact blocker, no follow
//   D-05 no-op rerun summary                D-06 read-only dry-run 0/1 contract
//   D-07 equality matches capture           D-08 accumulate failures
//   D-09 conditional npm ci                 D-10 files first, npm failure continues
//   D-11 never copy node_modules            D-12 missing node/npm fail-closed
//   D-13 skip machine-local (*.local)       D-14 preserve orphans, no destructive delete
//   D-15 mkdir parents, exec bit only       D-16 fail-closed preflight, no /mnt/c drvfs
//
// Usage:
//   node tools/restore.mjs [--dry-run] [--verify] [--no-models] [--no-cli]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadValidatedManifest, ManifestError } from "../lib/manifest.mjs";
import { materialize } from "../lib/home-placeholder.mjs";
import { isCertificateError, withSystemCaAnyPlatform } from "../lib/opencode-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function err(msg) { process.stderr.write(msg + "\n"); }
function out(msg) { process.stdout.write(msg + "\n"); }

// --- argument parsing -------------------------------------------------------
let DRY_RUN = false;
let VERIFY = false;
const VERIFY_ARGS = [];

for (const arg of process.argv.slice(2)) {
  switch (arg) {
    case "--dry-run": DRY_RUN = true; break;
    case "--verify": VERIFY = true; break;
    case "-h":
    case "--help":
      out("Usage: restore.sh [--dry-run] [--verify]");
      process.exit(0);
      break;
    case "--no-models":
    case "--no-cli":
      VERIFY_ARGS.push(arg);
      break;
    default:
      err("restore: unknown-argument (" + arg + ")");
      process.exit(2);
  }
}

// --- resolve $HOME (D-16) ---------------------------------------------------
const HOME = process.env.HOME;
if (!HOME) {
  err("restore: home-unset — HOME must point at the live ecosystem root (D-16)");
  process.exit(2);
}

// Resolve the canonical HOME. On POSIX prefer the external `realpath` (honors a
// PATH shim, preserves test V), then Node's native canonicalization. On win32
// the external tool is skipped and `realpathSync.native` yields the case-folded
// long path (W3).
function resolveHome() {
  if (process.platform !== "win32") {
    const r = spawnSync("realpath", [HOME], { encoding: "utf8" });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  }
  try {
    const native = fs.realpathSync.native ?? fs.realpathSync;
    return native(HOME);
  } catch { return null; }
}
const homeReal = resolveHome();
if (!homeReal) {
  err("restore: home-unresolved (cannot canonicalize HOME: " + HOME + ") (D-16)");
  process.exit(2);
}

// Reject a live root sitting on a Windows mount or WSL share: a drvfs/UNC home
// breaks the executable bit, the case-folded boundary and the backup renames
// (D-16). Normalize separators so both POSIX and win32 spellings are caught.
const homeNorm = homeReal.replace(/\\/g, "/").toLowerCase();
if (homeNorm === "/mnt/c" || homeNorm.startsWith("/mnt/c/")) {
  err("restore: home-on-drvfs (" + homeReal + ") — refusing before any write (D-16)");
  process.exit(2);
}
if (homeNorm.startsWith("//wsl$/") || homeNorm.startsWith("//wsl.localhost/")) {
  err("restore: home-on-wsl-share (" + homeReal + ") — usá un home nativo, no \\\\wsl$ (D-16)");
  process.exit(2);
}

// --- strict validator before any persistent mutation (D-16) -----------------
const manifestPath = path.join(repoRoot, "MANIFEST.json");
let entries;
try {
  entries = loadValidatedManifest(manifestPath);
} catch (e) {
  if (e instanceof ManifestError) {
    err("INVALID: " + e.code + " — " + e.message);
  } else {
    err("INVALID: manifest-read — " + (e && e.message ? e.message : String(e)));
  }
  err("restore: manifest-invalid — refusing before any write (D-16)");
  process.exit(2);
}

// --- reject exclude patterns rsync would interpret differently (WR-01/WR-03)
for (const entry of entries) {
  for (const pat of entry.excludes) {
    if (pat.startsWith("#")) {
      err("restore: exclude-pattern-unsupported (" + pat + ": leading # is an rsync comment) (WR-01)");
      process.exit(2);
    }
    if (pat.startsWith("!")) {
      err("restore: exclude-pattern-unsupported (" + pat + ": leading ! is an rsync include rule) (WR-01)");
      process.exit(2);
    }
    let core = pat;
    if (core.endsWith("/")) core = core.slice(0, -1);
    if (core.includes("/")) {
      err("restore: exclude-pattern-unsupported (" + pat + ": internal slash anchors the pattern) (WR-01/WR-03)");
      process.exit(2);
    }
  }
}

if (entries.length === 0) {
  err("restore: manifest-empty (no entries parsed)");
  process.exit(2);
}

// --- headless preflight: every repo payload root present, readable, typed ---
const srcTypes = [];
let preflightProblems = 0;
for (const entry of entries) {
  const src = path.join(repoRoot, entry.dest);
  let st = null;
  try { st = fs.statSync(src); } catch { st = null; }
  if (st && st.isDirectory()) {
    srcTypes.push("dir");
  } else if (st && st.isFile()) {
    srcTypes.push("file");
  } else {
    err("restore: origin-missing (" + entry.dest + ") — refusing before any write (D-16)");
    srcTypes.push("missing");
    preflightProblems += 1;
    continue;
  }
  try { fs.accessSync(src, fs.constants.R_OK); } catch {
    err("restore: origin-unreadable (" + entry.dest + ") — refusing before any write (D-16)");
    preflightProblems += 1;
  }
}
if (preflightProblems !== 0) {
  err("restore: preflight-failed (" + preflightProblems + ") — no destination writes performed");
  process.exit(2);
}

// --- persistent log (real run only; never in dry-run) (D-03) ----------------
const habitatDir = path.join(HOME, ".habitat");
const logFile = path.join(habitatDir, "restore.log");
if (!DRY_RUN) {
  let hst = null;
  try { hst = fs.lstatSync(habitatDir); } catch { hst = null; }
  if (hst && hst.isSymbolicLink()) {
    err("restore: log-unwritable (" + habitatDir + " is a symlink) — refusing before replacement (D-03)");
    process.exit(2);
  }
  try { fs.mkdirSync(habitatDir, { recursive: true }); } catch {
    err("restore: log-unwritable (cannot create " + habitatDir + ") (D-03)");
    process.exit(2);
  }
  let lst = null;
  try { lst = fs.lstatSync(logFile); } catch { lst = null; }
  if (lst && lst.isSymbolicLink()) {
    err("restore: log-unwritable (" + logFile + " is a symlink) — refusing before replacement (D-03)");
    process.exit(2);
  }
  try { fs.appendFileSync(logFile, ""); } catch {
    err("restore: log-unwritable (" + logFile + ") — refusing before replacement (D-03)");
    process.exit(2);
  }
}

// --- shared run state -------------------------------------------------------
function externalDate(fmt, fallback) {
  // Only POSIX `date` understands GNU format strings, and the tests shim it
  // there; on win32 use the JS fallback directly.
  if (process.platform !== "win32") {
    const r = spawnSync("date", ["-u", fmt], { encoding: "utf8" });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  }
  return fallback();
}
function jsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "-" +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds())
  );
}
function jsIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }

const STAMP = externalDate("+%Y%m%d-%H%M%S", jsStamp);
let failCount = 0;
let totalAdded = 0;
let totalChanged = 0;
let totalSkipped = 0;
let totalBackup = 0;
let actionNeeded = false;
let ENT_ADDED = 0;
let ENT_CHANGED = 0;
let ENT_SKIPPED = 0;

function recordFailure(msg) { err(msg); failCount += 1; }

// Persist one escaped record per event (WR-04): %q keeps a path with a newline
// inside a single physical log line.
function shellQuote(s) {
  if (s.length > 0 && /^[A-Za-z0-9._/:=@%,+-]+$/.test(s)) return s;
  let body = "";
  for (const ch of s) {
    switch (ch) {
      case "\n": body += "\\n"; break;
      case "\t": body += "\\t"; break;
      case "\r": body += "\\r"; break;
      case "\\": body += "\\\\"; break;
      case "'": body += "\\'"; break;
      default: body += ch;
    }
  }
  return "$'" + body + "'";
}

function logLine(s) {
  if (DRY_RUN) return;
  const ts = externalDate("+%Y-%m-%dT%H:%M:%SZ", jsIso);
  fs.appendFileSync(logFile, ts + " " + shellQuote(s) + "\n");
}

// --- equality: full content checksum + executable bit only (D-02/D-07) ------
// The payload stores __HABITAT_HOME__ tokens; the destination holds the
// expanded text, so the source side is hashed after expansion (same bytes that
// would be written). A placeholder-free file is hashed as-is.
function sha256Bytes(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function sha256File(p) { return sha256Bytes(fs.readFileSync(p)); }
function materializedSha(p) { return sha256Bytes(materialize(fs.readFileSync(p), HOME)); }
function isExec(p) { try { return (fs.statSync(p).mode & 0o111) !== 0; } catch { return false; } }
function fileEqual(a, b) {
  let ha, hb;
  try { ha = materializedSha(a); hb = sha256File(b); } catch { return false; }
  return ha === hb && isExec(a) === isExec(b);
}
// Write the expanded bytes of a payload file, keeping the source permission bits
// (the exec bit is then reconciled by the caller).
function writeMaterialized(src, dst) {
  fs.writeFileSync(dst, materialize(fs.readFileSync(src), HOME));
  try { fs.chmodSync(dst, fs.statSync(src).mode & 0o777); } catch { /* best-effort */ }
}

// --- rsync-parity glob-style exclusion matcher (WR-04/WR-05) ----------------
const globCache = new Map();
function globToRegExp(pat) {
  if (globCache.has(pat)) return globCache.get(pat);
  let re = "^";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1, cls = "[";
      if (pat[j] === "!" || pat[j] === "^") { cls += "^"; j++; }
      while (j < pat.length && pat[j] !== "]") {
        cls += pat[j] === "\\" ? "\\\\" : pat[j];
        j++;
      }
      cls += "]";
      re += cls;
      i = j;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  const rx = new RegExp(re + "$");
  globCache.set(pat, rx);
  return rx;
}
function isDirSync(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function isExcluded(rel, patterns, srcRoot) {
  const comps = rel.split("/");
  for (const pat of patterns) {
    if (!pat) continue;
    if (pat.endsWith("/")) {
      const rx = globToRegExp(pat.slice(0, -1));
      let prefix = "";
      for (const comp of comps) {
        prefix = prefix ? prefix + "/" + comp : comp;
        if (rx.test(comp)) {
          if (srcRoot) {
            if (!isDirSync(path.join(srcRoot, prefix))) continue;
          }
          return true;
        }
      }
    } else {
      const rx = globToRegExp(pat);
      for (const comp of comps) if (rx.test(comp)) return true;
    }
  }
  return false;
}

function machineLocal(rel) {
  return rel.split("/").some((c) => c.endsWith(".local"));
}

// --- per-entry mutation action log (CR-01 rollback) --------------------------
let ENTRY_KIND = [];
let ENTRY_ARG = [];
function entryActReset() { ENTRY_KIND = []; ENTRY_ARG = []; }
function entryActMv(from, to) { ENTRY_KIND.push("mv"); ENTRY_ARG.push(from + "\x1f" + to); }
function entryActMkdir(p) { ENTRY_KIND.push("mkdir"); ENTRY_ARG.push(p); }

function rollbackEntry() {
  let problems = 0;
  for (let i = ENTRY_KIND.length - 1; i >= 0; i--) {
    const kind = ENTRY_KIND[i];
    const arg = ENTRY_ARG[i];
    if (kind === "mv") {
      const idx = arg.indexOf("\x1f");
      const from = arg.slice(0, idx);
      const to = arg.slice(idx + 1);
      if (exists(from)) {
        recordFailure("restore: rollback-occupied (" + from + ") — backup kept at " + to + " (CR-01)");
        problems += 1;
      } else if (exists(to)) {
        try {
          fs.renameSync(to, from);
          out("restore: rollback (" + shellQuote(to) + " -> " + shellQuote(from) + ")");
          logLine("rollback " + to + " -> " + from);
        } catch {
          recordFailure("restore: rollback-failed (" + to + " -> " + from + ") (CR-01)");
          problems += 1;
        }
      } else {
        recordFailure("restore: rollback-missing (" + to + ") (CR-01)");
        problems += 1;
      }
    } else if (kind === "mkdir") {
      try { fs.rmdirSync(arg); } catch {
        recordFailure("restore: rollback-dir-nonempty (" + arg + ") (CR-01)");
        problems += 1;
      }
    }
  }
  entryActReset();
  return problems === 0;
}

// --- backup an exact blocker to a per-run sibling name (D-01/D-04) ----------
function backupPath(target) {
  const b = target + ".backup-" + STAMP;
  if (exists(b)) {
    recordFailure("restore: backup-collision (" + b + " exists) — refusing to overwrite (D-01)");
    return false;
  }
  try {
    fs.renameSync(target, b);
  } catch {
    recordFailure("restore: backup-failed (" + target + ")");
    return false;
  }
  entryActMv(target, b);
  out("restore: backup (" + shellQuote(target) + " -> " + shellQuote(b) + ")");
  logLine("backup " + target + " -> " + b);
  totalBackup += 1;
  return true;
}

function exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }

// A path is inside HOME when path.relative does not escape it. Case-insensitive
// comparison is unnecessary here: both sides come from the same HOME value.
function relFromHome(p) {
  const rel = path.relative(HOME, p);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

// --- create a destination directory, backing up any blocking component ------
function ensureDir(target) {
  if (target === HOME) return true;
  const rel = relFromHome(target);
  if (rel === null) return true;
  const parts = rel.split(path.sep);
  let cur = HOME;
  for (const comp of parts) {
    if (!comp || comp === ".") continue;
    cur = path.join(cur, comp);
    const st = lstat(cur);
    if (st && st.isSymbolicLink()) {
      if (!backupPath(cur)) return false;
      try { fs.mkdirSync(cur); } catch { recordFailure("restore: mkdir-failed (" + cur + ")"); return false; }
      entryActMkdir(cur);
    } else if (st) {
      if (!st.isDirectory()) {
        if (!backupPath(cur)) return false;
        try { fs.mkdirSync(cur); } catch { recordFailure("restore: mkdir-failed (" + cur + ")"); return false; }
        entryActMkdir(cur);
      }
    } else {
      try { fs.mkdirSync(cur); } catch { recordFailure("restore: mkdir-failed (" + cur + ")"); return false; }
      entryActMkdir(cur);
    }
  }
  return true;
}

// --- real-run: classify + backup a single destination path ------------------
function inspectReal(s, d) {
  const st = lstat(d);
  if (st && st.isSymbolicLink()) { if (!backupPath(d)) return false; ENT_CHANGED += 1; return true; }
  if (st) {
    if (st.isDirectory()) { if (!backupPath(d)) return false; ENT_CHANGED += 1; return true; }
    if (st.isFile()) {
      if (fileEqual(s, d)) { ENT_SKIPPED += 1; return true; }
      if (!backupPath(d)) return false;
      ENT_CHANGED += 1;
      return true;
    }
    if (!backupPath(d)) return false;
    ENT_CHANGED += 1;
    return true;
  }
  ENT_ADDED += 1;
  return true;
}

// --- dry-run: read-only classification of a single destination path ---------
function inspectDry(s, d) {
  const st = lstat(d);
  const disp = relFromHome(d) ?? d;
  if (st && (st.isSymbolicLink() || !st.isFile())) {
    ENT_CHANGED += 1; actionNeeded = true;
    out("  changed " + disp);
    return true;
  }
  if (st && st.isFile()) {
    if (fileEqual(s, d)) { ENT_SKIPPED += 1; }
    else { ENT_CHANGED += 1; actionNeeded = true; out("  changed " + disp); }
    return true;
  }
  ENT_ADDED += 1; actionNeeded = true;
  out("  added " + disp);
  return true;
}

// --- walk a payload root: files + directories, no symlinks (CR-02) ----------
function walkRoot(root) {
  const acc = [];
  const stack = [{ dir: root, rel: "" }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { throw new Error("enumerate"); }
    // reverse so pop() preserves directory order
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      const abs = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) { acc.push({ abs, rel: r, isDir: true }); stack.push({ dir: abs, rel: r }); }
      else if (st.isFile()) { acc.push({ abs, rel: r, isDir: false }); }
    }
  }
  return acc;
}

// --- real-run: copy a directory entry, preserving orphans (D-14) ------------
function entryDirReal(src, dstDir, patterns) {
  if (!ensureDir(dstDir)) return false;
  let list;
  try { list = walkRoot(src); } catch { recordFailure("restore: enumerate-failed (" + src + ")"); return false; }

  let aborted = false;
  for (const item of list) {
    const rel = item.rel;
    if (isExcluded(rel, patterns, src)) {
      if (machineLocal(rel)) {
        out("skipped machine-local: " + shellQuote(path.join(dstDir, rel)));
        ENT_SKIPPED += 1;
      }
      continue;
    }
    const dfile = path.join(dstDir, rel);
    if (item.isDir) {
      if (!ensureDir(dfile)) { aborted = true; continue; }
      continue;
    }
    if (!ensureDir(path.dirname(dfile))) { aborted = true; continue; }
    if (!inspectReal(item.abs, dfile)) { aborted = true; continue; }
  }

  if (aborted) {
    if (rollbackEntry()) {
      recordFailure("restore: entry-blocked (" + dstDir + ") — backup refused; destination left untouched (D-01/D-04)");
    } else {
      recordFailure("restore: entry-blocked (" + dstDir + ") — backup refused; rollback incomplete, see diagnostics (D-01/D-04/CR-01)");
    }
    return false;
  }

  // D-15: transfer bytes for added/changed files (a checksum-equal destination
  // was left in place above), then apply only the source executable bit so a
  // checksum-equal destination keeps its other permission bits.
  for (const item of list) {
    if (item.isDir) continue;
    const rel = item.rel;
    if (isExcluded(rel, patterns, src)) continue;
    const dfile = path.join(dstDir, rel);
    if (!exists(dfile)) {
      try {
        writeMaterialized(item.abs, dfile);
      } catch {
        recordFailure("restore: copy-failed (" + dfile + ")");
        return false;
      }
    }
    try {
      const mode = fs.statSync(dfile).mode;
      if (isExec(item.abs)) fs.chmodSync(dfile, mode | 0o111);
      else fs.chmodSync(dfile, mode & ~0o111);
    } catch { /* best-effort, mirrors `|| true` */ }
  }
  return true;
}

// --- dry-run: read-only walk of a directory entry ---------------------------
function entryDirDry(src, dstDir, patterns) {
  let list;
  try { list = walkRoot(src); } catch { recordFailure("restore: enumerate-failed (" + src + ")"); return true; }
  for (const item of list) {
    const rel = item.rel;
    if (isExcluded(rel, patterns, src)) {
      if (machineLocal(rel)) {
        out("  skipped machine-local " + shellQuote(path.join(dstDir, rel)));
        ENT_SKIPPED += 1;
      }
      continue;
    }
    const dfile = path.join(dstDir, rel);
    if (item.isDir) {
      const st = lstat(dfile);
      if (st && (st.isSymbolicLink() || !st.isDirectory())) {
        ENT_CHANGED += 1; actionNeeded = true;
        out("  changed " + (relFromHome(dfile) ?? dfile));
      }
      continue;
    }
    inspectDry(item.abs, dfile);
  }
  return true;
}

// --- real-run: copy a single-file root --------------------------------------
function entryFileReal(src, dst) {
  if (!ensureDir(path.dirname(dst))) { rollbackEntry(); return false; }
  if (!inspectReal(src, dst)) { rollbackEntry(); return false; }
  // Only transfer when the destination is absent (added, or a changed/blocking
  // destination was backed up). A checksum-equal destination is left untouched
  // so its other permission bits survive (D-15/CR-03).
  if (!exists(dst)) {
    try {
      writeMaterialized(src, dst);
    } catch {
      recordFailure("restore: copy-failed (" + dst + ")");
      return false;
    }
  }
  try {
    const mode = fs.statSync(dst).mode;
    if (isExec(src)) fs.chmodSync(dst, mode | 0o111);
    else fs.chmodSync(dst, mode & ~0o111);
  } catch { /* best-effort */ }
  return true;
}

// --- npm staleness fingerprint (D-09/D-11) ----------------------------------
function npmDigest(pkg, lock) {
  const h = crypto.createHash("sha256");
  for (const p of [pkg, lock]) {
    try { h.update(fs.readFileSync(p)); } catch { return ""; }
  }
  return h.digest("hex");
}
function npmLockPath(destDir) {
  const a = path.join(destDir, "package-lock.json");
  if (fileExists(a)) return a;
  const b = path.join(destDir, "npm-shrinkwrap.json");
  if (fileExists(b)) return b;
  return null;
}
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function npmInstallNeeded(destDir) {
  const nm = path.join(destDir, "node_modules");
  const marker = path.join(nm, ".habitat-restore-fingerprint");
  const pkg = path.join(destDir, "package.json");
  const lock = npmLockPath(destDir);
  if (!isDirSync(nm) || !fileExists(marker)) return true;
  if (lock && fileExists(pkg)) {
    const cur = npmDigest(pkg, lock);
    let prev = "";
    try { prev = fs.readFileSync(marker, "utf8"); } catch { prev = ""; }
    return cur !== prev;
  }
  return true;
}

function whichBin(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat", ".ps1"] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, name + ext);
      try {
        const st = fs.statSync(cand);
        if (!st.isFile()) continue;
        if (process.platform !== "win32") fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

// --- fixed post-step dispatch: `npm ci` only, never eval (RST-04) -----------
function npmGate(destDir, dest) {
  const pkg = path.join(destDir, "package.json");
  const lock = npmLockPath(destDir);
  const nm = path.join(destDir, "node_modules");
  const marker = path.join(nm, ".habitat-restore-fingerprint");

  if (!npmInstallNeeded(destDir)) {
    out("npm ci: up-to-date (" + dest + ")");
    logLine("npm-ci up-to-date " + dest);
    return;
  }

  const npm = whichBin("npm");
  if (!npm) {
    recordFailure("restore: npm required (" + dest + ") — install Node.js/npm and retry (D-12)");
    return;
  }
  if (!fileExists(pkg) || !lock) {
    recordFailure("restore: npm-inputs-missing (" + dest + ") — package.json and package-lock.json are required (D-09)");
    return;
  }
  // win32: whichBin resolves a full shim path (often "C:\Program Files\...\npm")
  // with spaces; with an args array + shell, spawnSync concatenates unquoted and
  // cmd.exe splits at the first space ("C:\Program" not found). Quote the spaces.
  const win = process.platform === "win32";
  const runCi = (env) => {
    const r = win
      ? spawnSync(`"${npm}" ci`, { cwd: destDir, encoding: "utf8", env, shell: true })
      : spawnSync(npm, ["ci"], { cwd: destDir, encoding: "utf8", env, shell: false });
    const output = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (output.trim()) process.stdout.write(output);
    return { status: r.status, output };
  };

  let attempt = runCi(process.env);
  let certificateFailure = false;
  if (attempt.status !== 0 && isCertificateError(attempt.output)) {
    certificateFailure = true;
    // Corporate TLS interception: retry once against the system CA store.
    const retryEnv = withSystemCaAnyPlatform(process.env);
    if (retryEnv !== process.env) {
      out("npm ci: fallo de certificado; reintento con el almacén de CA del sistema");
      attempt = runCi(retryEnv);
    }
  }
  if (attempt.status === 0) {
    try { fs.mkdirSync(nm, { recursive: true }); } catch { /* ignore */ }
    try { fs.writeFileSync(marker, npmDigest(pkg, lock)); } catch { /* ignore */ }
    out("npm ci: installed (" + dest + ")");
    logLine("npm-ci installed " + dest);
  } else if (certificateFailure) {
    recordFailure(
      "restore: npm-failed (" + dest + ") — la red intercepta TLS y el almacén de CA del sistema no incluye la CA corporativa; " +
        "instalá la CA corporativa en el sistema o exportá NODE_EXTRA_CA_CERTS=/ruta/ca.crt y repetí (D-10)",
    );
  } else {
    recordFailure("restore: npm-failed (" + dest + ") — retry npm ci by hand (D-10)");
  }
}

function realPostSteps(dstDir, dest, postSteps) {
  if (!postSteps || postSteps.length === 0) return;
  for (const step of postSteps) {
    if (!step) continue;
    if (step === "npm ci") npmGate(dstDir, dest);
    else recordFailure("restore: post-step-unsupported (" + step + " for " + dest + ") (RST-04)");
  }
}

function dryPostSteps(dstDir, dest, postSteps) {
  if (!postSteps || postSteps.length === 0) return;
  for (const step of postSteps) {
    if (!step) continue;
    if (step === "npm ci") {
      if (npmInstallNeeded(dstDir)) { out("npm ci: would-run (" + dest + ")"); actionNeeded = true; }
      else out("npm ci: up-to-date (" + dest + ")");
    } else {
      out("restore: post-step-unsupported (" + step + " for " + dest + ")");
      actionNeeded = true;
    }
  }
}

// --- per-entry driver -------------------------------------------------------
function processEntry(idx) {
  const entry = entries[idx];
  const origin = entry.origin;
  const dest = entry.dest;
  const type = srcTypes[idx];
  const src = path.join(repoRoot, dest);
  const dst = path.join(HOME, origin);

  ENT_ADDED = 0; ENT_CHANGED = 0; ENT_SKIPPED = 0;
  entryActReset();
  out("[entry " + origin + " -> " + dest + "]");

  if (DRY_RUN) {
    if (type === "file") inspectDry(src, dst);
    else entryDirDry(src, dst, entry.excludes);
    out("added=" + ENT_ADDED + " changed=" + ENT_CHANGED + " skipped=" + ENT_SKIPPED);
    dryPostSteps(dst, dest, entry.postSteps);
  } else {
    let entryFailed = false;
    if (type === "file") {
      if (!entryFileReal(src, dst)) entryFailed = true;
    } else {
      if (!entryDirReal(src, dst, entry.excludes)) entryFailed = true;
    }
    if (!entryFailed) {
      if (ENT_ADDED === 0 && ENT_CHANGED === 0) out("up-to-date, skipped " + ENT_SKIPPED + " files");
      else out("added=" + ENT_ADDED + " changed=" + ENT_CHANGED + " skipped=" + ENT_SKIPPED);
      realPostSteps(dst, dest, entry.postSteps);
    } else {
      out("restore: entry-failed (" + dest + ") — post-steps skipped (WR-01)");
    }
  }

  totalAdded += ENT_ADDED;
  totalChanged += ENT_CHANGED;
  totalSkipped += ENT_SKIPPED;
}

// ================= dry-run: read-only preview (D-06) ========================
if (DRY_RUN) {
  out("restore: dry-run — read-only preview (D-06)");
  for (let idx = 0; idx < entries.length; idx++) processEntry(idx);
  out("restore: total added=" + totalAdded + " changed=" + totalChanged + " skipped=" + totalSkipped + " backups=" + totalBackup);
  if (!actionNeeded) { out("restore: converged"); process.exit(0); }
  out("restore: drift (action needed)");
  process.exit(1);
}

// ================= real restore: copy, then conditional npm =================
out("restore: restoring into " + homeReal);
for (let idx = 0; idx < entries.length; idx++) processEntry(idx);

out("restore: total added=" + totalAdded + " changed=" + totalChanged + " skipped=" + totalSkipped + " backups=" + totalBackup);
logLine("complete added=" + totalAdded + " changed=" + totalChanged + " skipped=" + totalSkipped + " backups=" + totalBackup + " errors=" + failCount);

if (failCount === 0) {
  out("restore: complete");
  if (VERIFY) {
    const verifyTool = path.join(repoRoot, "tools", "verify.mjs");
    if (!fileExists(verifyTool)) {
      err("restore: verify-missing (tools/verify.mjs)");
      process.exit(1);
    }
    out("restore: verifying");
    const r = spawnSync(process.execPath, [verifyTool, "--home", homeReal, "--repo", repoRoot, ...VERIFY_ARGS], { stdio: "inherit" });
    if (r.status !== 0) {
      err("restore: verify-failed");
      process.exit(1);
    }
  }
  process.exit(0);
}
err("restore: failed (" + failCount + " errors)");
process.exit(1);
