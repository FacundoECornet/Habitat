// tests/plugin-contracts.test.mjs — contrato de los plugins del payload.
//
// OpenCode 1.x y 2.x no comparten el mismo contrato de plugin: 1.x llama
// `server` con el contexto 1.x, 2.x llama `setup` con el contexto 2.x. Un
// solo módulo tiene que servir para las dos líneas, sin registrar los hooks
// dos veces y sin romper la línea en la que no aplica.
//
// Estos tests fijan ese contrato con un contexto falso: no necesitan el CLI
// de OpenCode ni red.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payload = path.join(root, "home", ".config", "opencode");
const cavemanPath = path.join(payload, "plugins", "caveman", "plugin.js");
const graphifyPath = path.join(payload, "plugins", "graphify.js");

// Un contexto de host 2.x: los dominios que un plugin 2.x puede usar.
function v2Context() {
  const registered = { session: [], tool: [] };
  return {
    registered,
    ctx: {
      location: { directory: "/tmp/habitat-plugin-contracts" },
      session: {
        hook: async (name, callback) => {
          registered.session.push({ name, callback });
          return { dispose: async () => {} };
        },
      },
      tool: {
        hook: async (name, callback) => {
          registered.tool.push({ name, callback });
          return { dispose: async () => {} };
        },
      },
    },
  };
}

// A context of a 1.x host: the shape `setup` receives there (partial: no
// `session`, no `tool`).
function v1SetupContext() {
  const registered = [];
  return {
    registered,
    ctx: {
      options: {},
      agent: {},
      command: {},
      skill: {},
      session: undefined,
      tool: undefined,
    },
  };
}

// A 2.x host: the mcp domain can register a server.
function v2McpContext() {
  const servers = new Map();
  const calls = { set: [], reload: 0 };
  return {
    calls,
    servers,
    ctx: {
      mcp: {
        transform: async (callback) => {
          callback({
            set: (name, config) => {
              calls.set.push({ name, config });
              servers.set(name, { name, status: { status: "connected" } });
            },
          });
          return { dispose: async () => {} };
        },
        reload: async () => {
          calls.reload += 1;
        },
        list: async () => [...servers.values()],
      },
    },
  };
}

test("plugin caveman: el modulo exporta las dos formas", async () => {
  const mod = await import(pathToFileURL(cavemanPath).href);
  assert.equal(typeof mod.default, "object");
  assert.equal(mod.default.id, "habitat-caveman");
  assert.equal(typeof mod.default.server, "function", "la forma 1.x es `server`");
  assert.equal(typeof mod.default.setup, "function", "la forma 2.x es `setup`");
});

test("plugin graphify: el modulo exporta las dos formas", async () => {
  const mod = await import(pathToFileURL(graphifyPath).href);
  assert.equal(typeof mod.default, "object");
  assert.equal(mod.default.id, "habitat-graphify");
  assert.equal(typeof mod.default.server, "function");
  assert.equal(typeof mod.default.setup, "function");
});

test("plugin caveman: la forma 1.x devuelve los hooks de 1.x", async () => {
  const mod = await import(pathToFileURL(cavemanPath).href);
  const hooks = await mod.default.server({});
  assert.equal(typeof hooks["chat.message"], "function");
  assert.equal(typeof hooks["experimental.chat.system.transform"], "function");
  assert.equal(typeof hooks.event, "function");
  assert.equal(hooks.tool, undefined, "la forma 1.x no registra tools");
});

test("plugin graphify: la forma 1.x devuelve el hook de bash", async () => {
  const mod = await import(pathToFileURL(graphifyPath).href);
  const hooks = await mod.default.server({ directory: "/tmp" });
  assert.equal(typeof hooks["tool.execute.before"], "function");
});

test("plugin caveman: en un host 1.x la forma 2.x no registra nada", async () => {
  const mod = await import(pathToFileURL(cavemanPath).href);
  const { ctx, registered } = v1SetupContext();
  await mod.default.setup(ctx);
  assert.deepEqual(registered, [], "sin dominio session no hay hooks que registrar");
});

test("plugin graphify: en un host 1.x la forma 2.x no registra nada", async () => {
  const mod = await import(pathToFileURL(graphifyPath).href);
  const { ctx, registered } = v1SetupContext();
  await mod.default.setup(ctx);
  assert.deepEqual(registered, [], "sin dominio tool no hay hooks que registrar");
});

test("plugin caveman: en un host 2.x registra prompt y context", async () => {
  const mod = await import(pathToFileURL(cavemanPath).href);
  const { ctx, registered } = v2Context();
  await mod.default.setup(ctx);
  assert.deepEqual(
    registered.session.map((h) => h.name).sort(),
    ["context", "prompt"],
  );
  assert.deepEqual(registered.tool, []);
});

test("plugin graphify: en un host 2.x registra el hook de herramienta", async () => {
  const mod = await import(pathToFileURL(graphifyPath).href);
  const { ctx, registered } = v2Context();
  await mod.default.setup(ctx);
  assert.deepEqual(registered.tool.map((h) => h.name), ["execute.before"]);
  assert.deepEqual(registered.session, []);
});

test("plugin graphify: en 2.x el recordatorio precede al comando de bash", async (t) => {
  const mod = await import(pathToFileURL(graphifyPath).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-graphify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "graphify-out", "graph.json"), "{}\n");

  const { ctx, registered } = v2Context();
  ctx.location = { directory: dir };
  await mod.default.setup(ctx);

  const hook = registered.tool[0].callback;
  const input = { tool: "bash", input: { command: "ls -la" } };
  await hook(input);
  assert.match(input.input.command, /^\s*echo "\[graphify\]/, "el recordatorio va primero");
  assert.match(input.input.command, /ls -la$/, "el comando original se conserva");
});

test("plugin graphify: sin grafo no toca el comando", async (t) => {
  const mod = await import(pathToFileURL(graphifyPath).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-graphify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { ctx, registered } = v2Context();
  ctx.location = { directory: dir };
  await mod.default.setup(ctx);

  const hook = registered.tool[0].callback;
  const input = { tool: "bash", input: { command: "ls -la" } };
  await hook(input);
  assert.equal(input.input.command, "ls -la");
});
