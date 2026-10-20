// tests/install-hooks.test.mjs — activacion del gate de secretos en el repo.
//
// El hook de pre-commit vive en el repositorio de Habitat, asi que se activa
// ahi: configuracion local del repo, nunca la global, y nunca pisando un
// core.hooksPath que el usuario haya configurado por su cuenta.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installTool = path.join(root, "tools", "install.mjs");

function git(cwd, args, env) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
}

// A repository with the versioned hook, plus the modules the installer copies.
function fixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-hooks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".githooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".githooks", "pre-commit"), "#!/usr/bin/env bash\nexit 0\n");
  fs.cpSync(path.join(root, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.cpSync(path.join(root, "tools"), path.join(dir, "tools"), { recursive: true });
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "test@habitat.invalid"]);
  git(dir, ["config", "user.name", "test"]);
  return dir;
}

function installHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-hooks-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// The install runs with everything optional off, so the test touches nothing
// outside the sandbox: no restore, no verify, no global plugin install.
function install(repo, home) {
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
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
}

function hooksPath(repo) {
  return git(repo, ["config", "--local", "--get", "core.hooksPath"]).stdout.trim();
}

// The gate is activated in the repository the install runs from.
test("install activa el gate de secretos en el repo", (t) => {
  const repo = fixtureRepo(t);
  const home = installHome(t);

  const result = install(repo, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hooksPath(repo), ".githooks", "el gate queda activo en el repo");
  assert.match(result.stdout, /gate de secretos activo/);
});

// Running it again changes nothing.
test("install es idempotente con el gate de secretos", (t) => {
  const repo = fixtureRepo(t);
  const home = installHome(t);

  install(repo, home);
  const second = install(repo, home);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(hooksPath(repo), ".githooks");
});

// A hook path the user configured is never overwritten.
test("install no pisa un core.hooksPath propio", (t) => {
  const repo = fixtureRepo(t);
  const home = installHome(t);
  git(repo, ["config", "--local", "core.hooksPath", "mis-hooks"]);

  const result = install(repo, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hooksPath(repo), "mis-hooks", "la decisión del usuario se respeta");
  assert.match(result.stdout, /no se toca/);
});

// The global Git config is never written: other repositories of the user are
// not affected.
test("install no toca la configuracion global de Git", (t) => {
  const repo = fixtureRepo(t);
  const home = installHome(t);
  const globalHome = path.join(home, "global-git");
  fs.mkdirSync(globalHome, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(globalHome, ".gitconfig"),
  };

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
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr);

  const globalValue = spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], {
    encoding: "utf8",
    env,
  }).stdout.trim();
  assert.equal(globalValue, "", "la configuracion global queda intacta");
});

// A repository without the versioned hook is left alone.
test("install no inventa un gate en un repo sin .githooks", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-hooks-nogit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.cpSync(path.join(root, "tools"), path.join(dir, "tools"), { recursive: true });
  git(dir, ["init", "-q", "."]);
  const home = installHome(t);

  const result = install(dir, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hooksPath(dir), "", "sin hook versionado no se toca la config");
});
