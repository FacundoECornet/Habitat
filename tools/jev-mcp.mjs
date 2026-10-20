#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  jevMcpEntry,
  openCodeZenApiKey,
  openCodeAuthPath,
  withSystemCa,
} from "../lib/opencode-auth.mjs";

const home = os.homedir();
const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const configDir = path.join(configHome, "opencode");
const apiKey = openCodeZenApiKey({ home });

if (!apiKey) {
  process.stderr.write(
    `habitat-jev-mcp: falta credencial OpenCode Zen en ${openCodeAuthPath(home)}.\n` +
      "JEV es opcional: si no lo vas a usar, borrá la entrada `jev` del bloque `mcp` " +
      "de ~/.config/opencode/opencode.jsonc y OpenCode arrancará sin este MCP.\n" +
      "Para activarlo: `opencode auth login` y conectá OpenCode Zen.\n",
  );
  process.exit(1);
}

let serverEntry;
try {
  serverEntry = jevMcpEntry(configDir);
} catch (error) {
  process.stderr.write(
    `habitat-jev-mcp: paquete MCP no instalado (${error.message}); ` +
      "reinstalá Habitat para ejecutar npm ci.\n",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [serverEntry], {
  env: withSystemCa({
    ...process.env,
    JEV_PROVIDER: "compatible",
    JEV_API_BASE_URL: "https://opencode.ai/zen/v1/systemone",
    JEV_API_KEY: apiKey,
    JEV_MCP_MODEL: "jev-1.13-free",
  }),
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`habitat-jev-mcp: no se pudo iniciar servidor: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
