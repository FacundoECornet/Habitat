import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyTool = path.join(root, "tools", "verify.mjs");

// gsd-sdk and graphify are optional CLIs that only arrive with `--with-deps`.
// A machine without them is not broken: the check must stay green and say what
// is missing, otherwise `install.mjs` fails its own verification.
test("cli-tools stays green when the optional CLIs are not installed", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-cli-tools-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-empty-path-"));
  t.after(() => fs.rmSync(emptyPath, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [verifyTool, "--home", home, "--repo", root, "--no-models", "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPath },
    },
  );

  const payload = JSON.parse(result.stdout);
  const cli = payload.checks.find((entry) => entry.name === "cli-tools");
  assert.ok(cli, "verify debe reportar el check cli-tools");
  assert.equal(cli.ok, true, "una CLI opcional ausente no puede fallar la verificación");
  assert.ok(
    !payload.checks.some((entry) => entry.name === "cli-tools-installed"),
    "no debe existir un check separado que falle por CLIs ausentes",
  );
});
