import { setTimeout as sleep } from 'node:timers/promises';
import { CALL } from '../configuration/prompts.js';
import { LIMITS, SESSION_LOOKBACK_MS, WAIT_POLL_MS } from '../configuration/settings.js';
import { NeuronsError } from './guard.js';
import { connectionCheck } from './identity.js';
import { postMessage } from './inbox.js';
import { now } from './util.js';

/*
 * Calls and lines, like a telephone:
 *
 *   claude-a ── send/connect "codex" ──► rings codex-b, codex-c, … (every live codex session)
 *   codex-b picks up (dashboard, its chat, or an auto-answer rule) ──► line #n: claude-a ⇄ codex-b
 *   while line #n is up, "codex" from claude-a (and "claude" from codex-b) means that one session
 *   either side, the dashboard or the CLI hangs up ──► the next send rings again
 *
 * One row per call: ringing → connected → ended, or ringing → missed | declined | cancelled.
 * The call's first message is addressed to the agent while it rings, then to the session that picked up.
 */
export const CALL_SELECT = `SELECT c.*, f.handle AS from_handle, f.agent AS from_agent, a.handle AS answer_handle, a.agent AS answer_agent
  FROM calls c JOIN sessions f ON f.id = c.from_session LEFT JOIN sessions a ON a.id = c.answered_by`;

export const callById = (db, id) => db.get(`${CALL_SELECT} WHERE c.id = ?`, id);

const sessionById = (db, id) => db.get('SELECT * FROM sessions WHERE id = ?', id);

// Ends a line or a ringing call; a call nobody took also takes its message out of every inbox
function finish(db, call, status, by) {
  const res = db.run("UPDATE calls SET status = ?, ended_by = ?, ended_at = ? WHERE id = ? AND status IN ('ringing', 'connected')", status, by, now(), call.id);
  if (!res.changes) return false;
  if (status !== 'ended' && call.message_id) db.run("UPDATE messages SET status = ? WHERE id = ? AND status = 'open'", status, call.message_id);
  return true;
}

// Ringing calls past LIMITS.ringSeconds are missed calls
export function expireCalls(db) {
  for (const c of db.all("SELECT id, message_id FROM calls WHERE status = 'ringing' AND created_at < ?", now() - LIMITS.ringSeconds * 1000)) finish(db, c, 'missed', null);
}

// A line whose other end closed its window is over; the next send to that agent rings again
export function pruneLines(db, isLive = null) {
  const lines = db.all("SELECT * FROM calls WHERE status = 'connected'");
  if (!lines.length) return;
  isLive ||= connectionCheck(db);
  for (const c of lines) {
    const gone = [c.from_session, c.answered_by].map((id) => sessionById(db, id) || null).find((s) => !s || !isLive(s));
    if (gone !== undefined) finish(db, c, 'ended', gone ? `${gone.handle} closing its window` : 'a closed window');
  }
}

// This session's open lines, each with the session at the other end
export function linesOf(db, me) {
  return db
    .all(`${CALL_SELECT} WHERE c.status = 'connected' AND (c.from_session = ? OR c.answered_by = ?) ORDER BY c.answered_at`, me.id, me.id)
    .map((c) => ({ ...c, peer: sessionById(db, c.from_session === me.id ? c.answered_by : c.from_session) }));
}

// Calls ringing for this session: to its agent or to its handle, placed by someone else
export function ringingFor(db, me) {
  return db.all(
    `${CALL_SELECT} WHERE c.status = 'ringing' AND c.from_session != ? AND ((c.to_kind = 'agent' AND c.to_target = ?) OR (c.to_kind = 'session' AND c.to_target = ?)) ORDER BY c.id`,
    me.id,
    me.agent,
    me.id,
  );
}

// The open line a message to this target travels on, or null when it would ring
export function lineFor(db, me, target) {
  if (target.kind !== 'agent' && target.kind !== 'session') return null;
  pruneLines(db);
  const lines = linesOf(db, me).filter((l) => (target.kind === 'agent' ? l.peer.agent === target.target : l.peer.id === target.target));
  if (lines.length > 1) throw new NeuronsError(CALL.ambiguous(lines.map((l) => l.peer.handle)));
  return lines[0] || null;
}

// Handoffs and reviews to an agent go to the session on the line when there is one
export function overLine(db, me, target) {
  const line = lineFor(db, me, target);
  return line ? { kind: 'session', target: line.peer.id, label: `${line.peer.handle} (line #${line.id})`, session: line.peer } : target;
}

// One session per agent window: the one prompted last. A cleared Claude chat or an idle Codex thread in the same window is not who answers now
function newestPerWindow(rows) {
  const byWindow = new Map();
  const seen = (s) => s.hook_seen_at || s.created_at;
  for (const s of rows) {
    const key = s.server_pid ? `${s.server_pid}:${s.server_start}` : s.id;
    if (!byWindow.has(key) || seen(s) > seen(byWindow.get(key))) byWindow.set(key, s);
  }
  return [...byWindow.values()];
}

// Each session with whether its window shows call popups
const SESSION_WITH_POPUPS = 'SELECT s.*, (SELECT v.popups FROM servers v WHERE v.pid = s.server_pid AND v.start = s.server_start) AS popups FROM sessions s';

// Live sessions that can take a call: the one handle dialled, or the current session of each window of the agent except the caller's
export function candidates(db, call, isLive = connectionCheck(db)) {
  if (call.to_kind === 'session') return db.all(`${SESSION_WITH_POPUPS} WHERE s.id = ?`, call.to_target).filter(isLive);
  const rows = db.all(`${SESSION_WITH_POPUPS} WHERE s.agent = ? AND s.id != ? AND s.ended_at IS NULL AND s.last_seen > ? ORDER BY s.created_at`, call.to_target, call.from_session, now() - SESSION_LOOKBACK_MS);
  return newestPerWindow(rows.filter(isLive));
}

/*
 * Who picks up without the user:
 *   a session with auto-answer on (switched on in the dashboard; earliest first)
 *   nobody while any window that can take the call shows call popups: the user answers there (src/popup.js)
 *   otherwise the only session that can take the call, or the earliest listener
 */
function autoPick(list) {
  const first = (key) => list.filter((s) => s[key]).sort((a, b) => a[key] - b[key])[0];
  const auto = first('auto_answer');
  if (auto) return [auto, 'auto-answer'];
  if (list.some((s) => s.popups)) return [null, null];
  if (list.length === 1) return [list[0], 'only session'];
  const listening = first('listening_at');
  return listening ? [listening, 'listening'] : [null, null];
}

// Inside a transaction: the call is connected, and its message now belongs to the session that picked up (unread for it, even if it saw it ringing)
function pickUp(db, c, session, how) {
  db.run("UPDATE calls SET status = 'connected', answered_by = ?, answered_how = ?, answered_at = ? WHERE id = ?", session.id, how, now(), c.id);
  if (!c.message_id) return;
  db.run("UPDATE messages SET to_kind = 'session', to_target = ? WHERE id = ?", session.id, c.message_id);
  db.run('DELETE FROM message_reads WHERE message_id = ? AND session_id = ?', c.message_id, session.id);
}

// Picks up a ringing call for one session; false if someone else got there first or it stopped ringing
export function answerCall(db, callId, session, how) {
  return db.tx(() => {
    const c = db.get('SELECT * FROM calls WHERE id = ?', callId);
    if (!c || c.status !== 'ringing') return false;
    pickUp(db, c, session, how);
    return true;
  });
}

// Applies the auto-answer rules to every ringing call; a call whose caller left stops ringing
export function settleRinging(db) {
  expireCalls(db);
  const ringing = db.all("SELECT * FROM calls WHERE status = 'ringing'");
  if (!ringing.length) return;
  const isLive = connectionCheck(db);
  for (const c of ringing) {
    const caller = sessionById(db, c.from_session);
    if (!caller || !isLive(caller)) {
      finish(db, c, 'cancelled', 'caller left');
      continue;
    }
    const [s, how] = autoPick(candidates(db, c, isLive));
    if (s) answerCall(db, c.id, s, how);
  }
}

// Rings the target with a message (a question, a note, or the call itself); an auto-answer pick-up happens in the same
// transaction, so no other session ever sees an auto-answered call ringing
export function placeCall(db, me, target, message) {
  expireCalls(db);
  const isLive = connectionCheck(db);
  const id = db.tx(() => {
    const callId = Number(db.run('INSERT INTO calls (from_session, to_kind, to_target, created_at) VALUES (?, ?, ?, ?)', me.id, target.kind, target.target, now()).lastInsertRowid);
    const messageId = postMessage(db, { ...message, toKind: target.kind, toTarget: target.target, linkType: 'call', linkId: callId });
    db.run('UPDATE calls SET message_id = ? WHERE id = ?', messageId, callId);
    const call = db.get('SELECT * FROM calls WHERE id = ?', callId);
    const [s, how] = autoPick(candidates(db, call, isLive));
    if (s) pickUp(db, call, s, how);
    return callId;
  });
  return callById(db, id);
}

// Ends a line, or stops a ringing call: its caller cancels it, anyone else declines it
export function hangUp(db, call, by, bySession = null) {
  if (call.status === 'connected') return finish(db, call, 'ended', by);
  if (call.status === 'ringing') return finish(db, call, bySession === call.from_session ? 'cancelled' : 'declined', by);
  return false;
}

export const isOpen = (c) => c?.status === 'ringing' || c?.status === 'connected';

// Blocks until someone picks up, the call stops ringing, or the time is up
export async function waitForPickUp(db, callId, seconds, signal) {
  const deadline = Date.now() + Math.min(seconds, LIMITS.ringSeconds) * 1000;
  while (true) {
    expireCalls(db);
    const c = callById(db, callId);
    if (c.status !== 'ringing' || Date.now() >= deadline || signal?.aborted) return c;
    await sleep(WAIT_POLL_MS, undefined, { signal }).catch(() => {});
  }
}
