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
const CAVEMAN = "./plugins/caveman/plugin.js";

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

function homeWith(t, { plugins = [], mcp = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-vhome-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "opencode.jsonc"),
    JSON.stringify({ plugin: plugins, mcp }, null, 2) + "\n",
  );
  return home;
}

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

// En la línea 1.x el plugin nativo de context-mode carga y da las herramientas.
test("opencode-cli: en la línea 1.x con el plugin nativo todo esta bien", (t) => {
  const home = homeWith(t, { plugins: [CAVEMAN, NATIVE] });
  const cli = fakeCli(t, "1.19.3");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /plugin nativo/);
});

// En la línea 2.x el plugin nativo no carga: la ruta es el servidor MCP.
test("opencode-cli: en la línea 2.x con el MCP declarado todo esta bien", (t) => {
  const home = homeWith(t, {
    plugins: [CAVEMAN],
    mcp: { "context-mode": { type: "local", command: ["context-mode"] } },
  });
  const cli = fakeCli(t, "2.1.0");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /servidor MCP/);
});

// Un config sin adaptar (el plugin nativo y nada de MCP) es el fallo que
// dejaba al usuario sin herramientas sin enterarse.
test("opencode-cli: en la línea 2.x sin adaptar falla con el hint de reinstalar", (t) => {
  const home = homeWith(t, { plugins: [CAVEMAN, NATIVE] });
  const cli = fakeCli(t, "2.1.0");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, false, "sin servidor MCP no hay ruta en 2.x");
  assert.match(check.hint, /node tools\/install\.mjs/);
});

// En la línea 2.x el plugin nativo declarado no carga: el check lo dice.
test("opencode-cli: en la línea 2.x avisa del plugin nativo que no carga", (t) => {
  const home = homeWith(t, {
    plugins: [CAVEMAN, NATIVE],
    mcp: { "context-mode": { type: "local", command: ["context-mode"] } },
  });
  const cli = fakeCli(t, "2.1.0");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, true, "el MCP cubre: no es un fallo");
  assert.match(check.detail, /el plugin nativo declarado no carga en 2\.x/);
  assert.match(check.detail, /node tools\/install\.mjs/);
});

// Sin ninguna vía declarada, el check avisa que context-mode no está.
test("opencode-cli: sin ninguna vía declarada avisa que falta", (t) => {
  const home = homeWith(t, { plugins: [CAVEMAN] });
  const cli = fakeCli(t, "2.1.0");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, false);
  assert.match(check.detail, /no está declarado por ninguna vía/);
});

// En la línea 1.x, un config con el MCP en vez del plugin también es válido.
test("opencode-cli: en la línea 1.x con el MCP en vez del plugin tambien vale", (t) => {
  const home = homeWith(t, {
    plugins: [CAVEMAN],
    mcp: { "context-mode": { type: "local", command: ["context-mode"] } },
  });
  const cli = fakeCli(t, "1.19.3");

  const check = runVerifyWithCli(home, cli);
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /servidor MCP/);
});

// Sin CLI el check queda en skip: no hay veredicto posible.
test("opencode-cli: sin CLI el check queda en skip", (t) => {
  const home = homeWith(t, { plugins: [CAVEMAN, NATIVE] });
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
