#!/usr/bin/env node
// tools/gsd-grafiphy.mjs — portable Node replacement for the bash gsd-grafiphy.
//
// Local knowledge-graph layer over the `graphify` CLI (uv/pipx tool `graphifyy`).
// No Neo4j / FalkorDB / uploads: AST code extraction only.
//
// Usage: gsd-grafiphy [update|full|watch|status] [--dir <project>]

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = [
  "Uso:",
  "  gsd-grafiphy            Actualizar/inicializar grafo de código",
  "  gsd-grafiphy full       Extracción completa",
  "  gsd-grafiphy watch      Actualizar automáticamente al cambiar código",
  "  gsd-grafiphy status     Ver estado del grafo",
].join("\n");

function graphifyBinary() {
  for (const candidate of [
    process.env.GRAPHIFY_BIN,
    path.join(process.env.HOME ?? "", ".local", "bin", "graphify"),
    "graphify",
  ]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function runGraphify(binary, args, projectDir) {
  return spawnSync(binary, args, {
    cwd: projectDir,
    encoding: "utf8",
    stdio: "inherit",
  });
}

function main() {
  const args = process.argv.slice(2);
  let command = "update";
  let projectDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") projectDir = path.resolve(args[++i]);
    else if (["update", "full", "watch", "status"].includes(args[i])) command = args[i];
    else if (args[i] === "-h" || args[i] === "--help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(EXIT_OK);
    } else {
      process.stderr.write(`gsd-grafiphy: argumento desconocido: ${args[i]}\n`);
      process.exit(EXIT_USAGE);
    }
  }

  const graphDir = path.join(projectDir, "graphify-out");
  const graphFile = path.join(graphDir, "graph.json");

  if (command === "status") {
    process.stdout.write("=== GSD + Graphify — status ===\n");
    if (fs.existsSync(graphFile)) {
      const stats = fs.statSync(graphFile);
      process.stdout.write(`✓ graph.json existe (${stats.size} bytes, ${stats.mtime.toISOString()})\n`);
      process.exit(EXIT_OK);
    }
    process.stdout.write("✗ No existe graphify-out/graph.json\n");
    process.exit(EXIT_FAILED);
  }

  const binary = graphifyBinary();
  if (!binary) {
    process.stderr.write("gsd-grafiphy: CLI `graphify` no encontrada (instalá graphifyy: uv tool install graphifyy)\n");
    process.exit(EXIT_FAILED);
  }

  process.stdout.write(`=== GSD + Graphify — ${command} ===\nProyecto: ${projectDir}\n\n`);

  if (command === "watch") {
    const watch = runGraphify(binary, ["watch", projectDir], projectDir);
    process.exit(watch.status ?? EXIT_FAILED);
  }

  if (command === "full") {
    const full = runGraphify(binary, ["extract", projectDir], projectDir);
    process.exit(full.status ?? EXIT_FAILED);
  }

  fs.mkdirSync(graphDir, { recursive: true });
  if (fs.existsSync(graphFile)) {
    process.stdout.write("→ Grafo existente encontrado. Actualizando...\n");
    const update = runGraphify(binary, ["update", projectDir], projectDir);
    process.exit(update.status ?? EXIT_FAILED);
  }
  process.stdout.write("→ No existe grafo. Generando grafo inicial de código...\n");
  const extract = runGraphify(binary, ["extract", projectDir, "--code-only"], projectDir);
  process.exit(extract.status ?? EXIT_FAILED);
}

main();
