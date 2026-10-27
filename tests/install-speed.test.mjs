// tests/install-speed.test.mjs — contratos del plan de instalación rápida.
//
// Cubre los puntos que podrían romper seguridad o funcionalidad al reducir el
// trabajo del install: npm ci de producción con flags, fingerprint que evita
// el install repetido, guarda del SDK de plugins y npm audit visible solo
// cuando cambia el lock.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const restoreTool = path.join(root, "tools", "restore.mjs");
const verifyTool = path.join(root, "tools", "verify.mjs");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeNpm(t) {
  const bin = tempDir(t, "habitat-fake-npm-");
  const log = path.join(bin, "npm.log");
  if (process.platform === "win32") {
    write(
      path.join(bin, "npm.cmd"),
      `@echo off\r\necho %*>>"%HABITAT_NPM_LOG%"\r\nexit /b 0\r\n`,
    );
  } else {
    const file = path.join(bin, "npm");
    write(file, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$HABITAT_NPM_LOG"\nexit 0\n`);
    fs.chmodSync(file, 0o755);
  }
  return { bin, log };
}

function envWith(t, home, bin, log) {
  return {
    ...process.env,
    HOME: home,
    HABITAT_NPM_LOG: log,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

function restoreFixture(t) {
  const repo = tempDir(t, "habitat-speed-repo-");
  const home = tempDir(t, "habitat-speed-home-");
  fs.cpSync(path.join(root, "tools", "restore.mjs"), path.join(repo, "tools", "restore.mjs"));
  fs.cpSync(path.join(root, "lib"), path.join(repo, "lib"), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "MANIFEST.json"), "utf8"));
  for (const entry of manifest.entries) {
    entry.post_steps = entry.origin === ".config/opencode" ? ["npm ci"] : [];
    write(path.join(repo, entry.dest, ".keep"), "fixture\n");
  }
  write(path.join(repo, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  write(path.join(repo, "home", ".config", "opencode", "package.json"), '{"name":"fixture"}\n');
  write(path.join(repo, "home", ".config", "opencode", "package-lock.json"), '{"lockfileVersion":3}\n');
  return { repo, home };
}

function runRestore(fixture, env) {
  return spawnSync(process.execPath, [path.join(fixture.repo, "tools", "restore.mjs")], {
    encoding: "utf8",
    env,
  });
}

test("npmGate instala solo producción y con los flags de C3", (t) => {
  const fixture = restoreFixture(t);
  const npm = fakeNpm(t);
  const env = envWith(t, fixture.home, npm.bin, npm.log);

  const first = runRestore(fixture, env);
  assert.equal(first.status, 0, first.stderr);
  const calls = fs.readFileSync(npm.log, "utf8").trim().split(/\r?\n/);
  assert.deepEqual(calls, [
    "ci --omit=dev --no-audit --no-fund --prefer-offline --loglevel=error --ignore-scripts",
  ], "npm ci debe instalar solo producción, sin audit y sin lifecycle scripts ajenos");

  const second = runRestore(fixture, env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /npm ci: up-to-date/);
  assert.equal(
    fs.readFileSync(npm.log, "utf8").trim().split(/\r?\n/).length,
    1,
    "el fingerprint debe evitar un segundo npm ci y el rebuild",
  );
});

function verifyHome(t, { plugins = [], files = {} } = {}) {
  const home = tempDir(t, "habitat-verify-home-");
  const configDir = path.join(home, ".config", "opencode");
  write(
    path.join(configDir, "opencode.jsonc"),
    JSON.stringify({ plugin: plugins, mcp: {} }, null, 2) + "\n",
  );
  for (const [relative, content] of Object.entries(files)) write(path.join(configDir, relative), content);
  return home;
}

function runVerify(home, env) {
  const result = spawnSync(
    process.execPath,
    [verifyTool, "--home", home, "--repo", root, "--no-models", "--no-cli", "--json"],
    { encoding: "utf8", env },
  );
  return JSON.parse(result.stdout).checks;
}

test("verify falla con hint si un plugin importa el SDK devDependency", (t) => {
  const home = verifyHome(t, {
    plugins: ["./plugins/caveman/plugin.js"],
    files: {
      "plugins/caveman/plugin.js": 'import type { Plugin } from "@opencode-ai/plugin";\n',
    },
  });
  const checks = runVerify(home, { ...process.env, HOME: home });
  const guard = checks.find((entry) => entry.name === "plugin-sdk");
  assert.equal(guard.ok, false);
  assert.match(guard.hint, /npm i/);
  assert.match(guard.detail, /caveman/);
});

test("verify acepta el import del SDK cuando el SDK está instalado", (t) => {
  const home = verifyHome(t, {
    plugins: ["./plugins/caveman/plugin.js"],
    files: {
      "plugins/caveman/plugin.js": 'import type { Plugin } from "@opencode-ai/plugin";\n',
      "node_modules/@opencode-ai/plugin/package.json": '{"name":"@opencode-ai/plugin","main":"index.js"}\n',
      "node_modules/@opencode-ai/plugin/index.js": "module.exports = {};\n",
    },
  });
  const checks = runVerify(home, { ...process.env, HOME: home });
  const guard = checks.find((entry) => entry.name === "plugin-sdk");
  assert.equal(guard.ok, true, guard.detail);
  assert.match(guard.detail, /está instalado/);
});

test("verify acepta plugins que no importan el SDK", (t) => {
  const home = verifyHome(t, {
    plugins: ["./plugins/caveman/plugin.js"],
    files: { "plugins/caveman/plugin.js": "export default { id: 'x' };\n" },
  });
  const checks = runVerify(home, { ...process.env, HOME: home });
  const guard = checks.find((entry) => entry.name === "plugin-sdk");
  assert.equal(guard.ok, true, guard.detail);
});

test("verify resuelve context-mode desde el node_modules del config dir", (t) => {
  const home = verifyHome(t, {
    plugins: ["context-mode"],
    files: {
      "node_modules/context-mode/package.json": '{"name":"context-mode","main":"index.js"}\n',
      "node_modules/context-mode/index.js": "module.exports = {};\n",
    },
  });
  const checks = runVerify(home, { ...process.env, HOME: home });
  const plugins = checks.find((entry) => entry.name === "plugins");
  assert.equal(plugins.ok, true, plugins.detail);
  assert.match(plugins.detail, /1 plugins declarados/);
});

test("npm audit corre una vez por lock y después usa el fingerprint", (t) => {
  const home = verifyHome(t, {
    files: {
      "package.json": '{"name":"fixture","dependencies":{"demo":"1.0.0"}}\n',
      "package-lock.json": '{"lockfileVersion":3}\n',
    },
  });
  fs.mkdirSync(path.join(home, ".config", "opencode", "node_modules"), { recursive: true });
  const npm = fakeNpm(t);
  const env = envWith(t, home, npm.bin, npm.log);

  const first = runVerify(home, env);
  const firstAudit = first.find((entry) => entry.name === "npm-audit");
  assert.equal(firstAudit.ok, true, firstAudit.detail);
  assert.match(firstAudit.detail, /sin vulnerabilidades/);
  assert.equal(fs.readFileSync(npm.log, "utf8").trim(), "audit --omit=dev --audit-level=high");

  const second = runVerify(home, env);
  const secondAudit = second.find((entry) => entry.name === "npm-audit");
  assert.equal(secondAudit.ok, true, secondAudit.detail);
  assert.match(secondAudit.detail, /sin cambios/);
  assert.equal(
    fs.readFileSync(npm.log, "utf8").trim(),
    "audit --omit=dev --audit-level=high",
    "el segundo verify no debe volver a auditar",
  );
});
