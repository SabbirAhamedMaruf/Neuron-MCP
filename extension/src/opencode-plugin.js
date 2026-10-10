// The OpenCode plugin Connect writes to ~/.config/opencode/plugins/neurons.js: OpenCode has no command hooks, so this plays their part
export const OPENCODE_PLUGIN_NAME = 'neurons.js';

// Marks the file as ours, so Disconnect removes only this plugin and status can tell which build it runs
export const OPENCODE_PLUGIN_MARK = '// NEURONS_PLUGIN';

export function opencodePlugin({ node, hookScript, dataDir }) {
  return `${OPENCODE_PLUGIN_MARK}
// Written by the Neurons editor extension (Connect); reconnecting overwrites it, Disconnect removes it.
// Messages from other agents reach the model as context after each tool call, like Claude Code's hooks; the chat is untouched.
import { spawn } from "node:child_process";

const NODE = ${JSON.stringify(node)};
const ARGS = ${JSON.stringify([hookScript, 'hook', '--agent', 'opencode', ...(dataDir ? ['--data-dir', dataDir] : [])])};

// Runs the Neurons hook with a Claude-style event and returns its JSON answer, or null; a hook that hangs is stopped
// after 10 s, so it never holds up a tool call
function hook(input) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(NODE, ARGS, { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(out.trim() ? JSON.parse(out) : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export const NeuronsPlugin = async ({ directory }) => {
  const registered = new Set();
  // Subagent sessions are left alone; only the session you talk to gets messages
  const children = new Set();
  const register = async (sessionID) => {
    if (registered.has(sessionID)) return;
    registered.add(sessionID);
    await hook({ session_id: sessionID, cwd: directory, hook_event_name: "Register" });
  };
  return {
    "tool.execute.after": async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID || children.has(sessionID)) return;
      await register(sessionID);
      const text = (await hook({ session_id: sessionID, cwd: directory, hook_event_name: "PostToolUse", tool_name: input.tool }))?.hookSpecificOutput?.additionalContext;
      if (!text) return;
      // An MCP tool's result is a content list; a built-in tool's is its output text
      if (Array.isArray(output?.content)) output.content.push({ type: "text", text });
      else if (output && typeof output.output === "string") output.output += "\\n\\n" + text;
    },
    event: async ({ event }) => {
      const info = event?.properties?.info;
      if ((event?.type === "session.created" || event?.type === "session.updated") && info?.id && info.parentID) children.add(info.id);
      if (event?.type !== "session.idle") return;
      const sessionID = event.properties?.sessionID;
      if (!sessionID || children.has(sessionID)) return;
      await register(sessionID);
      // A finished turn refreshes the session's automatic handoff (git facts only)
      await hook({ session_id: sessionID, cwd: directory, hook_event_name: "Stop" });
    },
  };
};
`;
}
