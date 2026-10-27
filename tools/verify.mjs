#!/usr/bin/env node
// tools/verify.mjs — post-restore functional verification (VER-01/VER-02).
//
// Checks, in order, each with a machine-readable name and an actionable hint:
// 1. manifest-dests   every MANIFEST.json dest exists
// 2. mcp-json         opencode.json / opencode.jsonc parse and carry valid mcp entries
// 3. cli-tools        gsd-sdk --help and graphify --help respond (--no-cli skips)
// 4. plugins          plugin files referenced by opencode.json exist
// 5. discovery        skills/agents are discoverable
// 6. model-ids        every model id in the effective home profiles is listed
// by `opencode models` (--no-models skips)
//
// Exit 0 = all green, 1 = at least one failed check, 2 = usage error.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PROFILE_NAMES, loadOverlay, mergeOverlay } from "../lib/model-pick.mjs";
import { openCodeZenApiKey } from "../lib/opencode-auth.mjs";
import { findExecutable } from "../lib/exec-path.mjs";
import { createTimer } from "../lib/timing.mjs";

const require = createRequire(import.meta.url);
const timing = createTimer("verify");
process.on("exit", () => timing.finish());

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

// An authenticated `opencode models` lists well over this many entries; a smaller
// catalog (or one without the auth-gated `opencode-go/*` namespace) means the
// registry was truncated by missing credentials, not that the ids are invalid.
const MIN_FULL_CATALOG = 20;

// Models behind this namespace need credentials and are not always listed, even
// when the rest of the namespace is: a CLI that falls back to its bundled
// registry snapshot shows the older ids and omits the newer ones.
const AUTH_NAMESPACE = "opencode-go";

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    home: os.homedir(),
    repo: path.resolve(import.meta.dirname, ".."),
    noModels: false,
    noCli: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--home") options.home = path.resolve(args[++i]);
    else if (arg === "--repo") options.repo = path.resolve(args[++i]);
    else if (arg === "--no-models") options.noModels = true;
    else if (arg === "--no-cli") options.noCli = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Usage: verify.mjs [--home DIR] [--repo DIR] [--no-models] [--no-cli] [--json]\n",
      );
      process.exit(EXIT_OK);
    } else {
      process.stderr.write(`verify: unknown argument: ${arg}\n`);
      process.exit(EXIT_USAGE);
    }
  }
  return options;
}

const results = [];
function check(name, ok, detail, hint) {
  results.push({ name, ok, detail, hint: ok ? "" : hint ?? "" });
}

// A skipped check cannot be evaluated in this environment (missing CLI, no
// credentials, truncated registry). It never fails the run, but it is recorded
// so the operator sees why nothing was validated.
function skip(name, detail, hint) {
  results.push({ name, ok: true, skipped: true, detail, hint: hint ?? "" });
}

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s+)\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

function readJsonish(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(stripJsonComments(raw));
}

function checkManifest(repo, home) {
  const manifestPath = path.join(repo, "MANIFEST.json");
  if (!fs.existsSync(manifestPath)) {
    check("manifest-dests", false, `${manifestPath} missing`, "corre verify.mjs desde la raíz del repo habitat");
    return;
  }
  const manifest = readJsonish(manifestPath);
  const missing = [];
  for (const entry of manifest.entries ?? []) {
    const homeRelative = entry.dest.replace(/^home\//, "");
    const dest = path.resolve(home, homeRelative);
    if (!fs.existsSync(dest)) missing.push(entry.dest);
  }
  check(
    "manifest-dests",
    missing.length === 0,
    missing.length === 0
      ? `${manifest.entries.length} destinos presentes`
      : `faltan: ${missing.join(", ")}`,
    "ejecutá scripts/restore.sh antes de verify",
  );
}

// Restored payload must carry no unexpanded placeholder and no foreign
// absolute home path: either would resolve to a missing file on this machine.
// The current machine's own home (already expanded) is legitimate.
function checkPortablePaths(home) {
  const root = path.join(home, ".config", "opencode");
  if (!fs.existsSync(root)) return;
  const forbidden = ["__HABITAT_HOME__"];
  const ownHome = path.resolve(home).replace(/\\/g, "/").toLowerCase();
  // Home roots of another machine, in every spelling the payload can carry:
  // POSIX (/home/<login>), native Windows (<drive>:/Users/<login>) and the WSL
  // mount (/mnt/<drive>/Users/<login>). The payload is cross-platform, so all
  // three are checked on every platform.
  const foreignHomes = [
    /\/home\/[A-Za-z_][^/\s"'`)]*/g,
    // The login must start with a letter, a digit or an underscore, so a
    // documented placeholder (C:/Users/..., C:/Users/<usuario>) is not read as
    // somebody else's home.
    /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_][^\\/\s"'`.)]*/g,
    /\/mnt\/[A-Za-z][\\/]Users[\\/][A-Za-z0-9_][^\\/\s"'`.)]*/gi,
  ];
  const hits = [];
  // Vendor-managed copies and stale backups are not payload: they are written
  // by other tools (the GSD installer keeps a pristine copy) and never
  // restored by Habitat, so they must not fail this check.
  const ignored = /^(gsd-pristine|[^/]*\.bak-[^/]*|[^/]*\.backup-[^/]*)$/;
  const stack = [root];
  while (stack.length && hits.length < 20) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      if (ignored.test(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(abs); continue; }
      if (!entry.isFile() || !/\.(md|mdx|js|cjs|mjs|json|jsonc|sh|txt|tsv|yml|yaml)$/i.test(entry.name)) continue;
      const text = fs.readFileSync(abs, "utf8");
      for (const token of forbidden) {
        if (text.includes(token)) hits.push(`${path.relative(home, abs)} (${token})`);
      }
      for (const pattern of foreignHomes) {
        for (const match of text.match(pattern) ?? []) {
          const candidate = match.replace(/\\/g, "/").toLowerCase();
          // The same account's home root is legitimate (the payload expands to
          // this machine's home); any other login is a foreign absolute path.
          if (candidate === ownHome || ownHome.startsWith(`${candidate}/`)) continue;
          hits.push(`${path.relative(home, abs)} (${match})`);
        }
      }
    }
  }
  check(
    "portable-paths",
    hits.length === 0,
    hits.length === 0 ? "sin placeholders ni rutas /home/<usuario> ajenas" : `rutas sin expandir: ${hits.slice(0, 5).join(", ")}`,
    "ejecutá tools/restore.mjs para reexpandir el payload al home actual",
  );
}

// The plugin contract changed between OpenCode 1.x and 2.x: 1.x calls
// `server`, 2.x calls `setup` and only accepts a default export with
// `id` + `setup`. context-mode ships a 1.x plugin, so on 2.x it does not
// load; the payload carries a bridge that registers context-mode's MCP
// server there. This check says which line is in use and which route
// context-mode has, instead of leaving the user with a green verification
// and a plugin that silently does nothing.
function checkOpencodeCli(home) {
  const result = runTool("opencode", ["--version"], 10000);
  const version = String(result.stdout ?? "").trim();
  const major = version.match(/(\d+)\./);
  if (result.error || result.status !== 0 || !major) {
    skip(
      "opencode-cli",
      "no se encontró el CLI de OpenCode",
      "instalá OpenCode para validar que los plugins del payload cargan en tu versión",
    );
    return;
  }
  const line = Number(major[1]);

  const configPath = path.join(home, ".config", "opencode", "opencode.jsonc");
  let plugins = [];
  let mcpServers = {};
  try {
    const parsed = readJsonish(configPath);
    if (Array.isArray(parsed.plugin)) plugins = parsed.plugin;
    if (parsed.mcp && typeof parsed.mcp === "object") mcpServers = parsed.mcp;
  } catch (error) {
    // A config that does not parse is already reported by `mcp-json`.
  }
  const native = plugins.includes("context-mode");
  const viaMcp = mcpServers["context-mode"] !== undefined;

  if (line >= 2) {
    // On 2.x the native plugin cannot load; the route is the MCP server.
    if (native && !viaMcp) {
      check(
        "opencode-cli",
        false,
        `OpenCode ${version}: el plugin nativo de context-mode no carga en la línea 2.x y no está declarado como servidor MCP`,
        "corré `node tools/install.mjs` para adaptar la config a la línea 2.x",
      );
      return;
    }
    if (!viaMcp) {
      check(
        "opencode-cli",
        false,
        `OpenCode ${version}: context-mode no está declarado por ninguna vía (ni plugin ni MCP)`,
        "corré `node tools/install.mjs` o declaralo en el bloque mcp de tu opencode.jsonc",
      );
      return;
    }
    const tools = countCtxTools();
    check(
      "opencode-cli",
      true,
      `OpenCode ${version}: context-mode va por su servidor MCP${
        native ? "; el plugin nativo declarado no carga en 2.x — corré \`node tools/install.mjs\` para quitarlo" : ""
      }${tools > 0 ? ` — ${tools} herramientas ctx_* disponibles` : ""}`,
      "",
    );
    return;
  }

  if (native) {
    check("opencode-cli", true, `OpenCode ${version}: context-mode va por su plugin nativo`, "");
    return;
  }
  if (viaMcp) {
    check(
      "opencode-cli",
      true,
      `OpenCode ${version}: context-mode va por su servidor MCP, no por su plugin nativo`,
      "corré `node tools/install.mjs` para usar el plugin nativo en la línea 1.x",
    );
    return;
  }
  skip(
    "opencode-cli",
    `OpenCode ${version}: no hay plugin de context-mode declarado`,
    "si querés context-mode, declaralo en el plugin de tu opencode.jsonc",
  );
}

// How many `ctx_*` tools the CLI reports for context-mode. The listing format
// changed between the 1.x and 2.x lines, so the count is a tolerant match.
function countCtxTools() {
  const result = runTool("opencode", ["mcp", "list"], 20000);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const matches = output.match(/ctx_[a-z_]+/gi) ?? [];
  return new Set(matches.map((name) => name.toLowerCase())).size;
}

function checkMcp(home, repo) {
  const candidates = [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(repo, "home", ".config", "opencode", "opencode.jsonc"),
  ];
  const problems = [];
  let mcpCount = 0;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = readJsonish(file);
      const mcp = parsed.mcp;
      if (mcp && typeof mcp === "object") {
        for (const [name, entry] of Object.entries(mcp)) {
          mcpCount += 1;
          if (entry?.type !== "local" || !Array.isArray(entry.command) || entry.command.length === 0) {
            problems.push(`${path.basename(file)}:${name} sin command/type local`);
          }
        }
      }
    } catch (error) {
      problems.push(`${path.basename(file)}: ${error.message}`);
    }
  }
  check(
    "mcp-json",
    problems.length === 0,
    problems.length === 0 ? `${mcpCount} servidores MCP parseables` : problems.join("; "),
    "corregí el JSON del MCP en opencode.json(c); verify falla en el primer parse roto",
  );
}

function checkJevMcp(home) {
  // JEV is opt-in: without an OpenCode Zen credential there is nothing to
  // validate and nothing broken, so the check is skipped (never failed).
  let apiKey;
  try {
    apiKey = openCodeZenApiKey({ home });
  } catch (error) {
    check("jev-mcp", false, error.message, "revisá el perfil de autenticación de OpenCode");
    return;
  }
  if (!apiKey) {
    skip(
      "jev-mcp",
      "sin credencial OpenCode Zen — JEV queda desactivado",
      "conectá OpenCode Zen con `opencode auth login` y volvé a correr `node tools/install.mjs` para activarlo",
    );
    return;
  }

  const configDir = path.join(home, ".config", "opencode");
  const configPath = path.join(configDir, "opencode.jsonc");
  let config;
  try {
    config = readJsonish(configPath);
  } catch (error) {
    check("jev-mcp", false, `config MCP ilegible: ${error.message}`, "restaurá opencode.jsonc desde Habitat");
    return;
  }
  const command = config.mcp?.jev?.command;
  const expectedShim = path.join(
    home,
    "bin",
    process.platform === "win32" ? "habitat-jev-mcp.cmd" : "habitat-jev-mcp",
  );

  if (!Array.isArray(command) || command[0] !== "habitat-jev-mcp") {
    check(
      "jev-mcp",
      false,
      "opencode MCP `jev` no usa habitat-jev-mcp",
      "restaurá opencode.jsonc desde Habitat",
    );
    return;
  }
  if (!fs.existsSync(expectedShim)) {
    check("jev-mcp", false, `falta launcher: ${expectedShim}`, "ejecutá node tools/install.mjs para copiar tools/ a ~/bin");
    return;
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(configDir, "package.json"), "utf8"));
    if (!packageJson.dependencies?.["@jkudish/jev-mcp"]) throw new Error("dependencia no declarada");
    const moduleEntry = createRequire(path.join(configDir, "package.json")).resolve("@jkudish/jev-mcp");
    if (!fs.existsSync(path.join(path.dirname(moduleEntry), "index.js"))) throw new Error("entrypoint MCP ausente");
  } catch (error) {
    check(
      "jev-mcp",
      false,
      `paquete MCP no instalado: ${error.message}`,
      "ejecutá npm ci en ~/.config/opencode o reinstalá Habitat",
    );
    return;
  }
  // The verdict is the MCP handshake itself, not `opencode mcp list`: that
  // listing changed shape between the 1.x and 2.x lines of OpenCode, and on 2.x
  // it no longer mentions the server even when the connection works. The CLI
  // listing is kept as information, not as the verdict.
  const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "mcp-probe.mjs");
  const probed = runTool(process.execPath, [probe, expectedShim, "jev_classify"], 25000);
  const probeOutput = String(probed.stdout ?? "").trim();
  if (probed.status !== 0) {
    const listing = runTool("opencode", ["mcp", "list"], 20000);
    const listed = [listing.stdout, listing.stderr]
      .filter(Boolean)
      .join("\n")
      .replace(/\[[0-9;]*m/g, "");
    const line = listed.split(/\r?\n/).find((entry) => /\bjev\b/i.test(entry));
    check(
      "jev-mcp",
      false,
      `el servidor MCP de JEV no respondió: ${probeOutput || probed.stderr?.trim() || "sin salida"}`,
      `revisá el launcher ${expectedShim} y la dependencia @jkudish/jev-mcp; \`opencode mcp list\`: ${line?.trim() || "no lo lista"}`,
    );
    return;
  }
  const listing = runTool("opencode", ["mcp", "list"], 20000);
  const listed = [listing.stdout, listing.stderr].filter(Boolean).join("\n").replace(/\[[0-9;]*m/g, "");
  const line = listed.split(/\r?\n/).find((entry) => /\bjev\b/i.test(entry));
  check(
    "jev-mcp",
    true,
    `jev_classify anunciado por el servidor MCP${line ? ` (${line.trim()})` : ""}`,
    "",
  );
}

// On win32 the opencode launcher ships as opencode.cmd / opencode.exe; its
// opencode.ps1 is unusable without changing ExecutionPolicy. Prefer an explicit
// .exe/.cmd/.bat on PATH and never hand a .ps1 to spawn.
function resolveExecutable(command) {
  return findExecutable(command);
}

function runTool(command, args, timeoutMs, cwd) {
  const win = process.platform === "win32";
  const resolved = resolveExecutable(command);
  // A missing binary must surface as ENOENT even on win32, where the spawn
  // goes through cmd.exe and would otherwise look like a command that ran and
  // failed. Otherwise "not installed" is reported as "broken".
  if (win && !resolved) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: `${command} no está en PATH` },
    };
  }
  const result = spawnSync(win ? `"${resolved}"` : resolved, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: win,
  });
  return result;
}

// A transient network/timeout failure must not be reported as a broken id,
// so the catalog query is retried a few times before giving up. An absent CLI
// (ENOENT) is terminal: retrying cannot help.
function runToolRetry(command, args, timeoutMs, attempts = 3) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt++) {
    result = runTool(command, args, timeoutMs);
    if (!result.error && result.status === 0) return result;
    if (result.error && result.error.code === "ENOENT") return result;
  }
  return result;
}

function checkCli() {
  const tools = [
    { name: "gsd-sdk", args: ["--help"] },
    { name: "graphify", args: ["--help"] },
  ];
  const failures = [];
  const missing = [];
  for (const tool of tools) {
    const result = runTool(tool.name, tool.args, 30000);
    if (result.error) {
      missing.push(tool.name);
      continue;
    }
    if (result.status !== 0) failures.push(`${tool.name} (exit ${result.status})`);
  }
  if (failures.length > 0) {
    check("cli-tools", false, failures.join(", "), "revisá la instalación de esas CLIs; --no-cli omite la comprobación");
    return;
  }
  // Not installed is a state, not a fault: these CLIs are optional and only
  // arrive with `--with-deps`. The check stays green and says what is missing.
  check(
    "cli-tools",
    true,
    missing.length > 0 ? `ok, pero no instaladas: ${missing.join(", ")}` : "responden",
    missing.length > 0 ? "instalá las CLIs opcionales con node tools/install.mjs --with-deps" : "",
  );
}

function checkPlugins(home) {
  const configCandidates = [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
  ];
  const problems = [];
  const missingNpm = [];
  let local = 0;
  let npm = 0;
  const seen = new Set();
  for (const configPath of configCandidates) {
    if (!fs.existsSync(configPath)) continue;
    let parsed;
    try {
      parsed = readJsonish(configPath);
    } catch {
      continue;
    }
    const base = path.dirname(configPath);
    for (const plugin of parsed.plugin ?? []) {
      if (typeof plugin !== "string" || seen.has(plugin)) continue;
      seen.add(plugin);
      if (plugin.startsWith(".")) {
        local += 1;
        if (!fs.existsSync(path.resolve(base, plugin))) problems.push(plugin);
      } else {
        npm += 1;
        if (!resolveNpmPlugin(plugin, base)) missingNpm.push(plugin);
      }
    }
  }
  const failures = [...problems, ...missingNpm.map((p) => `${p} (npm)`)];
  check(
    "plugins",
    failures.length === 0,
    failures.length === 0
      ? `${seen.size} plugins declarados (${local} locales, ${npm} npm)`
      : `no resuelven: ${failures.join(", ")}`,
    missingNpm.length > 0
      ? "corré `npm ci` en ~/.config/opencode o node tools/install.mjs (context-mode es dependency del payload)"
      : "un plugin local no existe: corré scripts/restore.sh y npm ci",
  );
}

// Bare plugin names are npm packages installed in the config directory's
// node_modules (context-mode is a production dependency of the payload). The
// global npm root is deliberately not consulted: the installer never mutates
// the user's global packages anymore.
function resolveNpmPlugin(name, base) {
  try {
    require.resolve(name, { paths: [base] });
    return true;
  } catch {
    return false;
  }
}

// C1 guard: @opencode-ai/plugin is a devDependency now, so it is not installed
// by `npm ci --omit=dev`. A user plugin that imports it at runtime must be
// caught here with an actionable hint instead of failing later inside opencode.
const PLUGIN_SDK_RE = /@opencode-ai\/plugin\b/;
const PLUGIN_FILE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

function collectPluginFiles(home) {
  const configDir = path.join(home, ".config", "opencode");
  const files = new Set();
  const addTree = (root) => {
    if (!fs.existsSync(root)) return;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && PLUGIN_FILE_RE.test(entry.name)) files.add(full);
      }
    }
  };
  addTree(path.join(configDir, "plugins"));
  for (const configPath of [
    path.join(configDir, "opencode.json"),
    path.join(configDir, "opencode.jsonc"),
  ]) {
    if (!fs.existsSync(configPath)) continue;
    let parsed;
    try {
      parsed = readJsonish(configPath);
    } catch {
      continue;
    }
    for (const plugin of parsed.plugin ?? []) {
      if (typeof plugin !== "string" || !plugin.startsWith(".")) continue;
      const resolved = path.resolve(configDir, plugin);
      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch {
        continue;
      }
      if (stat.isDirectory()) addTree(resolved);
      else if (stat.isFile() && PLUGIN_FILE_RE.test(resolved)) files.add(resolved);
    }
  }
  return [...files];
}

function sdkInstalled(configDir) {
  try {
    require.resolve("@opencode-ai/plugin", { paths: [configDir] });
    return true;
  } catch {
    return false;
  }
}

function checkPluginSdk(home) {
  const configDir = path.join(home, ".config", "opencode");
  const hits = [];
  const files = collectPluginFiles(home);
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    PLUGIN_SDK_RE.lastIndex = 0;
    if (PLUGIN_SDK_RE.test(text)) hits.push(path.relative(configDir, file));
  }
  const installed = hits.length === 0 || sdkInstalled(configDir);
  check(
    "plugin-sdk",
    installed,
    hits.length === 0
      ? `${files.length} plugins sin imports de @opencode-ai/plugin`
      : installed
        ? `${hits.length} plugins importan el SDK y está instalado`
        : `plugins importan el SDK (devDependency, no instalado): ${hits.join(", ")}`,
    installed ? "" : "corré `npm i` en ~/.config/opencode para recuperar el SDK de tipos de plugins",
  );
}

// npm audit runs explicitly here because restore uses --no-audit (it was noise
// nobody read). The digest marker makes it run once per lock change, so the
// warm path costs nothing while a changed lock gets a visible verdict.
function npmInputsDigest(configDir) {
  const pkg = path.join(configDir, "package.json");
  const lock = path.join(configDir, "package-lock.json");
  if (!fs.existsSync(pkg) || !fs.existsSync(lock)) return null;
  const hash = crypto.createHash("sha256");
  for (const file of [pkg, lock]) {
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      return null;
    }
  }
  return hash.digest("hex");
}

function checkNpmAudit(home) {
  const configDir = path.join(home, ".config", "opencode");
  const digest = npmInputsDigest(configDir);
  if (!digest) {
    skip(
      "npm-audit",
      "sin package.json/package-lock.json en el config dir",
      "restaurá el payload antes de auditar dependencias",
    );
    return;
  }
  const marker = path.join(configDir, "node_modules", ".habitat-audit-fingerprint");
  let previous = "";
  try {
    previous = fs.readFileSync(marker, "utf8").trim();
  } catch {
    previous = "";
  }
  if (previous === digest) {
    check("npm-audit", true, "sin cambios desde la última auditoría");
    return;
  }
  const result = runTool("npm", ["audit", "--omit=dev", "--audit-level=high"], 120000, configDir);
  if (result.error) {
    skip("npm-audit", `no se pudo ejecutar npm audit: ${result.error.message}`, "instalá Node.js/npm y reintentá");
    return;
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    const summary = output.split(/\r?\n/).filter(Boolean).slice(-6).join("; ");
    check(
      "npm-audit",
      false,
      `npm audit falló (exit ${result.status}): ${summary || "sin salida"}`,
      "revisá las vulnerabilidades de alta severidad y actualizá las dependencias del payload",
    );
    return;
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, digest);
  } catch {
    /* marker is best-effort: a read-only node_modules still passes the check */
  }
  check("npm-audit", true, "sin vulnerabilidades high/critical en dependencias de producción");
}

function checkDiscovery(home) {
  const roots = [
    [path.join(home, ".config", "opencode", "skills"), "opencode/skills"],
    [path.join(home, ".config", "opencode", "agents"), "opencode/agents"],
    [path.join(home, ".claude", "skills"), ".claude/skills"],
    [path.join(home, ".agents", "skills"), ".agents/skills"],
  ];
  const counts = [];
  const skillRoots = new Map();
  for (const [root, label] of roots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root).filter((name) => !name.startsWith("."));
    counts.push(`${label}=${entries.length}`);
    if (!label.endsWith("/skills")) continue;
    for (const name of entries) {
      if (!skillRoots.has(name)) skillRoots.set(name, new Set());
      skillRoots.get(name).add(label);
    }
  }
  const duplicates = [...skillRoots.entries()].filter(([, labels]) => labels.size > 1);
  if (duplicates.length > 0) {
    const detail = duplicates.map(([name, labels]) => `${name} (${[...labels].join(", ")})`).join("; ");
    check(
      "discovery",
      false,
      `skill duplicada entre roots: ${detail}`,
      "una skill debe vivir en un solo root: quitá el duplicado (p.ej. el symlink vivo ~/.claude/skills/<name>)",
    );
    return;
  }
  check(
    "discovery",
    counts.length > 0,
    counts.length > 0 ? counts.join(" ") : "ningún directorio de skills/agents",
    "restaurá ~/.config/opencode antes de verificar",
  );
}

function checkArchify(home) {
  const cli = path.join(home, ".agents", "skills", "archify", "bin", "archify.mjs");
  if (!fs.existsSync(cli)) {
    check("archify", false, "falta CLI empaquetado del skill Archify", "reinstalá Habitat para restaurar la skill completa");
    return;
  }
  const result = spawnSync(process.execPath, [cli, "doctor"], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const ok = result.status === 0 && /Archify is ready\./.test(output);
  check(
    "archify",
    ok,
    ok ? "CLI listo; doctor OK" : `doctor falló (exit ${result.status ?? "unknown"})`,
    "reinstalá Habitat o revisá el payload de .agents/skills/archify",
  );
}

function checkModels(home, repo) {
  const homeRouterDir = path.join(home, ".config", "opencode", "gsd-router");
  const repoRouterDir = path.join(repo, "home", ".config", "opencode", "gsd-router");
  const profileDocs = {};
  let effective;
  try {
    for (const profile of PROFILE_NAMES) {
      const homeFile = path.join(homeRouterDir, `${profile}.json`);
      const file = fs.existsSync(homeFile) ? homeFile : path.join(repoRouterDir, `${profile}.json`);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        parsed.name !== profile ||
        !parsed.model_overrides ||
        typeof parsed.model_overrides !== "object" ||
        Array.isArray(parsed.model_overrides)
      ) {
        throw new Error(`${file}: perfil inválido`);
      }
      profileDocs[profile] = parsed;
    }
    effective = mergeOverlay(profileDocs, loadOverlay(home));
  } catch (error) {
    check("model-ids", false, `perfiles/overlay inválidos: ${error.message}`, "revisa gsd-router/*.json y picks.local");
    return;
  }

  // Without an OpenCode Zen credential the catalog is filtered and can never
  // produce a failure verdict: every missing id is unverified, not retired.
  // Skip the CLI call (11 s on a cold network) instead of paying for a check
  // that inevitably ends in `skip`. With credentials the full check runs.
  let apiKey;
  try {
    apiKey = openCodeZenApiKey({ home });
  } catch (error) {
    check("model-ids", false, error.message, "revisá el perfil de autenticación de OpenCode");
    return;
  }
  if (!apiKey) {
    skip(
      "model-ids",
      "sin credencial OpenCode Zen — no se consulta el catálogo; perfiles locales válidos",
      "autenticá opencode (`opencode auth login`) para validar el catálogo completo; `--no-models` omite el check",
    );
    return;
  }

  // Check only effective home models; repository defaults are fallback inputs,
  // not extra model selections when the user has customized their overlay.
  const available = runToolRetry("opencode", ["models"], 30000, 3);
  if (available.error || available.status !== 0) {
    skip(
      "model-ids",
      "no se pudo consultar `opencode models` (red/auth)",
      "autenticá opencode (`opencode auth login`) o usá --no-models",
    );
    return;
  }
  const known = new Set(available.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  // The catalog is only complete when the auth-gated namespace shows up: it
  // appears exclusively with credentials, and without them the listing is a
  // filtered subset (the free models) that still advertises models OpenCode
  // already retired. A missing id in an incomplete catalog is not evidence of
  // a retired model, so it is reported as unchecked instead of a failure.
  const hasAuthNamespace = [...known].some((id) => id.startsWith(`${AUTH_NAMESPACE}/`));
  const namespaces = new Set([...known].map((id) => id.split("/")[0]));
  const limited = !hasAuthNamespace || known.size < MIN_FULL_CATALOG;

  const problems = [];
  const unverified = [];
  let checked = 0;
  for (const profile of PROFILE_NAMES) {
    for (const [agent, model] of Object.entries(effective[profile])) {
      checked += 1;
      if (known.has(model)) continue;
      const namespace = model.includes("/") ? model.split("/")[0] : null;
      const invisible = namespace !== null && !namespaces.has(namespace);
      // Even a "complete" catalog can hide some auth-gated ids: older CLIs fall
      // back to a bundled snapshot that lists the namespace but not its newest
      // entries. Absence there is not proof of retirement, so only public ids
      // fail the install-time check; the weekly catalog job owns the verdict.
      const authGated = namespace === AUTH_NAMESPACE;
      if (limited || invisible || authGated) unverified.push(`${profile}:${agent}=${model}`);
      else problems.push(`${profile}:${agent}=${model}`);
    }
  }

  if (problems.length > 0) {
    check(
      "model-ids",
      false,
      problems.join("; "),
      "corré `gsd-model-pick` para cambiar la celda en `picks.local` (ver `opencode models`)",
    );
    return;
  }
  if (unverified.length > 0) {
    skip(
      "model-ids",
      `${checked - unverified.length}/${checked} ids válidos; ${unverified.length} sin verificar (catálogo incompleto o id autenticado invisible)`,
      "autenticá opencode (`opencode auth login`) para validar el catálogo completo; el job semanal del catálogo detecta los ids retirados",
    );
    return;
  }
  check("model-ids", true, `${checked} ids válidos`);
}

function main() {
  const options = parseArgs(process.argv);

  timing.wrap("manifest-dests", () => checkManifest(options.repo, options.home));
  timing.wrap("portable-paths", () => checkPortablePaths(options.home));
  timing.wrap("mcp-json", () => checkMcp(options.home, options.repo));
  timing.wrap("jev-mcp", () => checkJevMcp(options.home));
  if (!options.noCli) {
    timing.wrap("cli-tools", () => checkCli());
    timing.wrap("opencode-cli", () => checkOpencodeCli(options.home));
  }
  timing.wrap("plugins", () => checkPlugins(options.home));
  timing.wrap("plugin-sdk", () => checkPluginSdk(options.home));
  timing.wrap("discovery", () => checkDiscovery(options.home));
  timing.wrap("archify", () => checkArchify(options.home));
  timing.wrap("npm-audit", () => checkNpmAudit(options.home));
  if (!options.noModels) timing.wrap("model-ids", () => checkModels(options.home, options.repo));

  const failed = results.filter((r) => !r.ok);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      const mark = !result.ok ? "FAIL" : result.skipped ? "skip" : "ok  ";
      process.stdout.write(`${mark} ${result.name}: ${result.detail}\n`);
      if ((!result.ok || result.skipped) && result.hint) process.stdout.write(`     hint: ${result.hint}\n`);
    }
  }

  if (failed.length > 0) {
    process.stderr.write(`verify: ${failed.length} comprobación(es) fallida(s)\n`);
    process.exit(EXIT_FAILED);
  }
  process.stdout.write("verify: all checks passed\n");
  process.exit(EXIT_OK);
}

main();
