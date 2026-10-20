// tests/release-workflow.test.mjs — garantias del workflow de release.
//
// Publicar una version crea un tag inmutable: si el tag sale mal, no se puede
// mover. El workflow es manual a proposito y tiene que seguir siendolo, asi
// que estas propiedades quedan fijadas por test.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(root, ".github", "workflows", "release.yml");
// The file is read from the working tree, which on Windows can be CRLF: the
// assertions have to look at the content, not at the line endings.
const workflow = fs.readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");

// La release nunca se publica sola: siempre con una decision humana.
test("release: solo se dispara a mano", () => {
  assert.match(workflow, /workflow_dispatch:/, "el workflow es manual");
  for (const trigger of ["push:", "schedule:", "pull_request:"]) {
    assert.equal(
      workflow.includes(trigger),
      false,
      `el workflow no debe dispararse con ${trigger}`,
    );
  }
});

// Un tag ya publicado no se toca: los tags son inmutables.
test("release: se niega a publicar un tag que ya existe", () => {
  assert.match(workflow, /el tag \$VERSION ya existe/, "hay que comprobar el tag");
  assert.equal(
    /git push[^|]*--force/.test(workflow),
    false,
    "nunca se fuerza el push de un tag",
  );
  assert.equal(workflow.includes("git tag -f"), false, "nunca se reescribe un tag");
});

// Nada se publica sin las notas escritas y la CI en verde.
test("release: exige notas en el CHANGELOG y CI en verde", () => {
  assert.match(workflow, /el CHANGELOG no tiene la seccion/, "exige la seccion del CHANGELOG");
  assert.match(workflow, /la CI de master no esta en verde/, "exige la CI en verde");
  // The green run has to be the CI workflow's, not this workflow's own run
  // (which also happens on master).
  assert.match(workflow, /--workflow ci\.yml/, "mira el run del workflow de CI");
  assert.match(workflow, /--event push/, "mira el run de push de la CI");
  assert.match(workflow, /la CI no corrio sobre este commit/, "exige que la CI sea de este commit");
  assert.match(workflow, /release-notes\.md/, "las notas salen del CHANGELOG");
});

// El permiso que necesita es solo el de escribir contenidos: nada mas.
test("release: pide solo el permiso que necesita", () => {
  assert.match(workflow, /^permissions:\n  contents: write$/m, "solo contents: write");
  assert.equal(workflow.includes("issues: write"), false, "no hace falta escribir issues");
  assert.equal(workflow.includes("packages: write"), false, "no hace falta publicar paquetes");
});
