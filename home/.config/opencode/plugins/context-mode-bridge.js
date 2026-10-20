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

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVER_NAME = "context-mode";
const REPORT_NAME = ".habitat-context-mode.json";

function configDir() {
  return join(homedir(), ".config", "opencode");
}

function writeReport(payload) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), REPORT_NAME), JSON.stringify(payload, null, 2) + "\n");
  } catch (error) {
    // A diagnostic file is never worth failing a session over.
  }
}

// 1.x contract: nothing to do here, the real context-mode plugin is in charge.
export const ContextModeBridgePlugin = async () => ({});

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

  try {
    const servers = await ctx.mcp.list();
    const entry = (servers ?? []).find((server) => server?.name === SERVER_NAME);
    const status = entry?.status?.status ?? "unknown";
    writeReport({
      route: "mcp",
      ok: status === "connected",
      status,
      error: entry?.status?.error ?? null,
    });
  } catch (error) {
    writeReport({ route: "mcp", ok: false, error: String(error?.message ?? error) });
  }
}

export default {
  id: "habitat-context-mode-bridge",
  server: ContextModeBridgePlugin,
  setup: setupV2,
};
