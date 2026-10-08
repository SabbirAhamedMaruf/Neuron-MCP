import { CALL } from '../../configuration/prompts.js';
import { callById } from '../calls.js';
import { NeuronsError, assertClean } from '../guard.js';
import { isRecipient, isRinging, markRead, postMessage } from '../inbox.js';
import { oneLine } from '../util.js';

export default async function reply(a, me, { db }) {
  const status = a.status || 'answered';
  assertClean({ body: a.body, refs: a.refs || [] });
  const msg = db.get('SELECT * FROM messages WHERE id = ?', a.message_id);
  if (!msg) throw new NeuronsError(`No message #${a.message_id}.`);
  if (!isRecipient(msg, me)) throw new NeuronsError(`#${a.message_id} was not addressed to you (${me.handle}).`);
  // A call is answered by picking up first, so the user chooses which session takes it
  if (isRinging(msg)) {
    const call = callById(db, msg.link_id);
    throw new NeuronsError(call?.status === 'ringing' ? CALL.answerFirst(call.id) : CALL.ended(call || { id: msg.link_id, status: 'missed' }));
  }
  if (status !== 'answered' && msg.kind !== 'proposal') throw new NeuronsError('accepted/rejected only apply to proposals.');
  const id = db.tx(() => {
    const replyId = postMessage(db, {
      from: me.id,
      toKind: 'session',
      toTarget: msg.from_session,
      kind: 'reply',
      subject: `Re: ${msg.subject || oneLine(msg.body, 60)}`,
      body: status === 'answered' ? a.body : `[${status.toUpperCase()}] ${a.body}`,
      repo: msg.repo,
      refs: a.refs,
      replyTo: msg.id,
      status: 'closed',
    });
    if (msg.status === 'open') db.run('UPDATE messages SET status = ? WHERE id = ?', status, msg.id);
    markRead(db, me, [msg.id]);
    return replyId;
  });
  const to = db.get('SELECT handle FROM sessions WHERE id = ?', msg.from_session);
  return `Replied #${id} to ${to?.handle || 'sender'} (re #${msg.id}, ${status}).`;
}
