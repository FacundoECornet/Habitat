#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testsDir, name));

if (files.length === 0) {
  process.stderr.write("test: no .test.mjs files found\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`test: could not start Node test runner: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
