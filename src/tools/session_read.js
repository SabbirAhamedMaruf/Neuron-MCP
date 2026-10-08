import { OUTPUT } from '../../configuration/settings.js';
import { list } from '../format.js';
import { NeuronsError } from '../guard.js';
import { listOwnSessions, readOwnSession } from '../native/index.js';
import { ago, iso, oneLine } from '../util.js';

const LABEL = { user: 'USER', assistant: 'ASSISTANT', tool: 'TOOL' };

function listSessions(a, me, db) {
  const rows = listOwnSessions(me.agent, { cwd: a.here ? me.cwd : undefined, limit: a.limit || 10 });
  if (!rows.length) return `No ${me.agent} sessions found.`;
  return list(
    rows.map((r) => {
      const linked = r.nativeId && db.get('SELECT handle FROM sessions WHERE agent = ? AND native_id = ?', r.agent, r.nativeId);
      return `${r.nativeId}${linked ? ` (${linked.handle})` : ''} · ${oneLine(r.title || 'untitled', 60)} · ${ago(r.updatedAt)}${r.nativeId === me.native_id ? ' · this one' : ''}`;
    }),
  );
}

export default async function sessionRead(a, me, { db }) {
  let nativeId = a.native_id;
  let transcriptPath = null;
  if (a.handle) {
    const s = db.get('SELECT * FROM sessions WHERE handle = ? OR id = ?', a.handle.toLowerCase(), a.handle);
    if (!s) throw new NeuronsError(`No session ${a.handle}.`);
    if (s.agent !== me.agent) throw new NeuronsError(`${s.handle} is a ${s.agent} session; you can only read your own agent's chats. Ask it with \`send\`.`);
    if (!s.native_id) throw new NeuronsError(`${s.handle} has no linked transcript.`);
    nativeId = s.native_id;
    transcriptPath = s.transcript_path;
  }
  if (!nativeId) return listSessions(a, me, db);
  const { meta, entries } = await readOwnSession(me.agent, { nativeId, transcriptPath, includeTools: true });
  const tail = a.tail || OUTPUT.sessionTail;
  const from = a.offset ?? Math.max(0, entries.length - tail);
  const lines = entries
    .slice(from, from + tail)
    .map((e, i) => `[${from + i}] ${LABEL[e.role] || e.role}${e.ts ? ` ${iso(Date.parse(e.ts))}` : ''}: ${e.text.slice(0, OUTPUT.entryChars)}`);
  // Keep the newest lines when the budget runs out on a tail read
  const tailRead = a.offset === undefined;
  let budget = a.max_chars || OUTPUT.sessionMaxChars;
  const kept = [];
  for (const l of tailRead ? [...lines].reverse() : lines) {
    if (budget - l.length < 0 && kept.length) break;
    kept.push(l);
    budget -= l.length + 1;
  }
  if (tailRead) kept.reverse();
  const cut = lines.length - kept.length;
  return [`${meta.title || nativeId} · ${entries.length} entries, showing ${kept.length}${cut ? ` (${cut} cut, raise max_chars or page with offset)` : ''}`, ...kept].join('\n');
}
