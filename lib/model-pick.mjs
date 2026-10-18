// Pure model-profile helpers plus safe local persistence for F-14.
import fs from "node:fs";
import path from "node:path";

export const PROFILE_NAMES = ["easy", "medium", "hard"];

// Display groups only. The groups never imply a model assignment.
export const ROLE_GROUPS = {
  planner: [
    "gsd-planner",
    "gsd-roadmapper",
    "gsd-phase-researcher",
    "gsd-project-researcher",
    "gsd-research-synthesizer",
    "gsd-framework-selector",
    "gsd-eval-planner",
    "gsd-advisor-researcher",
    "gsd-ai-researcher",
    "gsd-domain-researcher",
    "gsd-assumptions-analyzer",
    "gsd-user-profiler",
  ],
  writer: [
    "gsd-doc-writer",
    "gsd-doc-classifier",
    "gsd-doc-synthesizer",
    "gsd-codebase-mapper",
    "gsd-pattern-mapper",
    "gsd-intel-updater",
    "gsd-ui-researcher",
  ],
  executor: ["gsd-executor", "gsd-debugger", "gsd-debug-session-manager", "gsd-code-fixer"],
  checker: [
    "gsd-verifier",
    "gsd-code-reviewer",
    "gsd-plan-checker",
    "gsd-security-auditor",
    "gsd-ui-auditor",
    "gsd-ui-checker",
    "gsd-nyquist-auditor",
    "gsd-eval-auditor",
    "gsd-integration-checker",
    "gsd-doc-verifier",
  ],
};

const MODEL_ID = /^[^/\\\s]+\/[^/\\\s]+$/;
const OVERLAY_NAME = "picks.local";

function assertProfileName(profile) {
  if (!PROFILE_NAMES.includes(profile)) throw new Error(`perfil desconocido: ${profile}`);
}

export function validateModelId(value) {
  return typeof value === "string" && MODEL_ID.test(value);
}

export function readProfiles(routerDir) {
  const profiles = {};
  for (const profile of PROFILE_NAMES) {
    const file = path.join(routerDir, `${profile}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      parsed.name !== profile ||
      !parsed.model_overrides ||
      typeof parsed.model_overrides !== "object" ||
      Array.isArray(parsed.model_overrides)
    ) {
      throw new Error(`${file}: formato de perfil inválido`);
    }
    for (const [agent, model] of Object.entries(parsed.model_overrides)) {
      if (!validateModelId(model)) throw new Error(`${file}: model id inválido para ${agent}: ${model}`);
    }
    profiles[profile] = parsed;
  }
  return profiles;
}

export function matrixFromProfiles(profiles) {
  return Object.fromEntries(PROFILE_NAMES.map((profile) => [profile, { ...profiles[profile].model_overrides }]));
}

function overlayProfiles(overlay) {
  if (overlay == null) return {};
  if (overlay.version !== 1 || !overlay.profiles || Array.isArray(overlay.profiles)) {
    throw new Error("overlay de modelos inválido: se esperaba version 1 y profiles");
  }
  for (const [profile, changes] of Object.entries(overlay.profiles)) {
    assertProfileName(profile);
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      throw new Error(`overlay inválido en perfil ${profile}`);
    }
  }
  return overlay.profiles;
}

export function mergeOverlay(defaultProfiles, overlay) {
  const matrix = matrixFromProfiles(defaultProfiles);
  const changesByProfile = overlayProfiles(overlay);
  for (const [profile, changes] of Object.entries(changesByProfile)) {
    for (const [agent, model] of Object.entries(changes)) {
      if (!Object.hasOwn(matrix[profile], agent)) throw new Error(`agente desconocido en ${profile}: ${agent}`);
      if (!validateModelId(model)) throw new Error(`model id inválido para ${profile}/${agent}: ${model}`);
      matrix[profile][agent] = model;
    }
  }
  return matrix;
}

export function applyProfileOverlay(profileDoc, profile, overlay) {
  assertProfileName(profile);
  const base = profileDoc?.model_overrides;
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    throw new Error(`perfil ${profile} no declara model_overrides`);
  }
  const changes = overlayProfiles(overlay)[profile] ?? {};
  const modelOverrides = { ...base };
  for (const [agent, model] of Object.entries(changes)) {
    if (!Object.hasOwn(modelOverrides, agent)) throw new Error(`agente desconocido en ${profile}: ${agent}`);
    if (!validateModelId(model)) throw new Error(`model id inválido para ${profile}/${agent}: ${model}`);
    modelOverrides[agent] = model;
  }
  return { ...profileDoc, name: profileDoc.name ?? profile, model_overrides: modelOverrides };
}

export function overlayFromMatrix(defaultProfiles, matrix) {
  const profiles = {};
  for (const profile of PROFILE_NAMES) {
    assertProfileName(profile);
    const defaults = defaultProfiles[profile]?.model_overrides;
    if (!defaults || !matrix[profile] || Array.isArray(matrix[profile])) {
      throw new Error(`falta matriz o defaults para ${profile}`);
    }
    if (Object.keys(defaults).length !== Object.keys(matrix[profile]).length) {
      throw new Error(`matriz incompleta o con agentes extra en ${profile}`);
    }
    const changes = {};
    for (const [agent, model] of Object.entries(matrix[profile])) {
      if (!Object.hasOwn(defaults, agent)) throw new Error(`agente desconocido en ${profile}: ${agent}`);
      if (!validateModelId(model)) throw new Error(`model id inválido para ${profile}/${agent}: ${model}`);
      if (model !== defaults[agent]) changes[agent] = model;
    }
    profiles[profile] = changes;
  }
  return { version: 1, profiles };
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${String(now.getMilliseconds()).padStart(3, "0")}`;
}

function backupExisting(filePath, home) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`se rehúsa reemplazar destino no regular: ${filePath}`);
  const backupDir = path.join(home, ".habitat", "backups", timestamp());
  fs.mkdirSync(backupDir, { recursive: true });
  let backupPath = path.join(backupDir, path.basename(filePath));
  let suffix = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = path.join(backupDir, `${path.basename(filePath)}.${suffix++}`);
  }
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
}

function atomicWrite(filePath, contents, home) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    if (fs.readFileSync(filePath, "utf8") === contents) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  backupExisting(filePath, home);
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, filePath);
    return true;
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

export function overlayPath(home) {
  return path.join(home, ".config", "opencode", "gsd-router", OVERLAY_NAME);
}

export function repoPointerPath(home) {
  return path.join(home, ".habitat", "repo-root");
}

export function loadOverlay(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(overlayPath(home), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("overlay de modelos inválido: se esperaba un objeto JSON");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function saveOverlay(home, defaultProfiles, matrix) {
  const overlay = overlayFromMatrix(defaultProfiles, matrix);
  atomicWrite(overlayPath(home), `${JSON.stringify(overlay, null, 2)}\n`, home);
  return overlay;
}

export function readModelFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || parsed.version !== 1 || !parsed.profiles || Array.isArray(parsed.profiles)) {
    throw new Error("archivo de modelos inválido: se esperaba {version:1, profiles:{...}}");
  }
  return parsed;
}
