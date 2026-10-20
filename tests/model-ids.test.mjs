// tests/model-ids.test.mjs — validacion de IDs de modelo contra el catalogo.
//
// El check `model-ids` decide si los IDs configurados siguen existiendo. Un
// falso positivo ahi rompe la instalacion de todo el mundo, y un falso
// negativo deja un ID muerto desplegandose solo.
//
// El CLI de OpenCode se sustituye por un stub en el PATH, asi que el caso es
// determinista y no depende de la red ni de la credencial.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyTool = path.join(root, "tools", "verify.mjs");

const VALID_PUBLIC = "opencode/mimo-v2.6-flash-free";
const VALID_AUTH = "opencode-go/mimo-v2.6-pro";
const RETIRED_PUBLIC = "opencode/retirado-ayer";

// Un catalogo publico completo: 25 modelos del namespace `opencode`.
const FULL_PUBLIC_CATALOG = Array.from({ length: 25 }, (_, i) => `opencode/modelo-${i}`);
// El namespace autenticado solo aparece con credencial: es la senal de que el
// catalogo devuelto esta completo.
const AUTH_MARKER = "opencode-go/alguna-cosa";

function makeHome(t, overrides) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-modelids-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".config", "opencode", "gsd-router");
  fs.mkdirSync(dir, { recursive: true });
  for (const profile of ["easy", "medium", "hard"]) {
    fs.writeFileSync(
      path.join(dir, `${profile}.json`),
      JSON.stringify({ name: profile, model_overrides: overrides }, null, 2) + "\n",
    );
  }
  return home;
}

// Stub del CLI `opencode`: imprime el catalogo o falla, segun el caso.
function stubOpencode(t, { models, fail = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-stub-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (process.platform === "win32") {
    const file = path.join(dir, "opencode.cmd");
    const body = fail
      ? "@echo off\r\nexit /b 1\r\n"
      : `@echo off\r\n${models.map((m) => `echo ${m}`).join("\r\n")}\r\n`;
    fs.writeFileSync(file, body);
  } else {
    const file = path.join(dir, "opencode");
    const body = fail
      ? "#!/usr/bin/env bash\nexit 1\n"
      : `#!/usr/bin/env bash\ncat <<'CATALOG'\n${models.join("\n")}\nCATALOG\n`;
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function runVerify(home, stubDir) {
  const result = spawnSync(
    process.execPath,
    [verifyTool, "--home", home, "--repo", root, "--no-cli", "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}` },
    },
  );
  const payload = JSON.parse(result.stdout);
  return payload.checks.find((entry) => entry.name === "model-ids");
}

// Un ID publico que ya no esta en el catalogo es un problema real: la
// instalacion de los usuarios fallaria.
test("model-ids: un id publico retirado falla con el catalogo completo", (t) => {
  const home = makeHome(t, { "gsd-codebase-mapper": RETIRED_PUBLIC });
  const stub = stubOpencode(t, {
    models: [...FULL_PUBLIC_CATALOG, VALID_PUBLIC, AUTH_MARKER],
  });

  const check = runVerify(home, stub);
  assert.equal(check.ok, false, "un id retirado debe fallar el check");
  assert.match(check.detail, new RegExp(RETIRED_PUBLIC));
});

// Sin credencial, el catalogo es un subconjunto que todavia anuncia modelos
// que OpenCode ya retiro: no hay veredicto posible y el check no puede fallar.
test("model-ids: sin el namespace autenticado no se emite veredicto", (t) => {
  const home = makeHome(t, {
    "gsd-codebase-mapper": RETIRED_PUBLIC,
    "gsd-code-reviewer": VALID_AUTH,
  });
  const stub = stubOpencode(t, { models: [...FULL_PUBLIC_CATALOG, VALID_PUBLIC] });

  const check = runVerify(home, stub);
  assert.equal(check.ok, true, `no debe fallar: ${check.detail}`);
  assert.equal(check.skipped, true, "queda como no verificado, no como error");
});

// Un ID del namespace autenticado no se puede dar por invalido si ese
// namespace entero no aparece en el catalogo.
test("model-ids: un id del namespace autenticado no falla si el namespace no aparece", (t) => {
  const home = makeHome(t, { "gsd-code-reviewer": VALID_AUTH });
  const stub = stubOpencode(t, { models: [...FULL_PUBLIC_CATALOG, VALID_PUBLIC] });

  const check = runVerify(home, stub);
  assert.equal(check.ok, true, `no debe fallar: ${check.detail}`);
  assert.equal(check.skipped, true, "queda como no verificado, no como error");
});

// Con el catalogo completo, un id publico roto se detecta igual aunque el
// namespace autenticado no este disponible.
test("model-ids: un id publico roto se detecta con el namespace autenticado", (t) => {
  const home = makeHome(t, {
    "gsd-codebase-mapper": RETIRED_PUBLIC,
    "gsd-code-reviewer": VALID_AUTH,
  });
  const stub = stubOpencode(t, {
    models: [...FULL_PUBLIC_CATALOG, VALID_PUBLIC, AUTH_MARKER],
  });

  const check = runVerify(home, stub);
  assert.equal(check.ok, false, "el id publico roto debe fallar el check");
  assert.match(check.detail, new RegExp(RETIRED_PUBLIC));
});

// Todos los ids presentes: el check pasa.
test("model-ids: con todos los ids presentes el check pasa", (t) => {
  const home = makeHome(t, {
    "gsd-codebase-mapper": VALID_PUBLIC,
    "gsd-code-reviewer": VALID_AUTH,
  });
  const stub = stubOpencode(t, {
    models: [...FULL_PUBLIC_CATALOG, VALID_PUBLIC, VALID_AUTH, AUTH_MARKER],
  });

  const check = runVerify(home, stub);
  assert.equal(check.ok, true, check.detail);
  assert.notEqual(check.skipped, true);
});

// Un catalogo chico esta truncado (falta la credencial): no se puede emitir
// un veredicto y el check no puede fallar.
test("model-ids: un catalogo truncado no falla", (t) => {
  const home = makeHome(t, { "gsd-codebase-mapper": RETIRED_PUBLIC });
  const stub = stubOpencode(t, { models: ["opencode/uno", "opencode/dos"] });

  const check = runVerify(home, stub);
  assert.equal(check.ok, true, "un catalogo truncado no puede fallar");
  assert.equal(check.skipped, true);
});

// Si el catalogo no se puede consultar (sin red), tampoco puede fallar.
test("model-ids: si el catalogo no responde no falla", (t) => {
  const home = makeHome(t, { "gsd-codebase-mapper": RETIRED_PUBLIC });
  const stub = stubOpencode(t, { fail: true });

  const check = runVerify(home, stub);
  assert.equal(check.ok, true, "sin catalogo no hay veredicto");
  assert.equal(check.skipped, true);
});
