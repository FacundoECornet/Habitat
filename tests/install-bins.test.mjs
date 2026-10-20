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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-install-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// The tools installed into ~/bin import their support modules as ../lib/<name>.
// If a module does not travel with them, the installed command dies with
// ERR_MODULE_NOT_FOUND the first time the user runs it.
test("installed binaries are self-contained", (t) => {
  const home = tempHome(t);

  const install = spawnSync(
    process.execPath,
    [installer, "--home", home, "--repo", root, "--skip-plugins", "--skip-restore", "--skip-verify"],
    { encoding: "utf8" },
  );
  assert.equal(install.status, 0, `install falló:\n${install.stdout}\n${install.stderr}`);

  const libDir = path.join(home, "lib");
  for (const name of fs.readdirSync(path.join(root, "lib")).filter((n) => n.endsWith(".mjs"))) {
    assert.ok(fs.existsSync(path.join(libDir, name)), `falta el módulo de soporte ${name}`);
  }

  const binDir = path.join(home, "bin");
  const commands = ["restore", "verify", "install", "gsd-route"];
  for (const command of commands) {
    const isWindows = process.platform === "win32";
    const candidate = isWindows ? path.join(binDir, `${command}.mjs`) : path.join(binDir, command);
    assert.ok(fs.existsSync(candidate), `falta el binario ${command}`);
    const probe = spawnSync(process.execPath, [candidate, "--help"], { encoding: "utf8" });
    assert.ok(
      !probe.stderr.includes("ERR_MODULE_NOT_FOUND"),
      `${command} no es autocontenido:\n${probe.stderr}`,
    );
  }
});
