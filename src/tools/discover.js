import { SESSION_LOOKBACK_MS } from '../../configuration/settings.js';
import { linesOf, newestPerWindow, pruneLines } from '../lines.js';
import { list, sessionLine } from '../format.js';
import { assertClean } from '../guard.js';
import { connectionCheck } from '../identity.js';
import { unreadCount } from '../inbox.js';
import { ago, now } from '../util.js';

// Who is online and which lines this session has (the user draws them in the dashboard)
export default async function discover({ model, task, label }, me, { db }) {
  if (model || task || label) {
    assertClean({ model, task, label });
    db.run('UPDATE sessions SET model = COALESCE(?, model), task = COALESCE(?, task), label = COALESCE(?, label) WHERE id = ?', model, task, label, me.id);
    me = db.get('SELECT * FROM sessions WHERE id = ?', me.id);
  }
  const isLive = connectionCheck(db);
  pruneLines(db, isLive);
  const lines = linesOf(db, me);
  const onLine = new Set(lines.map((l) => l.peer.id));
  // One session per window: a cleared chat's old session is not online
  const peers = newestPerWindow(db.all('SELECT * FROM sessions WHERE ended_at IS NULL AND last_seen > ? ORDER BY last_seen DESC LIMIT 51', now() - SESSION_LOOKBACK_MS).filter(isLive)).filter((s) => s.id !== me.id);
  return [
    `You are ${me.handle} (${me.model || me.agent})${me.repo ? `, repo ${me.repo}` : ''}. Inbox: ${unreadCount(db, me)} unread.`,
    lines.length ? `Lines: ${lines.map((l) => `${l.peer.handle} (#${l.id}, ${ago(l.answered_at)})`).join(', ')}` : null,
    peers.length ? `Online:\n${list(peers.map((s) => `${sessionLine(s)}${onLine.has(s.id) ? ' · on your line' : ''}`))}` : 'Nobody else is online.',
  ]
    .filter(Boolean)
    .join('\n');
}
