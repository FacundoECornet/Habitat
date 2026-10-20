// tests/restore-engine.test.mjs — suite de comportamiento del motor de restore.
//
// El motor resuelve el repositorio desde su propia ubicación (repoRoot) y el
// destino desde $HOME, así que cada caso corre contra un repositorio fixture:
// una copia de tools/restore.mjs más lib/, un manifiesto derivado del real (sin
// post-steps, para que ningún caso necesite red) y un payload mínimo. El home
// fixture es un directorio temporal: el $HOME real nunca se lee ni se escribe.
//
// Los nombres de archivo de los backups llevan timestamp, así que se validan
// por forma (regex) y no por valor.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BACKUP_RE = /\.backup-\d{8}-\d{6}$/;
const PLACEHOLDER = "__HABITAT_HOME__";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out.sort();
}

// Repo fixture + home fixture. El manifiesto se deriva del real para que
// satisfies las dos validaciones (Node y Bash) y los excludes reales.
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-restore-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const repo = path.join(base, "repo");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(repo, "tools"), { recursive: true });
  fs.cpSync(path.join(root, "tools", "restore.mjs"), path.join(repo, "tools", "restore.mjs"));
  fs.cpSync(path.join(root, "lib"), path.join(repo, "lib"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const manifest = JSON.parse(read(path.join(root, "MANIFEST.json")));
  manifest.generated = "2026-01-01T00:00:00Z";
  for (const entry of manifest.entries) entry.post_steps = [];
  write(path.join(repo, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

  const payload = path.join(repo, "home");
  write(path.join(payload, ".config", "opencode", "opencode.jsonc"), "config de prueba\n");
  write(path.join(payload, ".config", "opencode", "agents", "agent-a.md"), "agente\n");
  write(path.join(payload, ".config", "opencode", "node_modules", "pkg", "index.js"), "node_modules\n");
  write(path.join(payload, ".config", "opencode", "jev.env"), "SECRET=valor\n");
  write(path.join(payload, ".config", "opencode", "notes.bak"), "backup viejo\n");
  write(path.join(payload, ".config", "opencode", "picks.local"), "elección local\n");
  write(path.join(payload, ".claude", "skills", "skill-a", "SKILL.md"), "skill\n");
  write(path.join(payload, ".agents", "skills", "skill-b", "SKILL.md"), "skill\n");
  write(path.join(payload, ".gsd", "router.json"), `{"home":"${PLACEHOLDER}/code"}\n`);
  write(path.join(payload, "fuera-del-manifiesto.txt"), "no permitido\n");

  return { base, repo, home, payload };
}

function run(fx, args = []) {
  const result = spawnSync(process.execPath, [path.join(fx.repo, "tools", "restore.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: fx.home },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function backupsIn(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => BACKUP_RE.test(name));
  } catch {
    return [];
  }
}

// R1 — copia exactamente las rutas del manifiesto y nada más.
test("restore copia exactamente las rutas del manifiesto", (t) => {
  const fx = fixture(t);
  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restore: complete/);
  assert.equal(read(path.join(fx.home, ".config", "opencode", "opencode.jsonc")), "config de prueba\n");
  assert.equal(read(path.join(fx.home, ".config", "opencode", "agents", "agent-a.md")), "agente\n");
  assert.equal(read(path.join(fx.home, ".claude", "skills", "skill-a", "SKILL.md")), "skill\n");
  assert.equal(read(path.join(fx.home, ".agents", "skills", "skill-b", "SKILL.md")), "skill\n");
  assert.equal(
    read(path.join(fx.home, ".gsd", "router.json")),
    `{"home":"${fx.home.replace(/\\/g, "/")}/code"}\n`,
    "el payload llega expandido con el home de destino",
  );
  assert.equal(
    fs.existsSync(path.join(fx.home, "fuera-del-manifiesto.txt")),
    false,
    "un archivo fuera del manifiesto no se copia",
  );
});

// R2 — los excludes del manifiesto se respetan.
test("restore respeta los excludes del manifiesto", (t) => {
  const fx = fixture(t);
  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
  const config = path.join(fx.home, ".config", "opencode");
  assert.equal(fs.existsSync(path.join(config, "node_modules")), false, "node_modules/ se excluye");
  assert.equal(fs.existsSync(path.join(config, "jev.env")), false, "jev.env se excluye");
  assert.equal(fs.existsSync(path.join(config, "notes.bak")), false, "*.bak* se excluye");
  assert.equal(fs.existsSync(path.join(config, "picks.local")), false, "*.local se excluye");
});

// R3 — backup antes de sobrescribir.
test("restore respalda el archivo que va a sobrescribir", (t) => {
  const fx = fixture(t);
  const target = path.join(fx.home, ".config", "opencode", "opencode.jsonc");
  write(target, "contenido viejo\n");

  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restore: backup \(/);

  const backups = backupsIn(path.dirname(target));
  assert.equal(backups.length, 1, "debe quedar exactamente un backup");
  assert.equal(read(path.join(path.dirname(target), backups[0])), "contenido viejo\n");
  assert.equal(read(target), "config de prueba\n", "el destino recibe el payload");
});

// R4 — la segunda corrida es idempotente.
test("restore es idempotente: la segunda corrida no cambia nada", (t) => {
  const fx = fixture(t);
  const target = path.join(fx.home, ".config", "opencode", "opencode.jsonc");
  write(target, "contenido viejo\n");

  const first = run(fx);
  assert.equal(first.status, 0, first.stderr);
  const backupsAfterFirst = backupsIn(path.dirname(target)).length;

  const second = run(fx);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /up-to-date/);
  assert.match(second.stdout, /total added=0 changed=0/);
  assert.match(second.stdout, /backups=0/);
  assert.equal(backupsIn(path.dirname(target)).length, backupsAfterFirst, "no hay backups nuevos");
});

// R5 — los archivos locales de la máquina no se pisan.
test("restore no pisa los archivos locales de la máquina", (t) => {
  const fx = fixture(t);
  const local = path.join(fx.home, ".config", "opencode", "picks.local");
  write(local, "elección local\n");

  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(local), "elección local\n", "el archivo local conserva su contenido");
  assert.match(result.stdout, /skipped machine-local/);
});

// R6 — el dry-run no escribe nada.
test("restore --dry-run no escribe nada", (t) => {
  const fx = fixture(t);
  const before = listFiles(fx.home);

  const result = run(fx, ["--dry-run"]);
  assert.equal(result.status, 1, "con drift el dry-run devuelve 1");
  assert.match(result.stdout, /restore: dry-run/);
  assert.match(result.stdout, /restore: drift \(action needed\)/);
  assert.deepEqual(listFiles(fx.home), before, "el home queda intacto");
  assert.equal(
    fs.existsSync(path.join(fx.home, ".habitat", "restore.log")),
    false,
    "el dry-run no escribe el log",
  );
});

// R7 — dry-run sobre un home ya restaurado: converge.
test("restore --dry-run converge sobre un home ya restaurado", (t) => {
  const fx = fixture(t);
  const first = run(fx);
  assert.equal(first.status, 0, first.stderr);

  const second = run(fx, ["--dry-run"]);
  assert.equal(second.status, 0, `dry-run debe converger: ${second.stdout}${second.stderr}`);
  assert.match(second.stdout, /restore: converged/);
});

// R8 — preflight fail-closed: un origen ausente aborta antes de escribir.
test("restore falla cerrado si falta una raíz del payload", (t) => {
  const fx = fixture(t);
  fs.rmSync(path.join(fx.payload, ".gsd"), { recursive: true, force: true });

  const result = run(fx);
  assert.equal(result.status, 2, "un origen ausente aborta con 2");
  assert.match(result.stderr, /restore: origin-missing \(home\/\.gsd\)/);
  assert.deepEqual(listFiles(fx.home), [], "no se escribe nada");
  assert.equal(fs.existsSync(path.join(fx.home, ".habitat")), false, "no se crea el log");
});

// R9 — el placeholder del home se expande al destino.
test("restore expande el placeholder del home en el payload", (t) => {
  const fx = fixture(t);
  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);

  const content = read(path.join(fx.home, ".gsd", "router.json"));
  assert.equal(content.includes(PLACEHOLDER), false, "el token no llega al destino");
  assert.match(content, new RegExp(fx.home.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// R10 — los huérfanos del destino no se borran.
test("restore no borra los archivos que no están en el payload", (t) => {
  const fx = fixture(t);
  const orphan = path.join(fx.home, ".config", "opencode", "orphan.txt");
  write(orphan, "huérfano\n");

  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(orphan), "huérfano\n", "el huérfano sigue ahí");
});

// R11 — sin post-steps en el manifiesto no se invoca npm.
test("restore no invoca npm cuando el manifiesto no lo pide", (t) => {
  const fx = fixture(t);
  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(/npm ci/.test(result.stdout), false, "no debe correr npm ci");
});

// R12 — la corrida queda registrada en el log.
test("restore deja la corrida registrada en el log", (t) => {
  const fx = fixture(t);
  const target = path.join(fx.home, ".config", "opencode", "opencode.jsonc");
  write(target, "contenido viejo\n");

  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);

  const log = read(path.join(fx.home, ".habitat", "restore.log"));
  assert.match(log, /backup /);
  assert.match(log, /complete added=/);
});

// R13 — los symlinks del payload no se siguen ni se copian.
test("restore no sigue los symlinks del payload", (t) => {
  const fx = fixture(t);
  const link = path.join(fx.payload, ".config", "opencode", "enlace");
  try {
    fs.symlinkSync(path.join(fx.payload, ".gsd", "router.json"), link);
  } catch (error) {
    t.skip(`no se puede crear un symlink aquí: ${error.code ?? error.message}`);
    return;
  }

  const result = run(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(link), true, "el symlink del payload sigue donde estaba");
  assert.equal(
    fs.existsSync(path.join(fx.home, ".config", "opencode", "enlace")),
    false,
    "el symlink no se copia al destino",
  );
});
