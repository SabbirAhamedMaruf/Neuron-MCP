# How Neurons works

The details behind the [README](../README.md): lines, message delivery, the canvas, the tools, security, configuration and the project layout.

## Lines

Chats talk only over lines the user draws on the connection graph. Agents cannot dial.

```
canvas: drag claude-a ──────────► codex-c        line #7: claude-a ⇄ codex-c
claude-a: send(to: "codex", …)   goes to codex-c over line #7
codex-c:  send(to: "claude", …)  goes back over the same line
claude-a: send(to: "gemini", …)  "Not connected to gemini: … ask the user to connect you"
```

- **One line per pair of chats.** Drawing it again keeps the one line. A chat cannot be connected to itself, but it can have lines to any number of other chats. Each line remembers the box sides it was drawn between (`calls.from_side` / `to_side`; older lines go right to left).
- **Targets.** `"codex"` means the Codex chat on your line. With lines to two Codex chats it is ambiguous, so send to a handle. `"all"` asks every chat you are connected to.
- **Hanging up.** The selected line's × or <kbd>Delete</kbd> on the canvas, `disconnect` from either chat, or `neurons disconnect`.
- **A closed chat pauses its lines.** Reloading the window or closing the editor pauses every line of its chats. Reopen the same chat (it keeps its handle) and its lines come back by themselves. A Claude Code chat is back as soon as it resumes; a Codex thread is back after its next prompt. While a line is paused, a message to the closed chat fails and tells the agent the chat is closed. The sidebar lists paused lines.
- **A line ends by itself** when its closed chat is not back within a day, or when a Claude Code or Gemini chat is cleared or replaced in its window. A new chat must be connected again.
- **Handoffs and reviews** do not need a line. They go to the agent's inbox, or over a line when there is one.

## Settings

Set from the dashboard, kept in the database, so every chat's Neurons server and hook reads them.

- **Sending over its lines** (per chat, ⚙ modal; `sessions.send_mode`):
  - **Automatic** (default): `send` delivers over the line at once.
  - **Ask first:** `send` stores the message in `asks` and waits up to 45 s (under Codex's 60 s tool timeout). Every editor window hears of it; the first to claim it shows a notification, and the dashboard shows a card. Allow from either delivers it once, over lines still open; Deny or no answer sends nothing, and the agent is told which. Replies are never held.
- **Role** (per chat, ⚙ modal; `sessions.role`): none (default), admin or worker. Between an admin and its worker, each message carries a tag: to a worker, a message from its admin is a task the user gave it (done within its usual permission rules, answered with the result; anything risky or outside it is asked of the admin first); to an admin, a message from its worker is a result, progress or a permission request (answered, or taken to the user when unsure). `discover` shows a chat its role and counterparts, and the SessionStart hook repeats it. A role never lets a message approve a permission prompt.
- **Wake when a message arrives** (Claude Code chats, ⚙ modal; `sessions.wake`): off until the user reads what it means and presses Allow. Then the chat's own Neurons server hands a message that reaches it while it is idle to the session's inbox socket (Claude Code's cross-session messaging, `CLAUDE_CODE_MESSAGING_SOCKET`, which Claude Code gives the processes it starts). Claude Code starts a turn with it, marked as a message from another session: it cannot approve permission prompts or run slash commands. A message goes at most once (marked read and relayed first); if the socket cannot be reached it stays unread for the hooks. The line format comes from Claude Code's own debug hint and is not documented, so a Claude Code update could stop it; messages then simply wait as before.
- **A provider turned off** (⚙ modal or Agents setup; `settings.disabledAgents`): its tools answer that Neurons is off, its hooks do nothing, it is off the graph and cannot be messaged or connected, and its lines end. Its MCP config and hooks stay; turning it on again restores everything.

## The connection graph

A [React Flow](https://reactflow.dev) canvas in an editor tab (the dashboard opened in the editor, Live tab). The sidebar's Live tab lists the same chats and lines and opens it.

- **Which chats show.** Every chat open now, found from its process: one box per Claude Code chat, sidebar or tab, a few seconds after it opens; a Codex thread once it runs (Codex starts a thread's Neurons server only then). A closed chat leaves at once. A Claude Code chat without Neurons loaded shows as "Not joined".

- **Each open chat is a box** in its own color, with 5px corners:
  - **Top:** its agent's icon and name (Claude, Codex, Gemini, OpenCode, Ollama and LM Studio marks; a robot for any other agent), and the front panel's lights on the right.
  - **Middle:** the chat's name as its agent shows it (Claude Code's custom or AI title, Codex's thread name), its handle (the name other agents send to), then its model.
  - **Bottom:** Working or Idle, "Ask first" and unread count when they apply, and the ⚙ on the right. Repo, task and the rest are in the ⚙ modal.

  The front panel has four lights:
  - PWR: the chat is open;
  - ACT: it is working on a turn;
  - TX: it sent a message;
  - RX: it received one.
- **Each line is a plain edge** in its two chats' colors, with no label. Select it to show its × (hang up). The ⚙ modal lists each line's message count and when its last message came.
- **Every message travels along its line as one dot**, from the sender to the receiver. TX blinks on the sender, RX on the receiver, and both boxes flash.
- **⚙ on each box** (or a double-click) opens a modal: the chat's info, its lines (Open conversation, Hang up) and its settings. Clicking a box only selects it.
- **Ask first cards.** A message waiting for your OK shows as a card at the top, with Allow, Deny and a countdown.
- **Agents setup** (top right) connects or disconnects agents' configs.
- **Performance.** The canvas only moves while you look at it. A hidden dashboard gets no updates, then one refresh when it shows again. Messages from while it was hidden only add to the counts; they never replay. Box positions are remembered per dashboard.

## How a message reaches an agent

```
codex: send(to: "claude", "do you know how X works?")
   │
   ├─ no Claude window connected → "Couldn't reach claude …" (nothing stored)
   │
   └─ delivered → the hooks put it in front of Claude as hidden context, whole (no inbox call, nothing in your chat):
                     working   → after its next tool call: "finish your step, reply, carry on"
                     idle      → at your next prompt to Claude
                     │
                     claude: recall("X")      ← its own memory, past chats, Neurons notes, repo
                     claude: recall_get(ref)  ← open the useful hits
                     claude: reply(…)         ← only what it chooses to share
                     │
codex: inbox(wait_seconds) ◄────────────────────┘
```

It works the same in reverse, and between any two agents or sessions.

**A message for an idle agent.** Its Neurons server watches in the background, so nothing is added to the chat while it waits:
- **Codex:** the message is queued into the thread it is for with `codex queue`. It shows in Codex's chat as a prompt, and Codex answers at once. While that thread is in a turn, the hooks hand the message over mid-task instead; a question left unanswered when the turn ends is queued then.
- **Claude Code and others** answer at their next turn: your next prompt, or their next tool call.

Only messages to one session (line traffic, replies) are relayed this way. A handoff or review to every session of an agent waits for the hooks, so several windows never all answer it.

**Your chat stays yours.** Neurons never keeps an agent busy listening and never blocks it from stopping. The only prompt it ever adds is a queued one in an idle Codex, which you chose. The agent answers peers with `reply` and is told to keep that traffic out of its conversation with you. The dashboard's **Conversations** tab shows every exchange, as a chat per pair of sessions.

Targets for `send`:

| `to` | goes to |
|---|---|
| `"claude"`, `"codex"`, ... | over your line to a chat of that agent; without one, nothing is sent |
| `"claude-1a2b3c4"` | over your line to exactly that chat |
| `"all"` | one copy over each of your lines; the inbox shows the replies together ("Second opinions on #12 (2/2 answered)") |
| `"local"` | the local model, answered in the same call; nothing is stored |

## Architecture

```
 Claude Code ──stdio──► dist/neurons-mcp.mjs ─┐
 Codex ───────stdio──► dist/neurons-mcp.mjs ─┼──► <data folder>/neurons.db  (SQLite, WAL)
 Gemini CLI ──stdio──► dist/neurons-mcp.mjs ─┘        ▲
        │                                            │
        └── hooks: dist/neurons.mjs hook ────────────┘
              SessionStart / UserPromptSubmit  links the native session, hands over unread messages
              PreToolUse (edits)               records edited files, warns on claimed files
              PostToolUse (every tool)         hands over messages that arrived mid-task
              Stop                             refreshes the automatic handoff (prints nothing)
```

- **Processes.** Each agent window starts its own stdio server, and all of them share one SQLite file. There is no daemon, no port and nothing to keep running.
- **Presence.** Each server registers itself when its client connects and removes itself on exit. On Linux and macOS a window counts as connected while its process lives, sleep included. On Windows, a window that stops heartbeating for 3 minutes counts as gone.
- **Identity.** Every session gets a UUID and a handle such as `claude-1a2b3c4` or `codex-9f8e7d6`. With hooks installed, the session is tied to the agent's native session id, so a resumed chat keeps its handle.
- **Recall: an agent searching its own knowledge.**

  | agent | its own memory | its own past chats |
  |---|---|---|
  | claude | `~/.claude/projects/*/memory/*.md`, `~/.claude/CLAUDE.md`, the repo's `CLAUDE.md` | `~/.claude/projects/**/*.jsonl` |
  | codex | `~/.codex/AGENTS.md`, `~/.codex/memories/`, Codex's memories DB, the repo's `AGENTS.md` | `~/.codex/sessions` rollouts |
  | gemini | `~/.gemini/GEMINI.md`, the repo's `GEMINI.md` | not supported yet |
  | opencode | `~/.config/opencode/AGENTS.md`, the repo's `AGENTS.md` | OpenCode's session DB |

  `recall` also searches the agent's own Neurons notes and the repo's files (`git grep`, tracked and untracked; gitignored files are left out).
- **Semantic recall.** When a local embedding model is available, memory files and Neurons notes are also matched by meaning, so "car" finds a note that only says "automobile". Those results are merged with the keyword hits. Without the model, recall is keyword-only.
- **Ownership.** An agent can only update or archive its own Neurons notes. To suggest something for another agent's memory, it sends a `proposal`. The owner verifies it, saves it itself, and replies `accepted` or `rejected`.
- **Automatic handoffs.** The edit hook records which files a session edits. When a turn ends, that becomes one handoff per session:
  - which of those files are still uncommitted;
  - the commits since the session started that touch them;
  - the branch.

  A new session in the same repo gets one line about it at start. No model is involved and no chat text is stored.
- **Claim guard.** Before an edit, the hook checks other live sessions' file claims. In `warn` mode (the default), the agent gets a one-line note. In `block` mode, the edit is refused.

## Tools

Fifteen tools, kept short because every agent carries their definitions:

| area | tools |
|---|---|
| discovery | `discover`: who is online, your lines and calls (also sets your model/task/label) |
| lines | `disconnect` (hang up a line; the user draws them) |
| messages | `send` (`to`: agent, handle, `all`, `local`; `local_first`), `reply`, `inbox` (`wait_seconds` blocks for replies) |
| own knowledge | `recall`, `recall_get`, `memory_save` (also update and archive), `session_read` |
| handoffs | `handoff_publish`, `handoff_get` |
| code review | `review_request`, `review_get`, `review_submit` |
| file claims | `claims` (`claim`, `release`, `list`) |

**Token cost:** about 220 tokens of server instructions, plus about 2,560 for all tool definitions, in every session. The hooks add nothing unless a message arrived, or a claimed file is about to be edited.

## Security model

1. **No cross-agent reads.** `recall`, `recall_get`, `session_read` and semantic search only reach the caller's own memory, chats and notes. A repo path never reaches into an agent's home folder, even when that folder sits inside a git repo.
2. **Allow-listed reads.** A memory file opens only if the adapter listed it. Its real path must stay inside the agent's home or the repo, so a symlink cannot escape.
3. **Deny-listed names** never open, wherever they are:
   - `auth.json`, `.credentials*`, `oauth*`, `.env*`
   - `config.toml`, `settings*.json`, `.claude.json`, `mcp*.json`
   - keys and certificates, `.netrc`, `.npmrc`, `.pgpass`
   - any non-note file with token, secret, credential or password in its name
4. **Reject on write.** Every message, reply, note, handoff and diff is scanned for credential shapes, and a match is rejected without echoing the value:
   - API keys and tokens of the common providers
   - JWTs, Bearer tokens and private keys
   - URLs with passwords
   - assignments such as `API_KEY=` or `*_TOKEN=`
5. **Redact on read.** Recall results, local-model answers and commit subjects pass through the same patterns.
6. **Local model stays local.** `NEURONS_LLM_URL` must point at localhost, and no API key is ever sent.
7. **Private files.** The DB is created `0600` in a `0700` folder. No environment or config is ever returned.

## Manual hook setup

The editor's **Connect** writes all of this for you. By hand, `$N` stands for `node /path/to/neurons-mcp/dist/neurons.mjs hook --agent <agent>`. Add `--data-dir <folder>` if you moved the data folder.

**Claude Code**, in `~/.claude/settings.json`, merged with any hooks you already have:

```json
"hooks": {
  "SessionStart":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }],
  "PreToolUse":       [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }],
  "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }]
}
```

**Codex:** the same five go in `~/.codex/hooks.json`, with `--agent codex` and the matcher `^apply_patch$` for `PreToolUse`. Codex runs a new or changed hook only after you trust it with `/hooks`.

**Gemini CLI (0.35 or newer):** in `~/.gemini/settings.json` under `"hooks"`:
- `SessionStart` and `BeforeAgent`, with matcher `*`;
- `AfterTool`, with matcher `.*`;
- `AfterAgent`, with matcher `*`.

Each entry is `{ "name": "neurons", "type": "command", "command": "$N", "timeout": 10000 }`.

**OpenCode** has no command hooks. Connect writes a plugin to `~/.config/opencode/plugins/neurons.js` instead. It hands messages over after each tool call and refreshes the automatic handoff when a turn ends.

## Configuration

| env | default |
|---|---|
| `NEURONS_AGENT` | guessed from the MCP client name |
| `NEURONS_DATA_DIR` | Linux `~/.local/share/neurons-mcp`, macOS `~/Library/Application Support/neurons-mcp`, Windows `%LOCALAPPDATA%\neurons-mcp` |
| `NEURONS_CLAUDE_HOME`, `NEURONS_CODEX_HOME`, `NEURONS_GEMINI_HOME` | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` if set, else `~/.claude`, `~/.codex`, `~/.gemini` |
| `NEURONS_CODEX_BIN` | the Codex binary that started the server (used for `codex queue`) |
| `NEURONS_LLM_URL` | `http://127.0.0.1:11434/v1` (Ollama); loopback only |
| `NEURONS_LLM_MODEL` | `qwen2.5-coder:3b` |
| `NEURONS_EMBED_MODEL` | `nomic-embed-text` |
| `NEURONS_SEMANTIC` | on; `0` turns semantic recall off |
| `NEURONS_CLAIM_GUARD` | `warn`; `block` refuses edits to files another session claimed |

Limits (message size, recall budget, local model timeouts) are in `configuration/settings.js`.

## Project layout

```
configuration/              what the agents read, and the settings
├── settings.js             paths, limits, timeouts, recall budget, local model, claim guard, auto handoff
├── prompts.js              server instructions, hook lines, inbox hints and other texts
└── tools/<tool>.js         one per tool: name, title, description, input schema
src/
├── tools/<tool>.js         one per tool: the handler
├── registry.js             pairs each tool's config with its handler and registers it
├── lines.js                lines: open (from the dashboard), route a message over one, hang up, end with a closed window
├── delivery.js             what the hooks hand the model as hidden context
├── relay.js                messages for an idle agent (codex queue for Codex)
├── identity.js             sessions, handles, server presence, reachability
├── dashboard.js            what the editor dashboard reads and deletes, and the canvas graph
├── native/                 per-agent readers for an agent's own memory and transcripts
└── …                       memory, inbox, handoffs, reviews, claims, repo, local model, semantic search, guard, db
bin/neurons.js              CLI: hook, status, inbox, watch, disconnect, dashboard (the extension's backend)
extension/                  the VS Code / VSCodium extension (dashboard, one-click Connect)
├── webview-src/canvas.jsx  the Live canvas (React Flow), built into media/canvas.js and canvas.css
scripts/build.mjs           builds dist/ and the extension; --package also makes dist/neurons-<version>.vsix
```

To change how a tool is described to the model, edit `configuration/tools/<tool>.js`. To change what it does, edit `src/tools/<tool>.js`. **Run `npm run build` after any change.** Agents and hooks run `dist/`, and running sessions load a new build only when restarted.

## Limits and known gaps

- Hidden-context delivery needs the agent's hooks (Claude Code, Codex, Gemini CLI) or plugin (OpenCode). Other MCP clients see messages only through the unread line on their Neurons tool calls.
- Gemini CLI and OpenCode are tested by simulation, not in live sessions yet. The same goes for macOS and Windows.
- File claims are advisory unless `NEURONS_CLAIM_GUARD=block`. Edits made through shell commands are not seen by the edit hook.
- Secret detection is pattern-based: it catches the common shapes, not every possible secret.
- A local model on a CPU is slow (10–30 s) and only fit for general questions; its answers are marked unverified.
