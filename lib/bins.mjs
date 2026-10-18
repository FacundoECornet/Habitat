// lib/bins.mjs — pure helpers for planning ~/bin materialization (W2).
//
// POSIX: tools/<name>.mjs is copied to ~/bin/<name> and marked executable.
// win32: there is no shebang, so the engine copies ~/bin/<name>.mjs and emits a
// ~/bin/<name>.cmd shim (`node "%~dp0<name>.mjs" %*`) — the same shape npm
// itself uses, and it sidesteps the ExecutionPolicy that blocks `.ps1`.

export const BIN_NAME_OVERRIDES = { "route.mjs": "gsd-route" };

export function binBase(entry) {
  return BIN_NAME_OVERRIDES[entry] ?? entry.replace(/\.mjs$/, "");
}

// Pure plan: which files to write for each source entry on a given platform.
// targets[].kind is "copy" (the engine bytes) or "shim" (generated launcher).
export function planBin(sourceEntries, platform) {
  const win = platform === "win32";
  const plan = [];
  for (const entry of sourceEntries) {
    if (!entry.endsWith(".mjs")) continue;
    const base = binBase(entry);
    if (win) {
      plan.push({
        base,
        source: entry,
        targets: [
          { name: `${base}.mjs`, kind: "copy" },
          { name: `${base}.cmd`, kind: "shim" },
        ],
      });
    } else {
      plan.push({ base, source: entry, targets: [{ name: base, kind: "copy" }] });
    }
  }
  return plan;
}

export function cmdShim(base) {
  return `@echo off\r\nnode "%~dp0${base}.mjs" %*\r\n`;
}
