#!/usr/bin/env node
// tools/install.mjs — cross-platform habitat installer (VER-01/VER-02 entry point).
//
// Phases (each skippable, each idempotent):
// 1. detect      OS/arch detection (Windows native / WSL / Linux / macOS)
// 2. models      choose per-agent/profile preferences before installation
// 3. deps        optional (--with-deps): npm globals + graphifyy
// 4. gsd         optional (--with-gsd): run the GSD installer, then re-apply the
// anchored §5.5 patch and the $HOME path sanitization, both
// checksum-verified (a mismatch is reported, never silently patched)
// 5. bin         copy tools/*.mjs to <home>/bin (POSIX) or <home>/bin/*.mjs + *.cmd (win32)
// 6. restore     tools/restore.mjs (single Node engine; scripts/restore.sh is a shim)
// 7. verify      tools/verify.mjs
//
// JEV reuses OpenCode Zen credentials from OpenCode's auth store. Backups are
// timestamped siblings; nothing is deleted.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { planBin, cmdShim } from "../lib/bins.mjs";
import { mergeOverlay, readModelFile, readProfiles, repoPointerPath } from "../lib/model-pick.mjs";
import { canonicalHome, expandHome } from "../lib/home-placeholder.mjs";
import { isCertificateError, openCodeZenApiKey, withSystemCaAnyPlatform } from "../lib/opencode-auth.mjs";

const require = createRequire(import.meta.url);

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const IS_WIN = process.platform === "win32";

const DEPS = {
  gsd: "get-shit-done-cc@1.42.3",
  contextMode: "context-mode@1.0.169",
  graphify: "graphifyy==0.9.14",
};

const ABSOLUTE_BIN_RE =
  /(^|[\s"'`(:=])(\/[^\s"'`);|&]+\/get-shit-done\/bin\/(gsd-tools\.cjs|install\.js))/g;

// tools/*.mjs → ~/bin/<name>; a few commands are documented under a different
// name than their source file (route.mjs is the gsd-route CLI). The plan lives
// in lib/bins.mjs so it can be unit-tested without touching the filesystem.

function parseArgs(argv) {
  const options = {
    home: os.homedir(),
    repo: path.resolve(import.meta.dirname, ".."),
    withDeps: false,
    withGsd: false,
    skipRestore: false,
    skipVerify: false,
    skipPlugins: false,
    pickModels: true,
    forcePickModels: false,
    modelsFile: null,
    yes: false,
    dryRun: false,
    verifyArgs: [],
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--home") options.home = path.resolve(args[++i]);
    else if (arg === "--repo") options.repo = path.resolve(args[++i]);
    else if (arg === "--with-deps") options.withDeps = true;
    else if (arg === "--with-gsd") options.withGsd = true;
    else if (arg === "--skip-restore") options.skipRestore = true;
    else if (arg === "--skip-verify") options.skipVerify = true;
    else if (arg === "--skip-plugins") options.skipPlugins = true;
    else if (arg === "--pick-models") {
      options.pickModels = true;
      options.forcePickModels = true;
    } else if (arg === "--no-pick-models") {
      options.pickModels = false;
      options.forcePickModels = false;
    } else if (arg === "--models-file") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) {
        process.stderr.write("install: --models-file requiere una ruta\n");
        process.exit(EXIT_USAGE);
      }
      options.modelsFile = path.resolve(args[++i]);
    } else if (arg === "--yes") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-models" || arg === "--no-cli") options.verifyArgs.push(arg);
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: install.mjs [--home DIR] [--repo DIR] [--with-deps] [--with-gsd]",
          "                  [--skip-restore] [--skip-verify] [--skip-plugins] [--dry-run]",
          "                  [--pick-models|--no-pick-models] [--models-file FILE] [--yes]",
          "                  [--no-models] [--no-cli]",
          "",
          "Sin --with-deps/--with-gsd copia tools/, asegura context-mode,",
          "restaura el MANIFEST y verifica. JEV reutiliza credenciales OpenCode Zen.",
          "En TTY ofrece elegir",
          "modelos; las elecciones locales guardadas quedan disponibles para gsd-route.",
          "Nada se borra: archivos reemplazados se respaldan antes.",
        ].join("\n"),
      );
      process.exit(EXIT_OK);
    } else {
      process.stderr.write(`install: unknown argument: ${arg}\n`);
      process.exit(EXIT_USAGE);
    }
  }
  return options;
}

function log(step, message) {
  process.stdout.write(`[${step}] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`install: ${message}\n`);
}

function fail(message) {
  warn(message);
}

function errorDetail(result) {
  const parts = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  if (!parts) return "";
  return `\n${parts.split(/\r?\n/).filter(Boolean).slice(-10).join("\n")}`;
}

function childEnv(base) {
  const env = { ...(base ?? process.env) };
  if (IS_WIN) {
    const options = env.NODE_OPTIONS ?? "";
    if (!options.includes("--use-system-ca") && !options.includes("--use-openssl-ca")) {
      env.NODE_OPTIONS = `${options} --use-system-ca`.trim();
    }
  }
  return env;
}

function run(command, args, options = {}) {
  // Windows: .cmd/.bat shims (npm, opencode) only spawn through cmd.exe, and
  // an exe path with spaces ("C:\Program Files\nodejs\node.exe") must carry
  // inline quoting — with args-array + shell, spawnSync concatenates the line
  // unquoted and cmd.exe splits at the first space ("C:\Program" not found).
  // Empirical cmd.exe rules: quote only parts containing spaces — quoting a
  // bare shim name ("npm") makes the command fail with a silent exit 1.
  const env = childEnv(options.env);
  if (IS_WIN) {
    const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
    const line = [q(command), ...args.map(q)].join(" ");
    return spawnSync(line, {
      encoding: "utf8",
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      cwd: options.cwd,
      env,
      shell: true,
    });
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: options.cwd,
    env,
  });
  return result;
}

// A registry call that fails on the certificate chain is retried once against
// the system CA store: corporate networks that intercept TLS need the
// interception certificate, which Node's bundled list does not carry.
function runWithCertRetry(command, args, options = {}) {
  const first = run(command, args, options);
  if (first.status === 0) return first;
  const output = [first.stdout, first.stderr, first.error?.message].filter(Boolean).join("\n");
  if (!isCertificateError(output)) return first;
  const retryEnv = withSystemCaAnyPlatform(options.env ?? process.env);
  if (retryEnv === (options.env ?? process.env)) return first;
  log("run", "fallo de certificado; reintento con el almacén de CA del sistema");
  return run(command, args, { ...options, env: retryEnv });
}

// Long captured commands (npm installs) print nothing while they run; this
// keeps the terminal visibly alive so nobody thinks it froze and hits keys.
function spinner(label) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`[run] ${label}...\n`);
    return { stop: (ok = true) => process.stdout.write(`[run] ${label}: ${ok ? "ok" : "falló"}\n`) };
  }
  const frames = ["|", "/", "-", "\\"];
  const startedAt = Date.now();
  let frame = 0;
  const timer = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r${frames[frame++ % frames.length]} ${label} (${secs}s)   `);
  }, 100);
  return {
    stop(ok = true) {
      clearInterval(timer);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(`\r${ok ? "ok  " : "FALLO"} ${label} (${secs}s)\n`);
    },
  };
}

function successBanner(options) {
  process.stdout.write(
    [
      "",
      "============================================================",
      "  HABITAT INSTALADO",
      "============================================================",
      `  Config restaurada en:  ${options.home}`,
      "  JEV reutiliza OpenCode Zen; no requiere otra API key.",
      "  Si falta la conexión: opencode auth login",
      "                         (Windows con ExecutionPolicy: opencode.cmd auth login)",
      "  Reabrí la terminal para que tome el PATH (~/bin).",
      "  Cerrá y reabrí OpenCode para cargar MCP y plugins.",
      "  Verificá cuando quieras:  node tools/verify.mjs",
      "============================================================",
      "",
    ].join("\n") + "\n",
  );
}

function failureBanner() {
  process.stdout.write(
    [
      "",
      "============================================================",
      "  LA INSTALACIÓN NO TERMINÓ BIEN",
      "============================================================",
      "  Revisá los mensajes de arriba y corré:  node tools/verify.mjs",
      "  Si es una red corporativa, avisá el error exacto para ajustar el instalador.",
      "============================================================",
      "",
    ].join("\n") + "\n",
  );
}

function stamp() {  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function backupFile(filePath, home) {
  if (!fs.existsSync(filePath)) return null;
  const backupDir = path.join(home, ".habitat", "backups", stamp());
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(filePath));
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function rememberRepo(options) {
  const file = repoPointerPath(options.home);
  const contents = `${path.resolve(options.repo)}\n`;
  let temporary = null;
  try {
    if (fs.readFileSync(file, "utf8") === contents) return true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      fail(`no se pudo leer ${file}: ${error.message}`);
      return false;
    }
  }
  try {
    if (fs.existsSync(file)) {
      if (!fs.lstatSync(file).isFile()) throw new Error("destino no es archivo regular");
      backupFile(file, options.home);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
    temporary = null;
    return true;
  } catch (error) {
    if (temporary) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
    fail(`no se pudo guardar la ruta del repo Habitat: ${error.message}`);
    return false;
  }
}

// --- activate the versioned secret gate in the repo being installed from ----
// The pre-commit hook blocks a commit that carries a credential. It lives in
// this repository, so it is activated in this repository, and only there:
// repository-local config, never the global one, so no other repository of the
// user is affected. A hook path the user configured themselves is never
// overwritten.
function activateRepoHooks(options) {
  const repo = path.resolve(options.repo);
  const hook = path.join(repo, ".githooks", "pre-commit");
  if (!fs.existsSync(hook)) {
    log("hooks", "el repo no tiene .githooks/pre-commit; se omite");
    return true;
  }
  const top = run("git", ["-C", repo, "rev-parse", "--show-toplevel"], { capture: true });
  if (top.status !== 0 || !(top.stdout || "").trim()) {
    warn("el repo no es un work tree de Git; el gate de secretos no se activa (es opcional)");
    return true;
  }
  const current = run("git", ["-C", repo, "config", "--local", "--get", "core.hooksPath"], {
    capture: true,
  });
  const configured = (current.stdout || "").trim();
  if (configured && configured !== ".githooks") {
    log("hooks", `core.hooksPath ya apunta a '${configured}': no se toca (es tu decisión)`);
    return true;
  }
  if (!IS_WIN) {
    try {
      fs.chmodSync(hook, 0o755);
    } catch (error) {
      warn(`no se pudo marcar el hook como ejecutable: ${error.message}`);
    }
  }
  const set = run("git", ["-C", repo, "config", "--local", "core.hooksPath", ".githooks"], {
    capture: true,
  });
  if (set.status !== 0) {
    warn("no se pudo activar el gate de secretos (core.hooksPath): es opcional");
    return true;
  }
  log("hooks", "gate de secretos activo en este repo (core.hooksPath=.githooks, solo local)");
  return true;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// --- MCP opt-in helpers -----------------------------------------------------
// The payload ships the `jev` MCP entry so a user with an OpenCode Zen
// credential gets it working out of the box. Without that credential the entry
// is dead weight: OpenCode starts with a broken MCP. These helpers remove it
// from the restored copy only (the repo payload keeps it).

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s+)\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

// Index just past the end of the JSON value that starts at `start`.
function findJsonValueEnd(text, start) {
  const first = text[start];
  if (first === '"') {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === '"') return index + 1;
      index += 1;
    }
    return -1;
  }
  if (first === "{" || first === "[") {
    const stack = [];
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"') {
        const end = findJsonValueEnd(text, index);
        if (end < 0) return -1;
        index = end - 1;
        continue;
      }
      if (char === "{" || char === "[") { stack.push(char === "{" ? "}" : "]"); continue; }
      if (char === "}" || char === "]") {
        if (stack.pop() !== char) return -1;
        if (stack.length === 0) return index + 1;
      }
    }
    return -1;
  }
  const literal = /^[^\s,}\]]+/.exec(text.slice(start));
  return literal ? start + literal[0].length : -1;
}

// Removes `mcp.<name>` from a JSONC text. Returns the original text when the
// entry is absent; throws when no candidate removal produces a valid config
// with the entry gone.
function removeMcpEntry(text, name) {
  let original;
  try {
    original = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(`config MCP ilegible: ${error.message}`);
  }
  if (!original?.mcp?.[name]) return { text, removed: false };

  const keyPattern = new RegExp(`"${name}"\\s*:`, "g");
  let match;
  while ((match = keyPattern.exec(text)) !== null) {
    const afterColon = match.index + match[0].length;
    const whitespace = /^\s*/.exec(text.slice(afterColon))[0].length;
    const valueStart = afterColon + whitespace;
    const valueEnd = findJsonValueEnd(text, valueStart);
    if (valueEnd < 0) continue;

    let removeStart = match.index;
    while (removeStart > 0 && /[ \t]/.test(text[removeStart - 1])) removeStart -= 1;
    let previous = removeStart - 1;
    while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
    if (text[previous] === ",") {
      removeStart = previous;
      while (removeStart > 0 && /\s/.test(text[removeStart - 1])) removeStart -= 1;
    }

    let removeEnd = valueEnd;
    let ahead = removeEnd;
    while (ahead < text.length && /[ \t]/.test(text[ahead])) ahead += 1;
    if (text[ahead] === ",") removeEnd = ahead + 1;
    while (removeEnd < text.length && /[ \t]/.test(text[removeEnd])) removeEnd += 1;
    if (text[removeEnd] === "\r" && text[removeEnd + 1] === "\n") removeEnd += 2;
    else if (text[removeEnd] === "\n") removeEnd += 1;

    const candidate = text.slice(0, removeStart) + text.slice(removeEnd);
    let parsed;
    try {
      parsed = JSON.parse(stripJsonComments(candidate));
    } catch {
      continue;
    }
    if (parsed?.mcp?.[name] !== undefined) continue;
    return { text: candidate, removed: true };
  }
  throw new Error(`no se pudo quitar la entrada mcp.${name}`);
}

// Without an OpenCode Zen credential the `jev` MCP cannot work: drop it from
// the restored config so OpenCode does not start with a broken MCP server.
function disableJevWithoutCredential(options) {
  let apiKey = null;
  try {
    apiKey = openCodeZenApiKey({ home: options.home });
  } catch (error) {
    warn(`no se pudo leer la credencial OpenCode Zen (${error.message}); JEV queda como está`);
    return true;
  }
  if (apiKey) return true;

  const configDir = path.join(options.home, ".config", "opencode");
  for (const fileName of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(configDir, fileName);
    if (!fs.existsSync(file)) continue;
    let result;
    try {
      result = removeMcpEntry(fs.readFileSync(file, "utf8"), "jev");
    } catch (error) {
      fail(`no se pudo desactivar JEV en ${file}: ${error.message}`);
      return false;
    }
    if (!result.removed) continue;
    try {
      JSON.parse(stripJsonComments(result.text));
    } catch (error) {
      fail(`no se pudo desactivar JEV en ${file}: config resultante ilegible (${error.message})`);
      return false;
    }
    backupFile(file, options.home);
    fs.writeFileSync(file, result.text);
    log("jev", `JEV desactivado (sin credencial OpenCode Zen) en ${fileName}`);
  }
  log("jev", "para activarlo: `opencode auth login` → conectá OpenCode Zen → volvé a correr `node tools/install.mjs`");
  return true;
}

// Removes one entry from the `plugin` array of a JSONC text. Returns the
// original text when the entry is absent; throws when no candidate removal
// produces a valid config without the entry.
function removePluginEntry(text, name) {
  let original;
  try {
    original = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(`config de plugins ilegible: ${error.message}`);
  }
  if (!Array.isArray(original?.plugin) || !original.plugin.includes(name)) {
    return { text, removed: false };
  }

  const keyPattern = /"plugin"\s*:/g;
  let match;
  while ((match = keyPattern.exec(text)) !== null) {
    const afterColon = match.index + match[0].length;
    const whitespace = /^\s*/.exec(text.slice(afterColon))[0].length;
    const arrayStart = afterColon + whitespace;
    if (text[arrayStart] !== "[") continue;
    const arrayEnd = findJsonValueEnd(text, arrayStart);
    if (arrayEnd < 0) continue;

    const body = text.slice(arrayStart + 1, arrayEnd - 1);
    const elementPattern = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
    let element;
    while ((element = elementPattern.exec(body)) !== null) {
      let removeStart = element.index;
      let removeEnd = element.index + element[0].length;

      // Take the comma that follows the element, or the one that precedes it.
      let ahead = removeEnd;
      while (ahead < body.length && /[ \t]/.test(body[ahead])) ahead += 1;
      if (body[ahead] === ",") {
        removeEnd = ahead + 1;
      } else {
        let previous = removeStart - 1;
        while (previous >= 0 && /\s/.test(body[previous])) previous -= 1;
        if (body[previous] === ",") removeStart = previous;
      }
      while (removeEnd < body.length && /[ \t]/.test(body[removeEnd])) removeEnd += 1;
      if (body[removeEnd] === "\r" && body[removeEnd + 1] === "\n") removeEnd += 2;
      else if (body[removeEnd] === "\n") removeEnd += 1;

      const candidate = text.slice(0, arrayStart + 1) + body.slice(0, removeStart) + body.slice(removeEnd) + text.slice(arrayEnd - 1);
      let parsed;
      try {
        parsed = JSON.parse(stripJsonComments(candidate));
      } catch {
        continue;
      }
      if (!Array.isArray(parsed?.plugin) || parsed.plugin.includes(name)) continue;
      return { text: candidate, removed: true };
    }
  }
  throw new Error(`no se pudo quitar el plugin ${name}`);
}

// The OpenCode major version of the installed CLI, or null when it is not
// installed. 1.x and 2.x do not share the plugin contract, so the payload
// has to adapt to the line the user actually runs.
function opencodeCliMajor(home) {
  const result = run("opencode", ["--version"], { capture: true });
  if (result.status !== 0) return null;
  const version = String(result.stdout ?? "").trim().match(/(\d+)\./);
  return version ? Number(version[1]) : null;
}

// context-mode ships a 1.x plugin: on opencode 2.x it does not load at all,
// and the host logs a plugin error. The payload carries a bridge plugin that
// registers context-mode's MCP server on 2.x, so the `ctx_*` tools stay
// available. On 2.x the native entry is removed from the config so the host
// does not log a plugin that cannot load.
function adaptContextModeToCli(options) {
  const major = opencodeCliMajor(options.home);
  if (major === null) {
    log("context-mode", "no se encontró el CLI de OpenCode; se deja la config del payload");
    return true;
  }
  if (major < 2) {
    log("context-mode", `OpenCode ${major}.x: context-mode va por su plugin nativo`);
    return true;
  }

  const configDir = path.join(options.home, ".config", "opencode");
  for (const fileName of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(configDir, fileName);
    if (!fs.existsSync(file)) continue;
    let result;
    try {
      result = removePluginEntry(fs.readFileSync(file, "utf8"), "context-mode");
    } catch (error) {
      fail(`no se pudo adaptar context-mode en ${file}: ${error.message}`);
      return false;
    }
    if (!result.removed) continue;
    try {
      JSON.parse(stripJsonComments(result.text));
    } catch (error) {
      fail(`no se pudo adaptar context-mode en ${file}: config resultante ilegible (${error.message})`);
      return false;
    }
    backupFile(file, options.home);
    fs.writeFileSync(file, result.text);
    log("context-mode", `OpenCode ${major}.x: el plugin nativo de context-mode no carga, queda el puente por MCP`);
  }
  return true;
}

function detectPlatform() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32") {
    return { family: "windows-native", arch, notes: "sin WSL: usar rutas %USERPROFILE%" };
  }
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  if (platform === "linux" && isWsl) {
    return { family: "wsl", arch, notes: "dists WSL detectada" };
  }
  if (platform === "darwin") return { family: "macos", arch, notes: "Homebrew/node requeridos" };
  if (platform === "linux") return { family: "linux", arch, notes: "paths POSIX" };
  return { family: "unknown", arch, notes: "plataforma no reconocida" };
}

function executableOnPath(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const exts = IS_WIN ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (!IS_WIN) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function installDeps(options) {
  log("deps", "instalando dependencias globales declaradas");
  const commands = [["npm", ["install", "-g", DEPS.gsd]]];
  for (const [command, args] of commands) {
    const spin = spinner(`${command} ${args.join(" ")}`);
    const result = runWithCertRetry(command, args, { capture: true });
    spin.stop(result.status === 0);
    if (result.status !== 0) {
      fail(`${command} ${args.join(" ")} falló${errorDetail(result)}`);
      return false;
    }
  }
  // graphifyy is a Python tool (uv/pipx/pip). On Windows without any Python it
  // is skipped with a hint: graphify is optional and gsd-graphify-sync degrades
  // gracefully (W2/D3). npm deps above still install.
  const hasPython = executableOnPath("python") || executableOnPath("python3") || executableOnPath("py");
  if (IS_WIN && !hasPython) {
    log("deps", "graphifyy omitido: Windows sin Python — graphify es opcional (D3)");
    return true;
  }
  const spin = spinner(`graphifyy ${DEPS.graphify}`);
  const graphify = run("uv", ["tool", "install", DEPS.graphify], { capture: true });
  if (graphify.status !== 0) {
    const pipx = run("pipx", ["install", DEPS.graphify], { capture: true });
    if (pipx.status !== 0) {
      const pip = run(process.execPath, ["-m", "pip", "install", "--user", DEPS.graphify], {
        capture: true,
      });
      if (pip.status !== 0) {
        spin.stop(false);
        fail(`graphifyy no se pudo instalar (uv/pipx/pip fallaron)${errorDetail(pip)}`);
        return false;
      }
    }
  }
  spin.stop(true);
  return true;
}

function npmGlobalRoot() {
  const result = run("npm", ["root", "-g"], { capture: true });
  if (result.status !== 0) return null;
  const root = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  return root ? root.trim() : null;
}

// opencode loads a bare plugin name as an npm package from the config dir's
// node_modules or from the global npm root.
function pluginResolved(name, home) {
  const configDir = path.join(home, ".config", "opencode");
  try {
    require.resolve(name, { paths: [configDir] });
    return true;
  } catch {
    const globalRoot = npmGlobalRoot();
    return globalRoot ? fs.existsSync(path.join(globalRoot, name, "package.json")) : false;
  }
}

// context-mode is declared as an npm plugin in opencode.jsonc; without it the
// plugin silently fails to load. It is ensured on every run (not only
// --with-deps) but the failure is non-fatal: restore still completes and
// tools/verify.mjs reports the missing plugin by name.
function ensurePlugins(options) {
  if (pluginResolved("context-mode", options.home)) {
    log("plugins", "context-mode ya resoluble (local o global)");
    return true;
  }
  log("plugins", `instalando ${DEPS.contextMode}`);
  const spin = spinner(`npm install -g ${DEPS.contextMode}`);
  const result = runWithCertRetry("npm", ["install", "-g", DEPS.contextMode], { capture: true });
  spin.stop(result.status === 0);
  if (result.status !== 0) {
    fail(`${DEPS.contextMode} no se pudo instalar (npm falló)${errorDetail(result)}; verify lo reportará`);
    return false;
  }
  log("plugins", "context-mode instalado globalmente");
  return true;
}

function extractAnchors(text) {
  const pattern =
    /<!-- anchor:begin ([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- anchor:end \1 -->\n<!-- anchor:checksum \1 (sha256=[0-9a-f]+) -->/g;
  const anchors = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    anchors.push({ name: match[1], body: match[2], checksum: match[3] });
  }
  return anchors;
}

function replaceAnchors(text, anchors) {
  let result = text;
  for (const anchor of anchors) {
    const pattern = new RegExp(
      `(<!-- anchor:begin ${anchor.name} -->\\n)[\\s\\S]*?(\\n<!-- anchor:end ${anchor.name} -->)`,
    );
    if (!pattern.test(result)) continue;
    const safeName = anchor.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(pattern, `$1${anchor.body}$2`);
    result = result.replace(
      new RegExp(`(<!-- anchor:checksum ${safeName} )sha256=[0-9a-f]+( -->)`),
      `$1${anchor.checksum}$2`,
    );
  }
  return result;
}

function sanitizePaths(text) {
  return text.replace(ABSOLUTE_BIN_RE, (match, boundary, _absolute, base) => {
    const quoted = `"$HOME/.config/opencode/get-shit-done/bin/${base}"`;
    return boundary + quoted.slice(1, -1);
  });
}

function patchedGsdStep(options) {
  const target = path.join(options.home, ".config", "opencode", "get-shit-done");
  if (!fs.existsSync(target)) {
    log("gsd", "get-shit-done no está instalado en el home destino; se omite el parche");
    return true;
  }
  const problems = [];
  const files = [
    "workflows/new-project.md",
    "references/model-profile-resolution.md",
    "command/gsd-graphify.md",
    "command/gsd-import.md",
    "workflows/execute-phase.md",
  ];
  for (const relative of files) {
    const repoPath = path.join(options.repo, "home", ".config", "opencode", "get-shit-done", relative);
    const destPath = path.join(target, relative);
    if (!fs.existsSync(repoPath) || !fs.existsSync(destPath)) continue;
    const repoAnchors = extractAnchors(fs.readFileSync(repoPath, "utf8"));
    const destAnchors = extractAnchors(fs.readFileSync(destPath, "utf8"));
    if (repoAnchors.length === 0) continue;
    if (destAnchors.length === 0) {
      // The real GSD installer rewrites these files without Habitat's managed
      // blocks. That is not tampering: the manifest restore reconciles the whole
      // file from the payload (which carries the anchors), so warn and move on
      // instead of failing the entire install. Only a real checksum mismatch on
      // an existing anchor block stays fail-closed.
      warn(`parche diferido — ${relative}: sin anclas (el instalador GSD reescribió el archivo; restore lo reconcilia desde el payload)`);
      continue;
    }
    // Checksums cover the canonical (placeholder) form so repo and destination
    // blocks verify equal regardless of the machine's home directory.
    const checksumOf = (body) => `sha256=${sha256(canonicalHome(body, options.home))}`;
    for (const repoAnchor of repoAnchors) {
      const destAnchor = destAnchors.find((entry) => entry.name === repoAnchor.name);
      if (!destAnchor) {
        problems.push(`${relative}: ancla ${repoAnchor.name} ausente`);
        continue;
      }
      if (destAnchor.checksum !== checksumOf(destAnchor.body)) {
        problems.push(`${relative}: checksum del bloque ${repoAnchor.name} no coincide`);
        continue;
      }
      if (repoAnchor.checksum !== checksumOf(repoAnchor.body)) {
        problems.push(`${relative}: checksum del repo inválido`);
        continue;
      }
      if (options.dryRun) {
        log("gsd", `dry-run: ${relative} ancla ${repoAnchor.name} se actualizaría`);
        continue;
      }
      const current = fs.readFileSync(destPath, "utf8");
      const next = replaceAnchors(current, [{ ...repoAnchor, body: expandHome(repoAnchor.body, options.home) }]);
      if (next !== current) {
        backupFile(destPath, options.home);
        fs.writeFileSync(destPath, next, "utf8");
        log("gsd", `${relative}: ancla ${repoAnchor.name} parcheada`);
      }
    }
  }

  const binRoot = path.join(target, "bin");
  if (fs.existsSync(binRoot)) {
    for (const entry of fs.readdirSync(binRoot)) {
      if (!entry.endsWith(".cjs") && !entry.endsWith(".js")) continue;
      const filePath = path.join(binRoot, entry);
      const before = fs.readFileSync(filePath, "utf8");
      const after = sanitizePaths(before);
      if (after !== before) {
        if (options.dryRun) {
          log("gsd", `dry-run: ${entry} se sanearía`);
          continue;
        }
        backupFile(filePath, options.home);
        fs.writeFileSync(filePath, after, "utf8");
        log("gsd", `${entry}: rutas absolutas saneadas a $HOME`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) fail(`parche no aplicado — ${problem}`);
    return false;
  }
  return true;
}

function copyBin(options) {
  const source = path.join(options.repo, "tools");
  const binDir = path.join(options.home, "bin");
  if (!options.dryRun && !fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
  const plan = planBin(fs.readdirSync(source), process.platform);
  const copied = [];
  for (const item of plan) {
    for (const target of item.targets) {
      const targetPath = path.join(binDir, target.name);
      if (!options.dryRun) {
        // Replace whatever is there, including a symlink: writing through a
        // symlinked target would silently mutate its destination and leave the
        // command pointing at the wrong file. Unlink a symlink after
        // backing it up, then write a fresh regular file.
        let present = false;
        try { fs.lstatSync(targetPath); present = true; } catch { present = false; }
        if (present) {
          backupFile(targetPath, options.home);
          if (fs.lstatSync(targetPath).isSymbolicLink()) fs.unlinkSync(targetPath);
        }
        if (target.kind === "shim") {
          fs.writeFileSync(targetPath, cmdShim(item.base), "utf8");
        } else {
          fs.copyFileSync(path.join(source, item.source), targetPath);
          if (!IS_WIN) fs.chmodSync(targetPath, 0o755);
        }
      }
      copied.push(target.name);
    }
  }
  if (options.dryRun) log("bin", `dry-run: se copiarían ${copied.length} herramientas a ${binDir}`);
  else log("bin", `${copied.length} herramientas copiadas a ${binDir}`);
  return true;
}

// The payload does not ship a shell file: a snapshot of somebody's .bashrc is
// personal and machine-bound. The only thing Habitat needs from it is the
// ~/bin entry in PATH, so the installer writes that single guarded block
// (POSIX) or updates the user PATH (Windows) instead.
const PATH_BLOCK = [
  "",
  "# Added by Habitat: tools installed in ~/bin (gsd-route, gsd-model-pick, ...)",
  'if [ -d "$HOME/bin" ]; then',
  '    export PATH="$HOME/bin:$PATH"',
  "fi",
  "",
].join("\n");

function ensureBinOnPath(options) {
  const binDir = path.join(options.home, "bin");
  if (options.dryRun) {
    log("path", `dry-run: se agregaría ${binDir} al PATH`);
    return true;
  }
  if (IS_WIN) {
    const script = [
      "$p=[Environment]::GetEnvironmentVariable('Path','User')",
      "if (($p -split ';') -notcontains '" + binDir.replace(/'/g, "''") + "') {",
      "  [Environment]::SetEnvironmentVariable('Path', ($p + ';" + binDir.replace(/'/g, "''") + "'), 'User')",
      "}",
    ].join("; ");
    const result = run("powershell", ["-NoProfile", "-Command", script], { capture: true });
    if (result.status !== 0) {
      warn(`no se pudo agregar ${binDir} al PATH de usuario: agregalo a mano`);
      return true;
    }
    log("path", `${binDir} agregado al PATH de usuario; reabri la terminal para que tome efecto`);
    return true;
  }

  const rc = path.join(options.home, ".bashrc");
  let current = "";
  try {
    current = fs.readFileSync(rc, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      warn(`no se pudo leer ${rc}: ${error.message}`);
      return true;
    }
  }
  if (current.includes("Added by Habitat: tools installed in ~/bin")) {
    log("path", `${binDir} ya está en el PATH`);
    return true;
  }
  try {
    fs.appendFileSync(rc, PATH_BLOCK, "utf8");
    log("path", `${binDir} agregado al PATH en ${rc}; reabri la terminal para que tome efecto`);
  } catch (error) {
    warn(`no se pudo agregar ${binDir} al PATH (${error.message}): agregalo a mano`);
  }
  return true;
}

function copySupportModules(options) {
  const sourceDir = path.join(options.repo, "lib");
  // Every module of lib/ travels with the installed bins: the tools in ~/bin
  // import them as ../lib/<name>. Copying only a hand-picked list used to
  // leave ~/bin/restore broken (missing lib/manifest.mjs).
  const names = fs
    .readdirSync(sourceDir)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  const targetDir = path.join(options.home, "lib");
  if (options.dryRun) {
    for (const name of names) log("bin", `dry-run: se copiaría módulo de soporte a ${path.join(targetDir, name)}`);
    return true;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of names) {
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);
    let temporary = null;
    try {
      if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink() &&
          fs.readFileSync(target).equals(fs.readFileSync(source))) continue;
      if (fs.existsSync(target)) {
        backupFile(target, options.home);
        if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
      }
      temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, target);
      temporary = null;
      log("bin", `módulo de soporte copiado a ${target}`);
    } catch (error) {
      if (temporary) {
        try { fs.rmSync(temporary, { force: true }); } catch {}
      }
      fail(`no se pudo instalar módulo de soporte ${name}: ${error.message}`);
      return false;
    }
  }
  return true;
}

function restoreManifest(options) {
  const engine = path.join(options.repo, "tools", "restore.mjs");
  const result = run(process.execPath, [engine], { cwd: options.repo, env: { ...process.env, HOME: options.home } });
  if (result.status !== 0) {
    fail("tools/restore.mjs falló");
    return false;
  }
  return true;
}

function verify(options) {
  const script = path.join(options.repo, "tools", "verify.mjs");
  const result = run(
    process.execPath,
    [script, "--home", options.home, "--repo", options.repo, ...options.verifyArgs],
    { cwd: options.repo },
  );
  return result.status === EXIT_OK;
}

function pickModels(options) {
  const script = path.join(options.repo, "tools", "gsd-model-pick.mjs");
  const overlay = path.join(options.home, ".config", "opencode", "gsd-router", "picks.local");
  const args = [script, "--home", options.home, "--repo", options.repo];

  if (options.modelsFile) {
    args.push("--models-file", options.modelsFile);
    log("models", `aplicando matriz desde ${options.modelsFile}`);
  } else if (fs.existsSync(overlay) && !options.forcePickModels) {
    args.push("--apply-overlay");
    log("models", "validando elecciones locales guardadas para gsd-route");
  } else if (!options.pickModels || options.yes) {
    if (fs.existsSync(overlay)) {
      args.push("--apply-overlay");
      log("models", "validando elecciones locales guardadas (sin prompt)");
    } else {
      log("models", "omitido; se mantienen perfiles del repo");
      return true;
    }
  } else if (!process.stdin.isTTY) {
    if (options.forcePickModels) {
      fail("--pick-models requiere TTY; usa --models-file para instalación no interactiva");
      return false;
    }
    log("models", "sin TTY ni overlay; se mantienen perfiles del repo");
    return true;
  } else {
    log("models", "elegí modelos para agentes y perfiles (Enter mantiene valores actuales)");
  }

  const result = run(process.execPath, args, { cwd: options.repo });
  if (result.status !== EXIT_OK) {
    fail(`selector de modelos falló (exit ${result.status ?? "unknown"})`);
    return false;
  }
  return true;
}

function main() {
  const options = parseArgs(process.argv);
  if (options.forcePickModels && !options.modelsFile && !process.stdin.isTTY && !options.dryRun) {
    fail("--pick-models requiere TTY; usa --models-file para instalación no interactiva");
    process.exit(EXIT_USAGE);
  }
  if (options.modelsFile) {
    try {
      const defaults = readProfiles(path.join(options.repo, "home", ".config", "opencode", "gsd-router"));
      mergeOverlay(defaults, readModelFile(options.modelsFile));
    } catch (error) {
      fail(`matriz de modelos inválida: ${error.message}`);
      process.exit(EXIT_USAGE);
    }
  }
  const platform = detectPlatform();
  log("detect", `${platform.family} (${platform.arch}) — ${platform.notes}`);
  log("detect", `repo=${options.repo} home=${options.home}`);

  if (options.dryRun) log("detect", "modo dry-run: no se escribe nada");

  if (options.dryRun) {
    log("models", "dry-run: se guardaría overlay local o se conservaría la matriz actual");
  } else if (!pickModels(options)) {
    process.exit(EXIT_FAILED);
  }

  if (!options.dryRun) {
    log("run", "instalando Habitat — no aprietes teclas, esto puede tardar unos minutos");
  }

  if (options.withDeps) {
    if (options.dryRun) log("deps", "dry-run: se instalarían " + JSON.stringify(DEPS));
    else if (!installDeps(options)) process.exit(EXIT_FAILED);
  } else {
    log("deps", "omitido (usar --with-deps para get-shit-done-cc y graphifyy)");
  }

  if (options.withGsd) {
    if (options.dryRun) {
      log("gsd", "dry-run: se correría el instalador GSD y se re-aplicarían los parches");
    } else {
      log("gsd", "ejecutando instalador GSD (puede tardar)");
      const install = runWithCertRetry("npx", ["-y", "get-shit-done-cc@1.42.3", "--opencode", "--global"], {
        cwd: options.repo,
      });
      if (install.status !== 0) {
        fail("el instalador de get-shit-done-cc falló; no se parchea");
        process.exit(EXIT_FAILED);
      }
      if (!patchedGsdStep(options)) process.exit(EXIT_FAILED);
    }
  } else if (fs.existsSync(path.join(options.home, ".config", "opencode", "get-shit-done"))) {
    if (!patchedGsdStep(options)) process.exit(EXIT_FAILED);
  }

  if (!copyBin(options)) process.exit(EXIT_FAILED);
  if (!copySupportModules(options)) process.exit(EXIT_FAILED);
  if (!ensureBinOnPath(options)) process.exit(EXIT_FAILED);

  if (options.skipPlugins) log("plugins", "omitido (--skip-plugins)");
  else if (options.dryRun) log("plugins", "dry-run: se verificaría/instalaría context-mode");
  else ensurePlugins(options);

  if (options.skipRestore) {
    log("restore", "omitido (--skip-restore)");
    warn("--skip-restore deja el home sin restaurar; tools/verify.mjs va a fallar por destinos faltantes");
  } else if (!options.dryRun && !restoreManifest(options)) {
    process.exit(EXIT_FAILED);
  }

  if (!options.dryRun && !rememberRepo(options)) process.exit(EXIT_FAILED);

  if (!options.dryRun) activateRepoHooks(options);

  if (!options.dryRun && !adaptContextModeToCli(options)) process.exit(EXIT_FAILED);

  if (!options.dryRun && !disableJevWithoutCredential(options)) process.exit(EXIT_FAILED);

  if (options.skipVerify) {
    log("verify", "omitido");
    if (!options.dryRun) successBanner(options);
    process.exit(EXIT_OK);
  }
  if (options.dryRun) {
    log("verify", "dry-run: se ejecutaría tools/verify.mjs");
    process.exit(EXIT_OK);
  }
  const ok = verify(options);
  if (ok) {
    successBanner(options);
    process.exit(EXIT_OK);
  }
  failureBanner();
  process.exit(EXIT_FAILED);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { removeMcpEntry, disableJevWithoutCredential, stripJsonComments };
