#!/usr/bin/env node
// lib/mcp-probe.mjs — comprueba que un servidor MCP local responde.
//
// Por qué existe: el check `jev-mcp` no puede apoyarse en `opencode mcp list`,
// porque el formato de esa salida cambió entre las líneas 1.x y 2.x de
// OpenCode (en 2.x el listado ya no menciona el servidor, y el check daba por
// rota una conexión que funcionaba). Este probe hace el handshake JSON-RPC
// directamente contra el launcher, igual que un cliente MCP real, así que el
// veredicto no depende de la versión del CLI.
//
// Uso:
//   node lib/mcp-probe.mjs <launcher> [herramienta-esperada]
//
// Salida: los nombres de las herramientas que anuncia el servidor.
// Código 0 si responde, 1 si no, 2 si el uso es incorrecto.

import { spawn } from "node:child_process";
import process from "node:process";

const launcher = process.argv[2];
const expected = process.argv[3] ?? null;

if (!launcher) {
  process.stderr.write("mcp-probe: falta el launcher del servidor MCP\n");
  process.exit(2);
}

const win = process.platform === "win32";
// A `.mjs` launcher is a node script: on Windows there is no shebang, so it
// has to be handed to node explicitly.
const isNodeScript = launcher.endsWith(".mjs");
const command = isNodeScript ? process.execPath : launcher;
const args = isNodeScript ? [launcher] : [];
const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: win && !isNodeScript,
});

let buffer = "";
let stderr = "";
const pending = new Map();
let nextId = 1;

child.on("error", (error) => {
  process.stderr.write(`mcp-probe: no se pudo lanzar el servidor MCP: ${error.message}\n`);
  process.exit(1);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Noise on stdout is not a response: keep waiting.
      continue;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

function request(method, params = {}, timeoutMs = 8000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} no respondió a tiempo; stderr=${stderr.trim()}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function finish(code, message) {
  try {
    child.kill();
  } catch {
    // The child may already be gone.
  }
  if (message) {
    (code === 0 ? process.stdout : process.stderr).write(message.endsWith("\n") ? message : `${message}\n`);
  }
  process.exit(code);
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "habitat-probe", version: "1" },
  });
  if (!initialized?.result) {
    finish(1, `mcp-probe: el servidor no inicializó: ${JSON.stringify(initialized?.error ?? initialized)}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = await request("tools/list");
  const tools = listed?.result?.tools ?? [];
  const names = tools.map((tool) => tool?.name).filter(Boolean);
  if (expected && !names.includes(expected)) {
    finish(1, `mcp-probe: el servidor no anuncia ${expected} (anuncia: ${names.join(", ") || "nada"})`);
  }
  finish(0, names.join("\n"));
} catch (error) {
  finish(1, `mcp-probe: ${error.message}`);
}
