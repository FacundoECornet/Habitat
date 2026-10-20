// tests/verify-opencode-cli.test.mjs — el check de compatibilidad de plugins.
//
// El contrato de plugins cambió entre OpenCode 1.x y 2.x. El check dice qué
// línea está en uso y por qué ruta llega context-mode, para que un usuario
// con un plugin que no carga no se quede con una verificación en verde.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyTool = path.join(root, "tools", "verify.mjs");

const NATIVE = "context-mode";
const BRIDGE = "./plugins/context-mode-bridge.js";

function fakeCli(t, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-vcli-"));
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

function homeWith(t, { plugins, report }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-vhome-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "opencode.jsonc"),
    JSON.stringify({ plugin: plugins, mcp: {} }, null, 2) + "\n",
  );
  if (report) {
    fs.writeFileSync(path.join(dir, ".habitat-context-mode.json"), JSON.stringify(report, null, 2) + "\n");
  }
  return home;
}

function runVerify(home, cliDir, extraArgs = []) {
  const env = { ...process.env, HOME: home };
  if (cliDir) env.PATH = `${cliDir}${path.delimiter}${env.PATH ?? ""}`;
  const result = spawnSync(
    process.execPath,
    [verifyTool, "--home", home, "--repo", root, "--no-models", "--no-cli", "--json", ...extraArgs],
    { encoding: "utf8", env },
  );
  const payload = JSON.parse(result.stdout);
  return payload.checks.find((entry) => entry.name === "opencode-cli");
}

// The check needs the CLI, so it is run without --no-cli.
function runVerifyWithCli(home, cliDir) {
  const env = { ...process.env, HOME: home, PATH: `${cliDir}${path.delimiter}${process.env.PATH ?? ""}` };
  const result = spawnSync(
    process.execPath,
    [verifyTool, "--home", home, "--repo", root, "--no-models", "--json"],
    { encoding: "utf8", env },
  );
  const payload = JSON.parse(result.stdout);
  return payload.checks.find((entry) => entry.name === "opencode-cli");
}

test("opencode-cli: en la línea 1.x con el plugin nativo todo esta bien", (t) => {
  const home = homeWith(t, { plugins: [NATIVE, BRIDGE] });
  const cli = fakeCli(t, "1.19.3");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /plugin nativo/);
});

test("opencode-cli: en la línea 2.x con el puente todo esta bien", (t) => {
  const home = homeWith(t, {
    plugins: [BRIDGE],
    report: { route: "mcp", ok: true, status: "connected" },
  });
  const cli = fakeCli(t, "2.1.0");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /puente \(MCP\)/);
  assert.match(check.detail, /servidor conectado/);
});

test("opencode-cli: en la línea 2.x sin puente falla con el hint de reinstalar", (t) => {
  const home = homeWith(t, { plugins: [NATIVE] });
  const cli = fakeCli(t, "2.1.0");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, false, "sin puente no hay ruta de context-mode en 2.x");
  assert.match(check.hint, /node tools\/install\.mjs/);
});

test("opencode-cli: en la línea 2.x con el MCP caido falla con el hint de context-mode", (t) => {
  const home = homeWith(t, {
    plugins: [BRIDGE],
    report: { route: "mcp", ok: false, status: "failed", error: "boom" },
  });
  const cli = fakeCli(t, "2.1.0");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, false, "el servidor MCP no levantó");
  assert.match(check.hint, /context-mode/);
});

test("opencode-cli: en la línea 2.x con el plugin nativo declarado avisa del ruido", (t) => {
  const home = homeWith(t, {
    plugins: [NATIVE, BRIDGE],
    report: { route: "mcp", ok: true, status: "connected" },
  });
  const cli = fakeCli(t, "2.1.0");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, true, "el puente cubre: no es un fallo");
  assert.match(check.detail, /el plugin nativo declarado no carga en 2\.x/);
  assert.match(check.detail, /node tools\/install\.mjs/);
});

test("opencode-cli: sin CLI el check queda en skip", (t) => {
  const home = homeWith(t, { plugins: [NATIVE] });
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-vempty-"));
  t.after(() => fs.rmSync(emptyBin, { recursive: true, force: true }));

  const env = { ...process.env, HOME: home, PATH: emptyBin };
  const result = spawnSync(
    process.execPath,
    [verifyTool, "--home", home, "--repo", root, "--no-models", "--json"],
    { encoding: "utf8", env },
  );
  const payload = JSON.parse(result.stdout);
  const check = payload.checks.find((entry) => entry.name === "opencode-cli");
  assert.equal(check.ok, true);
  assert.equal(check.skipped, true, "sin CLI no hay veredicto");
});
