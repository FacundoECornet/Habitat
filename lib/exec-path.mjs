import fs from "node:fs";
import path from "node:path";

// Resolve an executable the way Windows does it: an explicit .exe/.cmd/.bat
// sitting on PATH. Returns null when nothing matches, so a missing optional
// CLI is reported as "not installed" instead of "broken".
//
// On POSIX the command is resolved by the OS itself, so the name is returned
// unchanged and a missing binary surfaces as the usual ENOENT error.
export function findExecutable(command, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return command;
  if (command.includes("/") || command.includes("\\")) return command;
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
