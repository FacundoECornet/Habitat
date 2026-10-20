import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyTool = path.join(root, "tools", "verify.mjs");

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
test("portable-paths flags a foreign home path in the config", (t) => {
  const { home, configDir } = sandbox(t);
  fs.writeFileSync(path.join(configDir, "agent.md"), "proyecto en /home/john/app\n");
  const check = runVerify(home);
  assert.equal(check.ok, false, "una ruta ajena debe fallar el check");
});

// The GSD installer keeps its own pristine copy of the upstream files, and
// those upstream files carry the upstream author's example paths. They are not
// Habitat's payload, so they must not fail the check.
test("portable-paths ignores vendor copies and stale backups", (t) => {
  const { home, configDir } = sandbox(t);
  const pristine = path.join(configDir, "gsd-pristine");
  fs.mkdirSync(pristine, { recursive: true });
  fs.writeFileSync(path.join(pristine, "upstream.md"), "ejemplo /home/john/app\n");
  const stale = path.join(configDir, "agents.bak-tier-2026-10-02");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "old.md"), "ejemplo /home/john/app\n");

  const check = runVerify(home);
  assert.equal(check.ok, true, `no debería fallar: ${check.detail}`);
});
