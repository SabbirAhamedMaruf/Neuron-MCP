import { setTimeout as sleep } from 'node:timers/promises';
import { INBOX_HINTS, ROLE, opinionsHeader } from '../configuration/prompts.js';
import { BROADCAST_TTL_MS, LIMITS, OUTPUT, WAIT_POLL_MS } from '../configuration/settings.js';
import { ago, clip, now, oneLine, parseJson } from './util.js';

/*
 * What lands in a session's inbox:
 *   to this session            → until read
 *   to its agent / to "any"    → questions and proposals while unanswered,
 *                                review requests while unclaimed,
 *                                notes and handoffs for BROADCAST_TTL_MS
 * Messages of the older ringing calls that nobody picked up (status missed, declined or cancelled) were never delivered.
 */
const CALL_HIDDEN = `COALESCE(m.link_type, '') = 'call' AND m.status IN ('missed', 'declined', 'cancelled')`;
const BROADCAST = `((m.kind IN ('question', 'proposal', 'review') AND m.status = 'open') OR (m.kind NOT IN ('question', 'proposal', 'review') AND m.created_at > :since))`;
const visible = (addressed) => `m.from_session != :me AND NOT (${CALL_HIDDEN}) AND (${addressed})`;
// Every branch starts with an equality on messages_to, so SQLite reads the index instead of the whole table
const VISIBLE = visible(`(m.to_kind = 'session' AND m.to_target = :me)
  OR (m.to_kind = 'agent' AND m.to_target = :agent AND ${BROADCAST})
  OR (m.to_kind = 'any' AND ${BROADCAST})`);
// Messages to this one session: line traffic and replies
const TO_SESSION = visible(`m.to_kind = 'session' AND m.to_target = :me`);

const params = (me, extra = {}) => ({ me: me.id, agent: me.agent, since: now() - BROADCAST_TTL_MS, ...extra });

// Newest first, or the oldest ones first for hand-overs, so a long backlog is never starved by new arrivals
export function inboxRows(db, me, { includeRead = false, limit = 30, sessionOnly = false, oldestFirst = false } = {}) {
  const order = oldestFirst ? 'ASC' : 'DESC';
  return db.all(
    `SELECT m.*, s.handle AS from_handle, s.agent AS from_agent, s.model AS from_model, r.read_at
     FROM messages m
     JOIN sessions s ON s.id = m.from_session
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.session_id = :me
     WHERE ${sessionOnly ? TO_SESSION : VISIBLE} AND (:includeRead = 1 OR r.read_at IS NULL)
     ORDER BY m.created_at ${order}, m.id ${order}
     LIMIT :limit`,
    // node:sqlite refuses named parameters the statement does not use, and the session-only one uses fewer
    sessionOnly ? { me: me.id, includeRead: includeRead ? 1 : 0, limit } : params(me, { includeRead: includeRead ? 1 : 0, limit }),
  );
}

export function unreadCount(db, me) {
  return db.get(
    `SELECT COUNT(*) AS n FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.session_id = :me
     WHERE ${VISIBLE} AND r.read_at IS NULL`,
    params(me),
  ).n;
}

// One statement for any number of ids, so it is atomic without a transaction (callers may already be in one)
export function markRead(db, me, ids) {
  if (!ids.length) return;
  db.run('INSERT OR IGNORE INTO message_reads (message_id, session_id, read_at) SELECT value, ?, ? FROM json_each(?)', me.id, now(), JSON.stringify(ids));
}

// May this session answer the message? Only if it was addressed to it
export function isRecipient(msg, me) {
  if (msg.from_session === me.id) return false;
  if (msg.to_kind === 'any') return true;
  if (msg.to_kind === 'agent') return msg.to_target === me.agent;
  return msg.to_target === me.id;
}

export function postMessage(db, { from, toKind, toTarget, kind, subject, body, repo, refs, replyTo, linkType, linkId, status = 'open' }) {
  const res = db.run(
    `INSERT INTO messages (from_session, to_kind, to_target, kind, subject, body, repo, refs, reply_to, link_type, link_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    from,
    toKind,
    toTarget,
    kind,
    subject,
    body,
    repo,
    refs && refs.length ? JSON.stringify(refs) : null,
    replyTo,
    linkType,
    linkId,
    status,
    now(),
  );
  return Number(res.lastInsertRowid);
}

// Between an admin and its worker (roles the user set), what the message is to the chat reading it
function roleTag(db, m) {
  if (m.to_kind !== 'session') return null;
  const from = db.get('SELECT role FROM sessions WHERE id = ?', m.from_session)?.role;
  const to = db.get('SELECT role FROM sessions WHERE id = ?', m.to_target)?.role;
  if (from === 'admin' && to === 'worker') return ROLE.fromAdmin;
  if (from === 'worker' && to === 'admin') return ROLE.fromWorker;
  return null;
}

export function formatMessage(db, m) {
  const call = m.link_type === 'call' ? ` · line #${m.link_id}` : '';
  const head = `#${m.id} ${m.kind} from ${m.from_handle}${m.reply_to ? ` re #${m.reply_to}` : ''}${call} · ${ago(m.created_at)}${m.subject ? ` · ${m.subject}` : ''}`;
  const refs = parseJson(m.refs, []);
  const hint = INBOX_HINTS[m.kind];
  return [head, roleTag(db, m), clip(m.body, OUTPUT.messageBodyChars), refs.length ? `refs: ${refs.join(', ')}` : null, hint ? hint(m) : null].filter(Boolean).join('\n');
}

/*
 * Second opinions: a fan-out is one question per agent, all with
 * link_type 'group' and link_id = the first question's id. Replies to any of
 * them are shown together under one header, with who has not answered yet.
 */
export function formatInbox(db, rows) {
  const parents = new Map();
  const parentOf = (m) => {
    if (!m.reply_to) return null;
    if (!parents.has(m.reply_to)) parents.set(m.reply_to, db.get('SELECT id, link_type, link_id, subject, body FROM messages WHERE id = ?', m.reply_to));
    return parents.get(m.reply_to);
  };
  const groupOf = (m) => {
    const p = parentOf(m);
    return p?.link_type === 'group' ? p.link_id : null;
  };
  const shown = new Set();
  const blocks = [];
  for (const m of rows) {
    const group = groupOf(m);
    if (group === null) {
      blocks.push(formatMessage(db, m));
      continue;
    }
    if (shown.has(group)) continue;
    shown.add(group);
    const asked = db.all(
      "SELECT m.id, COALESCE(s.handle, m.to_target) AS to_label, m.subject, m.body FROM messages m LEFT JOIN sessions s ON m.to_kind = 'session' AND s.id = m.to_target WHERE m.link_type = 'group' AND m.link_id = ? ORDER BY m.id",
      group,
    );
    const answered = new Set(db.all('SELECT DISTINCT reply_to FROM messages WHERE reply_to IN (SELECT value FROM json_each(?))', JSON.stringify(asked.map((q) => q.id))).map((r) => r.reply_to));
    const waiting = asked.filter((q) => !answered.has(q.id)).map((q) => q.to_label);
    const members = rows.filter((r) => groupOf(r) === group);
    blocks.push([opinionsHeader(group, asked[0]?.subject || oneLine(asked[0]?.body, 60), answered.size, asked.length, waiting), ...members.map((r) => formatMessage(db, r))].join('\n\n'));
  }
  return blocks.join('\n---\n');
}

function repliesTo(db, ids) {
  return db.all(
    `SELECT m.*, s.handle AS from_handle, s.agent AS from_agent, s.model AS from_model FROM messages m
     JOIN sessions s ON s.id = m.from_session WHERE m.reply_to IN (SELECT value FROM json_each(?)) ORDER BY m.created_at`,
    JSON.stringify(ids),
  );
}

// Polls the shared DB; another agent's process writes the reply. `every` waits for an answer to each id, not just the first; `stop` ends the wait early
export async function waitForReplies(db, me, ids, seconds, signal, { every = false, stop = null } = {}) {
  const deadline = Date.now() + Math.min(seconds, LIMITS.waitSeconds) * 1000;
  while (true) {
    const replies = repliesTo(db, ids);
    const done = every ? ids.every((id) => replies.some((r) => r.reply_to === id)) : replies.length > 0;
    if (done || Date.now() >= deadline || signal?.aborted || stop?.()) {
      markRead(db, me, replies.map((r) => r.id));
      return replies;
    }
    await sleep(WAIT_POLL_MS, undefined, { signal }).catch(() => {});
  }
}
