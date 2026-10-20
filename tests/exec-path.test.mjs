import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findExecutable } from "../lib/exec-path.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habitat-exec-path-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("POSIX resolves the command as-is", () => {
  assert.equal(findExecutable("gsd-sdk", { platform: "linux", env: { PATH: "/usr/bin" } }), "gsd-sdk");
});

test("win32 finds an explicit .cmd on PATH", (t) => {
  const dir = tempDir(t);
  const shim = path.join(dir, "gsd-sdk.cmd");
  fs.writeFileSync(shim, "@echo off\r\n");
  assert.equal(findExecutable("gsd-sdk", { platform: "win32", env: { PATH: dir } }), shim);
});

test("win32 finds an explicit .exe on PATH", (t) => {
  const dir = tempDir(t);
  const shim = path.join(dir, "graphify.exe");
  fs.writeFileSync(shim, "");
  assert.equal(findExecutable("graphify", { platform: "win32", env: { PATH: dir } }), shim);
});

test("win32 returns null when the command is not installed", (t) => {
  const dir = tempDir(t);
  assert.equal(findExecutable("gsd-sdk", { platform: "win32", env: { PATH: dir } }), null);
});

test("win32 never resolves a .ps1 shim", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "opencode.ps1"), "");
  assert.equal(findExecutable("opencode", { platform: "win32", env: { PATH: dir } }), null);
});

test("an explicit path is returned unchanged", () => {
  const target = path.join("C:", "tools", "gsd-sdk.cmd");
  assert.equal(findExecutable(target, { platform: "win32", env: { PATH: "" } }), target);
});
