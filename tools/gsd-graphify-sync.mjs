#!/usr/bin/env node
// tools/gsd-graphify-sync.mjs — local Graphify refresh for the GSD phase close.
//
// Runs tools/gsd-grafiphy.mjs (update) and then VERIFIES the result instead of
// trusting it: the run only counts as refreshed when the tool exited 0 AND
// graphify-out/graph.json exists with a modification time after the run start
// (or was created by this run). The verdict is machine-readable:
//
// GRAPHIFY_SYNC=ok        refreshed and verified
// GRAPHIFY_SYNC=failed    not refreshed (reason printed above the verdict)
//
// When the project config declares graphify.enabled=true, a
// .planning/graphs/last-sync.json record is written so the phase SUMMARY can
// quote evidence instead of asserting success.
//
// Usage: gsd-graphify-sync [--dir <project>] [--status]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const EXIT_OK = 0;
const EXIT_NOT_REFRESHED = 1;

function parseArgs(argv) {
  const args = argv.slice(2);
  let projectDir = process.cwd();
  let status = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") projectDir = path.resolve(args[++i]);
    else if (args[i] === "--status") status = true;
    else if (args[i] === "-h" || args[i] === "--help") {
      process.stdout.write("Uso: gsd-graphify-sync [--dir <proyecto>] [--status]\n");
      process.exit(EXIT_OK);
    } else {
      process.stderr.write(`gsd-graphify-sync: argumento desconocido: ${args[i]}\n`);
      process.exit(2);
    }
  }
  return { projectDir, status };
}

function grafiphyTool() {
  const candidates = [
    process.env.GSD_HABITAT_ROOT
      ? path.join(process.env.GSD_HABITAT_ROOT, "tools", "gsd-grafiphy.mjs")
      : null,
    path.resolve(path.dirname(process.argv[1]), "gsd-grafiphy.mjs"),
    path.join(os.homedir(), "bin", "gsd-grafiphy"),
    path.resolve(import.meta.dirname, "gsd-grafiphy.mjs"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function graphifyEnabled(projectDir) {
  const configPath = path.join(projectDir, ".planning", "config.json");
  if (!fs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config?.graphify?.enabled === true;
  } catch {
    return false;
  }
}

function main() {
  const { projectDir, status } = parseArgs(process.argv);
  const graphFile = path.join(projectDir, "graphify-out", "graph.json");

  if (status) {
    const tool = grafiphyTool();
    if (!tool) {
      process.stderr.write("gsd-graphify-sync: no se encontró gsd-grafiphy\n");
      process.exit(EXIT_NOT_REFRESHED);
    }
    const args = tool.endsWith(".mjs") ? [tool, "status", "--dir", projectDir] : [tool, "status"];
    const result = spawnSync(process.execPath, args, { stdio: "inherit" });
    process.exit(result.status ?? EXIT_NOT_REFRESHED);
  }

  process.stdout.write("=== GSD Graphify sync (local) ===\n");
  process.stdout.write(`Proyecto: ${projectDir}\n`);

  const tool = grafiphyTool();
  if (!tool) {
    process.stdout.write("✗ gsd-grafiphy no encontrado (ejecutá tools/install.mjs)\n");
    process.stdout.write("GRAPHIFY_SYNC=failed\n");
    process.exit(EXIT_NOT_REFRESHED);
  }

  const existedBefore = fs.existsSync(graphFile);
  const startedAt = Date.now();
  const args = tool.endsWith(".mjs")
    ? [tool, "update", "--dir", projectDir]
    : [tool, "update"];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", stdio: "inherit" });
  const exitCode = result.status ?? EXIT_NOT_REFRESHED;

  let reason = "";
  if (exitCode !== 0) reason = `gsd-grafiphy salió con código ${exitCode}`;
  else if (!fs.existsSync(graphFile)) reason = "graphify-out/graph.json no existe tras el refresh";
  else if (existedBefore && fs.statSync(graphFile).mtimeMs < startedAt - 1000) {
    reason = "graphify-out/graph.json no fue regenerado en esta corrida";
  }

  const refreshed = reason === "";
  if (refreshed) process.stdout.write("✓ Graphify sync completo (local, sin uploads)\n");
  else process.stdout.write(`✗ Graphify no actualizado: ${reason}\n`);

  if (graphifyEnabled(projectDir)) {
    const graphsDir = path.join(projectDir, ".planning", "graphs");
    fs.mkdirSync(graphsDir, { recursive: true });
    const record = {
      refreshed,
      tool: "gsd-graphify-sync",
      graph_file: "graphify-out/graph.json",
      at: new Date().toISOString(),
      ...(refreshed ? {} : { reason }),
    };
    fs.writeFileSync(
      path.join(graphsDir, "last-sync.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }

  process.stdout.write(refreshed ? "GRAPHIFY_SYNC=ok\n" : "GRAPHIFY_SYNC=failed\n");
  process.exit(refreshed ? EXIT_OK : EXIT_NOT_REFRESHED);
}

main();
