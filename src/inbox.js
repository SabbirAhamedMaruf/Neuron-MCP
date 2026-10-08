import { setTimeout as sleep } from 'node:timers/promises';
import { INBOX_HINTS, opinionsHeader } from '../configuration/prompts.js';
import { BROADCAST_TTL_MS, LIMITS, OUTPUT, WAIT_POLL_MS } from '../configuration/settings.js';
import { connectionCheck } from './identity.js';
import { ago, clip, now, oneLine, parseJson } from './util.js';

/*
 * What lands in a session's inbox:
 *   to this session            → until read
 *   to its agent / to "any"    → questions and proposals while unanswered,
 *                                review requests while unclaimed, calls while ringing,
 *                                notes and handoffs for BROADCAST_TTL_MS
 */
const VISIBLE = `
  m.from_session != :me
  AND (
    (m.to_kind = 'session' AND m.to_target = :me)
    OR (
      ((m.to_kind = 'agent' AND m.to_target = :agent) OR m.to_kind = 'any')
      AND (
        (m.kind IN ('question', 'proposal', 'review', 'call') AND m.status = 'open')
        OR (m.kind NOT IN ('question', 'proposal', 'review', 'call') AND m.created_at > :since)
      )
    )
  )`;

const params = (me, extra = {}) => ({ me: me.id, agent: me.agent, since: now() - BROADCAST_TTL_MS, ...extra });

// A ringing call's message, which a window that shows call popups leaves to the popup
const NOT_RINGING = ` AND NOT (m.link_type = 'call' AND m.to_kind != 'session')`;

export function inboxRows(db, me, { includeRead = false, limit = 30, ringing = true } = {}) {
  return db.all(
    `SELECT m.*, s.handle AS from_handle, s.agent AS from_agent, s.model AS from_model, r.read_at
     FROM messages m
     JOIN sessions s ON s.id = m.from_session
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.session_id = :me
     WHERE ${VISIBLE} AND (:includeRead = 1 OR r.read_at IS NULL)${ringing ? '' : NOT_RINGING}
     ORDER BY m.created_at DESC
     LIMIT :limit`,
    params(me, { includeRead: includeRead ? 1 : 0, limit }),
  );
}

export function unreadCount(db, me, { ringing = true } = {}) {
  return db.get(
    `SELECT COUNT(*) AS n FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.session_id = :me
     WHERE ${VISIBLE} AND r.read_at IS NULL${ringing ? '' : NOT_RINGING}`,
    params(me),
  ).n;
}

export function markRead(db, me, ids) {
  const t = now();
  for (const id of ids) db.run('INSERT OR IGNORE INTO message_reads (message_id, session_id, read_at) VALUES (?, ?, ?)', id, me.id, t);
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

// A call's message is addressed to the whole agent while it rings and to one session once picked up
export const isRinging = (m) => m.link_type === 'call' && m.to_kind !== 'session';

export function formatMessage(db, m) {
  const call = m.link_type === 'call' ? (isRinging(m) ? ` · ringing call #${m.link_id}` : ` · line #${m.link_id}`) : '';
  const head = `#${m.id} ${m.kind} from ${m.from_handle}${m.reply_to ? ` re #${m.reply_to}` : ''}${call} · ${ago(m.created_at)}${m.subject ? ` · ${m.subject}` : ''}`;
  const refs = parseJson(m.refs, []);
  const hint = isRinging(m) ? INBOX_HINTS.ringing : INBOX_HINTS[m.kind];
  return [head, clip(m.body, OUTPUT.messageBodyChars), refs.length ? `refs: ${refs.join(', ')}` : null, hint ? hint(m) : null].filter(Boolean).join('\n');
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
    const asked = db.all("SELECT id, to_target, subject, body FROM messages WHERE link_type = 'group' AND link_id = ? ORDER BY id", group);
    const answered = new Set(db.all(`SELECT DISTINCT reply_to FROM messages WHERE reply_to IN (${asked.map(() => '?').join(', ')})`, ...asked.map((q) => q.id)).map((r) => r.reply_to));
    const waiting = asked.filter((q) => !answered.has(q.id)).map((q) => q.to_target);
    const members = rows.filter((r) => groupOf(r) === group);
    blocks.push([opinionsHeader(group, asked[0]?.subject || oneLine(asked[0]?.body, 60), answered.size, asked.length, waiting), ...members.map((r) => formatMessage(db, r))].join('\n\n'));
  }
  return blocks.join('\n---\n');
}

// Handles of the sessions behind these live servers, for telling the sender who got the message
export function connectedHandles(db, servers, me) {
  const connected = connectionCheck(db, servers);
  return db
    .all('SELECT * FROM sessions WHERE ended_at IS NULL AND id != ? ORDER BY last_seen DESC LIMIT 200', me.id)
    .filter(connected)
    .map((s) => s.handle)
    .slice(0, 6);
}

function repliesTo(db, ids) {
  const marks = ids.map(() => '?').join(', ');
  return db.all(
    `SELECT m.*, s.handle AS from_handle, s.agent AS from_agent, s.model AS from_model FROM messages m
     JOIN sessions s ON s.id = m.from_session WHERE m.reply_to IN (${marks}) ORDER BY m.created_at`,
    ...ids,
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
