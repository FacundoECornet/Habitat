#!/usr/bin/env node
// tools/install.mjs — cross-platform habitat installer (VER-01/VER-02 entry point).
//
// Phases (each skippable, each idempotent):
//   1. detect      OS/arch detection (Windows native / WSL / Linux / macOS)
//   2. deps        optional (--with-deps): npm globals + graphifyy
//   3. gsd         optional (--with-gsd): run the GSD installer, then re-apply the
//                  anchored §5.5 patch and the $HOME path sanitization, both
//                  checksum-verified (a mismatch is reported, never silently patched)
//   4. bin         copy tools/* to <home>/bin with a timestamped backup
//   5. jevenv      create ~/.config/opencode/jev.env from jev.env.example if absent
//   6. restore     scripts/restore.sh
//   7. verify      tools/verify.mjs
//
// The installer never writes credentials: jev.env is only created when absent and
// only carries names. Backups are timestamped siblings; nothing is deleted.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const DEPS = {
  gsd: "get-shit-done-cc@1.42.3",
  contextMode: "context-mode@1.0.169",
  graphify: "graphifyy==0.9.14",
};

const ABSOLUTE_BIN_RE =
  /(^|[\s"'`(:=])(\/[^\s"'`);|&]+\/get-shit-done\/bin\/(gsd-tools\.cjs|install\.js))/g;

// tools/*.mjs → ~/bin/<name>; a few commands are documented under a different
// name than their source file (route.mjs is the gsd-route CLI).
const BIN_NAME_OVERRIDES = { "route.mjs": "gsd-route" };

function parseArgs(argv) {
  const options = {
    home: os.homedir(),
    repo: path.resolve(import.meta.dirname, ".."),
    withDeps: false,
    withGsd: false,
    skipRestore: false,
    skipVerify: false,
    skipPlugins: false,
    dryRun: false,
    verifyArgs: [],
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--home") options.home = path.resolve(args[++i]);
    else if (arg === "--repo") options.repo = path.resolve(args[++i]);
    else if (arg === "--with-deps") options.withDeps = true;
    else if (arg === "--with-gsd") options.withGsd = true;
    else if (arg === "--skip-restore") options.skipRestore = true;
    else if (arg === "--skip-verify") options.skipVerify = true;
    else if (arg === "--skip-plugins") options.skipPlugins = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-models" || arg === "--no-cli") options.verifyArgs.push(arg);
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: install.mjs [--home DIR] [--repo DIR] [--with-deps] [--with-gsd]",
          "                  [--skip-restore] [--skip-verify] [--skip-plugins] [--dry-run]",
          "                  [--no-models] [--no-cli]",
          "",
          "Sin --with-deps/--with-gsd solo copia tools/, crea jev.env (si falta),",
          "asegura context-mode, restaura el MANIFEST y verifica. Nada se borra:",
          "todo se respalda antes.",
        ].join("\n"),
      );
      process.exit(EXIT_OK);
    } else {
      process.stderr.write(`install: unknown argument: ${arg}\n`);
      process.exit(EXIT_USAGE);
    }
  }
  return options;
}

function log(step, message) {
  process.stdout.write(`[${step}] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`install: ${message}\n`);
}

function fail(message) {
  warn(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  return result;
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function backupFile(filePath, home) {
  if (!fs.existsSync(filePath)) return null;
  const backupDir = path.join(home, ".habitat", "backups", stamp());
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(filePath));
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function detectPlatform() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32") {
    return { family: "windows-native", arch, notes: "sin WSL: usar rutas %USERPROFILE%" };
  }
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  if (platform === "linux" && isWsl) {
    return { family: "wsl", arch, notes: "dists WSL detectada" };
  }
  if (platform === "darwin") return { family: "macos", arch, notes: "Homebrew/node requeridos" };
  if (platform === "linux") return { family: "linux", arch, notes: "paths POSIX" };
  return { family: "unknown", arch, notes: "plataforma no reconocida" };
}

function installDeps(options) {
  log("deps", "instalando dependencias globales declaradas");
  const commands = [["npm", ["install", "-g", DEPS.gsd]]];
  for (const [command, args] of commands) {
    if (run(command, args, { capture: true }).status !== 0) {
      fail(`${command} ${args.join(" ")} falló`);
      return false;
    }
  }
  const graphify = run("uv", ["tool", "install", DEPS.graphify], { capture: true });
  if (graphify.status !== 0) {
    const pipx = run("pipx", ["install", DEPS.graphify], { capture: true });
    if (pipx.status !== 0) {
      const pip = run(process.execPath, ["-m", "pip", "install", "--user", DEPS.graphify], {
        capture: true,
      });
      if (pip.status !== 0) {
        fail("graphifyy no se pudo instalar (uv/pipx/pip fallaron)");
        return false;
      }
    }
  }
  return true;
}

function npmGlobalRoot() {
  const result = run("npm", ["root", "-g"], { capture: true });
  if (result.status !== 0) return null;
  const root = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  return root ? root.trim() : null;
}

// opencode loads a bare plugin name as an npm package from the config dir's
// node_modules or from the global npm root.
function pluginResolved(name, home) {
  const configDir = path.join(home, ".config", "opencode");
  try {
    require.resolve(name, { paths: [configDir] });
    return true;
  } catch {
    const globalRoot = npmGlobalRoot();
    return globalRoot ? fs.existsSync(path.join(globalRoot, name, "package.json")) : false;
  }
}

// context-mode is declared as an npm plugin in opencode.jsonc; without it the
// plugin silently fails to load. It is ensured on every run (not only
// --with-deps) but the failure is non-fatal: restore still completes and
// tools/verify.mjs reports the missing plugin by name.
function ensurePlugins(options) {
  if (pluginResolved("context-mode", options.home)) {
    log("plugins", "context-mode ya resoluble (local o global)");
    return true;
  }
  log("plugins", `instalando ${DEPS.contextMode}`);
  const result = run("npm", ["install", "-g", DEPS.contextMode], { capture: true });
  if (result.status !== 0) {
    fail(`${DEPS.contextMode} no se pudo instalar (npm falló); verify lo reportará`);
    return false;
  }
  log("plugins", "context-mode instalado globalmente");
  return true;
}

function extractAnchors(text) {
  const pattern =
    /<!-- anchor:begin ([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- anchor:end \1 -->\n<!-- anchor:checksum \1 (sha256=[0-9a-f]+) -->/g;
  const anchors = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    anchors.push({ name: match[1], body: match[2], checksum: match[3] });
  }
  return anchors;
}

function replaceAnchors(text, anchors) {
  let result = text;
  for (const anchor of anchors) {
    const pattern = new RegExp(
      `(<!-- anchor:begin ${anchor.name} -->\\n)[\\s\\S]*?(\\n<!-- anchor:end ${anchor.name} -->)`,
    );
    if (!pattern.test(result)) continue;
    const safeName = anchor.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(pattern, `$1${anchor.body}$2`);
    result = result.replace(
      new RegExp(`(<!-- anchor:checksum ${safeName} )sha256=[0-9a-f]+( -->)`),
      `$1${anchor.checksum}$2`,
    );
  }
  return result;
}

function sanitizePaths(text) {
  return text.replace(ABSOLUTE_BIN_RE, (match, boundary, _absolute, base) => {
    const quoted = `"$HOME/.config/opencode/get-shit-done/bin/${base}"`;
    return boundary + quoted.slice(1, -1);
  });
}

function patchedGsdStep(options) {
  const target = path.join(options.home, ".config", "opencode", "get-shit-done");
  if (!fs.existsSync(target)) {
    log("gsd", "get-shit-done no está instalado en el home destino; se omite el parche");
    return true;
  }
  const problems = [];
  const files = [
    "workflows/new-project.md",
    "references/model-profile-resolution.md",
    "command/gsd-graphify.md",
    "command/gsd-import.md",
    "workflows/execute-phase.md",
  ];
  for (const relative of files) {
    const repoPath = path.join(options.repo, "home", ".config", "opencode", "get-shit-done", relative);
    const destPath = path.join(target, relative);
    if (!fs.existsSync(repoPath) || !fs.existsSync(destPath)) continue;
    const repoAnchors = extractAnchors(fs.readFileSync(repoPath, "utf8"));
    const destAnchors = extractAnchors(fs.readFileSync(destPath, "utf8"));
    if (repoAnchors.length === 0) continue;
    if (destAnchors.length === 0) {
      problems.push(`${relative}: sin anclas (el instalador reescribió el archivo)`);
      continue;
    }
    const checksumOf = (body) => `sha256=${sha256(body)}`;
    for (const repoAnchor of repoAnchors) {
      const destAnchor = destAnchors.find((entry) => entry.name === repoAnchor.name);
      if (!destAnchor) {
        problems.push(`${relative}: ancla ${repoAnchor.name} ausente`);
        continue;
      }
      if (destAnchor.checksum !== checksumOf(destAnchor.body)) {
        problems.push(`${relative}: checksum del bloque ${repoAnchor.name} no coincide`);
        continue;
      }
      if (repoAnchor.checksum !== checksumOf(repoAnchor.body)) {
        problems.push(`${relative}: checksum del repo inválido`);
        continue;
      }
      if (options.dryRun) {
        log("gsd", `dry-run: ${relative} ancla ${repoAnchor.name} se actualizaría`);
        continue;
      }
      const current = fs.readFileSync(destPath, "utf8");
      const next = replaceAnchors(current, [repoAnchor]);
      if (next !== current) {
        backupFile(destPath, options.home);
        fs.writeFileSync(destPath, next, "utf8");
        log("gsd", `${relative}: ancla ${repoAnchor.name} parcheada`);
      }
    }
  }

  const binRoot = path.join(target, "bin");
  if (fs.existsSync(binRoot)) {
    for (const entry of fs.readdirSync(binRoot)) {
      if (!entry.endsWith(".cjs") && !entry.endsWith(".js")) continue;
      const filePath = path.join(binRoot, entry);
      const before = fs.readFileSync(filePath, "utf8");
      const after = sanitizePaths(before);
      if (after !== before) {
        if (options.dryRun) {
          log("gsd", `dry-run: ${entry} se sanearía`);
          continue;
        }
        backupFile(filePath, options.home);
        fs.writeFileSync(filePath, after, "utf8");
        log("gsd", `${entry}: rutas absolutas saneadas a $HOME`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) fail(`parche no aplicado — ${problem}`);
    return false;
  }
  return true;
}

function copyBin(options) {
  const source = path.join(options.repo, "tools");
  const binDir = path.join(options.home, "bin");
  if (!options.dryRun && !fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
  const copied = [];
  for (const entry of fs.readdirSync(source)) {
    if (!entry.endsWith(".mjs")) continue;
    const base = BIN_NAME_OVERRIDES[entry] ?? entry.replace(/\.mjs$/, "");
    const target = path.join(binDir, base);
    if (!options.dryRun) {
      if (fs.existsSync(target)) backupFile(target, options.home);
      fs.copyFileSync(path.join(source, entry), target);
      fs.chmodSync(target, 0o755);
    }
    copied.push(path.basename(target));
  }
  if (options.dryRun) log("bin", `dry-run: se copiarían ${copied.length} herramientas a ${binDir}`);
  else log("bin", `${copied.length} herramientas copiadas a ${binDir}`);
  return true;
}

function ensureJevEnv(options) {
  const example = path.join(options.repo, "jev.env.example");
  const target = path.join(options.home, ".config", "opencode", "jev.env");
  if (fs.existsSync(target)) {
    log("jevenv", `${target} ya existe — no se toca`);
    return true;
  }
  if (options.dryRun) {
    log("jevenv", `dry-run: se crearía ${target} desde jev.env.example`);
    return true;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(example, target);
  fs.chmodSync(target, 0o600);
  log("jevenv", `${target} creado desde jev.env.example — completá los valores a mano (nunca se commitean)`);
  return true;
}

function restoreManifest(options) {
  const engine = path.join(options.repo, "tools", "restore.mjs");
  const result = run(process.execPath, [engine], { cwd: options.repo, env: { ...process.env, HOME: options.home } });
  if (result.status !== 0) {
    fail("tools/restore.mjs falló");
    return false;
  }
  return true;
}

function verify(options) {
  const script = path.join(options.repo, "tools", "verify.mjs");
  const result = run(
    process.execPath,
    [script, "--home", options.home, "--repo", options.repo, ...options.verifyArgs],
    { cwd: options.repo },
  );
  return result.status === EXIT_OK;
}

function main() {
  const options = parseArgs(process.argv);
  const platform = detectPlatform();
  log("detect", `${platform.family} (${platform.arch}) — ${platform.notes}`);
  log("detect", `repo=${options.repo} home=${options.home}`);

  if (options.dryRun) log("detect", "modo dry-run: no se escribe nada");

  if (options.withDeps) {
    if (options.dryRun) log("deps", "dry-run: se instalarían " + JSON.stringify(DEPS));
    else if (!installDeps(options)) process.exit(EXIT_FAILED);
  } else {
    log("deps", "omitido (usar --with-deps para get-shit-done-cc y graphifyy)");
  }

  if (options.withGsd) {
    if (options.dryRun) {
      log("gsd", "dry-run: se correría el instalador GSD y se re-aplicarían los parches");
    } else {
      const install = run("npx", ["-y", "get-shit-done-cc@1.42.3", "--opencode", "--global"], {
        cwd: options.repo,
      });
      if (install.status !== 0) {
        fail("el instalador de get-shit-done-cc falló; no se parchea");
        process.exit(EXIT_FAILED);
      }
      if (!patchedGsdStep(options)) process.exit(EXIT_FAILED);
    }
  } else if (fs.existsSync(path.join(options.home, ".config", "opencode", "get-shit-done"))) {
    if (!patchedGsdStep(options)) process.exit(EXIT_FAILED);
  }

  if (!copyBin(options)) process.exit(EXIT_FAILED);
  if (!ensureJevEnv(options)) process.exit(EXIT_FAILED);

  if (options.skipPlugins) log("plugins", "omitido (--skip-plugins)");
  else if (options.dryRun) log("plugins", "dry-run: se verificaría/instalaría context-mode");
  else ensurePlugins(options);

  if (options.skipRestore) {
    log("restore", "omitido (--skip-restore)");
    warn("--skip-restore deja el home sin restaurar; tools/verify.mjs va a fallar por destinos faltantes");
  } else if (!options.dryRun && !restoreManifest(options)) {
    process.exit(EXIT_FAILED);
  }

  if (options.skipVerify) {
    log("verify", "omitido");
    process.exit(EXIT_OK);
  }
  if (options.dryRun) {
    log("verify", "dry-run: se ejecutaría tools/verify.mjs");
    process.exit(EXIT_OK);
  }
  process.exit(verify(options) ? EXIT_OK : EXIT_FAILED);
}

main();
