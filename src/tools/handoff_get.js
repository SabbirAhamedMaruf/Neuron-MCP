import { list, section } from '../format.js';
import { NeuronsError } from '../guard.js';
import { HANDOFF_SELECT, handoffLine } from '../handoffs.js';
import { targetLabel } from '../identity.js';
import { markRead } from '../inbox.js';
import { ago, parseJson } from '../util.js';

export default async function handoffGet(a, me, { db }) {
  if (!a.id) {
    const rows = db.all(
      `${HANDOFF_SELECT} WHERE (? IS NULL OR h.repo = ?) AND (? IS NULL OR s.agent = ?) ORDER BY h.created_at DESC LIMIT ?`,
      a.repo ?? null, a.repo ?? null, a.agent ?? null, a.agent ?? null, a.limit || 10,
    );
    if (!rows.length) return 'No handoffs.';
    return list(rows.map((h) => handoffLine({ ...h, to_label: h.to_kind ? targetLabel(db, h.to_kind, h.to_target) : null })));
  }
  const h = db.get(`${HANDOFF_SELECT} WHERE h.id = ?`, a.id);
  if (!h) throw new NeuronsError(`No handoff #${a.id}.`);
  const d = parseJson(h.data, {});
  markRead(db, me, db.all("SELECT id FROM messages WHERE link_type = 'handoff' AND link_id = ?", h.id).map((m) => m.id));
  return [
    `# Handoff #${h.id}: ${h.title}`,
    `from ${h.author_handle} · ${ago(h.created_at)} · repo ${h.repo || '-'} · questions: send to=${h.author_handle}`,
    h.goal && section('Goal', h.goal),
    d.summary && section('Summary', d.summary),
    section('Done', list(d.done)),
    section('Decisions', list(d.decisions)),
    section('Next steps', list(d.next_steps)),
    section('Open questions', list(d.open_questions)),
    section('Gotchas', list(d.gotchas)),
    section('Files', list((d.files || []).map((f) => `${f.path}${f.note ? `: ${f.note}` : ''}`))),
    section('Commits', list(d.commits)),
  ]
    .filter(Boolean)
    .join('\n');
}
