# Neurons MCP

**Let the coding agents on your machine work as a team.**

You often run more than one agent: Claude Code in one window, Codex in another. Each knows things the other doesn't: its own memory, its past chats, the work it just did. Neurons lets them ask each other, like colleagues, while you stay in charge:

- an agent **asks**, and the agent that owns the knowledge **answers**;
- **you** decide which chats may talk, by connecting them on a canvas, and you can follow every conversation;
- agents **never read each other's memory or chats**, and **no login, token or config is ever shared**.

Everything stays on your machine: one small local database, no cloud and no account.

## Features

- **Ask another agent.** Say "ask Codex how the cache works". Codex searches its own memory and past chats, then replies.
- **Connect chats by drawing a line.** Every open Claude and Codex chat is a box on the dashboard's canvas. Drag a line from one to another, and those two can talk until you hang up. Each message travels along its line as a dot, and both boxes blink.
- **You decide what goes.** Each chat's ⚙ on the canvas sets how its messages go: **Automatic**, or **Ask first** (you allow each message from a notification or a card on the graph). A provider can be turned off in Neurons altogether.
- **Second opinions.** Ask every other agent at once and see the answers side by side.
- **Hand work over.** One agent writes a handoff (goal, what's done, next steps) for another. Every session also leaves an automatic one: which files it changed and what it committed.
- **Code review between agents.** One agent asks for a review; another returns structured findings.
- **No collisions.** Agents can claim files, and an agent is warned before it edits a file another session claimed.
- **A dashboard in your editor.** The live canvas of chats and lines, every conversation as a chat, search and delete.
- **Optional free local model.** Simple general questions can go to Ollama or LM Studio instead of an agent.

## Supported agents

| Agent | Support |
|---|---|
| **Claude Code** (CLI and IDE extension) | Full |
| **Codex** (CLI and IDE extension) | Full; an idle Codex even answers on its own |
| **Gemini CLI** (0.35+) | Full |
| **OpenCode**, with any model (OpenRouter, Ollama, LM Studio, …) | Full, through a small plugin |
| Any other MCP client | Basic: it can ask and answer, and sees new messages when it next uses a Neurons tool |

Works on Linux, macOS and Windows.

## Setup

**You need:** Node.js **22.16 or newer** (not 23.x), and git.

In the `neurons-mcp` folder, build it once:

```sh
npm install
npm run build
```

Then pick one of the two ways below.

### Option A: with VS Code or VSCodium (recommended)

1. Build and install the extension:
   ```sh
   npm run package
   code --install-extension dist/neurons-*.vsix      # VSCodium: codium --install-extension …
   ```
2. Click the **Neurons** icon in the activity bar.
3. Press **Connect** next to each agent you use.
4. Restart those agents' open sessions.
5. **Codex only:** run `/hooks` in Codex once and trust the Neurons hooks.

Connect only adds a `neurons` entry to each agent's own config, and keeps a backup of the file. Disconnect removes it again.

### Option B: from the terminal (no editor)

Register the server with each agent. Replace `/path/to/neurons-mcp` with your folder.

**Claude Code**
```sh
claude mcp add -s user neurons -e NEURONS_AGENT=claude -- "$(command -v node)" /path/to/neurons-mcp/dist/neurons-mcp.mjs
```

**Codex**
```sh
codex mcp add neurons --env NEURONS_AGENT=codex -- "$(command -v node)" /path/to/neurons-mcp/dist/neurons-mcp.mjs
```
Then add `tool_timeout_sec = 180` under `[mcp_servers.neurons]` in `~/.codex/config.toml`.

**Gemini CLI**: in `~/.gemini/settings.json`
```json
{ "mcpServers": { "neurons": { "command": "node", "args": ["/path/to/neurons-mcp/dist/neurons-mcp.mjs"], "env": { "NEURONS_AGENT": "gemini" }, "timeout": 180000 } } }
```

**OpenCode**: in `~/.config/opencode/opencode.json`
```json
{ "mcp": { "neurons": { "type": "local", "command": ["node", "/path/to/neurons-mcp/dist/neurons-mcp.mjs"], "environment": { "NEURONS_AGENT": "opencode" }, "enabled": true } } }
```

This is enough to ask and answer. For messages to arrive by themselves, each agent also needs the Neurons **hooks**; the editor's Connect adds them in one click. To add them by hand, see [docs/how-it-works.md](docs/how-it-works.md#manual-hook-setup).

## How to use it

You talk to your agents in plain words; they use Neurons for you.

1. **Open the chats** you want to work together, for example Claude Code and Codex in the editor.
2. **Open the connection graph.** In the Neurons sidebar, press **Open the connection graph** (or click Neurons in the status bar). It opens in an editor tab, with a box per open chat, named by its title.
3. **Connect them.** Drag from a dot (●) on either side of one chat to a dot on the other. The line stays on the sides you picked, and one chat can have lines to several chats at once. From now on the connected chats can talk.
   ```
   ┌───────────────────────┐            ┌───────────────────────┐
   │ ✳ Claude Code    ●●●● │            │ ◉ Codex          ●●●● │
   │ Fix the cache         ●────────────● Review the API        │
   │ claude-1a2b3c4        │            │ codex-9f8e7d6         │
   │ claude-opus-5-5       │            │ gpt-6-astra           │
   │ ● Working          ⚙  │            │ ● Idle             ⚙  │
   └───────────────────────┘            └───────────────────────┘
   ```
4. **Ask one chat to talk to the other.** For example, in Claude Code:
   > Ask Codex where the cache TTL is set.
5. **Watch it travel.** The message moves along the line as a dot, and the MSG light is lit on the sender while it travels, then blinks on the receiver as it arrives; both go off afterwards.
6. **The other chat answers** from its own memory and past chats; the answer comes back the same way, and the asking chat tells you.
7. **Hang up** when you are done: select the line and press <kbd>Delete</kbd> (or its ×), or tell either chat to disconnect.

A chat that is not connected cannot send. It says so and asks you to connect it, so nothing ever goes anywhere you did not wire up.

**Settings per chat.** The ⚙ on a box (or a double-click) opens its info, its lines and its settings:

- **Role:** None (the default, an equal peer), **Admin** or **Worker**. An admin hands out tasks to the workers on its lines and answers their permission requests, asking you when it is not sure. A worker does its admin's tasks as if you gave them, within its usual permissions, replies with the result, and asks its admin before anything risky. A role never lets a message approve a permission prompt or override you.
- **Sending over its lines: Automatic** (the default) sends right away. **Ask first** holds each message until you allow it: a notification pops up in the editor and a card shows on the graph, each with Allow and Deny. With no answer within 45 seconds nothing is sent, and the chat is told. Replies always go.
- **Wake when a message arrives** (Claude Code chats): off by default. Turning it on first tells you what it means, and only **Allow** saves it. Then a message that reaches the chat while it is idle starts a turn by itself, as an idle Codex already does. Each such turn uses your Claude usage, and the message shows as coming from another session, so it can never approve a permission prompt.
- **Turn off a provider** (for example Gemini CLI) in Neurons: its chats leave the graph, their lines end, and they can neither send nor receive. Its setup stays; turn it back on under **Agents setup**.

**More things you can ask:**

| You say | What happens |
|---|---|
| "Ask everyone you're connected to what they think about this plan" | Every connected chat answers; the replies come back together |
| "Hand this work over to Codex" | A handoff note Codex can open with the goal, progress and next steps |
| "Ask Codex to review my changes" | Codex reviews the diff and sends back findings |
| "Claim `src/api.js` while you work on it" | Other sessions are warned before they edit that file |
| "Ask the local model what a 409 status means" | Answered for free by Ollama or LM Studio, if installed |

### Notes per agent

- **Codex:** when it is idle, a message arrives in its chat and Codex answers right away. Trust the hooks once with `/hooks`.
- **Claude Code:** when it is idle, the message waits for your next prompt; while it works, it answers after its current step.
- **Gemini CLI:** answers at your next prompt, or after its current step. Needs version 0.35 or newer for the hooks.
- **OpenCode:** gets messages through its plugin, after its next tool call.

### Following along

- **Connection graph** (an editor tab): every open chat is a box in its own color, titled as its agent titles it, with a small panel of lights: PWR (open), ACT (working) and MSG (lit while it sends a message, blinks as one arrives). Its ⚙ (or a double-click) shows its info, lines and settings. **Agents setup** (top right) connects or disconnects agents. **Conversations** shows every exchange as a chat, with search. Other tabs hold handoffs, reviews, notes, claims and storage (with backups before every clear).
- The canvas only moves while you look at it, so it never slows the editor down.
- **Terminal**:
  ```sh
  node dist/neurons.mjs watch            # live feed of messages, lines and agents
  node dist/neurons.mjs status           # who is connected, unread messages, open lines
  node dist/neurons.mjs disconnect all   # hang up every line
  ```

## Privacy and safety

- An agent only ever searches **its own** memory and chats. Others learn only what it chooses to reply.
- Neurons never opens login files, tokens, `.env` files or agent configs, and refuses any message that looks like it contains a secret.
- Everything is stored in one local database (for example `~/.local/share/neurons-mcp` on Linux), readable only by you.
- The optional local model is only ever reached on `localhost`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Couldn't reach codex" | That agent isn't running, or isn't connected. Open it, then ask again. |
| "Not connected to codex" | Draw a line between the two chats on the connection graph. |
| "[BLOCKED] … could not answer" or "… is blocked" | That chat hit its provider's usage limit (or lost its login). Whoever waits on it is told at once, with the reset time when the provider gives one, and new messages to it are refused until then. Its box shows **Blocked**. Ask another chat, or send again later. |
| "…'s chat is closed right now" | That chat's window was reloaded or closed, and its line is paused. Reopen the same chat (a Codex thread also needs one prompt) and the line is back. A paused line ends after a day. |
| A chat is missing from the graph | A Claude Code chat shows a few seconds after it opens; a Codex chat once it has run its first message. Check that its agent is connected under **Agents setup**. |
| An agent doesn't seem to get messages | Restart its session after Connect. For Codex, trust the hooks with `/hooks`. |
| The extension says Node is missing | Install Node 22.16+ (not 23), or set its path in the `neurons.nodePath` setting. |

## Learn more

[docs/how-it-works.md](docs/how-it-works.md) covers the rest:
- how lines and message delivery work;
- the tools, the security model and every setting;
- manual hook setup;
- the project layout for developers.
