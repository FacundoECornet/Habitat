// tests/manifest.test.mjs — contrato del manifiesto, validado por los dos validadores.
//
// El repositorio tiene dos validadores del mismo manifiesto: uno en Node
// (lib/manifest.mjs, el que usan restore y verify) y otro en Bash
// (scripts/validate-manifest.sh, el que usa la captura). Si uno acepta algo
// que el otro rechaza, el mismo manifiesto es valido para una mitad del
// producto y no para la otra. Esta suite los mantiene en sync.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "MANIFEST.json");
const bashValidator = path.join(root, "scripts", "validate-manifest.sh");

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function writeManifest(t, doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-manifest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "MANIFEST.json");
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return file;
}

function validateWithBash(file) {
  const result = spawnSync("bash", [bashValidator, file], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr ?? "" };
}

function validateWithNode(file) {
  // A dynamic import needs a file URL: a Windows path is not a valid
  // specifier.
  const specifier = pathToFileURL(path.join(root, "lib", "manifest.mjs")).href;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(specifier)}).then((m) => {
        try { m.loadValidatedManifest(${JSON.stringify(file)}); process.exit(0); }
        catch (error) { process.stderr.write(String(error.message)); process.exit(2); }
      })`,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

function both(file) {
  return { bash: validateWithBash(file), node: validateWithNode(file) };
}

// El manifiesto real tiene que pasar en los dos validadores.
test("manifest: el manifiesto real es valido en los dos validadores", () => {
  const result = both(manifestPath);
  assert.equal(result.bash.status, 0, result.bash.stderr);
  assert.equal(result.node.status, 0, result.node.stderr);
});

// Un manifiesto sin un exclude obligatorio se rechaza en los dos.
test("manifest: sin un exclude obligatorio lo rechazan los dos validadores", (t) => {
  const doc = readManifest();
  doc.entries[0].excludes = doc.entries[0].excludes.filter((x) => x !== "*.backup-*");
  const result = both(writeManifest(t, doc));
  assert.equal(result.bash.status, 2, "el validador de Bash lo rechaza");
  assert.equal(result.node.status, 2, "el validador de Node lo rechaza");
});

// Y sin el exclude que exige la raiz de GSD, tambien.
test("manifest: sin el exclude de la raiz de GSD lo rechazan los dos validadores", (t) => {
  const doc = readManifest();
  const entry = doc.entries.find((e) => e.origin === ".gsd");
  entry.excludes = entry.excludes.filter((x) => x !== "backup-*");
  const result = both(writeManifest(t, doc));
  assert.equal(result.bash.status, 2, "el validador de Bash lo rechaza");
  assert.equal(result.node.status, 2, "el validador de Node lo rechaza");
});

// Una raiz fuera de la allowlist se rechaza en los dos.
test("manifest: una raiz fuera de la allowlist la rechazan los dos validadores", (t) => {
  const doc = readManifest();
  doc.entries[0].origin = ".ssh";
  const result = both(writeManifest(t, doc));
  assert.equal(result.bash.status, 2);
  assert.equal(result.node.status, 2);
});
