import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A symlink in the payload is never followed by the restore engine, but it
// would still point somewhere on the user's machine: the snapshot must be
// plain files.
test("the payload ships no symlinks", (t) => {
  const listed = spawnSync("git", ["ls-files", "-s", "home"], { cwd: root, encoding: "utf8" });
  if (listed.status !== 0) {
    t.skip("git no disponible");
    return;
  }
  const symlinks = listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("120000"))
    .map((line) => line.split(/\s+/).slice(3).join(" "));
  assert.deepEqual(symlinks, [], `el payload no debe contener symlinks: ${symlinks.join(", ")}`);
});
