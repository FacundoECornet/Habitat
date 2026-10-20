import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  jevMcpEntry,
  openCodeAuthPath,
  openCodeZenApiKey,
  withSystemCa,
} from "../lib/opencode-auth.mjs";
import { MCP_MISSING_HINT, mcpPackageInstalled, payloadConfigDir } from "./helpers/mcp-deps.mjs";

function temporaryDataHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "habitat-auth-test-"));
}

test("reads OpenCode Zen key from auth store under XDG_DATA_HOME", (t) => {
  const dataHome = temporaryDataHome();
  t.after(() => fs.rmSync(dataHome, { recursive: true, force: true }));
  const authPath = openCodeAuthPath(os.tmpdir(), { XDG_DATA_HOME: dataHome });
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ opencode: { type: "api", key: "zen-secret" } }));

  assert.equal(
    openCodeZenApiKey({ home: os.tmpdir(), env: { XDG_DATA_HOME: dataHome } }),
    "zen-secret",
  );
});

test("prefers OPENCODE_API_KEY environment override", (t) => {
  const dataHome = temporaryDataHome();
  t.after(() => fs.rmSync(dataHome, { recursive: true, force: true }));
  assert.equal(
    openCodeZenApiKey({ home: os.tmpdir(), env: { OPENCODE_API_KEY: "override", XDG_DATA_HOME: dataHome } }),
    "override",
  );
});

test("returns null when OpenCode Zen credential is absent", (t) => {
  const dataHome = temporaryDataHome();
  t.after(() => fs.rmSync(dataHome, { recursive: true, force: true }));
  assert.equal(openCodeZenApiKey({ home: os.tmpdir(), env: { XDG_DATA_HOME: dataHome } }), null);
});

test("resolves executable MCP entrypoint from the installed package", (t) => {
  if (!mcpPackageInstalled()) {
    t.skip(MCP_MISSING_HINT);
    return;
  }
  assert.equal(path.basename(jevMcpEntry(payloadConfigDir)), "index.js");
});

test("adds Windows system CA without overriding existing Node options", () => {
  assert.deepEqual(withSystemCa({ NODE_OPTIONS: "--trace-warnings" }, "win32"), {
    NODE_OPTIONS: "--trace-warnings --use-system-ca",
  });
  assert.equal(
    withSystemCa({ NODE_OPTIONS: "--use-openssl-ca" }, "win32").NODE_OPTIONS,
    "--use-openssl-ca",
  );
  assert.equal(withSystemCa({ NODE_OPTIONS: "" }, "linux").NODE_OPTIONS, "");
});
