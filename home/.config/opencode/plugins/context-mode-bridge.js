// context-mode bridge — the opencode 2.x route for context-mode.
//
// OpenCode 1.x and 2.x do not share the plugin contract: 1.x calls `server`
// with the 1.x context, 2.x calls `setup` with the 2.x context and only
// accepts a default export with `id` + `setup`. context-mode is a 1.x
// plugin, so on a 2.x host it does not load at all (the host logs
// "Plugin must export a default definition with an id and an effect or setup
// function") and its `ctx_*` tools disappear.
//
// This bridge keeps those tools available on 2.x: it registers context-mode's
// MCP server — the same stdio child the 1.x plugin uses in-process — so the
// features are the same, only the transport differs.
//
// On 1.x this module does nothing: the real context-mode plugin is declared
// in the config and provides the tools natively, with its hooks.
//
// The report file is a diagnostic: it records which route is in use and
// whether the MCP server came up. `tools/verify.mjs` reads it, and it is
// also the first thing to look at when the `ctx_*` tools are missing.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVER_NAME = "context-mode";
const REPORT_NAME = ".habitat-context-mode.json";

// The report goes to the config dir of the host, the same one
// `tools/verify.mjs` reads. It is resolved from the environment and not from
// the location of this file: the host can load the plugin from a copy (in its
// cache), and the setup and the session can run in different processes.
function configDir() {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode");
  return join(homedir(), ".config", "opencode");
}

function readReport() {
  try {
    return JSON.parse(fs.readFileSync(join(configDir(), REPORT_NAME), "utf8"));
  } catch (error) {
    return {};
  }
}

function writeReport(payload) {
  let text;
  try {
    text = JSON.stringify(payload, null, 2) + "\n";
  } catch (error) {
    // The listing can hold values that do not serialize: the report still
    // goes out, with the reason instead of the payload.
    text = JSON.stringify(
      {
        route: payload?.route ?? "mcp",
        ok: false,
        error: `el reporte no se pudo serializar: ${error?.message ?? error}`,
      },
      null,
      2,
    ) + "\n";
  }
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), REPORT_NAME), text);
  } catch (error) {
    // A diagnostic file is never worth failing a session over.
  }
}

// 1.x contract: nothing to do here, the real context-mode plugin is in charge.
export const ContextModeBridgePlugin = async () => ({});

// The V2 API returns an Effect result: `{location, data}`, and the page can
// be an array or an object with the items inside. Every shape is accepted.
function serverList(result, depth = 0) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object" || depth > 2) return [];
  for (const key of ["data", "items", "servers", "results", "list", "page"]) {
    const value = result[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = serverList(value, depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

// A deep search for the server, whatever shape the listing has.
function findServer(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findServer(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value.name === SERVER_NAME) return value;
  for (const nested of Object.values(value)) {
    const found = findServer(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

// A short, safe description of whatever the listing returned, so a shape
// change is readable from the report instead of guesswork. Only primitives
// are kept: the raw listing can hold values that do not serialize.
function describe(value, depth = 0) {
  if (Array.isArray(value)) {
    return { kind: "array", length: value.length };
  }
  if (!value || typeof value !== "object" || depth > 2) return { kind: typeof value };
  const described = { kind: "object", keys: Object.keys(value).slice(0, 8) };
  for (const key of ["data", "items", "servers", "results", "list", "page"]) {
    const nested = value[key];
    if (nested === undefined) continue;
    if (Array.isArray(nested)) described[key] = { kind: "array", length: nested.length };
    else if (nested && typeof nested === "object") described[key] = describe(nested, depth + 1);
    else described[key] = typeof nested;
  }
  return described;
}

function serverStatus(entry) {
  const status = entry?.status;
  if (typeof status === "string") return status;
  return status?.status ?? "unknown";
}

// 2.x contract: register context-mode's MCP server and report its state.
async function setupV2(ctx) {
  // Only a 2.x host has the mcp domain; on 1.x this stays inert.
  if (!ctx || typeof ctx.mcp?.transform !== "function") return;

  try {
    await ctx.mcp.transform((editor) => {
      editor.set(SERVER_NAME, { type: "local", command: [SERVER_NAME] });
    });
  } catch (error) {
    writeReport({ route: "mcp", ok: false, error: String(error?.message ?? error) });
    return;
  }

  try {
    if (typeof ctx.mcp.reload === "function") await ctx.mcp.reload();
  } catch (error) {
    // The transform is already applied; a failed reload is not fatal.
  }

  // The server is spawned when it is registered: the first model request can
  // arrive before it is up, and then the tools would be missing. Wait for it
  // to show up in the listing.
  let status = "unknown";
  let error = null;
  let mcpList = null;
  let entry = null;
  const deadline = Date.now() + 15000;
  do {
    try {
      const raw = await ctx.mcp.list();
      mcpList = describe(raw);
      entry = findServer(raw);
      if (entry) break;
    } catch (error_) {
      error = String(error_?.message ?? error_);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);

  if (entry) {
    status = serverStatus(entry);
    error = entry?.status?.error ?? null;
  }
  // `ok` stays false until a session proves the tools reached the model: the
  // server being up is not the same as the tools being exposed.
  writeReport({ route: "mcp", ok: false, status, error, mcpList });

  // The session context carries the tools the model actually receives: that
  // is the proof that the `ctx_*` tools are exposed, not only that the server
  // is up. Recorded once, on the first request.
  if (typeof ctx.session?.hook === "function") {
    let recorded = false;
    let lastCount = -1;
    try {
      await ctx.session.hook("context", async (input) => {
        if (!input || typeof input.tools !== "object") return;
        const all = Object.keys(input.tools);
        // The host can name the MCP tools with a prefix ("context-mode_ctx_..."),
        // so the match is not anchored at the start.
        const names = all.filter((name) => /ctx/i.test(name));
        // The tool list can grow while the server connects: the report always
        // carries the latest one.
        if (recorded && names.length === lastCount) return;
        recorded = true;
        lastCount = names.length;
        writeReport({
          route: "mcp",
          ...readReport(),
          ok: names.length > 0,
          tools: names.sort(),
          totalTools: all.length,
          sampleTools: all.slice(0, 20),
        });
      });
    } catch (error) {
      // A diagnostic hook must never break a request.
    }
  }
}

export default {
  id: "habitat-context-mode-bridge",
  server: ContextModeBridgePlugin,
  setup: setupV2,
};
