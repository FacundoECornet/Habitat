// tests/install-context-mode.test.mjs — adaptación del payload a la línea
// de OpenCode.
//
// El plugin nativo de context-mode es de la línea 1.x: en un host 2.x no
// carga. El payload lleva un puente que registra el servidor MCP de
// context-mode, y el instalador saca la entrada nativa cuando el CLI es 2.x,
// para que el host no loguee un plugin que no puede cargar.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installTool = path.join(root, "tools", "install.mjs");
const payloadConfig = path.join(root, "home", ".config", "opencode", "opencode.jsonc");

function readJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s+)\/\/[^\n]*/g, "$1").replace(/,(\s*[}\]])/g, "$1"));
}

function fixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-cm-repo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.cpSync(path.join(root, "tools"), path.join(dir, "tools"), { recursive: true });
  spawnSync("git", ["-C", dir, "init", "-q", "."]);
  return dir;
}

// A fake OpenCode CLI that only knows how to report its version.
function fakeCli(t, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-cm-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "opencode.cmd"), `@echo off\r\necho ${version}\r\n`);
  } else {
    const file = path.join(dir, "opencode");
    fs.writeFileSync(file, `#!/usr/bin/env bash\necho "${version}"\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function fixtureHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-cm-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(payloadConfig, path.join(configDir, "opencode.jsonc"));
  return home;
}

function install(repo, home, cliDir) {
  return spawnSync(
    process.execPath,
    [
      installTool,
      "--home",
      home,
      "--repo",
      repo,
      "--skip-plugins",
      "--skip-restore",
      "--skip-verify",
      "--no-pick-models",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${cliDir}${path.delimiter}${process.env.PATH ?? ""}` },
    },
  );
}

test("install: en opencode 1.x context-mode queda como plugin nativo", (t) => {
  const repo = fixtureRepo(t);
  const home = fixtureHome(t);
  const cli = fakeCli(t, "1.19.3");

  const result = install(repo, home, cli);
  assert.equal(result.status, 0, result.stderr);

  const config = readJsonc(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), "utf8"));
  assert.equal(config.plugin.includes("context-mode"), true, "el plugin nativo se queda");
  assert.equal(
    config.plugin.includes("./plugins/context-mode-bridge.js"),
    true,
    "el puente sigue declarado para cuando haga falta",
  );
  assert.match(result.stdout, /context-mode va por su plugin nativo/);
});

test("install: en opencode 2.x el plugin nativo se quita y queda el puente", (t) => {
  const repo = fixtureRepo(t);
  const home = fixtureHome(t);
  const cli = fakeCli(t, "2.1.0");

  const result = install(repo, home, cli);
  assert.equal(result.status, 0, result.stderr);

  const config = readJsonc(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), "utf8"));
  assert.equal(config.plugin.includes("context-mode"), false, "el plugin nativo no puede cargar en 2.x");
  assert.equal(
    config.plugin.includes("./plugins/context-mode-bridge.js"),
    true,
    "el puente queda: es el que registra el MCP de context-mode",
  );
  assert.equal(config.plugin.includes("./plugins/caveman/plugin.js"), true, "los otros plugins no se tocan");
  assert.match(result.stdout, /queda el puente por MCP/);
});

test("install: sin CLI de OpenCode la config del payload no se toca", (t) => {
  const repo = fixtureRepo(t);
  const home = fixtureHome(t);
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-cm-empty-"));
  t.after(() => fs.rmSync(emptyBin, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [
      installTool,
      "--home",
      home,
      "--repo",
      repo,
      "--skip-plugins",
      "--skip-restore",
      "--skip-verify",
      "--no-pick-models",
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home, PATH: emptyBin } },
  );
  assert.equal(result.status, 0, result.stderr);

  const config = readJsonc(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), "utf8"));
  assert.equal(config.plugin.includes("context-mode"), true, "sin CLI no se adapta nada");
});
