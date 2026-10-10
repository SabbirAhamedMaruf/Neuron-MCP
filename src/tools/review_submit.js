import { joinBlocks } from '../format.js';
import { NeuronsError, assertClean } from '../guard.js';
import { isRecipient, postMessage } from '../inbox.js';
import { bySeverity, findingLine, getReview, requestMessage } from '../reviews.js';
import { now, oneLine } from '../util.js';

export default async function reviewSubmit(a, me, { db }) {
  assertClean({ summary: a.summary, findings: a.findings || [] });
  const r = getReview(db, a.id);
  if (!r) throw new NeuronsError(`No review #${a.id}.`);
  if (r.requester_session === me.id) throw new NeuronsError('You cannot review your own request.');
  const msg = requestMessage(db, a.id);
  const taken = (row = r) => new NeuronsError(`Review #${a.id} is ${row.status}${row.reviewer_handle ? ` by ${row.reviewer_handle}` : ''}.`);
  if (r.status === 'open') {
    if (!isRecipient({ from_session: r.requester_session, to_kind: r.to_kind, to_target: r.to_target }, me)) throw new NeuronsError(`Review #${a.id} is not addressed to you.`);
  } else if (r.reviewer_session !== me.id) {
    throw taken();
  }
  const findings = bySeverity(a.findings || []);
  db.tx(() => {
    // Still open, or this reviewer's: two reviewers submitting at once cannot both post a result
    const res = db.run(
      "UPDATE reviews SET status = 'done', reviewer_session = ?, verdict = ?, summary = ?, findings = ?, claimed_at = COALESCE(claimed_at, ?), completed_at = ? WHERE id = ? AND (status = 'open' OR reviewer_session = ?)",
      me.id,
      a.verdict,
      a.summary,
      JSON.stringify(findings),
      now(),
      now(),
      a.id,
      me.id,
    );
    if (!res.changes) throw taken(getReview(db, a.id));
    if (msg) db.run("UPDATE messages SET status = 'closed' WHERE id = ?", msg.id);
    postMessage(db, {
      from: me.id,
      toKind: 'session',
      toTarget: r.requester_session,
      kind: 'review-result',
      subject: `Review #${a.id} ${a.verdict}: ${oneLine(r.title, 80)}`,
      body: joinBlocks(a.summary, findings.length ? findings.map(findingLine).join('\n') : 'No findings.'),
      repo: r.repo,
      replyTo: msg?.id,
      linkType: 'review',
      linkId: a.id,
      status: 'closed',
    });
  });
  return `Submitted review #${a.id} (${a.verdict}, ${findings.length} finding(s)) to ${r.requester_handle}.`;
}
