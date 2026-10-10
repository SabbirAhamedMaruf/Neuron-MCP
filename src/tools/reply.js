import { NeuronsError, assertClean } from '../guard.js';
import { isRecipient, markRead, postMessage } from '../inbox.js';
import { oneLine } from '../util.js';

export default async function reply(a, me, { db }) {
  const status = a.status || 'answered';
  assertClean({ body: a.body, refs: a.refs || [] });
  const msg = db.get('SELECT * FROM messages WHERE id = ?', a.message_id);
  if (!msg) throw new NeuronsError(`No message #${a.message_id}.`);
  if (!isRecipient(msg, me)) throw new NeuronsError(`#${a.message_id} was not addressed to you (${me.handle}).`);
  // A message of the older ringing calls that nobody picked up was never delivered
  if (msg.link_type === 'call' && ['missed', 'declined', 'cancelled'].includes(msg.status)) throw new NeuronsError(`#${msg.id} was never delivered; nothing to answer.`);
  if (status !== 'answered' && msg.kind !== 'proposal' && msg.kind !== 'question') throw new NeuronsError('accepted/rejected only apply to proposals and questions (a permission request: accepted allows it, rejected denies it).');
  // A proposal is accepted or rejected; a question asking for permission is allowed or denied
  const label = msg.kind === 'question' ? { accepted: 'ALLOWED', rejected: 'DENIED' }[status] : status.toUpperCase();
  const id = db.tx(() => {
    const replyId = postMessage(db, {
      from: me.id,
      toKind: 'session',
      toTarget: msg.from_session,
      kind: 'reply',
      subject: `Re: ${msg.subject || oneLine(msg.body, 60)}`,
      body: status === 'answered' ? a.body : `[${label}] ${a.body}`,
      repo: msg.repo,
      refs: a.refs,
      replyTo: msg.id,
      status: 'closed',
    });
    // Only the first answer sets the status; a concurrent accept and reject cannot overwrite each other
    db.run("UPDATE messages SET status = ? WHERE id = ? AND status = 'open'", status, msg.id);
    markRead(db, me, [msg.id]);
    return replyId;
  });
  const to = db.get('SELECT handle FROM sessions WHERE id = ?', msg.from_session);
  return `Replied #${id} to ${to?.handle || 'sender'} (re #${msg.id}, ${status}).`;
}
