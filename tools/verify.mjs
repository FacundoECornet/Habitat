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
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { PROFILE_NAMES, loadOverlay, mergeOverlay } from "../lib/model-pick.mjs";
import { openCodeZenApiKey } from "../lib/opencode-auth.mjs";
import { findExecutable } from "../lib/exec-path.mjs";

const require = createRequire(import.meta.url);

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

// An authenticated `opencode models` lists well over this many entries; a smaller
// catalog (or one without the auth-gated `opencode-go/*` namespace) means the
// registry was truncated by missing credentials, not that the ids are invalid.
const MIN_FULL_CATALOG = 20;

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
  const result = runTool("opencode", ["mcp", "list"], 20000);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  const line = output.split(/\r?\n/).find((entry) => /\bjev\b/i.test(entry));
  const ok = result.status === 0 && line && !/(?:failed|timeout|✗|error)/i.test(line);
  check(
    "jev-mcp",
    Boolean(ok),
    ok ? line.trim() : line?.trim() || `OpenCode no confirmó conexión${result.error ? `: ${result.error.message}` : ""}`,
    "ejecutá `opencode.cmd --print-logs --log-level DEBUG mcp list` (Windows) o `opencode --print-logs --log-level DEBUG mcp list`; revisá JEV MCP y OpenCode Zen",
  );
}

// On win32 the opencode launcher ships as opencode.cmd / opencode.exe; its
// opencode.ps1 is unusable without changing ExecutionPolicy. Prefer an explicit
// .exe/.cmd/.bat on PATH and never hand a .ps1 to spawn.
function resolveExecutable(command) {
  return findExecutable(command);
}

function runTool(command, args, timeoutMs) {
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
    missing.length > 0 ? `responden (no instalados: ${missing.join(", ")})` : "responden",
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
  const globalRoot = npmGlobalRoot();
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
        if (!resolveNpmPlugin(plugin, base, globalRoot)) missingNpm.push(plugin);
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
      ? `instalá el paquete npm faltante (npm i -g ${missingNpm.join(" ")}@<versión>) o corré node tools/install.mjs`
      : "un plugin local no existe: corré scripts/restore.sh y npm ci",
  );
}

function npmGlobalRoot() {
  const result = runTool("npm", ["root", "-g"], 20000);
  if (result.error || result.status !== 0) return null;
  const root = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  return root ? root.trim() : null;
}

// A bare plugin name is an npm package. opencode resolves it from the config
// directory's node_modules or from the global npm root, so either location
// counts as installed.
function resolveNpmPlugin(name, base, globalRoot) {
  try {
    require.resolve(name, { paths: [base] });
    return true;
  } catch {
    return globalRoot ? fs.existsSync(path.join(globalRoot, name, "package.json")) : false;
  }
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
  const hasAuthNamespace = [...known].some((id) => id.startsWith("opencode-go/"));
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
      if (limited || invisible) unverified.push(`${profile}:${agent}=${model}`);
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
      `${checked - unverified.length}/${checked} ids válidos; ${unverified.length} sin verificar (catálogo limitado)`,
      "autenticá opencode (`opencode auth login`) para validar el catálogo completo",
    );
    return;
  }
  check("model-ids", true, `${checked} ids válidos`);
}

function main() {
  const options = parseArgs(process.argv);

  checkManifest(options.repo, options.home);
  checkPortablePaths(options.home);
  checkMcp(options.home, options.repo);
  checkJevMcp(options.home);
  if (!options.noCli) checkCli();
  checkPlugins(options.home);
  checkDiscovery(options.home);
  checkArchify(options.home);
  if (!options.noModels) checkModels(options.home, options.repo);

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
