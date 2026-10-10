import { setTimeout as sleep } from 'node:timers/promises';
import { WAIT_POLL_MS } from '../../configuration/settings.js';
import { formatInbox, inboxRows, markRead, unreadCount } from '../inbox.js';
import { now } from '../util.js';

export default async function inbox(a, me, { db, extra }) {
  const waitSeconds = a.wait_seconds || 0;
  const deadline = now() + waitSeconds * 1000;
  // Blocking read: return as soon as anything new is addressed to this session
  while (waitSeconds && now() < deadline && !extra?.signal?.aborted && !unreadCount(db, me)) {
    await sleep(WAIT_POLL_MS, undefined, { signal: extra?.signal }).catch(() => {});
  }
  const rows = inboxRows(db, me, { includeRead: !!a.include_read, limit: a.limit || 10 });
  if (!a.peek) markRead(db, me, rows.map((r) => r.id));
  if (!rows.length) return waitSeconds ? `Nothing new after ${waitSeconds}s.` : 'Inbox empty.';
  return formatInbox(db, rows);
}
