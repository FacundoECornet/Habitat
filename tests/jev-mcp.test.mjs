import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openCodeAuthPath } from "../lib/opencode-auth.mjs";
import { MCP_MISSING_HINT, mcpPackageInstalled } from "./helpers/mcp-deps.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "tools", "jev-mcp.mjs");
const configHome = path.join(root, "home", ".config");

test("JEV launcher initializes MCP and advertises jev_classify", async (t) => {
  if (!mcpPackageInstalled()) {
    t.skip(MCP_MISSING_HINT);
    return;
  }
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-jev-mcp-test-"));
  t.after(() => fs.rmSync(dataHome, { recursive: true, force: true }));

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
  };
  const authPath = openCodeAuthPath(os.homedir(), env);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ opencode: { type: "api", key: "test-key" } }));

  const child = spawn(process.execPath, [launcher], { env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());

  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } catch {
        // Keep test failure focused on the missing JSON-RPC response.
      }
    }
  });

  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out; stderr=${stderr}; stdout-buffer=${buffer}`));
      }, 8000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "habitat-test", version: "1" },
  });
  assert.ok(initialized.result?.protocolVersion);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const tools = await request(2, "tools/list");
  assert.ok(tools.result?.tools?.some((tool) => tool.name === "jev_classify"));
});
