// graphify OpenCode plugin
// Injects a knowledge graph reminder before bash tool calls when the graph exists.
//
// IMPORTANT: keep the reminder string free of backticks and $(...) constructs.
// The hook prepends `echo "<reminder>" && <cmd>` to the user's bash command;
// backticks inside the double-quoted echo trigger bash command substitution,
// which both corrupts tool output and silently executes the very graphify
// command we are only suggesting. Plain words render fine in opencode's TUI.
//
// Two plugin contracts, one module (opencode 1.x and 2.x):
//   - `server` is the 1.x contract: the host calls it with the 1.x context
//     ({client, project, directory, worktree, ...}) and expects the 1.x hooks.
//   - `setup` is the 2.x contract: the host calls it with the 2.x context and
//     expects `id` + `setup`. 1.x also calls `setup` when it is present, but
//     with a partial context (no `tool` domain), so the guard below keeps the
//     2.x path inert on 1.x and avoids registering every hook twice.
import { existsSync } from "fs";
import { join } from "path";

const REMINDER =
  'echo "[graphify] knowledge graph at graphify-out/. For focused questions, run graphify query with your question (scoped subgraph, usually much smaller than GRAPH_REPORT.md) instead of grepping raw files. Read GRAPH_REPORT.md only for broad architecture context." ; ';

// 1.x contract.
export const GraphifyPlugin = async ({ directory }) => {
  let reminded = false;

  return {
    "tool.execute.before": async (input, output) => {
      if (reminded) return;
      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;

      if (input.tool === "bash") {
        // ';' not '&&' — Windows PowerShell 5.1 rejects '&&' as a statement
        // separator, breaking the first bash command of the session (#1646).
        output.args.command = REMINDER + output.args.command;
        reminded = true;
      }
    },
  };
};

// 2.x contract. Only active on a 2.x host: the 1.x context has no `tool`.
async function setupV2(ctx) {
  if (!ctx || typeof ctx.tool?.hook !== "function") return;

  const directory = ctx.location?.directory ?? ctx.directory;
  if (!directory) return;
  let reminded = false;

  await ctx.tool.hook("execute.before", async (input) => {
    try {
      if (reminded) return;
      if (input?.tool !== "bash") return;
      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;

      const args = input?.input;
      if (!args || typeof args !== "object") return;
      if (typeof args.command !== "string") return;

      args.command = REMINDER + args.command;
      reminded = true;
    } catch (error) {
      // A hook must never break the tool call it is decorating.
    }
  });
}

export default {
  id: "habitat-graphify",
  server: GraphifyPlugin,
  setup: setupV2,
};
