// tests/mcp-probe.test.mjs — el probe que habla MCP directamente.
//
// El check `jev-mcp` no puede apoyarse en `opencode mcp list` (el formato
// cambió entre las líneas 1.x y 2.x de OpenCode), así que valida el servidor
// con un handshake JSON-RPC. Estos tests fijan ese comportamiento.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(root, "lib", "mcp-probe.mjs");

// A minimal MCP server: initialize + tools/list over stdio.
function fakeServer(t, { tools = ["jev_classify"], fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-mcp-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "server.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } }) + "\\n");
    } else if (message.method === "tools/list") {
      if (${fail ? "true" : "false"}) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "boom" } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: ${JSON.stringify(tools)}.map((name) => ({ name })) } }) + "\\n");
      }
    }
  }
});
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function runProbe(launcher, expected) {
  const args = expected ? [probe, launcher, expected] : [probe, launcher];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

test("mcp-probe: un servidor que responde anuncia sus herramientas", (t) => {
  const server = fakeServer(t);
  const result = runProbe(server, "jev_classify");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "jev_classify");
});

test("mcp-probe: sin la herramienta esperada falla con el detalle", (t) => {
  const server = fakeServer(t, { tools: ["otra_cosa"] });
  const result = runProbe(server, "jev_classify");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no anuncia jev_classify/);
});

test("mcp-probe: un servidor que devuelve error falla", (t) => {
  const server = fakeServer(t, { fail: true });
  const result = runProbe(server, "jev_classify");
  assert.equal(result.status, 1);
});

test("mcp-probe: un launcher inexistente falla sin colgarse", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-mcp-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runProbe(path.join(dir, "no-existe"), "jev_classify");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.length > 0, "dice por que fallo");
});

test("mcp-probe: sin argumentos es un error de uso", () => {
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8" });
  assert.equal(result.status, 2);
});
