import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openCodeAuthPath } from "../lib/opencode-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const router = path.join(root, "home", ".config", "opencode", "gsd-router");
const script = path.join(root, "tools", "gsd-jevs-route.mjs");

test("GSD JEV router reuses OpenCode Zen auth without JEV_API_KEY", (t) => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-route-test-"));
  t.after(() => fs.rmSync(dataHome, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    GSD_ROUTER_DIR: router,
    GSD_JEV_MOCK: path.join(dataHome, "jev-response.json"),
  };
  const authPath = openCodeAuthPath(os.homedir(), env);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ opencode: { type: "api", key: "test-key" } }));
  fs.writeFileSync(
    env.GSD_JEV_MOCK,
    JSON.stringify({ results: [{ classification: "medium", decision: "auto", confidence: 0.95, margin: 0.7 }] }),
  );
  delete env.JEV_API_KEY;
  delete env.OPENCODE_API_KEY;

  const result = spawnSync(process.execPath, [script, "fixture task", "--dry-run"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /JEV \(zen_free\): medium/);
  assert.match(result.stdout, /dry-run: no se escribe configuración/);
});
