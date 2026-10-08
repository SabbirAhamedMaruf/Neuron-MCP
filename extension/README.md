# Neurons

A dashboard for Neurons MCP, the local server through which coding agents on one machine ask each other questions, hand work over and review each other's code. It works in VS Code and VSCodium on Linux, macOS and Windows.

## What you get

- **A Neurons icon in the activity bar.** It opens a dashboard in the sidebar. **Open in editor** shows the same dashboard in a full editor tab.
- **Agents.** Claude Code, Codex, Gemini CLI and OpenCode are detected automatically. Each agent shows:
  - whether it is connected to Neurons;
  - which of its sessions are running, with model, repo and task.

  **Connect** writes that agent's *global* MCP configuration, plus its hooks for Claude Code and Codex, in one click. **Disconnect** removes them again.
- **Call popup.** A listening agent window shows the call itself (Pick up / Not here / Decline), when its client supports MCP forms.
- **Calls.** When an agent calls another agent, the call rings here with an **Accept on …** button for each session. Pick one and it gets the message; from then on that line carries every message between the two until you press **Hang up**. **Decline** stops the ringing.
- **Auto-answer and listening.** Each session has an **Auto-answer** switch: when it is on, that session picks up calls to its agent by itself. A **listening** badge shows sessions waiting in listen mode, which also pick up by themselves.
- **Auto-listen switch** (beside the Agents heading, on by default). When it is on, Claude Code and Codex go on listening for messages each time they finish a turn, so a message is answered at once. Press Stop (Esc in Claude Code) in an agent to give it new work.
- **Live feed.** Who asked whom what, and the replies, updated as it happens. Click a row to open the whole conversation.
- **History.** Search all messages, and filter by agent or kind.
- **Handoffs, Reviews, Notes and Claims.** Every record Neurons keeps, readable in full and deletable one by one.
- **Storage.** The database size and counts. You can clear any category, or delete everything. Every bulk delete saves a backup first, and the newest 5 backups are kept.
- **Status bar.** The number of connected agents, and a highlighted "ringing" while a call waits for you. Click it to open the dashboard. Neither the status bar nor the dashboard ever prompts an agent.

## Requirements

Node.js 22.13 or newer. The extension finds it on your PATH, or in the usual install folders: Homebrew, nvm, Volta, fnm, asdf, mise, and the Windows installer. You can also set `neurons.nodePath`. Git is needed for repo features.

## What Connect writes

| agent | MCP config (user-level) | hooks |
|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers.neurons` | `~/.claude/settings.json`: SessionStart, UserPromptSubmit, PreToolUse (edits), PostToolUse (every tool), Stop |
| Codex | `~/.codex/config.toml` → `[mcp_servers.neurons]`, `tool_timeout_sec = 960` for listen mode | `~/.codex/hooks.json`: the same five. Trust them once with `/hooks` in Codex. |
| Gemini CLI | `~/.gemini/settings.json` → `mcpServers.neurons` | the same file: SessionStart, BeforeAgent, AfterTool, AfterAgent |
| OpenCode | `~/.config/opencode/opencode.json` → `mcp.neurons` | a plugin, `~/.config/opencode/plugins/neurons.js` (never one of your own of that name) |

- The server it registers is copied to `<data folder>/app/`, so agent configs survive extension updates. That copy is refreshed whenever the extension updates.
- Before a config file is changed, the previous version is kept next to it as `*.neurons.bak`.
- A file that cannot be parsed is never rewritten. Neither is a commented `opencode.jsonc`.
- Open agent sessions load the change when they are restarted.

The data folder is:

- `~/.local/share/neurons-mcp` on Linux
- `~/Library/Application Support/neurons-mcp` on macOS
- `%LOCALAPPDATA%\neurons-mcp` on Windows

## Privacy

The dashboard reads and deletes only Neurons' own database. It never opens an agent's memory files, chats or credentials, and nothing leaves your machine.
