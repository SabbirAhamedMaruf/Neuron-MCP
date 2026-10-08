import { setTimeout as sleep } from 'node:timers/promises';
import { WAIT_POLL_MS } from '../../configuration/settings.js';
import { settleRinging } from '../calls.js';
import { formatInbox, inboxRows, markRead, unreadCount } from '../inbox.js';
import { CallPopups } from '../popup.js';
import { now } from '../util.js';

export default async function inbox(a, me, { db, identity, extra, ask }) {
  const waitSeconds = a.wait_seconds || 0;
  const deadline = now() + waitSeconds * 1000;
  // While it waits, the session is marked as listening; a window that shows popups answers ringing calls there, not here
  const popups = waitSeconds && ask ? new CallPopups(db, me, ask, identity) : null;
  const ringing = () => !popups || !identity.popups;
  if (waitSeconds) db.run('UPDATE sessions SET listening_at = ?, listened_at = ? WHERE id = ?', now(), now(), me.id);
  try {
    settleRinging(db);
    // Blocking read: return as soon as anything new is addressed to this session
    while (waitSeconds && now() < deadline && !extra?.signal?.aborted && !unreadCount(db, me, { ringing: ringing() })) {
      popups?.tick();
      await sleep(WAIT_POLL_MS, undefined, { signal: extra?.signal }).catch(() => {});
    }
  } finally {
    popups?.close();
    if (waitSeconds) db.run('UPDATE sessions SET listening_at = NULL WHERE id = ?', me.id);
  }
  const rows = inboxRows(db, me, { includeRead: !!a.include_read, limit: a.limit || 10, ringing: ringing() });
  if (!a.peek) markRead(db, me, rows.map((r) => r.id));
  if (!rows.length) return waitSeconds ? `Nothing new after ${waitSeconds}s.` : 'Inbox empty.';
  return formatInbox(db, rows);
}
