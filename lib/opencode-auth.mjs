import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export function openCodeAuthPath(home = os.homedir(), env = process.env) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

export function withSystemCa(env = process.env, platform = process.platform) {
  if (platform !== "win32") return env;
  return withSystemCaAnyPlatform(env);
}

// Same intent as withSystemCa, for every platform: corporate networks that
// intercept TLS fail npm/registry calls when Node trusts only its bundled CA
// list. The system CA store usually holds the interception certificate.
export function withSystemCaAnyPlatform(env = process.env) {
  const options = env.NODE_OPTIONS ?? "";
  if (options.includes("--use-system-ca") || options.includes("--use-openssl-ca")) return env;
  return { ...env, NODE_OPTIONS: `${options} --use-system-ca`.trim() };
}

// Certificate-chain failures worth retrying with the system CA store.
const CERT_ERROR_PATTERNS = [
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
  /unable to verify the first certificate/i,
  /unable to get local issuer certificate/i,
  /SELF_SIGNED_CERT_IN_CHAIN/i,
  /self[- ]signed certificate/i,
  /certificate has expired/i,
];

export function isCertificateError(output) {
  const text = String(output ?? "");
  return CERT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function openCodeZenApiKey({ home = os.homedir(), env = process.env } = {}) {
  const fromEnvironment = env.OPENCODE_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;

  const authPath = openCodeAuthPath(home, env);
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`no se pudo leer credenciales OpenCode (${authPath}): ${error.message}`);
  }

  const zen = credentials.opencode;
  return zen?.type === "api" && typeof zen.key === "string" ? zen.key.trim() || null : null;
}

export function jevMcpEntry(configDir) {
  const moduleEntry = createRequire(path.join(configDir, "package.json")).resolve("@jkudish/jev-mcp");
  const entry = path.join(path.dirname(moduleEntry), "index.js");
  if (!fs.existsSync(entry)) throw new Error(`binario JEV MCP ausente: ${entry}`);
  return entry;
}
