import { CALL } from '../configuration/prompts.js';
import { NeuronsError } from './guard.js';
import { connectionCheck } from './identity.js';
import { now } from './util.js';

/*
 * Lines: the user connects two chats in the Neurons dashboard, by drawing a line from one to the other, and only
 * then can they talk. Agents never dial; a message without a line fails and asks the agent to have the user connect it.
 *
 *   dashboard: claude-a ──drag──► codex-b  ──► line #7: claude-a ⇄ codex-b
 *   "codex" from claude-a (and "claude" from codex-b) now means that one session; its handle works too
 *   either side (`disconnect`), the dashboard or the CLI hangs up; a closed window or a cleared chat ends its lines
 *
 * A line is a row of the calls table, connected → ended. Rows of the older ringing design end as missed, declined or
 * cancelled and are never reopened.
 */
export const LINE_SELECT = `SELECT c.*, f.handle AS from_handle, f.agent AS from_agent, a.handle AS answer_handle, a.agent AS answer_agent
  FROM calls c JOIN sessions f ON f.id = c.from_session LEFT JOIN sessions a ON a.id = c.answered_by`;

export const lineById = (db, id) => db.get(`${LINE_SELECT} WHERE c.id = ?`, id);

const sessionById = (db, id) => db.get('SELECT * FROM sessions WHERE id = ?', id);

// Ends a line once; false when it had already ended
function endLine(db, line, by) {
  return Number(db.run("UPDATE calls SET status = 'ended', ended_by = ?, ended_at = ? WHERE id = ? AND status = 'connected'", by, now(), line.id).changes) === 1;
}

export const hangUp = (db, line, by) => line.status === 'connected' && endLine(db, line, by);

// Agents whose window holds one chat at a time: a newer session there means the older chat was cleared or left.
// A Codex app-server and an OpenCode server host several threads that all stay open.
const ONE_CHAT_PER_WINDOW = new Set(['claude', 'gemini']);

// Why a line's end is gone: its window closed, or (one chat per window) a newer chat replaced it; null while it is there
function goneReason(db, s, isLive) {
  if (!s) return 'a closed window';
  if (!isLive(s)) return `${s.handle} closing its window`;
  if (!ONE_CHAT_PER_WINDOW.has(s.agent) || !s.server_pid) return null;
  const newer = db.get(
    'SELECT 1 FROM sessions WHERE server_pid = ? AND server_start = ? AND agent = ? AND id != ? AND ended_at IS NULL AND COALESCE(hook_seen_at, created_at) > ? LIMIT 1',
    s.server_pid,
    s.server_start,
    s.agent,
    s.id,
    s.hook_seen_at || s.created_at,
  );
  return newer ? `${s.handle} leaving its chat` : null;
}

// A line whose end closed its window or left its chat is over
export function pruneLines(db, isLive = null) {
  const lines = db.all("SELECT * FROM calls WHERE status = 'connected'");
  if (!lines.length) return;
  isLive ||= connectionCheck(db);
  for (const c of lines) {
    const why = [c.from_session, c.answered_by].map((id) => goneReason(db, sessionById(db, id), isLive)).find(Boolean);
    if (why) endLine(db, c, why);
  }
}

// This session's open lines, each with the session at the other end
export function linesOf(db, me) {
  return db
    .all(`${LINE_SELECT} WHERE c.status = 'connected' AND (c.from_session = ? OR c.answered_by = ?) ORDER BY c.answered_at`, me.id, me.id)
    .map((c) => ({ ...c, peer: sessionById(db, c.from_session === me.id ? c.answered_by : c.from_session) }));
}

// The open line a message to this target travels on, or null when there is none
function lineFor(db, me, target) {
  if (target.kind !== 'agent' && target.kind !== 'session') return null;
  pruneLines(db);
  const matching = linesOf(db, me).filter((l) => (target.kind === 'agent' ? l.peer.agent === target.target : l.peer.id === target.target));
  // Lines made twice between the same two sessions (older data) are one line to talk on: the oldest
  const seen = new Set();
  const lines = matching.filter((l) => !seen.has(l.peer.id) && seen.add(l.peer.id));
  if (lines.length > 1) throw new NeuronsError(CALL.ambiguous(lines.map((l) => l.peer.handle)));
  return lines[0] || null;
}

// The line a message must travel on; without one, the agent is told to ask the user to connect it
export function requireLine(db, me, target) {
  const line = lineFor(db, me, target);
  if (!line) throw new NeuronsError(CALL.notConnected(target.kind === 'agent' ? target.target : target.label));
  return line;
}

// Handoffs and reviews to an agent go to the session on the line when there is one
export function overLine(db, me, target) {
  const line = lineFor(db, me, target);
  return line ? { kind: 'session', target: line.peer.id, label: `${line.peer.handle} (line #${line.id})`, session: line.peer } : target;
}

// One session per agent window: the one prompted last. A cleared Claude chat or an idle Codex thread in the same window is not who answers now
export function newestPerWindow(rows) {
  const byWindow = new Map();
  const seen = (s) => s.hook_seen_at || s.created_at;
  for (const s of rows) {
    const key = s.server_pid ? `${s.server_pid}:${s.server_start}` : s.id;
    if (!byWindow.has(key) || seen(s) > seen(byWindow.get(key))) byWindow.set(key, s);
  }
  return [...byWindow.values()];
}

// The user connects two chats (from the dashboard); an existing line between them is returned instead of a second one
export function openLine(db, fromId, toId, how = 'dashboard') {
  if (fromId === toId) throw new NeuronsError('A chat cannot be connected to itself.');
  const isLive = connectionCheck(db);
  const [a, b] = [sessionById(db, fromId), sessionById(db, toId)];
  if (!a || !b || !isLive(a) || !isLive(b)) throw new NeuronsError('Both chats must be open to connect them.');
  const id = db.tx(() => {
    const existing = db.get(
      "SELECT id FROM calls WHERE status = 'connected' AND ((from_session = ? AND answered_by = ?) OR (from_session = ? AND answered_by = ?))",
      a.id,
      b.id,
      b.id,
      a.id,
    );
    if (existing) return existing.id;
    const t = now();
    return Number(
      db.run(
        "INSERT INTO calls (from_session, to_kind, to_target, status, answered_by, answered_how, created_at, answered_at) VALUES (?, 'session', ?, 'connected', ?, ?, ?, ?)",
        a.id,
        b.id,
        b.id,
        how,
        t,
        t,
      ).lastInsertRowid,
    );
  });
  return lineById(db, id);
}
