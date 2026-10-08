import { LIMITS } from '../../configuration/settings.js';
import { list, section } from '../format.js';
import { NeuronsError } from '../guard.js';
import { targetLabel } from '../identity.js';
import { isRecipient, markRead } from '../inbox.js';
import { REVIEW_SELECT, findingLine, getReview, requestMessage, reviewLine } from '../reviews.js';
import { clip, now, parseJson } from '../util.js';

function listReviews(a, me, db) {
  const status = a.status || 'open';
  const rows = db.all(
    `${REVIEW_SELECT} WHERE (? = 'all' OR r.status = ?) AND (? = 0 OR r.requester_session = ?) AND (? IS NULL OR r.repo = ?)
     ORDER BY r.created_at DESC LIMIT 15`,
    status, status, a.mine ? 1 : 0, me.id, a.repo ?? null, a.repo ?? null,
  );
  return rows.length ? list(rows.map((r) => reviewLine(db, r))) : 'No reviews.';
}

export default async function reviewGet(a, me, { db }) {
  if (!a.id) return listReviews(a, me, db);
  const id = a.id;
  let r = getReview(db, id);
  if (!r) throw new NeuronsError(`No review #${id}.`);
  const msg = requestMessage(db, id);
  let note = '';
  if (a.claim !== false && r.status === 'open' && r.requester_session !== me.id) {
    if (msg && !isRecipient(msg, me)) throw new NeuronsError(`Review #${id} is addressed to ${targetLabel(db, r.to_kind, r.to_target)}, not you.`);
    db.tx(() => {
      db.run("UPDATE reviews SET status = 'claimed', reviewer_session = ?, claimed_at = ? WHERE id = ? AND status = 'open'", me.id, now(), id);
      if (msg) db.run("UPDATE messages SET status = 'closed' WHERE id = ?", msg.id);
    });
    r = getReview(db, id);
    note = r.reviewer_session === me.id ? 'Claimed by you; finish with review_submit.' : `Already claimed by ${r.reviewer_handle}.`;
  }
  if (msg) markRead(db, me, [msg.id]);
  const findings = parseJson(r.findings, []);
  const files = parseJson(r.files, []);
  return [
    reviewLine(db, r),
    note,
    r.base || r.head ? `range: ${r.base || '?'}..${r.head || 'working tree'}` : '',
    r.focus && section('Focus', r.focus),
    files.length ? section('Files', list(files)) : '',
    r.diff && section('Diff', '```diff\n' + clip(r.diff, LIMITS.outputChars) + '\n```'),
    r.summary && section('Result', r.summary),
    findings.length ? section('Findings', findings.map(findingLine).join('\n')) : '',
  ]
    .filter(Boolean)
    .join('\n');
}
