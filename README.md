# Neurons MCP

A local MCP server that lets the coding agents running on one machine work as a team. It supports Claude Code, Codex, Gemini CLI, and OpenCode with OpenRouter, Ollama, LM Studio or any other model behind it. Agents can:

- **Ask each other.** One agent asks; the agent that owns the knowledge looks in its own memory and past chats, then answers. `to: "all"` asks every other agent at once for a second opinion.
- **Call each other, like a phone.** A message to `"codex"` rings every running Codex session. You pick up in the one that should take it, and from then on that line carries every message between the two sessions until someone hangs up.
- **Ask a local model for free.** `to: "local"` sends simple, general questions to Ollama or LM Studio on this machine. `local_first` tries the local model before bothering an agent.
- **Hand off session context.** The agent handing over writes the goal, what is done, decisions, next steps, files and commits. On top of that, every session leaves an **automatic, model-free handoff**: its uncommitted files and its commits.
- **Review each other's code.** Reviews go through a queue: a reviewer claims a request and returns structured findings.
- **Avoid collisions.** Agents take advisory file claims per repo. An **edit hook** warns an agent, or blocks the edit, when a file is claimed by another session.

The user can follow all of this live, either in the terminal with `neurons watch` or in the **VS Code / VSCodium extension**. The extension shows which agents are connected and who is talking to whom. It lets you browse and delete history, and connect each agent with one click.

**Agents never read each other's memory or chats, and no auth is ever shared.** Knowledge moves only as questions and answers, so the owner decides what to share. Neurons never opens credentials or config files, rejects any message that looks like a secret, and only talks to model servers on localhost.

Agents talk only while both are running. Neurons never starts or wakes an agent. A message to an agent that is not open fails with "couldn't reach".

## Calls and lines

```
claude-a: send(to: "codex", …)          no line to codex yet
   │
   ├─ rings codex-b and codex-c  ──── pick up: the dashboard's "Accept on codex-c",
   │                                  or "accept" in codex-c's chat (connect)
   │
   └─ line #7: claude-a ⇄ codex-c
        every later "codex" from claude-a, and "claude" from codex-c, goes over it
        hang up: disconnect (either side), the dashboard, or `neurons disconnect`
```

**The call popup.** When a call rings for a window that is listening (auto-listen does that after every turn) and whose client can show forms (MCP elicitation), the window shows a popup, once per call:

```
📞 claude-1a2b3c4 is calling: Where is the cache TTL set?
   ( Pick up )  ( Not here )  ( Decline )
```

- **Pick up:** this session takes the call and gets the message at once.
- **Not here:** only this popup closes; other windows keep ringing.
- **Decline:** the call ends everywhere, and the caller hears so.

The model never sees the popup, and once a line is up there are no more popups. A popup closes by itself when another window picks up. If the listen ends before you answer, it comes back on the next listen.

Without a popup, the call is picked up:

1. by a session you switched **Auto-answer** on for in the dashboard (always, even with popups);
2. when no window can show a popup: by the only session that can take the call, or by the session that started listening first.

Otherwise the call rings for 2 minutes and then becomes a missed call; the caller hears "nobody picked up". You can always pick up from the dashboard, or tell the agent to (`connect`). An agent picks up in chat only when you tell it to, and it cannot `reply` to a call it has not picked up. A client that answers popups faster than a person could click (a known Claude Code bug) is treated as having none.

A session can hold any number of lines. With two lines to Codex sessions, `"codex"` is ambiguous, so send to the handle. When a window closes, its lines end, and the next message rings again. Calls to a handle connect straight away, since that session is the only one that can take them. `to: "any"` and `to: "all"` do not ring.

## How a question flows

```
codex: send(to: "claude", "do you know how X works?")
   │
   ├─ no Claude window connected → "Couldn't reach claude …" (nothing stored)
   │
   └─ delivered → the hooks put it in front of Claude, whole (no inbox call needed):
                     working   → after its next tool call: "finish your task first, then reply"
                     stopping  → the stop is blocked and Claude answers it now, in the chat
                     idle      → auto-listen: Claude is already waiting in inbox and answers at once
                     │
                     claude: recall("X")      ← its own memory, past chats, Neurons notes, repo
                     claude: recall_get(ref)  ← open the useful hits
                     claude: reply(…)         ← only what it chooses to share
                     │
codex: inbox(wait_seconds) ◄────────────────────┘
```

It works the same in reverse, and between any two agents or sessions.

**Auto-listen, for answers within seconds.** An idle session takes no turn by itself. So with auto-listen on (the default, switchable in the dashboard), an agent that finishes a turn does not go idle: its Stop hook tells it to listen, and it:

1. calls `inbox` with `wait_seconds=900`;
2. answers whatever arrives, the moment it arrives;
3. waits again.

To give it new work, press Stop (Esc in Claude Code) first: a prompt typed while it listens waits until the listen call returns. While idle it makes about four small requests an hour. It never starts an agent that is not running. An agent that does not listen when asked is not asked again until your next prompt, so it cannot loop. You can also start listening by hand: tell any agent "neurons listen".

Targets for `send`:

| `to` | goes to |
|---|---|
| `"claude"`, `"codex"`, ... | over your line to that agent; with no line, it rings the agent's sessions until one picks up |
| `"claude-1a2b3c4"` | exactly that session (over the line, or opening one) |
| `"any"` | whichever agent answers first |
| `"all"` | one copy per other connected agent (over your line where you have one); the inbox shows the replies together ("Second opinions on #12 (2/2 answered)") |
| `"local"` | the local model, answered in the same call; nothing is stored |

## How it works

```
 Claude Code ──stdio──► dist/neurons-mcp.mjs ─┐
 Codex ───────stdio──► dist/neurons-mcp.mjs ─┼──► ~/.local/share/neurons-mcp/neurons.db  (SQLite, WAL)
 Gemini CLI ──stdio──► dist/neurons-mcp.mjs ─┘        ▲
        │                                            │
        └── hooks: dist/neurons.mjs hook ────────────┘
              SessionStart / UserPromptSubmit  links the native session, hands over unread messages
              PreToolUse (edits)               records edited files, warns on claimed files
              PostToolUse (every tool)         hands over messages that arrived mid-task
              Stop                             refreshes the automatic handoff; continues the agent for unread messages or auto-listen
```

- **Processes.** Each agent window spawns its own stdio server, and all of them share one SQLite file. There is no daemon, no port, and nothing to keep running. Agents run the **built** files in `dist/`, never `src/` directly.
- **Presence.** Each server registers itself when its client connects and removes itself on exit. A window that stops heartbeating for 3 minutes, for example while the machine sleeps, counts as gone, and it comes back with its next heartbeat or tool call.
- **Identity.** Every session gets a UUID and a handle such as `claude-1a2b3c4` or `codex-9f8e7d6`. With hooks installed, the session is tied to the agent's native session id, so a resumed chat keeps its handle.
- **Recall: an agent searching its own knowledge.**

  | agent | its own memory | its own past chats |
  |---|---|---|
  | claude | `~/.claude/projects/*/memory/*.md`, `~/.claude/CLAUDE.md`, the repo's `CLAUDE.md` | `~/.claude/projects/**/*.jsonl` |
  | codex | `~/.codex/AGENTS.md`, `~/.codex/memories/`, Codex's memories DB, the repo's `AGENTS.md` | `~/.codex/sessions` rollouts |
  | gemini | `~/.gemini/GEMINI.md`, the repo's `GEMINI.md` | not supported yet |
  | opencode | `~/.config/opencode/AGENTS.md`, the repo's `AGENTS.md` | OpenCode's session DB |

  `recall` also searches the agent's own Neurons notes and the repo's files (`git grep`, tracked and untracked, gitignored files excluded). There are no user-specific folders.
- **Semantic recall.** When a local embedding model is available, memory files and Neurons notes are also matched by meaning, so "car" finds a note that only says "automobile". The results are merged with the keyword hits. Vectors are cached in the DB and recomputed only when a note changes. Without the model, recall is keyword-only and just as fast.
- **Ownership.** An agent can only update or archive its own Neurons notes. To suggest something for another agent's memory, it sends a `proposal`. The owner verifies it, saves it itself, and replies `accepted` or `rejected`. Saving something learned from a peer (`source=peer`) requires `evidence`.
- **Automatic handoffs.** The edit hook records which files a session edits. The Stop hook turns that into one handoff per session:
  - which of those files are still uncommitted, and with what status;
  - commits since the session started that touch them;
  - how many other uncommitted files it did not edit;
  - the branch.

  The handoff is updated every turn and deleted when nothing is left. A new session in the same repo gets a single line at start (`codex-… has work in this repo: handoff_get id=7`). No model is involved and no chat text is stored.
- **Claim guard.** Before an edit (`Edit`, `Write`, `MultiEdit` and `NotebookEdit` in Claude Code, `apply_patch` in Codex), the hook checks the claims of other live sessions. In `warn` mode (the default), the agent gets a one-line note and the edit goes ahead. In `block` mode, the edit is refused. Nothing is printed unless there is a conflict.

## Tools

Sixteen tools, kept short because every agent carries their definitions. Their display titles start with "Neurons" (Neurons Discovery, Neurons Connect, …):

| area | tools |
|---|---|
| discovery | `discover`: who is online, your lines, calls ringing for you (also sets your model/task) |
| calls | `connect` (`to`: call an agent or handle; `call_id`: pick up), `disconnect` (hang up a line, cancel or decline a call) |
| messages | `send` (`to`: agent, handle, `any`, `all`, `local`; `local_first`), `reply`, `inbox` (`wait_seconds` blocks for replies) |
| own knowledge | `recall`, `recall_get`, `memory_save` (also update and archive), `session_read` (lists your sessions without an id) |
| handoffs | `handoff_publish`, `handoff_get` (lists without an id, automatic handoffs included) |
| code review | `review_request`, `review_get` (lists without an id, claims with one), `review_submit` |
| file claims | `claims` (`claim`, `release`, `list`) |

Agents call `inbox` only when the hook or the one-line unread banner says something is waiting. Questions and replies are capped at 8,000 characters.

## Token budget

| what | ≈ tokens |
|---|---|
| server instructions (in every session's system prompt) | 237 |
| all 16 tool schemas | 2,760 |
| SessionStart hook line (+ one line per automatic handoff in the repo) | 8 (+15) |
| edit hook | 0 unless a claimed file is edited |
| PostToolUse and Stop hooks | 0 unless a message arrived; auto-listen adds about 4 small requests an hour while idle. PostToolUse costs about 0.1 s per tool call (Node start-up) |
| typical `recall` / `session_read` result | 600 / 1,200 |
| `send to:"local"` | only the answer; the local model's own tokens are free |

Output defaults (hits per source, transcript tail, snippet length) live in `configuration/settings.js` under `OUTPUT` and `RECALL`; agents can ask for more per call.

## Project layout

```
configuration/              what the agents read, and the knobs
├── settings.js             paths, limits, timeouts, recall budget, local model, claim guard, auto handoff
├── prompts.js              server instructions, hook lines, inbox hints, delivery/unreachable/local texts (all kept short)
└── tools/
    ├── index.js            the tool list, in registration order
    └── <tool>.js           one per tool: name, title, description (the tool prompt), input schema, readOnly/banner flags
src/
├── tools/
│   ├── index.js            tool name → handler
│   └── <tool>.js           one per tool: the handler only, (args, me, { db, identity, extra }) → text
├── registry.js             pairs each config with its handler (fails at startup on a mismatch) and registers it
├── memory.js, inbox.js, handoffs.js, reviews.js, claims.js, repo.js, format.js   shared logic used by several tools
├── local.js                loopback-only client for Ollama / LM Studio (chat + embeddings)
├── semantic.js             embedding index and search over an agent's own notes
├── snapshot.js             edit tracking and the model-free automatic handoff
├── identity.js             sessions, handles, server presence, reachability
├── calls.js                calls and lines: ring, pick up (by hand or auto-answer), route over a line, hang up
├── delivery.js             what the hooks hand the model: messages at prompt, mid-task and at stop; auto-listen
├── popup.js                the call popup (MCP elicitation) a listening window shows: Pick up / Not here / Decline
├── guard.js, db.js, util.js
└── native/                 per-agent adapters for an agent's own memory and transcripts
├── dashboard.js            reads and deletes behind the editor dashboard (snapshot, history, threads, clears with backup)
bin/neurons.js              CLI: hook, status, inbox, watch, dashboard (the extension's backend, JSON lines over stdio)
extension/                  the VS Code / VSCodium extension
├── src/extension.js        sidebar + editor-tab dashboard, status bar, commands
├── src/setup.js            one-click global MCP + hook setup per agent (Claude Code, Codex, Gemini CLI, OpenCode)
├── src/opencode-plugin.js  the OpenCode plugin Connect writes (OpenCode has no command hooks)
├── src/node.js             finds Node 22.13+ on Linux, macOS and Windows
├── src/backend.js          runs `neurons.mjs dashboard` and talks to it
└── media/                  the webview (dashboard.js, dashboard.css) and the activity bar icon
scripts/build.mjs           dist/neurons-mcp.mjs, dist/neurons.mjs, the extension bundle; --package also makes dist/neurons-<version>.vsix
```

To change how a tool is described to the model, edit `configuration/tools/<tool>.js`. To change what it does, edit `src/tools/<tool>.js`. A new tool needs both files, plus one line in each `index.js`. **Run `npm run build` after any change**: agents and hooks run `dist/`, so an edit does nothing until it is built, and running sessions pick it up when restarted.

## Security model

1. **No cross-agent reads.** Every adapter function takes the caller's own agent. `recall`, `recall_get`, `session_read` and semantic search cannot reach another agent's memory, chats, Neurons notes or embeddings.
2. **Allow-listed reads.** A memory file opens only if the adapter enumerated it. Its `realpath` must stay inside the agent's home or the repo in question, so a symlink cannot escape.
3. **Deny-listed names.** These never open, wherever they are:
   - `auth.json`, `.credentials*`, `oauth*`, `.env*`
   - `config.toml`, `settings*.json`, `.claude.json`, `mcp*.json`
   - keys and certificates, `.netrc`, `.npmrc`, `.pgpass`
   - any non-note file with token, secret, credential or password in its name

   Automatic handoffs count such files but never list them.
4. **Explicit queries on shared DBs.** OpenCode's DB also stores account tokens, so only its `session`, `message` and `part` tables are queried. Codex's memories DB is read only through `stage1_outputs`.
5. **Reject on write.** Every message, reply, note, handoff and diff is scanned for credential shapes. A match rejects the write without echoing the value. The scan covers:
   - API keys and tokens: Anthropic, OpenAI, OpenRouter, AWS, GitHub, GitLab, Slack, Google, Stripe, Supabase, npm and Hugging Face
   - JWTs, Bearer tokens and private keys
   - URLs with passwords
   - assignments such as `*_TOKEN=` and `*_SECRET=`, and JSON secret fields
6. **Redact on read.** Recall results, local-model answers and commit subjects pass through the same patterns.
7. **Local model stays local.** `NEURONS_LLM_URL` must be `localhost`/`127.0.0.1`/`::1`; any other host is refused. No API key is ever sent.
8. **No environment or config is ever returned.** The DB is created `0600` in a `0700` directory.

## Setup

Requires Node ≥ 22.13 (for `node:sqlite`) and git (for repo detection, repo recall and automatic handoffs). Linux, macOS and Windows are supported.

### The easy way: the editor extension (any OS)

```sh
cd ~/Projects/neurons-mcp && npm install && npm run package
codium --install-extension dist/neurons-*.vsix         # or: code --install-extension …
```

1. Open the **Neurons** icon in the activity bar.
2. Every agent on the machine is listed. Press **Connect** next to each one.

Connect writes the agent's global MCP config, plus its hooks for Claude Code and Codex, pointing at a copy of the server in the data folder. Restart the agent's open sessions afterwards. In Codex, trust the new hooks once with `/hooks`. The extension's README has the details.

The manual setup below does the same by hand.

### Manual setup

```sh
cd ~/Projects/neurons-mcp && npm install && npm run build
```

`dist/` is self-contained: the agents only need `node` and the two files in it.

Set `NEURONS_AGENT` in each client, so the handle is right even if the client's name is unfamiliar.

### Claude Code (CLI and IDE extension)

```sh
claude mcp add -s user neurons -e NEURONS_AGENT=claude -- "$(command -v node)" "$HOME/Projects/neurons-mcp/dist/neurons-mcp.mjs"
```

Hooks go in `~/.claude/settings.json`, merged with any you already have. `$N` stands for `node ~/Projects/neurons-mcp/dist/neurons.mjs hook --agent claude`:

```json
"hooks": {
  "SessionStart":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }],
  "PreToolUse":       [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }],
  "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "$N", "timeout": 10 }] }]
}
```

### Codex (CLI and IDE extension)

```sh
codex mcp add neurons --env NEURONS_AGENT=codex -- "$(command -v node)" "$HOME/Projects/neurons-mcp/dist/neurons-mcp.mjs"
```

Then:

- Add `tool_timeout_sec = 960` under `[mcp_servers.neurons]` in `~/.codex/config.toml`. In listen mode `inbox` blocks for up to 900 s, and Codex's default tool timeout is 60 s.
- Add the same five hooks to `~/.codex/hooks.json` with `--agent codex`. Use the matcher `^apply_patch$` for `PreToolUse`.
- Codex will not run a new or changed hook until you trust it: open `/hooks` in the Codex CLI once and approve them.

### Gemini CLI (0.35 or newer for the hooks)

`~/.gemini/settings.json`:

```json
{ "mcpServers": { "neurons": { "command": "node", "args": ["/home/<you>/Projects/neurons-mcp/dist/neurons-mcp.mjs"], "env": { "NEURONS_AGENT": "gemini" }, "timeout": 960000 } } }
```

Hooks go in the same file under `"hooks"`: `SessionStart` and `BeforeAgent` (matcher `*`), `AfterTool` (matcher `.*`) and `AfterAgent` (matcher `*`), each `{ "name": "neurons", "type": "command", "command": "node …/dist/neurons.mjs hook --agent gemini", "timeout": 10000 }`. Gemini may run `AfterAgent` after you cancel, so auto-listen only follows a turn you started there.

### OpenCode (OpenRouter / Ollama / LM Studio models)

`~/.config/opencode/opencode.jsonc`:

```jsonc
{ "mcp": { "neurons": { "type": "local", "command": ["node", "/home/<you>/Projects/neurons-mcp/dist/neurons-mcp.mjs"], "environment": { "NEURONS_AGENT": "opencode" }, "enabled": true } } }
```

OpenCode has no command hooks, so the extension's Connect also writes a plugin, `~/.config/opencode/plugins/neurons.js`. It hands messages over after each tool call and, when a turn ends with something unread, sends it as a prompt. OpenCode reports "idle" even after you cancel, so it never auto-listens: tell it "neurons listen" instead.

Call `discover` with `model` set to the model id (for example `ollama/qwen3-coder`) so peers know which model they are talking to.

### Local model (optional: `to:"local"`, `local_first`, semantic recall)

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5-coder:3b      # chat model for to:"local" (~2 GB, fine on CPU)
ollama pull nomic-embed-text      # embedding model for semantic recall (~270 MB)
```

LM Studio works too. Start its server, then set `NEURONS_LLM_URL=http://127.0.0.1:1234/v1` and `NEURONS_LLM_MODEL` to the loaded model's id. Everything degrades quietly when the server is off: semantic recall falls back to keywords, `local_first` asks the agent, and `to:"local"` says the server is not running.

### Anything else

Any MCP client that can launch a stdio server works: run `node dist/neurons-mcp.mjs` with `NEURONS_AGENT=<name>`. Clients without hooks still get the inbox banner on every tool call, but they get no claim guard and no automatic handoff.

## CLI

```sh
node dist/neurons.mjs watch           # live feed: messages, replies, claims, agents connecting/leaving (--last N, --full)
node dist/neurons.mjs status          # connected sessions, unread counts, open questions/reviews, lines and ringing calls
node dist/neurons.mjs disconnect all  # hang up: a call id, every line of one handle, or all
node dist/neurons.mjs inbox <handle>  # peek at a session's inbox
node dist/neurons.mjs hook --agent X  # used by the agents' hooks (reads hook JSON on stdin)
node dist/neurons.mjs dashboard --once snapshot   # what the editor dashboard sees, as JSON
```

## Configuration

| env | default |
|---|---|
| `NEURONS_AGENT` | guessed from the MCP client name |
| `NEURONS_DATA_DIR` | Linux `~/.local/share/neurons-mcp`, macOS `~/Library/Application Support/neurons-mcp`, Windows `%LOCALAPPDATA%\neurons-mcp` |
| `NEURONS_CLAUDE_HOME`, `NEURONS_CODEX_HOME`, `NEURONS_GEMINI_HOME` | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` if set, else `~/.claude`, `~/.codex`, `~/.gemini` |
| `NEURONS_LLM_URL` | `http://127.0.0.1:11434/v1` (Ollama); loopback only |
| `NEURONS_LLM_MODEL` | `qwen2.5-coder:3b` |
| `NEURONS_EMBED_MODEL` | `nomic-embed-text` |
| `NEURONS_SEMANTIC` | on; `0` turns semantic recall off |
| `NEURONS_CLAIM_GUARD` | `warn`; `block` refuses edits to files another session claimed |

Recall limits, how long a call rings (`LIMITS.ringSeconds`), local model timeouts and automatic-handoff sizes are in `configuration/settings.js`.

## Limits and known gaps

- An MCP server cannot start a turn in an idle agent, and Neurons does not try to. With auto-listen off, a connected but idle agent answers when it next takes a turn: your next prompt to it hands the message over via the hook. An agent you stopped with Stop/Esc stays idle until your next prompt.
- Mid-task delivery and auto-listen need the agent's hooks: Claude Code and Codex, Gemini CLI (auto-listen only after a turn you started) and OpenCode through its plugin (no auto-listen). Other MCP clients see messages through the unread banner on their Neurons tool calls.
- The call popup needs a client that shows MCP forms, and it only appears while the agent listens. The Gemini CLI hooks and the OpenCode plugin are tested by simulation, not in a live session yet.
- A Codex app-server hosts several threads in one process. The thread that most recently received a prompt is the one Neurons attributes calls to, and each of its threads counts as a session a call can ring.
- Picking up from the dashboard does not prompt the agent. The message waits for that session's next turn, unless it is listening.
- Session recall searches the newest 60 transcripts within an 8 second budget. Older chats are still readable with `session_read`.
- Semantic recall covers memory files and Neurons notes, not transcripts or repo code.
- The local model on a CPU is slow (10–30 s) and only fit for general questions. Its answers are marked unverified.
- File claims are advisory unless `NEURONS_CLAIM_GUARD=block`. Edits made through shell commands (`sed`, scripts) are not seen by the edit hook.
- Secret detection is pattern-based: it catches the common shapes, not every possible secret.
- Platform specifics:
  - Linux reads process facts from `/proc`, and macOS from one `ps` call.
  - Windows tells Node only a process's parent and whether it exists. So the hook links a session to the agent window started in the same folder, and a window that stops heartbeating for 3 minutes counts as gone.
  - The macOS and Windows code paths are tested by simulation on Linux, not yet on real machines.
