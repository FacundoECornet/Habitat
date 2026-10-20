// Shared test helpers.
//
// The MCP package lives in the payload lockfile (`home/.config/opencode`), not
// in the root one, so a fresh clone has it only after `npm ci --prefix
// home/.config/opencode`. Tests that need the installed package skip
// themselves instead of failing: `npm test` stays green on a bare checkout and
// covers the real thing once the dependency is there.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const payloadConfigDir = path.join(root, "home", ".config", "opencode");

export function mcpPackageInstalled() {
  try {
    const require = createRequire(path.join(payloadConfigDir, "package.json"));
    const entry = require.resolve("@jkudish/jev-mcp");
    return fs.existsSync(path.join(path.dirname(entry), "index.js"));
  } catch {
    return false;
  }
}

export const MCP_MISSING_HINT =
  "requiere `npm ci --prefix home/.config/opencode` (paquete MCP no instalado)";
