#!/usr/bin/env node
// gsd-route — deterministic difficulty-profile router (Node replacement for route.sh).
//
// Usage: node route.mjs <easy|medium|hard> [--project-root <dir>] [--no-global-sync]
//
// Writes model_overrides + difficulty_profile/difficulty_source/difficulty_confidence
// into <project>/.planning/config.json (atomic) and, only when the project does not
// already declare difficulty_profile, syncs ~/.gsd/router.json model_overrides.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyProfileOverlay } from "../lib/model-pick.mjs";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NO_CHANGE = 2;

const PROFILES = ["easy", "medium", "hard"];

function fail(message) {
  process.stderr.write(`gsd-route: ${message}\n`);
  process.exit(EXIT_USAGE);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let profile = null;
  let projectRoot = null;
  let globalSync = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-global-sync") {
      globalSync = false;
    } else if (arg === "--project-root") {
      i++;
      projectRoot = args[i];
      if (!projectRoot) fail("--project-root requiere un valor");
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "Uso: gsd-route {easy|medium|hard} [--project-root <dir>] [--no-global-sync]\n",
      );
      process.exit(EXIT_OK);
    } else if (!profile && PROFILES.includes(arg)) {
      profile = arg;
    } else {
      fail(`argumento desconocido o perfil inválido: ${arg}`);
    }
  }

  if (!profile) {
    process.stdout.write("Uso: gsd-route {easy|medium|hard}\n");
    process.exit(EXIT_USAGE);
  }
  return { profile, projectRoot, globalSync };
}

function readJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    fail(`no existe ${filePath} (${label})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${filePath} no es JSON válido: ${error.message}`);
  }
  return null;
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, filePath);
}

function parseConfidence(rawValue) {
  if (rawValue === undefined || rawValue === "") return null;
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    fail(`JEV_CONFIDENCE no es una confianza numérica válida en [0,1]: ${rawValue}`);
  }
  return numeric;
}

function main() {
  const { profile, projectRoot, globalSync } = parseArgs(process.argv);
  const root = path.resolve(projectRoot ?? process.cwd());
  const configPath = path.join(root, ".planning", "config.json");

  if (!fs.existsSync(configPath)) {
    fail(
      `no existe ${path.join(".planning", "config.json")}\nEjecutá gsd-route desde un proyecto GSD (raíz: ${root}).`,
    );
  }

  const config = readJson(configPath, "config del proyecto");
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    fail(`${configPath} debe contener un objeto JSON`);
  }

  const profileDir =
    process.env.GSD_ROUTER_DIR ?? path.join(os.homedir(), ".config", "opencode", "gsd-router");
  const profilePath = path.join(profileDir, `${profile}.json`);
  const profileFile = readJson(profilePath, "perfil");
  if (typeof profileFile?.model_overrides !== "object" || profileFile.model_overrides === null) {
    fail(`${profilePath} no declara model_overrides`);
  }
  let localOverlay = null;
  const overlayPath = path.join(profileDir, "picks.local");
  if (fs.existsSync(overlayPath)) {
    try {
      localOverlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
    } catch (error) {
      fail(`${overlayPath} no es JSON válido: ${error.message}`);
    }
    if (!localOverlay || typeof localOverlay !== "object" || Array.isArray(localOverlay)) {
      fail(`${overlayPath} debe contener un objeto JSON de overlay`);
    }
  }
  let effectiveProfile;
  try {
    effectiveProfile = applyProfileOverlay(profileFile, profile, localOverlay);
  } catch (error) {
    fail(`overlay local de modelos inválido (${overlayPath}): ${error.message}`);
  }

  const declaredBefore =
    typeof config.difficulty_profile === "string" && config.difficulty_profile.length > 0;
  const confidence = parseConfidence(process.env.JEV_CONFIDENCE);

  const next = {
    ...config,
    model_overrides: { ...effectiveProfile.model_overrides },
    difficulty_profile: profileFile.name ?? profile,
    difficulty_source: process.env.JEV_PROFILE_SOURCE ?? "manual",
  };
  if (confidence !== null) next.difficulty_confidence = confidence;

  writeJsonAtomic(configPath, next);

  if (globalSync && !declaredBefore) {
    const globalDir = process.env.GSD_GLOBAL_DIR ?? path.join(os.homedir(), ".gsd");
    const routerPath = path.join(globalDir, "router.json");
    try {
      fs.mkdirSync(path.dirname(routerPath), { recursive: true });
      const existing = fs.existsSync(routerPath) ? readJson(routerPath, "router global") : {};
      const base =
        typeof existing === "object" && existing !== null && !Array.isArray(existing)
          ? existing
          : {};
      writeJsonAtomic(routerPath, {
        ...base,
        model_overrides: { ...effectiveProfile.model_overrides },
      });
    } catch (error) {
      process.stderr.write(`warn: no se pudo sincronizar router global: ${error.message}\n`);
    }
  } else if (!globalSync || declaredBefore) {
    process.stderr.write(
      "nota: ~/.gsd/router.json no se sincroniza (proyecto declara difficulty_profile o --no-global-sync)\n",
    );
  }

  process.stdout.write(`Ruta GSD activa: ${next.difficulty_profile}\n`);
  for (const [agent, model] of Object.entries(next.model_overrides)) {
    process.stdout.write(`  ${agent}: ${model}\n`);
  }
  process.exit(EXIT_OK);
}

main();
