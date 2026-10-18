#!/usr/bin/env node
// Interactive and scriptable editor for GSD model profile matrices (F-14).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  PROFILE_NAMES,
  ROLE_GROUPS,
  loadOverlay,
  mergeOverlay,
  overlayPath,
  readModelFile,
  readProfiles,
  repoPointerPath,
  saveOverlay,
  validateModelId,
} from "../lib/model-pick.mjs";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");
const EXIT_USAGE = 2;

function usage() {
  stdout.write([
    "Usage: gsd-model-pick [--home DIR] [--repo DIR] [--apply-overlay]",
    "       gsd-model-pick --models-file FILE [--home DIR] [--repo DIR]",
    "       gsd-model-pick --export-models FILE [--home DIR] [--repo DIR]",
    "       gsd-model-pick --profile PROFILE --agent AGENT --model PROVIDER/MODEL",
    "       gsd-model-pick --profile PROFILE --role ROLE --model PROVIDER/MODEL",
    "       gsd-model-pick --list",
    "",
    "Sin flags, abre editor interactivo por perfil si stdin es TTY.",
    "En el prompt: Enter mantiene, ! usa default del repo, * salta perfil, q termina.",
    "Atajo bulk por perfil: @planner=ID, @writer=ID, @executor=ID, @checker=ID.",
    "",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    home: os.homedir(),
    repo: null,
    profile: null,
    agent: null,
    role: null,
    model: null,
    modelsFile: null,
    exportModels: null,
    applyOverlay: false,
    list: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${arg} requiere un valor`);
      return argv[++i];
    };
    if (arg === "--home") options.home = path.resolve(value());
    else if (arg === "--repo") options.repo = path.resolve(value());
    else if (arg === "--profile") options.profile = value();
    else if (arg === "--agent") options.agent = value();
    else if (arg === "--role") options.role = value();
    else if (arg === "--model") options.model = value();
    else if (arg === "--models-file") options.modelsFile = path.resolve(value());
    else if (arg === "--export-models" || arg === "--to-file") options.exportModels = path.resolve(value());
    else if (arg === "--apply-overlay") options.applyOverlay = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`argumento desconocido: ${arg}`);
    }
  }
  return options;
}

function profileFileDir(repo) {
  return path.join(repo, "home", ".config", "opencode", "gsd-router");
}

function hasBundledProfiles(repo) {
  const dir = profileFileDir(repo);
  return PROFILE_NAMES.every((profile) => fs.existsSync(path.join(dir, `${profile}.json`)));
}

function locateRepo(options) {
  if (options.repo) {
    if (!hasBundledProfiles(options.repo)) throw new Error(`no se encontraron perfiles Habitat en ${options.repo}`);
    return options.repo;
  }
  const candidates = [];
  try {
    const pointer = fs.readFileSync(repoPointerPath(options.home), "utf8").trim();
    if (pointer) candidates.push(path.resolve(pointer));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  candidates.push(process.cwd(), SOURCE_ROOT);
  const repo = candidates.find(hasBundledProfiles);
  if (!repo) throw new Error("no se encontró repo Habitat; pasa --repo RUTA o reinstala para guardar ~/.habitat/repo-root");
  return repo;
}

function roleAgents(matrix, role) {
  const list = ROLE_GROUPS[role];
  if (!list) throw new Error(`rol desconocido: ${role} (roles: ${Object.keys(ROLE_GROUPS).join(", ")})`);
  const allAgents = new Set(Object.values(matrix).flatMap((models) => Object.keys(models)));
  return list.filter((agent) => allAgents.has(agent));
}

function orderedAgents(matrix, profile) {
  const models = matrix[profile];
  const seen = new Set();
  const ordered = [];
  for (const [role, agents] of Object.entries(ROLE_GROUPS)) {
    const members = agents.filter((agent) => Object.hasOwn(models, agent));
    if (members.length) ordered.push({ role, agents: members });
    for (const agent of members) seen.add(agent);
  }
  const other = Object.keys(models).filter((agent) => !seen.has(agent)).sort();
  if (other.length) ordered.push({ role: "otro", agents: other });
  return ordered;
}

function changedCells(before, after) {
  const changed = [];
  for (const profile of PROFILE_NAMES) {
    for (const [agent, model] of Object.entries(after[profile])) {
      if (before[profile][agent] !== model) changed.push({ profile, agent, from: before[profile][agent], to: model });
    }
  }
  return changed;
}

function printMatrix(matrix) {
  for (const profile of PROFILE_NAMES) {
    stdout.write(`\n${profile.toUpperCase()}\n`);
    for (const group of orderedAgents(matrix, profile)) {
      stdout.write(`  ${group.role}:\n`);
      for (const agent of group.agents) stdout.write(`    ${agent}: ${matrix[profile][agent]}\n`);
    }
  }
}

async function editMatrix(matrix, defaults, rl) {
  let finishAll = false;
  stdout.write("Selector de modelos GSD. Enter=mantener, !=default repo, *=saltar perfil, q=terminar.\n");
  stdout.write("Atajo bulk opcional por perfil: @planner=model, @writer=model, @executor=model, @checker=model.\n");
  for (const profile of PROFILE_NAMES) {
    stdout.write(`\n=== Perfil ${profile} ===\n`);
    let skipAgents = new Set();
    for (const group of orderedAgents(matrix, profile)) {
      for (const agent of group.agents) {
        if (finishAll) break;
        if (skipAgents.has(agent)) continue;
        while (true) {
          const value = (await rl.question(`[${group.role}] ${agent} [${matrix[profile][agent]}] > `)).trim();
          if (value === "") break;
          if (value === "*") {
            skipAgents = new Set(Object.keys(matrix[profile]));
            break;
          }
          if (value.toLowerCase() === "q") {
            finishAll = true;
            break;
          }
          if (value === "!") {
            matrix[profile][agent] = defaults[profile].model_overrides[agent];
            break;
          }
          const bulk = value.match(/^@([a-z-]+)=(.+)$/);
          if (bulk) {
            const [, role, model] = bulk;
            if (!ROLE_GROUPS[role]) {
              stdout.write(`Rol inválido. Opciones: ${Object.keys(ROLE_GROUPS).join(", ")}\n`);
              continue;
            }
            if (!validateModelId(model)) {
              stdout.write("ID inválido; usa proveedor/modelo.\n");
              continue;
            }
            const members = roleAgents(matrix, role);
            for (const member of members) matrix[profile][member] = model;
            skipAgents = new Set([...skipAgents, ...members]);
            stdout.write(`${members.length} agentes de ${role} actualizados en ${profile}.\n`);
            break;
          }
          if (!validateModelId(value)) {
            stdout.write("ID inválido; usa proveedor/modelo (ej. opencode-go/mimo-v2.6-pro).\n");
            continue;
          }
          matrix[profile][agent] = value;
          break;
        }
      }
      if (finishAll || skipAgents.size === Object.keys(matrix[profile]).length) break;
    }
    if (finishAll) break;
  }
  return matrix;
}

function persist(home, defaults, matrix) {
  const before = mergeOverlay(defaults, loadOverlay(home));
  const changed = changedCells(before, matrix);
  stdout.write(`\n${changed.length} celdas cambiadas desde la configuración guardada.\n`);
  for (const item of changed.slice(0, 12)) {
    stdout.write(`  ${item.profile}/${item.agent}: ${item.from} → ${item.to}\n`);
  }
  if (changed.length > 12) stdout.write(`  … y ${changed.length - 12} más\n`);

  saveOverlay(home, defaults, matrix);
  stdout.write(`Matriz local guardada (sin modificar los perfiles del repo): ${overlayPath(home)}\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv);
    options.repo = locateRepo(options);
    const defaults = readProfiles(profileFileDir(options.repo));
    const overlay = loadOverlay(options.home);
    let matrix = mergeOverlay(defaults, overlay);

    if (options.list) {
      printMatrix(matrix);
      return 0;
    }
    if (options.exportModels) {
      fs.mkdirSync(path.dirname(options.exportModels), { recursive: true });
      fs.writeFileSync(
        options.exportModels,
        `${JSON.stringify({ version: 1, profiles: matrix }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      stdout.write(`Matriz completa exportada a ${options.exportModels}\n`);
      return 0;
    }
    if (options.applyOverlay) {
      if (!overlay) {
        stdout.write("No hay overlay local; se mantienen defaults.\n");
        return 0;
      }
      stdout.write("Overlay local cargado para `gsd-route`; perfiles base sin cambios.\n");
      return 0;
    }
    if (options.modelsFile) {
      matrix = mergeOverlay(defaults, readModelFile(options.modelsFile));
      persist(options.home, defaults, matrix);
      return 0;
    }
    if (options.profile || options.agent || options.role || options.model) {
      if (!PROFILE_NAMES.includes(options.profile)) throw new Error("--profile debe ser easy, medium o hard");
      if (!options.model || !validateModelId(options.model)) throw new Error("--model requiere un ID proveedor/modelo válido");
      if (Boolean(options.agent) === Boolean(options.role)) throw new Error("indica exactamente uno de --agent o --role");
      const targets = options.agent ? [options.agent] : roleAgents(matrix, options.role);
      if (targets.length === 0) throw new Error(`sin agentes para ${options.role}`);
      for (const agent of targets) {
        if (!Object.hasOwn(matrix[options.profile], agent)) throw new Error(`agente desconocido en ${options.profile}: ${agent}`);
        matrix[options.profile][agent] = options.model;
      }
      persist(options.home, defaults, matrix);
      return 0;
    }

    if (!stdin.isTTY) {
      if (overlay) {
        stdout.write("Overlay local disponible para `gsd-route`; sin TTY se omitió el asistente.\n");
        return 0;
      }
      stdout.write("Sin TTY ni overlay: se mantienen defaults (usa --models-file para elegir en modo automatizado).\n");
      return 0;
    }
    if (overlay) stdout.write("Se parte de tus elecciones guardadas; Enter mantiene cada celda.\n");
    const savedMatrix = structuredClone(matrix);
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      matrix = await editMatrix(matrix, defaults, rl);
      const changed = changedCells(savedMatrix, matrix);
      stdout.write(`\n${changed.length} celdas cambiadas. Guardar y continuar instalación? [S/n] `);
      const answer = (await rl.question("")).trim().toLowerCase();
      if (["n", "no"].includes(answer)) {
        stdout.write("Cambios descartados; no se modificaron archivos.\n");
        return 0;
      }
    } finally {
      rl.close();
    }
    persist(options.home, defaults, matrix);
    return 0;
  } catch (error) {
    process.stderr.write(`gsd-model-pick: ${error.message}\n`);
    return EXIT_USAGE;
  }
}

process.exitCode = await main();
