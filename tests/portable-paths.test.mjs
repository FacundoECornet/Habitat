import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyTool = path.join(root, "tools", "verify.mjs");

// Foreign home roots, in the spellings the payload can carry. The check is
// cross-platform: the payload travels between machines, so a foreign home has
// to be detected no matter which platform runs the check.
//
// Every path is assembled from fragments, so this file does not contain the
// literal path its own detectors look for.
const FOREIGN_HOMES = {
  posix: ["", "home", "someone-else"].join("/"),
  windows: ["C:", "Users", "someone-else"].join("\\"),
  wsl: ["", "mnt", "c", "Users", "someone-else"].join("/"),
};

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-portable-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "opencode.jsonc"), "{}\n");
  return { home, configDir };
}

function runVerify(home) {
  const result = spawnSync(
    process.execPath,
    [verifyTool, "--home", home, "--repo", root, "--no-models", "--no-cli", "--json"],
    { encoding: "utf8" },
  );
  const payload = JSON.parse(result.stdout);
  return payload.checks.find((entry) => entry.name === "portable-paths");
}

// A foreign home path inside the payload is a leak and must fail the check.
for (const [flavor, foreignHome] of Object.entries(FOREIGN_HOMES)) {
  test(`portable-paths flags a foreign home path (${flavor})`, (t) => {
    const { home, configDir } = sandbox(t);
    fs.writeFileSync(path.join(configDir, "agent.md"), `proyecto en ${foreignHome}/app\n`);
    const check = runVerify(home);
    assert.equal(check.ok, false, `una ruta ajena (${flavor}) debe fallar el check`);
  });
}

// The GSD installer keeps its own pristine copy of the upstream files, and
// those upstream files carry the upstream author's example paths. They are not
// Habitat's payload, so they must not fail the check.
test("portable-paths ignores vendor copies and stale backups", (t) => {
  const { home, configDir } = sandbox(t);
  const pristine = path.join(configDir, "gsd-pristine");
  fs.mkdirSync(pristine, { recursive: true });
  fs.writeFileSync(path.join(pristine, "upstream.md"), `ejemplo ${FOREIGN_HOMES.posix}/app\n`);
  const stale = path.join(configDir, "agents.bak-tier-2026-10-02");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "old.md"), `ejemplo ${FOREIGN_HOMES.posix}/app\n`);

  const check = runVerify(home);
  assert.equal(check.ok, true, `no debería fallar: ${check.detail}`);
});

// The machine's own home is legitimate: the payload expands to it.
test("portable-paths accepts the machine's own home", (t) => {
  const { home, configDir } = sandbox(t);
  const own = home.replace(/\\/g, "/");
  fs.writeFileSync(path.join(configDir, "agent.md"), `proyecto en ${own}/app\n`);
  const check = runVerify(home);
  assert.equal(check.ok, true, `la home propia no es una fuga: ${check.detail}`);
});

// A documented placeholder is not somebody else's home.
test("portable-paths ignores documented placeholders", (t) => {
  const { home, configDir } = sandbox(t);
  const placeholder = ["C:", "Users", "..."].join("\\");
  fs.writeFileSync(path.join(configDir, "guia.md"), `la config puede quedar en ${placeholder}/docs\n`);
  const check = runVerify(home);
  assert.equal(check.ok, true, `un placeholder documentado no es una fuga: ${check.detail}`);
});
