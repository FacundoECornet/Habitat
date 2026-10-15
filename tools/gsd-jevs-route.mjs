#!/usr/bin/env node
// gsd-jevs-route — JEV difficulty router: classifies a project/task summary with the
// `jev_classify` tool and, only on an auto-accepted easy/medium/hard verdict, applies
// the matching model profile through tools/route.mjs.
//
// Usage: node gsd-jevs-route.mjs "<summary>" [--dry-run] [--project-root <dir>]
//
// Provider order, thresholds and catalog live in ~/.config/opencode/gsd-router/
// (jev.json + jev-catalog.json). Every failure path — missing key, HTTP error,
// timeout, manual_review, low confidence/margin, invalid response — exits 2 and
// writes nothing.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NOT_APPLIED = 2;

const ROUTABLE = ["easy", "medium", "hard"];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function warn(message) {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parts = [];
  let dryRun = false;
  let projectRoot = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--project-root") {
      i += 1;
      projectRoot = args[i];
      if (!projectRoot) {
        warn("gsd-jevs-route: --project-root requiere un valor");
        process.exit(EXIT_USAGE);
      }
    } else if (arg === "-h" || arg === "--help") {
      log('Uso: gsd-jevs-route "<resumen del proyecto>" [--dry-run] [--project-root <dir>]');
      process.exit(EXIT_OK);
    } else {
      parts.push(arg);
    }
  }

  const summary = parts.join(" ").trim();
  if (!summary) {
    warn('Uso: gsd-jevs-route "<resumen del proyecto>"');
    process.exit(EXIT_USAGE);
  }
  return { summary, dryRun, projectRoot };
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function routerDir() {
  return (
    process.env.GSD_ROUTER_DIR ??
    path.join(os.homedir(), ".config", "opencode", "gsd-router")
  );
}

function repoRoot() {
  const candidates = [];
  if (process.env.GSD_HABITAT_ROOT) candidates.push(process.env.GSD_HABITAT_ROOT);
  candidates.push(path.resolve(import.meta.dirname, ".."));
  const installed = path.dirname(fs.realpathSync(path.join(routerDir(), "jev.json")));
  const marker = `${path.sep}home${path.sep}.config${path.sep}opencode${path.sep}gsd-router${path.sep}`;
  if (installed.includes(marker)) {
    candidates.push(installed.split(marker)[0]);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "tools", "route.mjs"))) return candidate;
  }
  warn("gsd-jevs-route: no se encontró tools/route.mjs (root del repo habitat)");
  process.exit(EXIT_NOT_APPLIED);
}

function providerEnvironment(provider, key) {
  const env = { ...process.env };
  for (const name of ["JEV_PROVIDER", "JEV_API_BASE_URL", "JEV_API_KEY", "JEV_MCP_MODEL"]) {
    delete env[name];
  }
  delete env.TYPESAFE_API_KEY;

  if (provider.key_env) env[provider.key_env] = key;
  if (provider.carrier) env.JEV_PROVIDER = provider.carrier;
  if (provider.carrier === "compatible") {
    const baseUrl =
      (provider.id === "user" ? process.env.JEV_API_BASE_URL : undefined) ??
      provider.api_base_url;
    if (!baseUrl) throw new Error(`provider ${provider.id} sin api_base_url`);
    env.JEV_API_BASE_URL = baseUrl;
    env.JEV_API_KEY = key;
  }
  if (provider.model) env.JEV_MCP_MODEL = provider.model;
  return env;
}

function mockResult(providerId) {
  const mockPath = process.env.GSD_JEV_MOCK;
  if (!mockPath) return undefined;
  let payload;
  try {
    payload = readJsonFile(mockPath);
  } catch (error) {
    throw new Error(`mock ilegible: ${error.message}`);
  }
  if (payload && typeof payload === "object" && payload.providers) {
    const entry = payload.providers[providerId];
    if (entry === undefined) {
      const error = new Error("sin mock");
      error.code = "NO_MOCK";
      throw error;
    }
    return entry;
  }
  return payload;
}

async function callJevClassify(provider, key, arguments_) {
  const mocked = mockResult(provider.id);
  if (mocked !== undefined) {
    if (mocked.error) throw new Error(mocked.error);
    return mocked;
  }

  const command = process.env.GSD_JEV_MCP_COMMAND ?? "npx -y @jkudish/jev-mcp";
  const [bin, ...binArgs] = command.split(/\s+/).filter(Boolean);
  const timeoutMs = Number(process.env.GSD_JEV_TIMEOUT_MS ?? 25000);

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, binArgs, {
        env: providerEnvironment(provider, key),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`no se pudo lanzar el servidor JEV: ${error.message}`));
      return;
    }

    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`timeout tras ${timeoutMs}ms`));
    }, timeoutMs);

    let buffer = "";
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "gsd-jevs-route", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_classify", arguments: arguments_ } },
    ];

    function handleMessage(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        for (const payload of requests.slice(1)) {
          child.stdin.write(`${JSON.stringify(payload)}\n`);
        }
        return;
      }
      if (message.id === 2) {
        const result = message.result;
        if (!result || result.isError) {
          const text = result?.content?.[0]?.text ?? "error sin detalle";
          finish(new Error(`jev_classify falló: ${text}`));
          return;
        }
        const text = result.content?.[0]?.text;
        if (typeof text !== "string") {
          finish(new Error("respuesta JEV sin content textual"));
          return;
        }
        try {
          finish(null, JSON.parse(text));
        } catch (error) {
          finish(new Error(`respuesta JEV no es JSON: ${error.message}`));
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) handleMessage(trimmed);
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", (error) => finish(new Error(`spawn falló: ${error.message}`)));
    child.on("exit", (code) => {
      finish(new Error(`servidor JEV terminó con código ${code}`));
    });

    child.stdin.write(`${JSON.stringify(requests[0])}\n`);
  });
}

function verdictOf(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload vacío");
  if (payload.status === "invalid_response") throw new Error("JEV devolvió invalid_response");
  const result = Array.isArray(payload.results) ? payload.results[0] : undefined;
  if (!result || result.status === "invalid_response") {
    throw new Error("JEV devolvió un resultado inválido");
  }
  const classification =
    result.classification ?? result.class ?? result.choice ?? result.selected;
  if (typeof classification !== "string") throw new Error("JEV no devolvió clasificación");
  return {
    classification,
    decision: result.decision ?? "manual_review",
    confidence: typeof result.confidence === "number" ? result.confidence : null,
    margin: typeof result.margin === "number" ? result.margin : null,
    probabilities: result.probabilities ?? null,
  };
}

function applyProfile(profile, confidence, projectRoot) {
  const root = repoRoot();
  const child = spawn(process.execPath, [path.join(root, "tools", "route.mjs"), profile], {
    cwd: projectRoot ?? process.cwd(),
    env: {
      ...process.env,
      JEV_PROFILE_SOURCE: "jev",
      ...(confidence !== null ? { JEV_CONFIDENCE: String(confidence) } : {}),
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? EXIT_NOT_APPLIED));
}

async function main() {
  const { summary, dryRun, projectRoot } = parseArgs(process.argv);
  const dir = routerDir();

  if (process.env.GSD_JEV_DISABLE === "1") {
    warn("gsd-jevs-route: JEV deshabilitado (GSD_JEV_DISABLE=1); no se aplica perfil");
    process.exit(EXIT_NOT_APPLIED);
  }

  let providers;
  let catalog;
  try {
    const config = readJsonFile(path.join(dir, "jev.json"));
    providers = Array.isArray(config.providers) ? config.providers : [];
    catalog = readJsonFile(path.join(dir, "jev-catalog.json"));
  } catch (error) {
    warn(`gsd-jevs-route: no se pudo leer la configuración del router: ${error.message}`);
    process.exit(EXIT_NOT_APPLIED);
  }

  const autoAccept = Number(catalog.auto_accept ?? 0.85);
  const minimumMargin = Number(catalog.minimum_margin ?? 0.5);
  const classes = (Array.isArray(catalog.catalog) ? catalog.catalog : []).map((entry) => ({
    id: entry.id,
    description: entry.description,
  }));
  if (classes.length === 0) {
    warn("gsd-jevs-route: jev-catalog.json sin catálogo");
    process.exit(EXIT_NOT_APPLIED);
  }

  const arguments_ = {
    purpose:
      "Clasificar la dificultad de un proyecto o tarea GSD para elegir el perfil de modelos",
    items: [{ id: "routing", text: summary }],
    classes,
    auto_accept: autoAccept,
    minimum_margin: minimumMargin,
  };

  const failures = [];
  for (const provider of providers) {
    const key = provider.key_env ? process.env[provider.key_env] : "";
    if (!key) {
      failures.push(`${provider.id}: falta ${provider.key_env ?? "key"}`);
      continue;
    }
    let verdict;
    try {
      verdict = verdictOf(await callJevClassify(provider, key, arguments_));
    } catch (error) {
      failures.push(`${provider.id}: ${error.message}`);
      continue;
    }

    if (!ROUTABLE.includes(verdict.classification)) {
      warn(
        `gsd-jevs-route: clasificación ${verdict.classification} — se requiere revisión humana; no se aplica perfil`,
      );
      process.exit(EXIT_NOT_APPLIED);
    }
    if (verdict.decision !== "auto") {
      warn(
        `gsd-jevs-route: decisión ${verdict.decision} para ${verdict.classification}; no se aplica perfil automáticamente`,
      );
      process.exit(EXIT_NOT_APPLIED);
    }
    if (
      verdict.confidence !== null &&
      verdict.margin !== null &&
      (verdict.confidence < autoAccept || verdict.margin < minimumMargin)
    ) {
      warn(
        `gsd-jevs-route: confianza ${verdict.confidence} / margen ${verdict.margin} bajo umbral ` +
          `(${autoAccept}/${minimumMargin}); no se aplica perfil`,
      );
      process.exit(EXIT_NOT_APPLIED);
    }

    log(
      `JEV (${provider.id}): ${verdict.classification} ` +
        `(confianza ${verdict.confidence ?? "n/a"}, margen ${verdict.margin ?? "n/a"})`,
    );
    if (dryRun) {
      log("dry-run: no se escribe configuración");
      process.exit(EXIT_OK);
    }
    applyProfile(verdict.classification, verdict.confidence, projectRoot);
    return;
  }

  warn(`gsd-jevs-route: ningún proveedor JEV respondió; no se aplica perfil`);
  for (const failure of failures) warn(`  - ${failure}`);
  process.exit(EXIT_NOT_APPLIED);
}

main().catch((error) => {
  warn(`gsd-jevs-route: ${error.message}`);
  process.exit(EXIT_NOT_APPLIED);
});
