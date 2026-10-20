// tests/capture-bash.test.mjs — suite de comportamiento de scripts/capture.sh.
//
// La captura relee el entorno vivo y publica el payload. Es el otro proceso
// del producto y no tenia ninguna prueba, asi que un cambio suyo podia
// copiar de mas, pisar el payload o publicar un secreto sin que nadie lo
// viera.
//
// Cada caso corre contra un repositorio fixture (copias de scripts/ y lib/,
// manifiesto derivado del real) y un HOME fixture, de modo que ni el
// $HOME real ni el repositorio real se tocan.
//
// La captura necesita Bash, Git, Node y rsync: en Windows se omite (rsync no
// existe ahi) y en cualquier plataforma sin rsync tambien.
//
// Los valores sensibles de prueba se arman en runtime: el detector de
// secretos y el de rutas no deben encontrar en el source del test lo que
// buscan.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function has(tool) {
  return spawnSync("bash", ["-c", `command -v ${tool} >/dev/null 2>&1`]).status === 0;
}

const SKIP_REASON = !has("rsync")
  ? "capture necesita rsync (no disponible en esta plataforma)"
  : process.platform === "win32"
    ? "capture es una herramienta POSIX (Bash + rsync)"
    : false;

const POSIX_ONLY = { skip: SKIP_REASON };

// "/home/<login>/..." armado en runtime: el scanner de rutas no debe
// coincidir con su propio source.
const FOREIGN_PATH = ["/", "home", "alguien", "proyecto"].join("/");
// "apikey_" + cuerpo de 20 caracteres: la regla del detector de secretos.
const FAKE_SECRET = ["apikey", "A".repeat(20)].join("_");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Hash determinista de un arbol: rutas relativas + bytes + bit ejecutable.
// No mira mtimes, para que dos capturas iguales den el mismo hash.
function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        const exec = (fs.statSync(full).mode & 0o111) !== 0 ? "x" : "-";
        hash.update(`${rel}\0${exec}\0${fs.readFileSync(full).toString("base64")}\0`);
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

// Repo fixture + HOME fixture. El manifiesto se deriva del real para que
// pase la validacion de Bash y las excludes sean las de verdad.
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-capture-"));
  t.after(() => {
    // Un caso deja una origen sin permiso de lectura: hay que devolverlo
    // antes de borrar, o el tree no se puede traversed.
    spawnSync("chmod", ["-R", "u+rwX", base]);
    fs.rmSync(base, { recursive: true, force: true });
  });

  const repo = path.join(base, "repo");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
  for (const name of ["capture.sh", "validate-manifest.sh", "check-path-leaks.sh"]) {
    fs.cpSync(path.join(root, "scripts", name), path.join(repo, "scripts", name));
  }
  for (const name of ["manifest.sh", "secret-scan.sh"]) {
    fs.cpSync(path.join(root, "lib", name), path.join(repo, "lib", name));
  }

  git(repo, ["init", "-q", "."]);
  git(repo, ["config", "user.email", "test@habitat.invalid"]);
  git(repo, ["config", "user.name", "test"]);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "MANIFEST.json"), "utf8"));
  manifest.generated = "2026-01-01T00:00:00Z";
  for (const entry of manifest.entries) entry.post_steps = [];
  write(path.join(repo, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Payload publicado (desactualizado a proposito: el primer dry-run debe ver drift).
  write(path.join(repo, "home", ".config", "opencode", "opencode.jsonc"), "payload viejo\n");
  write(path.join(repo, "home", ".gsd", "router.json"), "router viejo\n");

  // HOME fixture: las cuatro origenes del manifiesto.
  write(path.join(home, ".config", "opencode", "opencode.jsonc"), "config de prueba\n");
  write(path.join(home, ".config", "opencode", "agents", "agent-a.md"), "agente\n");
  write(path.join(home, ".config", "opencode", "node_modules", "pkg", "index.js"), "node_modules\n");
  write(path.join(home, ".config", "opencode", "notes.bak"), "backup viejo\n");
  write(path.join(home, ".config", "opencode", "picks.local"), "elección local\n");
  write(path.join(home, ".claude", "skills", "skill-a", "SKILL.md"), "skill\n");
  write(path.join(home, ".agents", "skills", "skill-b", "SKILL.md"), "skill\n");
  write(path.join(home, ".gsd", "router.json"), "router nuevo\n");
  // Fuera de toda raiz del manifiesto: no debe capturarse nunca.
  write(path.join(home, "documentos", "privado.txt"), "privado\n");

  return { base, repo, home };
}

function capture(fx, args = []) {
  const result = spawnSync("bash", [path.join(fx.repo, "scripts", "capture.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: fx.home },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Lineas de accounting por entrada: "added=.. changed=.. removed=.. delta=.."
function accounting(stdout) {
  return stdout
    .split("\n")
    .map((line) => /added=(\d+) changed=(\d+) removed=(\d+) delta=(-?\d+)/.exec(line))
    .filter(Boolean)
    .map((m) => ({
      added: Number(m[1]),
      changed: Number(m[2]),
      removed: Number(m[3]),
      delta: Number(m[4]),
    }));
}

// C1 — el dry-run no escribe nada.
test("capture --dry-run no escribe nada", POSIX_ONLY, (t) => {
  const fx = fixture(t);
  const before = treeHash(path.join(fx.repo, "home"));

  const result = capture(fx, ["--dry-run"]);
  assert.equal(result.status, 1, `con drift el dry-run devuelve 1: ${result.stderr}`);
  assert.match(result.stdout, /DRIFT: detected/);
  assert.equal(treeHash(path.join(fx.repo, "home")), before, "el payload no se toca");
  assert.equal(
    fs.readdirSync(path.join(fx.repo, ".git")).some((name) => name.startsWith(".habitat-capture.")),
    false,
    "no queda basura del workspace temporal",
  );
});

// C2 — sobre un payload ya capturado, el dry-run no ve drift.
test("capture --dry-run no ve drift sobre un payload recien capturado", POSIX_ONLY, (t) => {
  const fx = fixture(t);
  const first = capture(fx);
  assert.equal(first.status, 0, `la captura debe salir en 0: ${first.stderr}`);

  const second = capture(fx, ["--dry-run"]);
  const counters = accounting(second.stdout);
  assert.ok(counters.length > 0, "el dry-run reporta las entradas");
  const clean = counters.every((c) => c.added === 0 && c.changed === 0 && c.removed === 0);
  assert.ok(
    clean,
    `el accounting debe estar en cero: ${JSON.stringify(counters)}\n${second.stdout}`,
  );
  assert.equal(
    second.status,
    0,
    `el dry-run debe converger: ${second.stdout}\n${second.stderr}\n` +
      (clean
        ? "phantom drift: rsync itemizo cambios sobre un arbol convergente (bug del motor)"
        : ""),
  );
  assert.match(second.stdout, /DRIFT: none/);
});

// C3 — la copia publica exactamente las rutas del manifiesto.
test("capture publica exactamente las rutas del manifiesto", POSIX_ONLY, (t) => {
  const fx = fixture(t);
  const result = capture(fx);
  assert.equal(result.status, 0, result.stderr);

  const published = path.join(fx.repo, "home");
  assert.equal(
    fs.readFileSync(path.join(published, ".config", "opencode", "opencode.jsonc"), "utf8"),
    "config de prueba\n",
  );
  assert.equal(
    fs.readFileSync(path.join(published, ".config", "opencode", "agents", "agent-a.md"), "utf8"),
    "agente\n",
  );
  assert.equal(
    fs.readFileSync(path.join(published, ".claude", "skills", "skill-a", "SKILL.md"), "utf8"),
    "skill\n",
  );
  assert.equal(
    fs.readFileSync(path.join(published, ".agents", "skills", "skill-b", "SKILL.md"), "utf8"),
    "skill\n",
  );
  assert.equal(fs.readFileSync(path.join(published, ".gsd", "router.json"), "utf8"), "router nuevo\n");

  const config = path.join(published, ".config", "opencode");
  assert.equal(fs.existsSync(path.join(config, "node_modules")), false, "node_modules/ se excluye");
  assert.equal(fs.existsSync(path.join(config, "notes.bak")), false, "*.bak* se excluye");
  assert.equal(fs.existsSync(path.join(config, "picks.local")), false, "*.local se excluye");
  assert.equal(
    fs.existsSync(path.join(published, "documentos", "privado.txt")),
    false,
    "una ruta fuera del manifiesto no se captura",
  );
});

// C4 — origen ausente: rechazo fail-closed, sin copia parcial.
test("capture falla cerrado si falta una origen", POSIX_ONLY, (t) => {
  const fx = fixture(t);
  const before = treeHash(path.join(fx.repo, "home"));
  fs.rmSync(path.join(fx.home, ".gsd"), { recursive: true, force: true });

  const result = capture(fx);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /capture: origin-missing \(\.gsd\)/);
  assert.equal(treeHash(path.join(fx.repo, "home")), before, "no hay copia parcial");
});

// C5 — origen ilegible: rechazo fail-closed.
test("capture falla cerrado si una origen no se puede leer", POSIX_ONLY, (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("como root los permisos de lectura no bloquean");
    return;
  }
  const fx = fixture(t);
  const before = treeHash(path.join(fx.repo, "home"));
  const dir = path.join(fx.home, ".gsd");
  fs.chmodSync(dir, 0o000);
  t.after(() => {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      /* best-effort */
    }
  });

  const result = capture(fx);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /capture: origin-unreadable \(\.gsd\)/);
  assert.equal(treeHash(path.join(fx.repo, "home")), before, "no hay copia parcial");
});

// C6 — la captura es idempotente.
test("capture es idempotente: la segunda corrida no cambia el payload", POSIX_ONLY, (t) => {
  const fx = fixture(t);
  const first = capture(fx);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = treeHash(path.join(fx.repo, "home"));

  const second = capture(fx);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(treeHash(path.join(fx.repo, "home")), afterFirst, "el payload queda igual");
});

// C7 — un secreto en la origen bloquea la promoción y deja el payload intacto.
test("capture bloquea la promoción si el origen tiene un secreto", POSIX_ONLY, (t) => {
  const fx = fixture(t);
  const before = treeHash(path.join(fx.repo, "home"));
  write(path.join(fx.home, ".config", "opencode", "secreto.txt"), `token: ${FAKE_SECRET}\n`);

  const result = capture(fx);
  assert.equal(result.status, 1, `un secreto bloquea: ${result.stderr}`);
  assert.match(result.stderr, /pre-scan-blocked/);
  assert.match(result.stderr, /rule=apikey-marker/);
  assert.equal(treeHash(path.join(fx.repo, "home")), before, "el payload queda intacto");
  assert.equal(
    fs.existsSync(path.join(fx.repo, "home", ".config", "opencode", "secreto.txt")),
    false,
    "el secreto no se publica",
  );
});

// C8 — una ruta de maquina en la origen bloquea la promoción.
test("capture bloquea la promoción si el origen tiene una ruta de maquina", POSIX_ONLY, (t) => {
  const fx = fixture(t);
  const before = treeHash(path.join(fx.repo, "home"));
  write(path.join(fx.home, ".config", "opencode", "notas.txt"), `proyecto en ${FOREIGN_PATH}/app\n`);

  const result = capture(fx);
  assert.equal(result.status, 1, `una ruta de maquina bloquea: ${result.stderr}`);
  assert.match(result.stderr, /pre-scan-blocked/);
  assert.match(result.stderr, /rule=home-absolute-path/);
  assert.equal(treeHash(path.join(fx.repo, "home")), before, "el payload queda intacto");
});

// C9 — la captura publica el payload y nada mas: no stagea ni commitea.
test("capture no stagea ni commitea nada", POSIX_ONLY, (t) => {
  const fx = fixture(t);
  const result = capture(fx);
  assert.equal(result.status, 0, result.stderr);

  const staged = git(fx.repo, ["diff", "--cached", "--name-only"]);
  assert.equal(staged.stdout.trim(), "", "no hay nada stageado");
  const commits = git(fx.repo, ["log", "--oneline"]);
  assert.equal(commits.stdout.trim(), "", "no hay commits nuevos");
  const status = git(fx.repo, ["status", "--porcelain"]);
  assert.match(status.stdout, /home\//, "el payload aparece como cambio sin stagear");
});
