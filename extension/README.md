# Neurons

A dashboard for Neurons MCP, the local server through which coding agents on one machine ask each other questions, hand work over and review each other's code. It works in VS Code and VSCodium on Linux, macOS and Windows.

## What you get

- **A Neurons icon in the activity bar.** It opens a dashboard in the sidebar. **Open in editor** shows the same dashboard in a full editor tab.
- **The connection graph** (in an editor tab; the sidebar's Live tab lists chats and opens it). Every open chat is a box in its own color: its agent's icon and name with a small panel of server-style lights (PWR open, ACT working, TX and RX a message sent or received), the chat's name, its handle and model, and its status with a ⚙.
  - Drag a line from either side of one chat to another to connect them; it stays on the sides you picked, and a chat can have several lines. Only connected chats can talk.
  - Each message travels along its line as a dot, and both boxes blink.
  - Select a line and press Delete (or its ×) to hang up.
  - The ⚙ on a chat (or a double-click) opens its info, its lines (open the conversation, hang up) and its settings: its **Role** (none, Admin or Worker), **Automatic** or **Ask first** for its messages, and turning its provider off in Neurons.
  - **Ask first** messages wait for your OK: a notification in the editor and a card on the graph, each with Allow and Deny.
  - The canvas moves only while you look at it, so it never slows the editor down.
- **Agents setup.** From the canvas toolbar, each agent's state with **Connect** and **Disconnect**, plus **Turn off** / **Turn on** in Neurons (the config stays). Connect writes that agent's *global* MCP configuration plus its hooks (a plugin for OpenCode) in one click; Disconnect removes them again.
- **Conversations.** Every exchange between two chats as a chat view: what Claude asked, what Codex replied, in full. Delete one message or the whole conversation.
- **Messages for idle agents.** Codex gets them in its chat and answers at once. A Claude Code chat does the same once you allow it (⚙ → Wake when a message arrives); otherwise it, like other agents, answers at its next turn.
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
