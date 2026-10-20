// tests/path-leaks.test.mjs — suite del scanner de rutas absolutas.
//
// El scanner es la puerta que impide versionar una ruta de máquina. Corre en
// Bash, así que la suite solo corre en POSIX (Linux, macOS, WSL); en Windows
// se omite con un hint, igual que la suite de captura.
//
// La ruta filtrada de prueba se arma por concatenación en runtime: el propio
// scanner no debe encontrar en su source la ruta que busca.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(root, "scripts", "check-path-leaks.sh");

const POSIX_ONLY = { skip: process.platform === "win32" ? "el scanner es una herramienta POSIX (Bash)" : false };

// "/home/<login>/..." — armado en runtime para no coincidir con su propio detector.
const LEAK = ["/", "home", "alguien", "proyecto"].join("/");

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-pathleaks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "test@habitat.invalid"]);
  git(dir, ["config", "user.name", "test"]);
  return dir;
}

function write(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function scan(args) {
  const result = spawnSync("bash", [scanner, ...args], { encoding: "utf8" });
  const leaks = (result.stderr ?? "")
    .split("\n")
    .filter((line) => line.startsWith("LEAK: "));
  return { status: result.status, leaks, stderr: result.stderr ?? "" };
}

// Un repo limpio no bloquea.
test("path-leaks: un repo limpio pasa", POSIX_ONLY, (t) => {
  const dir = repo(t);
  write(dir, "limpio.txt", "nada sospechoso\n");
  git(dir, ["add", "-A"]);

  const result = scan([dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.leaks, []);
});

// Una ruta de máquina versionada bloquea y se reporta una sola vez: el scanner
// lee el blob del índice y también el archivo del worktree, y el mismo
// hallazgo no puede aparecer dos veces.
test("path-leaks: una ruta filtrada bloquea y se reporta una vez", POSIX_ONLY, (t) => {
  const dir = repo(t);
  write(dir, "fuga.txt", `proyecto en ${LEAK}/app\n`);
  git(dir, ["add", "-A"]);

  const result = scan([dir]);
  assert.equal(result.status, 1, "una ruta filtrada bloquea");
  assert.equal(result.leaks.length, 1, `un solo hallazgo: ${result.stderr}`);
  assert.match(result.leaks[0], /rule=home-absolute-path path=fuga\.txt line=1/);
});

// Dos archivos distintos con la misma regla y la misma línea se reportan los
// dos: la deduplicación nunca puede colapsar hallazgos de archivos distintos.
test("path-leaks: archivos distintos con la misma regla se reportan todos", POSIX_ONLY, (t) => {
  const dir = repo(t);
  write(dir, "a.txt", `proyecto en ${LEAK}/app\n`);
  write(dir, "b.txt", `proyecto en ${LEAK}/app\n`);
  git(dir, ["add", "-A"]);

  const result = scan([dir]);
  assert.equal(result.status, 1);
  const paths = result.leaks.map((line) => /path=([^ ]+)/.exec(line)?.[1]).sort();
  assert.deepEqual(paths, ["a.txt", "b.txt"], `cada archivo se reporta: ${result.stderr}`);
});

// Un archivo modificado en el worktree pero no en el índice también bloquea.
test("path-leaks: un archivo modificado sin stagear bloquea", POSIX_ONLY, (t) => {
  const dir = repo(t);
  write(dir, "a.txt", "limpio\n");
  git(dir, ["add", "-A"]);
  write(dir, "a.txt", `proyecto en ${LEAK}/app\n`);

  const result = scan([dir]);
  assert.equal(result.status, 1);
  assert.equal(result.leaks.length, 1, result.stderr);
});

// Un archivo sin trackear también entra en la revisión.
test("path-leaks: un archivo sin trackear bloquea", POSIX_ONLY, (t) => {
  const dir = repo(t);
  write(dir, "limpio.txt", "nada sospechoso\n");
  git(dir, ["add", "-A"]);
  write(dir, "nuevo.txt", `proyecto en ${LEAK}/app\n`);

  const result = scan([dir]);
  assert.equal(result.status, 1);
  assert.equal(result.leaks.length, 1, result.stderr);
  assert.match(result.leaks[0], /path=nuevo\.txt/);
});

// El modo árbol recorre los archivos físicos, incluidos los que Git ignora.
test("path-leaks: el modo árbol encuentra lo que Git ignora", POSIX_ONLY, (t) => {
  const dir = repo(t);
  write(dir, ".gitignore", "ignorado.txt\n");
  write(dir, "ignorado.txt", `proyecto en ${LEAK}/app\n`);
  git(dir, ["add", "-A"]);

  const inGit = scan([dir]);
  assert.equal(inGit.status, 0, "Git no lo ve: el archivo está ignorado");

  const inTree = scan(["--tree", dir]);
  assert.equal(inTree.status, 1, "el modo árbol sí lo encuentra");
  assert.equal(inTree.leaks.length, 1, inTree.stderr);
});

// El diagnóstico nunca imprime el texto que coincidió, solo regla, ruta y línea.
test("path-leaks: el diagnóstico no imprime el texto coincidente", POSIX_ONLY, (t) => {
  const dir = repo(t);
  write(dir, "fuga.txt", `proyecto en ${LEAK}/app\n`);
  git(dir, ["add", "-A"]);

  const result = scan([dir]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes(LEAK), false, "la ruta filtrada no se imprime");
  assert.match(result.stderr, /LEAK: rule=home-absolute-path path=fuga\.txt line=1/);
});
