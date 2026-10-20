import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openCodeAuthPath } from "../lib/opencode-auth.mjs";
import { disableJevWithoutCredential, removeMcpEntry } from "../tools/install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyTool = path.join(root, "tools", "verify.mjs");
const payloadConfig = path.join(root, "home", ".config", "opencode", "opencode.jsonc");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-jev-optin-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s+)\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

function writeAuth(home, key) {
  const authPath = openCodeAuthPath(home, { XDG_DATA_HOME: path.join(home, ".local", "share") });
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ opencode: { type: "api", key } }));
  return authPath;
}

test("removeMcpEntry quita mcp.jev y deja el JSON parseable", () => {
  const original = fs.readFileSync(payloadConfig, "utf8");
  assert.ok(JSON.parse(stripJsonComments(original)).mcp.jev, "el payload debe traer mcp.jev");

  const { text, removed } = removeMcpEntry(original, "jev");
  assert.equal(removed, true);
  const parsed = JSON.parse(stripJsonComments(text));
  assert.equal(parsed.mcp.jev, undefined);
  assert.ok(parsed.mcp, "el bloque mcp sigue existiendo");
  assert.ok(parsed.agent, "el resto de la config no se toca");
});

test("removeMcpEntry no toca nada cuando la entrada no existe", () => {
  const original = fs.readFileSync(payloadConfig, "utf8");
  const { text, removed } = removeMcpEntry(original, "no-existe");
  assert.equal(removed, false);
  assert.equal(text, original);
});

test("install sin credencial OpenCode Zen deja la config restaurada sin mcp.jev", (t) => {
  const home = tempHome(t);
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const target = path.join(configDir, "opencode.jsonc");
  fs.copyFileSync(payloadConfig, target);

  assert.equal(disableJevWithoutCredential({ home }), true);

  const parsed = JSON.parse(stripJsonComments(fs.readFileSync(target, "utf8")));
  assert.equal(parsed.mcp?.jev, undefined, "la entrada jev debe desaparecer");
  assert.ok(parsed.agent, "el resto de la config se conserva");
  const backups = path.join(home, ".habitat", "backups");
  assert.ok(fs.existsSync(backups), "debe quedar un backup del config original");
});

test("install con credencial OpenCode Zen conserva mcp.jev", (t) => {
  const home = tempHome(t);
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const target = path.join(configDir, "opencode.jsonc");
  fs.copyFileSync(payloadConfig, target);
  writeAuth(home, "test-key");

  assert.equal(disableJevWithoutCredential({ home }), true);

  const parsed = JSON.parse(stripJsonComments(fs.readFileSync(target, "utf8")));
  assert.ok(parsed.mcp?.jev, "con credencial la entrada jev se conserva");
});

test("verify marca jev-mcp como skip (no fail) sin credencial OpenCode Zen", (t) => {
  const home = tempHome(t);
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(payloadConfig, path.join(configDir, "opencode.jsonc"));

  const result = spawnSync(
    process.execPath,
    [verifyTool, "--home", home, "--repo", root, "--no-models", "--no-cli", "--json"],
    { encoding: "utf8", env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, ".local", "share") } },
  );

  const payload = JSON.parse(result.stdout);
  const jev = payload.checks.find((entry) => entry.name === "jev-mcp");
  assert.ok(jev, "verify debe reportar el check jev-mcp");
  assert.equal(jev.skipped, true, "jev-mcp debe quedar skip sin credencial");
  assert.equal(jev.ok, true, "un skip nunca falla el run");
  assert.ok(
    !payload.checks.some((entry) => entry.name === "jev-mcp" && entry.ok === false),
    "jev-mcp no debe fallar",
  );
});
