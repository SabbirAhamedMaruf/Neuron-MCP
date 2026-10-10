import { setTimeout as sleep } from 'node:timers/promises';
import { ASK_WAIT_MS, WAIT_POLL_MS } from '../configuration/settings.js';
import { postMessage } from './inbox.js';
import { now, oneLine, parseJson } from './util.js';

/*
 * Ask first: a chat set to it sends nothing by itself. Its message waits here while the editor shows it (a
 * notification and a card on the graph), and goes out over its lines once, if the user allows it.
 *
 *   send ──► asks: pending ──► Allow ──► one message per line (if the line is still open)
 *                          ──► Deny, or no answer within ASK_WAIT_MS ──► nothing is sent
 */
const KEEP_DECIDED_MS = 24 * 60 * 60 * 1000;

// One message per chat; a group (several chats, or "all") links them so the inbox shows their answers together
export function deliver(db, message, peers, group = peers.length > 1) {
  const out = [];
  for (const peer of peers) {
    const link = group ? { linkType: 'group', linkId: out[0]?.id ?? null } : {};
    const id = postMessage(db, { ...message, toKind: 'session', toTarget: peer.id, ...link });
    if (group && !out.length) db.run('UPDATE messages SET link_id = ? WHERE id = ?', id, id);
    out.push({ id, handle: peer.handle });
  }
  return out;
}

// Holds a message (without its sender) for the user's OK; routes: [{ peer, lineId }]
export function openAsk(db, me, message, routes) {
  const t = now();
  db.run("DELETE FROM asks WHERE status != 'pending' AND created_at < ?", t - KEEP_DECIDED_MS);
  const payload = { message, to: routes.map(({ peer, lineId }) => ({ session: peer.id, handle: peer.handle, line: lineId })) };
  return Number(db.run("INSERT INTO asks (from_session, payload, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)", me.id, JSON.stringify(payload), t, t + ASK_WAIT_MS).lastInsertRowid);
}

// Waits for the user's answer; past its time (or a cancelled tool call) the ask expires, unless it was just decided
export async function awaitDecision(db, id, signal) {
  for (;;) {
    const row = db.get('SELECT * FROM asks WHERE id = ?', id);
    if (!row || row.status !== 'pending') return row || { status: 'cancelled' };
    if (now() >= row.expires_at || signal?.aborted) {
      db.run("UPDATE asks SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", now(), id);
      continue;
    }
    await sleep(WAIT_POLL_MS, undefined, { signal }).catch(() => {});
  }
}

// The user's answer, from the editor notification or the dashboard; an allowed message goes only over lines still open
export function decideAsk(db, id, allow, by) {
  return db.tx(() => {
    const row = db.get('SELECT * FROM asks WHERE id = ?', id);
    if (!row) return { status: 'gone' };
    if (row.status !== 'pending') return { status: row.status };
    const t = now();
    if (row.expires_at <= t) return { status: 'expired' };
    if (!allow) {
      db.run("UPDATE asks SET status = 'denied', decided_at = ?, decided_by = ? WHERE id = ?", t, by, id);
      return { status: 'denied' };
    }
    const { message = {}, to = [] } = parseJson(row.payload, {});
    const peers = to
      .filter((x) => db.get("SELECT 1 FROM calls WHERE id = ? AND status = 'connected' AND paused_at IS NULL", x.line))
      .map((x) => db.get('SELECT * FROM sessions WHERE id = ?', x.session))
      .filter(Boolean);
    if (!peers.length) {
      db.run("UPDATE asks SET status = 'cancelled', decided_at = ?, decided_by = ? WHERE id = ?", t, by, id);
      return { status: 'cancelled' };
    }
    const sent = deliver(db, { ...message, from: row.from_session }, peers);
    db.run("UPDATE asks SET status = 'allowed', decided_at = ?, decided_by = ?, message_ids = ? WHERE id = ?", t, by, JSON.stringify(sent), id);
    return { status: 'allowed', sent };
  });
}

// Every editor window sees a new ask; the first to claim it shows the notification
export const claimAskNotice = (db, id, by) => Number(db.run("UPDATE asks SET noticed_by = ? WHERE id = ? AND noticed_by IS NULL AND status = 'pending'", String(by), id).changes) === 1;

// Asks still waiting for the user, for the dashboard and the editor notification
export function pendingAsks(db) {
  return db
    .all(
      `SELECT a.*, s.handle AS from_handle, s.agent AS from_agent FROM asks a JOIN sessions s ON s.id = a.from_session
       WHERE a.status = 'pending' AND a.expires_at > ? ORDER BY a.id`,
      now(),
    )
    .map((a) => {
      const { message = {}, to = [] } = parseJson(a.payload, {});
      return {
        id: a.id,
        from: a.from_handle,
        fromId: a.from_session,
        fromAgent: a.from_agent,
        to: to.map((x) => x.handle),
        kind: message.kind || 'question',
        text: oneLine(message.subject || message.body, 160),
        at: a.created_at,
        expiresAt: a.expires_at,
      };
    });
}
