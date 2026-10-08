import { SESSION_LOOKBACK_MS } from '../../configuration/settings.js';
import { linesOf, pruneLines, ringingFor, settleRinging } from '../calls.js';
import { list, sessionLine } from '../format.js';
import { assertClean } from '../guard.js';
import { connectionCheck } from '../identity.js';
import { unreadCount } from '../inbox.js';
import { ago, now } from '../util.js';

// Who is online, which lines this session has, and which calls ring for it or from it
export default async function discover({ model, task, label }, me, { db }) {
  if (model || task || label) {
    assertClean({ model, task, label });
    db.run('UPDATE sessions SET model = COALESCE(?, model), task = COALESCE(?, task), label = COALESCE(?, label) WHERE id = ?', model, task, label, me.id);
    me = db.get('SELECT * FROM sessions WHERE id = ?', me.id);
  }
  settleRinging(db);
  const isLive = connectionCheck(db);
  pruneLines(db, isLive);
  const lines = linesOf(db, me);
  const onLine = new Set(lines.map((l) => l.peer.id));
  const incoming = ringingFor(db, me);
  const outgoing = db.all("SELECT * FROM calls WHERE status = 'ringing' AND from_session = ? ORDER BY id", me.id);
  const peers = db
    .all('SELECT * FROM sessions WHERE id != ? AND ended_at IS NULL AND last_seen > ? ORDER BY last_seen DESC LIMIT 50', me.id, now() - SESSION_LOOKBACK_MS)
    .filter(isLive);
  const state = (s) => [onLine.has(s.id) ? 'on your line' : null, s.listening_at ? 'listening' : null, s.auto_answer ? 'auto-answer' : null].filter(Boolean).join(', ');
  return [
    `You are ${me.handle} (${me.model || me.agent})${me.repo ? `, repo ${me.repo}` : ''}. Inbox: ${unreadCount(db, me)} unread.`,
    lines.length ? `Lines: ${lines.map((l) => `${l.peer.handle} (#${l.id}, ${ago(l.answered_at)})`).join(', ')}` : null,
    incoming.length ? `Ringing for you: ${incoming.map((c) => `#${c.id} from ${c.from_handle}`).join(', ')}; \`connect\` call_id only if the user wants it.` : null,
    outgoing.length ? `Calling: ${outgoing.map((c) => `#${c.id} → ${c.to_kind === 'agent' ? c.to_target : (db.get('SELECT handle FROM sessions WHERE id = ?', c.to_target)?.handle ?? 'a session')}`).join(', ')}` : null,
    peers.length ? `Online:\n${list(peers.map((s) => [sessionLine(s), state(s)].filter(Boolean).join(' · ')))}` : 'Nobody else is online.',
  ]
    .filter(Boolean)
    .join('\n');
}
