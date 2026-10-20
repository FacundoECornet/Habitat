import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "tools", "install.mjs");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-path-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function install(home) {
  return spawnSync(
    process.execPath,
    [installer, "--home", home, "--repo", root, "--skip-plugins", "--skip-restore", "--skip-verify"],
    { encoding: "utf8" },
  );
}

// The payload ships no shell file (a snapshot of somebody's .bashrc is
// personal), so the installer is the one that puts ~/bin on PATH. On POSIX it
// appends one guarded block; it must be idempotent.
test("the installer adds ~/bin to PATH without touching the rest of .bashrc", (t) => {
  if (process.platform === "win32") {
    t.skip("en Windows el PATH se actualiza en el registro de usuario");
    return;
  }
  const home = tempHome(t);
  const rc = path.join(home, ".bashrc");
  const original = "# mi shell\nexport FOO=bar\n";
  fs.writeFileSync(rc, original);

  const first = install(home);
  assert.equal(first.status, 0, `install falló:\n${first.stdout}\n${first.stderr}`);

  const after = fs.readFileSync(rc, "utf8");
  assert.ok(after.startsWith(original), "no debe reescribir el .bashrc del usuario");
  assert.ok(after.includes('export PATH="$HOME/bin:$PATH"'), "debe agregar ~/bin al PATH");
  assert.equal(after.match(/Added by Habitat/g).length, 1, "un solo bloque");

  const second = install(home);
  assert.equal(second.status, 0);
  const afterTwice = fs.readFileSync(rc, "utf8");
  assert.equal(
    afterTwice.match(/Added by Habitat/g).length,
    1,
    "una segunda instalación no debe duplicar el bloque",
  );
});
