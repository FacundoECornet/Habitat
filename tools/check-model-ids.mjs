// tools/check-model-ids.mjs — comprueba que los IDs de modelo del payload
// sigan existiendo en el catálogo de OpenCode.
//
// Por qué existe: OpenCode retira IDs del catálogo con el tiempo. Cuando eso
// pasa, la instalación de todos los usuarios falla (no es solo un aviso) y
// el arreglo es manual. Este script convierte esa corrección manual en una
// alerta automática.
//
// Qué revisa, en el payload del repositorio:
// - los perfiles de GSD (home/.config/opencode/gsd-router/{easy,medium,hard}.json)
// - la configuración (home/.config/opencode/opencode.jsonc)
// - las definiciones de agente (home/.config/opencode/agents/*.md)
//
// Contrato de salida:
// - 0: todos los IDs verificables existen, o el catálogo no se pudo consultar
//     (sin credencial o sin red: nunca un rojo falso)
// - 1: hay IDs del namespace publico que ya no estan en el catálogo
// - 2: error de uso
//
// Uso:
// node tools/check-model-ids.mjs [--repo DIR] [--json]

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

// Un catálogo autenticado lista muchos mas modelos; uno mas corto (o sin el
// namespace `opencode-go/*`, que exige credencial) esta truncado, no invalido.
const MIN_FULL_CATALOG = 20;
const AUTH_NAMESPACE = "opencode-go/";

function parseArgs(argv) {
  const options = { repo: path.resolve(import.meta.dirname, ".."), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") options.repo = path.resolve(argv[++i] ?? "");
    else if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: check-model-ids.mjs [--repo DIR] [--json]\n");
      process.exit(EXIT_OK);
    } else {
      process.stderr.write(`check-model-ids: unknown-argument (${arg})\n`);
      process.exit(EXIT_USAGE);
    }
  }
  return options;
}

// --- fuentes de IDs ---------------------------------------------------------

function readJsonc(file) {
  // opencode.jsonc es JSON con comentarios: se quitan las lineas de comentario
  // antes de parsear. Los bloques de comentario no se usan en el payload.
  const raw = fs.readFileSync(file, "utf8");
  const withoutComments = raw
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("//")) return line;
      return line.slice(0, line.length - trimmed.length);
    })
    .join("\n");
  return JSON.parse(withoutComments);
}

function collectProfiles(repo) {
  const dir = path.join(repo, "home", ".config", "opencode", "gsd-router");
  const found = [];
  for (const profile of ["easy", "medium", "hard"]) {
    const file = path.join(dir, `${profile}.json`);
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const overrides = parsed.model_overrides ?? {};
    for (const [agent, model] of Object.entries(overrides)) {
      if (typeof model === "string" && model) found.push({ model, where: `perfil ${profile}: ${agent}` });
    }
  }
  return found;
}

function collectConfig(repo) {
  const file = path.join(repo, "home", ".config", "opencode", "opencode.jsonc");
  if (!fs.existsSync(file)) return [];
  const parsed = readJsonc(file);
  const found = [];
  const agents = parsed.agent ?? {};
  for (const [name, definition] of Object.entries(agents)) {
    const model = definition && typeof definition === "object" ? definition.model : undefined;
    if (typeof model === "string" && model) found.push({ model, where: `config: agente ${name}` });
  }
  const defaultModel = parsed.model;
  if (typeof defaultModel === "string" && defaultModel) {
    found.push({ model: defaultModel, where: "config: model por defecto" });
  }
  return found;
}

function collectAgentFiles(repo) {
  const dir = path.join(repo, "home", ".config", "opencode", "agents");
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    // Solo el frontmatter: la primera linea "---" hasta el cierre.
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!match) continue;
    const model = /^model:\s*(\S+)\s*$/m.exec(match[1]);
    if (model) found.push({ model: model[1], where: `agente: ${name}` });
  }
  return found;
}

// --- catalogo ---------------------------------------------------------------

function catalog() {
  const result = spawnSync("opencode", ["models"], { encoding: "utf8", timeout: 60000 });
  if (result.error || result.status !== 0) return null;
  const ids = new Set(
    (result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return ids;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const references = [...collectProfiles(options.repo), ...collectConfig(options.repo), ...collectAgentFiles(options.repo)];
  if (references.length === 0) {
    process.stderr.write("check-model-ids: no-seencontraron-ids (el payload no declara modelos)\n");
    process.exit(EXIT_OK);
  }

  const known = catalog();
  if (known === null || known.size === 0) {
    // Sin catalogo no hay veredicto: nunca un rojo falso por falta de red.
    const message = "check-model-ids: skip (no se pudo consultar `opencode models`)";
    if (options.json) process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: message }) + "\n");
    else process.stdout.write(message + "\n");
    process.exit(EXIT_OK);
  }

  // El catalogo esta completo solo cuando aparece el namespace autenticado:
  // sin credencial la lista es un subconjunto que todavia anuncia modelos que
  // OpenCode ya retiro, asi que un id ausente no prueba que este retirado.
  const hasAuthNamespace = [...known].some((id) => id.startsWith(AUTH_NAMESPACE));
  const namespaces = new Set([...known].map((id) => id.split("/")[0]));
  const limited = !hasAuthNamespace || known.size < MIN_FULL_CATALOG;

  const missing = [];
  const unverifiable = [];
  for (const { model, where } of references) {
    if (known.has(model)) continue;
    const namespace = model.includes("/") ? model.split("/")[0] : null;
    const invisible = namespace !== null && !namespaces.has(namespace);
    if (limited || invisible) unverifiable.push({ model, where });
    else missing.push({ model, where });
  }

  const summary = {
    ok: missing.length === 0,
    catalogSize: known.size,
    limited,
    checked: references.length,
    missing,
    unverifiable,
    hint:
      missing.length === 0
        ? ""
        : "Cambiá la celda con `gsd-model-pick --profile <perfil> --agent <agente> --model <id>` y actualizá el payload del repo en home/.config/opencode/gsd-router/.",
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(`catálogo: ${known.size} modelos${limited ? " (limitado: sin namespace autenticado)" : ""}\n`);
    process.stdout.write(`revisados: ${references.length} referencias\n`);
    if (unverifiable.length > 0) {
      process.stdout.write(`no verificables (requieren credencial): ${unverifiable.length}\n`);
    }
    for (const item of missing) {
      process.stdout.write(`RETIRADO: ${item.model} — ${item.where}\n`);
    }
    if (missing.length === 0) process.stdout.write("check-model-ids: ok\n");
    else {
      process.stdout.write(`check-model-ids: ${missing.length} id(s) fuera del catálogo\n`);
      process.stdout.write(`${summary.hint}\n`);
    }
  }

  process.exit(missing.length === 0 ? EXIT_OK : EXIT_FAILED);
}

main();
