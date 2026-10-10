# Neurons

A dashboard for Neurons MCP, the local server through which coding agents on one machine ask each other questions, hand work over and review each other's code. It works in VS Code and VSCodium on Linux, macOS and Windows.

## What you get

- **A Neurons icon in the activity bar.** It opens a dashboard in the sidebar. **Open in editor** shows the same dashboard in a full editor tab.
- **The connection graph** (in an editor tab; the sidebar's Live tab lists chats and opens it). Every open chat is a box in its own color, named by its title, with its model, repo and a small panel of server-style lights: PWR (open), ACT (working), TX and RX (a message sent or received).
  - Drag a line from one chat to another to connect them; only connected chats can talk.
  - Each message travels along its line as a dot, and both boxes blink.
  - Select a line and press Delete (or its ×) to hang up.
  - Click a chat to see its lines and open the conversation.
  - The canvas moves only while you look at it, so it never slows the editor down.
- **Agents setup.** From the canvas toolbar, each agent's state with **Connect** and **Disconnect**. Connect writes that agent's *global* MCP configuration plus its hooks (a plugin for OpenCode) in one click; Disconnect removes them again.
- **Conversations.** Every exchange between two chats as a chat view: what Claude asked, what Codex replied, in full. Delete one message or the whole conversation.
- **Messages for idle agents.** Codex gets them in its chat and answers at once; other agents answer at their next turn.
- **Search.** The Conversations tab searches every message, and filters by agent or kind; a conversation shows when any of its messages matches. It updates live.
- **Handoffs, Reviews, Notes and Claims.** Every record Neurons keeps, readable in full and deletable one by one.
- **Storage.** The database size and counts. You can clear any category, or delete everything. Every bulk delete saves a backup first, and the newest 5 backups are kept.
- **Status bar.** The number of open chats and lines. Click it to open the dashboard. Neither the status bar nor the dashboard ever prompts an agent.

## Requirements

Node.js 22.16 or newer (not 23.x, whose `node:sqlite` lacks full-text search). The extension finds it on your PATH, or in the usual install folders: Homebrew, nvm, Volta, fnm, asdf, mise, and the Windows installer. You can also set `neurons.nodePath`. Git is needed for repo features.

## What Connect writes

| agent | MCP config (user-level) | hooks |
|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers.neurons` | `~/.claude/settings.json`: SessionStart, UserPromptSubmit, PreToolUse (edits), PostToolUse (every tool), Stop |
| Codex | `~/.codex/config.toml` → `[mcp_servers.neurons]`, `tool_timeout_sec = 180` | `~/.codex/hooks.json`: the same five. Trust them once with `/hooks` in Codex. |
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
