#!/usr/bin/env node
// Neurons CLI: the agents' hooks, plus status, watch and the editor dashboard's backend for humans
import path from 'node:path';
import readline from 'node:readline';
import { HOOK } from '../configuration/prompts.js';
import { AUTO_HANDOFF, CLAIM_GUARD, DASHBOARD, DB_PATH, SESSION_LOOKBACK_MS, WAIT_POLL_MS } from '../configuration/settings.js';
import { CALL_SELECT, hangUp, pruneLines } from '../src/calls.js';
import { liveClaims, normalizeClaimPath, overlaps } from '../src/claims.js';
import { createDashboard } from '../src/dashboard.js';
import { openDb } from '../src/db.js';
import { HANDOFF_SELECT } from '../src/handoffs.js';
import { ancestorKeys, connectionCheck, linkSessionToServer, liveServers, normalizeAgent, upsertNativeSession } from '../src/identity.js';
import { handOver, stopDecision } from '../src/delivery.js';
import { inboxRows, unreadCount } from '../src/inbox.js';
import { readTail } from '../src/native/common.js';
import { recordEdits, snapshotSession } from '../src/snapshot.js';
import { ago, now, oneLine } from '../src/util.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : null;
};

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// Claude's UserPromptSubmit input carries no model; the transcript's last assistant turn does
function modelFromTranscript(file) {
  try {
    const all = [...readTail(file, 128 * 1024).matchAll(/"model":"([a-z0-9][a-z0-9.\-[\]]{2,60})"/g)];
    return all.length ? all[all.length - 1][1] : null;
  } catch {
    return null;
  }
}

// Files an edit tool is about to write: Claude's Edit/Write/MultiEdit/NotebookEdit, or the paths inside a Codex apply_patch
function editedFiles(input) {
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  let files = [];
  if (input.tool_name === 'apply_patch') {
    const patch = String(ti.command ?? ti.patch ?? ti.input ?? '');
    files = [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => m[1].trim());
  } else {
    const p = ti.file_path || ti.notebook_path;
    if (p) files = [p];
  }
  return [...new Set(files.map((f) => path.resolve(cwd, f)))];
}

// PreToolUse on edits: remember what this session edits, and warn about (or block) files another live session has claimed
function guardEdit(db, agent, input) {
  const files = editedFiles(input);
  if (!files.length) return;
  const me = nativeSession(db, agent, input);
  if (me) recordEdits(db, me, files);
  if (!db.get('SELECT 1 FROM claims WHERE released_at IS NULL AND expires_at > ? LIMIT 1', now())) return;
  const notes = [];
  for (const file of files) {
    const { repo, path: rel } = normalizeClaimPath(file, null);
    if (!repo) continue;
    const held = liveClaims(db, repo).find((c) => c.session_id !== me?.id && overlaps(c.path, rel));
    if (held) notes.push((CLAIM_GUARD === 'block' ? HOOK.claimBlocked : HOOK.claimWarning)(`${repo}/${rel}`, held));
  }
  if (!notes.length) return;
  const out =
    CLAIM_GUARD === 'block'
      ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: notes.join('\n') }
      : { hookEventName: 'PreToolUse', additionalContext: notes.join('\n') };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }) + '\n');
}

const nativeSession = (db, agent, input) => db.get('SELECT * FROM sessions WHERE agent = ? AND native_id = ?', agent, String(input.session_id));

/*
 * The same moments under each agent's event names (Claude Code / Codex · Gemini CLI); the OpenCode plugin sends
 * Claude-style names, plus Register to tie its session to its Neurons window
 */
const AFTER_TOOL = new Set(['PostToolUse', 'AfterTool']);
const AT_STOP = new Set(['Stop', 'AfterAgent']);
const NEW_PROMPT = new Set(['UserPromptSubmit', 'BeforeAgent']);
// Gemini CLI parses all hook output as JSON; Claude Code and Codex add plain text from prompt hooks to the context
const JSON_ONLY = new Set(['gemini', 'opencode']);
// Claude Code and Codex never run their Stop hook after the user interrupts; for the others, auto-listen only follows a turn the user started
const STOP_SKIPS_INTERRUPTS = new Set(['claude', 'codex']);

const context = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

// After a tool call: messages that arrived while the agent works, as extra context for the rest of its task
function afterTool(db, agent, input) {
  const me = nativeSession(db, agent, input);
  const text = me && handOver(db, me, HOOK.midTask);
  if (text) process.stdout.write(context(input.hook_event_name, text) + '\n');
}

// At stop: refresh the automatic handoff, then either let the agent stop or continue it (unread messages, auto-listen); JSON only
function atStop(db, agent, input) {
  const me = nativeSession(db, agent, input);
  if (!me) return;
  if (input.cwd) snapshotSession(db, me, input.cwd);
  const reason = stopDecision(db, me, { listen: STOP_SKIPS_INTERRUPTS.has(agent) || !input.stop_hook_active });
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

/*
 * Hook contract (Claude Code and Codex share it):
 *   stdin  {session_id, transcript_path, cwd, hook_event_name, model?, tool_name?, tool_input?}
 *   SessionStart / UserPromptSubmit: plain stdout → added to the model's context
 *   PreToolUse: JSON hookSpecificOutput, only when a claimed file is about to be edited
 *   PostToolUse: JSON hookSpecificOutput.additionalContext, only when messages arrived
 *   Stop: JSON {decision: 'block', reason} to continue the agent, otherwise silent
 * Gemini CLI: SessionStart, BeforeAgent, AfterTool and AfterAgent, all answered in JSON.
 * SessionStart announces the handle. Unread messages are handed over whole by src/delivery.js.
 */
async function hook() {
  const agent = normalizeAgent(flag('agent') || process.env.NEURONS_AGENT);
  const raw = await readStdin();
  if (!agent || !raw.trim()) return;
  const input = JSON.parse(raw);
  if (!input.session_id) return;
  const db = openDb();
  const event = input.hook_event_name;
  if (event === 'PreToolUse') return guardEdit(db, agent, input);
  if (AFTER_TOOL.has(event)) return afterTool(db, agent, input);
  if (AT_STOP.has(event)) return atStop(db, agent, input);
  if (event !== 'SessionStart' && event !== 'Register' && !NEW_PROMPT.has(event)) return;
  const hookPids = ancestorKeys(process.pid);
  const me = upsertNativeSession(db, {
    agent,
    nativeId: String(input.session_id),
    transcriptPath: input.transcript_path || null,
    cwd: input.cwd || null,
    model: input.model || (input.transcript_path ? modelFromTranscript(input.transcript_path) : null),
    hookPids,
  });
  linkSessionToServer(db, me, hookPids);
  if (event === 'Register') return;
  const lines = [];
  if (event === 'SessionStart') {
    lines.push(HOOK.sessionStart(me.handle));
    // Other sessions' automatic handoffs in this repo, so a new session knows what is in flight
    if (me.repo) {
      const recent = db.all(
        `${HANDOFF_SELECT} WHERE h.auto = 1 AND h.repo = ? AND h.author_session != ? AND h.created_at > ? ORDER BY h.created_at DESC LIMIT ?`,
        me.repo,
        me.id,
        now() - AUTO_HANDOFF.hintMaxAgeMs,
        AUTO_HANDOFF.hintCount,
      );
      for (const h of recent) lines.push(HOOK.autoHandoff(h));
    }
  }
  // A new prompt from the user starts a new stretch: auto-listen may ask again when this turn ends
  if (NEW_PROMPT.has(event)) db.run('UPDATE sessions SET listen_prompted_at = NULL WHERE id = ?', me.id);
  // A call waiting for this agent may be this session's to pick up now that it is here; unread messages go in whole
  const text = handOver(db, me, HOOK.delivered);
  if (text) lines.push(text);
  if (!lines.length) return;
  process.stdout.write((JSON_ONLY.has(agent) ? context(event, lines.join('\n')) : lines.join('\n')) + '\n');
}

function status() {
  const db = openDb();
  const sessions = db.all('SELECT * FROM sessions WHERE ended_at IS NULL AND last_seen > ? ORDER BY last_seen DESC', now() - SESSION_LOOKBACK_MS).filter(connectionCheck(db));
  console.log(`Active sessions (${sessions.length}):`);
  for (const s of sessions) {
    console.log(`  ${s.handle.padEnd(18)} ${String(s.model || '-').padEnd(20)} ${String(s.repo || 'workspace').padEnd(24)} unread ${unreadCount(db, s)}  seen ${ago(s.last_seen)}`);
  }
  const open = db.all(
    `SELECT m.*, s.handle FROM messages m JOIN sessions s ON s.id = m.from_session
     WHERE m.kind IN ('question', 'proposal', 'review') AND m.status = 'open' ORDER BY m.created_at DESC LIMIT 20`,
  );
  console.log(`\nOpen questions / proposals / review requests (${open.length}):`);
  for (const m of open) console.log(`  #${m.id} ${m.kind.padEnd(8)} ${m.handle} → ${m.to_kind === 'session' ? 'session' : m.to_target || 'any'}: ${oneLine(m.subject || m.body, 70)} (${ago(m.created_at)})`);
  pruneLines(db);
  const calls = db.all(`${CALL_SELECT} WHERE c.status IN ('ringing', 'connected') ORDER BY c.id`);
  console.log(`\nLines and ringing calls (${calls.length}):`);
  for (const c of calls) console.log(`  #${c.id} ${c.from_handle} ${c.status === 'connected' ? `⇄ ${c.answer_handle} (${c.answered_how}, ${ago(c.answered_at)})` : `→ ${c.to_kind === 'agent' ? c.to_target : 'a session'} ringing (${ago(c.created_at)})`}`);
  const counts = db.get(
    "SELECT (SELECT COUNT(*) FROM memories WHERE status = 'active') AS memories, (SELECT COUNT(*) FROM handoffs) AS handoffs, (SELECT COUNT(*) FROM reviews) AS reviews, (SELECT COUNT(*) FROM messages) AS messages",
  );
  console.log(`\nStore: ${counts.memories} memories · ${counts.handoffs} handoffs · ${counts.reviews} reviews · ${counts.messages} messages`);
}

function inbox() {
  const handle = rest[0];
  if (!handle) {
    console.error('usage: neurons inbox <handle>');
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  const me = db.get('SELECT * FROM sessions WHERE handle = ?', handle);
  if (!me) {
    console.error(`no session ${handle}`);
    process.exitCode = 1;
    return;
  }
  const rows = inboxRows(db, me, { limit: 30 });
  if (!rows.length) console.log('Inbox empty.');
  for (const m of rows) console.log(`#${m.id} ${m.kind} from ${m.from_handle} (${ago(m.created_at)}): ${oneLine(m.subject || m.body, 100)}`);
}

const KIND_COLOR = { question: 36, reply: 32, proposal: 34, review: 35, 'review-result': 35, handoff: 33, note: 90, call: 93 };
const paint = (code, text) => (process.stdout.isTTY && code ? `\x1b[${code}m${text}\x1b[0m` : text);
const clock = (ms) => new Date(ms).toLocaleTimeString('sv-SE').slice(0, 8);

/*
 * Live feed for the user: every message between agents, file claims, and
 * agent windows connecting or leaving. It only reads the DB, so it costs no
 * model tokens. --last N replays the last N messages first, --full prints whole bodies.
 */
async function watch() {
  const db = openDb();
  const full = rest.includes('--full');
  const back = Math.max(0, Number(flag('last') ?? 10) || 0);
  const handleOf = (id) => db.get('SELECT handle FROM sessions WHERE id = ?', id)?.handle || 'unknown';
  const toLabel = (m) => (m.to_kind === 'session' ? handleOf(m.to_target) : m.to_kind === 'agent' ? m.to_target : 'any');
  const show = (m) => {
    const head = `${paint(90, clock(m.created_at))} ${paint(KIND_COLOR[m.kind], `#${m.id} ${m.kind}`)} ${m.from_handle} → ${toLabel(m)}${m.reply_to ? ` re #${m.reply_to}` : ''}`;
    const text = m.subject ? `${m.subject}: ${m.body}` : m.body;
    console.log(full ? `${head}\n${text.replace(/^/gm, '    ')}` : `${head}: ${oneLine(text, 140)}`);
  };
  const key = (s) => `${s.pid}:${s.start}`;
  let lastMessage = Math.max(0, db.get('SELECT COALESCE(MAX(id), 0) AS id FROM messages').id - back);
  let lastClaim = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM claims').id;
  let since = now();
  let servers = new Map(liveServers(db).map((s) => [key(s), s]));
  console.log(`Watching ${DB_PATH}. Connected: ${[...servers.values()].map((s) => s.agent).join(', ') || 'nobody'}. Ctrl-C to stop.`);
  const tick = () => {
    for (const m of db.all('SELECT m.*, s.handle AS from_handle FROM messages m JOIN sessions s ON s.id = m.from_session WHERE m.id > ? ORDER BY m.id', lastMessage)) {
      show(m);
      lastMessage = m.id;
    }
    const t = now();
    for (const c of db.all('SELECT c.*, s.handle FROM claims c JOIN sessions s ON s.id = c.session_id WHERE c.id > ? ORDER BY c.id', lastClaim)) {
      console.log(`${paint(90, clock(c.created_at))} ${paint(33, 'claim')} ${c.handle} ${c.repo}/${c.path}${c.reason ? ` · ${c.reason}` : ''}`);
      lastClaim = c.id;
    }
    for (const c of db.all('SELECT c.*, s.handle FROM claims c JOIN sessions s ON s.id = c.session_id WHERE c.released_at > ? AND c.released_at <= ?', since, t)) {
      console.log(`${paint(90, clock(c.released_at))} ${paint(90, 'release')} ${c.handle} ${c.repo}/${c.path}`);
    }
    for (const c of db.all(`${CALL_SELECT} WHERE c.answered_at > ? AND c.answered_at <= ?`, since, t)) {
      console.log(`${paint(90, clock(c.answered_at))} ${paint(93, `line #${c.id}`)} ${c.from_handle} ⇄ ${c.answer_handle} (${c.answered_how})`);
    }
    for (const c of db.all(`${CALL_SELECT} WHERE c.ended_at > ? AND c.ended_at <= ?`, since, t)) {
      console.log(`${paint(90, clock(c.ended_at))} ${paint(90, `${c.status} #${c.id}`)} ${c.from_handle}${c.answer_handle ? ` ⇄ ${c.answer_handle}` : ''}${c.ended_by ? ` · ${c.ended_by}` : ''}`);
    }
    const current = new Map(liveServers(db).map((s) => [key(s), s]));
    for (const [k, s] of current) if (!servers.has(k)) console.log(`${paint(90, clock(t))} ${paint(32, '+')} ${s.agent} connected${s.client ? ` (${s.client})` : ''}`);
    for (const [k, s] of servers) if (!current.has(k)) console.log(`${paint(90, clock(t))} ${paint(31, '-')} ${s.agent} disconnected`);
    servers = current;
    since = t;
  };
  tick();
  const timer = setInterval(tick, WAIT_POLL_MS);
  await new Promise((resolve) => process.once('SIGINT', resolve));
  clearInterval(timer);
}

/*
 * Backend for the editor extension: JSON lines over stdio.
 *   in   {"id":1,"cmd":"snapshot","args":{}}
 *   out  {"id":1,"ok":true,"data":{...}}   or   {"id":1,"ok":false,"error":"..."}
 *   push {"event":"changed"} whenever another process commits to the DB or an agent window connects or leaves
 * `--once <cmd>` prints one answer and exits, for scripts and debugging.
 */
async function dashboard() {
  const db = openDb();
  const ops = createDashboard(db);
  const once = flag('once');
  if (once) {
    console.log(JSON.stringify(await ops[once]?.({}) ?? null, null, 2));
    return;
  }
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  // data_version moves when another connection commits; presence moves when a window opens or closes, or a call changes state
  let version = db.get('PRAGMA data_version').data_version;
  let presence = ops.presence();
  let lastPresence = Date.now();
  const timer = setInterval(() => {
    const v = db.get('PRAGMA data_version').data_version;
    let changed = v !== version;
    version = v;
    if (Date.now() - lastPresence >= DASHBOARD.presenceMs) {
      lastPresence = Date.now();
      const p = ops.presence();
      changed ||= p !== presence;
      presence = p;
    }
    if (changed) send({ event: 'changed' });
  }, DASHBOARD.pollMs);
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
      if (typeof ops[req.cmd] !== 'function' || req.cmd === 'presence') throw new Error(`Unknown command "${req.cmd}".`);
      send({ id: req.id, ok: true, data: await ops[req.cmd](req.args || {}) });
    } catch (err) {
      send({ id: req?.id ?? null, ok: false, error: err?.message || String(err) });
    }
  }
  clearInterval(timer);
}

// Hang up from a terminal: one line or call by id, every line of one handle, or everything
function disconnect() {
  const arg = rest[0];
  if (!arg) {
    console.error('usage: neurons disconnect <call id | handle | all>');
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  let calls = db.all("SELECT * FROM calls WHERE status IN ('ringing', 'connected')");
  if (/^#?\d+$/.test(arg)) calls = calls.filter((c) => c.id === Number(arg.replace('#', '')));
  else if (arg !== 'all') {
    const s = db.get('SELECT id FROM sessions WHERE handle = ?', arg.toLowerCase());
    if (!s) {
      console.error(`no session ${arg}`);
      process.exitCode = 1;
      return;
    }
    calls = calls.filter((c) => c.from_session === s.id || c.answered_by === s.id || (c.to_kind === 'session' && c.to_target === s.id));
  }
  const n = calls.filter((c) => hangUp(db, c, 'the CLI')).length;
  console.log(n ? `Hung up ${n} line(s) or call(s).` : 'Nothing to hang up.');
}

const COMMANDS = { hook, status, inbox, watch, dashboard, disconnect };

try {
  if (!COMMANDS[cmd]) {
    console.log('usage: neurons <hook --agent <name> | status | inbox <handle> | watch [--last N] [--full] | disconnect <call id | handle | all> | dashboard [--once <cmd>]>');
  } else {
    await COMMANDS[cmd]();
  }
} catch (err) {
  // A hook must never break the agent's prompt; report and exit cleanly
  console.error(`[neurons] ${cmd} failed: ${err?.message || err}`);
  if (cmd !== 'hook') process.exitCode = 1;
}
