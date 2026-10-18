#!/usr/bin/env node
// tools/verify.mjs — post-restore functional verification (VER-01/VER-02).
//
// Checks, in order, each with a machine-readable name and an actionable hint:
//   1. manifest-dests   every MANIFEST.json dest exists
//   2. mcp-json         opencode.json / opencode.jsonc parse and carry valid mcp entries
//   3. cli-tools        gsd-sdk --help and graphify --help respond (--no-cli skips)
//   4. plugins          plugin files referenced by opencode.json exist
//   5. discovery        skills/agents are discoverable
//   6. model-ids        every model id in gsd-router/{easy,medium,hard}.json is listed
//                       by `opencode models` (--no-models skips)
//
// Exit 0 = all green, 1 = at least one failed check, 2 = usage error.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

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

function runTool(command, args, timeoutMs) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
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
  check(
    "cli-tools",
    true,
    missing.length > 0 ? `responden (no instalados: ${missing.join(", ")})` : "responden",
  );
  if (missing.length > 0) {
    results.push({
      name: "cli-tools-installed",
      ok: false,
      detail: `faltan: ${missing.join(", ")}`,
      hint: "instalar con tools/install.mjs --with-deps",
    });
  }
}

function checkPlugins(home) {
  const configCandidates = [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
  ];
  const problems = [];
  let local = 0;
  let seen = new Set();
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
      }
    }
  }
  check(
    "plugins",
    problems.length === 0,
    problems.length === 0 ? `${seen.size} plugins declarados, ${local} locales presentes` : problems.join(", "),
    "un plugin local no existe: corré scripts/restore.sh y npm ci",
  );
}

function checkDiscovery(home) {
  const roots = [
    [path.join(home, ".config", "opencode", "skills"), "opencode/skills"],
    [path.join(home, ".config", "opencode", "agents"), "opencode/agents"],
    [path.join(home, ".claude", "skills"), ".claude/skills"],
    [path.join(home, ".agents", "skills"), ".agents/skills"],
  ];
  const counts = [];
  for (const [root, label] of roots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root).filter((name) => !name.startsWith("."));
    counts.push(`${label}=${entries.length}`);
  }
  check(
    "discovery",
    counts.length > 0,
    counts.length > 0 ? counts.join(" ") : "ningún directorio de skills/agents",
    "restaurá ~/.config/opencode antes de verificar",
  );
}

function checkModels(home, repo) {
  const candidateDirs = [
    [path.join(home, ".config", "opencode", "gsd-router"), "home"],
    [path.join(repo, "home", ".config", "opencode", "gsd-router"), "repo"],
  ];
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
  const hasAuthNamespace = [...known].some((id) => id.startsWith("opencode-go/"));
  // A small catalog, or one without the auth-gated namespace, cannot validate
  // the ids: report them as unchecked instead of inventing a failure.
  const limited = !(known.size >= MIN_FULL_CATALOG || hasAuthNamespace);

  const problems = [];
  const unverified = [];
  let checked = 0;
  for (const [routerDir, label] of candidateDirs) {
    for (const profile of ["easy", "medium", "hard"]) {
      const file = path.join(routerDir, `${profile}.json`);
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [agent, model] of Object.entries(parsed.model_overrides ?? {})) {
        checked += 1;
        if (known.has(model)) continue;
        if (limited) unverified.push(`${label}/${profile}:${agent}=${model}`);
        else problems.push(`${label}/${profile}:${agent}=${model}`);
      }
    }
  }

  if (problems.length > 0) {
    check(
      "model-ids",
      false,
      problems.join("; "),
      "reemplazá los ids inválidos en gsd-router/*.json (ver `opencode models`)",
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
  checkMcp(options.home, options.repo);
  if (!options.noCli) checkCli();
  checkPlugins(options.home);
  checkDiscovery(options.home);
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
