import { CALL } from '../../configuration/prompts.js';
import { LIMITS } from '../../configuration/settings.js';
import { answerCall, callById, candidates, lineFor, placeCall, ringingFor, settleRinging, waitForPickUp } from '../calls.js';
import { joinBlocks } from '../format.js';
import { NeuronsError } from '../guard.js';
import { assertReachable, resolveTarget } from '../identity.js';
import { formatMessage, markRead } from '../inbox.js';

// Picks up a call ringing for this session and hands over the message it carries
function pickUp(db, me, id) {
  const c = callById(db, id);
  if (!c) throw new NeuronsError(`No call #${id}.`);
  if (c.status === 'connected' && c.answered_by === me.id) return CALL.already(c.from_handle, c.id);
  if (c.from_session === me.id) throw new NeuronsError(`Call #${id} is your own.`);
  // Someone else picked up, the call stopped ringing, or it rings for another agent
  const gone = (now) => (now.status === 'connected' ? CALL.taken(now) : now.status === 'ringing' ? `Call #${id} is not for you.` : CALL.ended(now));
  if (!ringingFor(db, me).some((r) => r.id === c.id)) throw new NeuronsError(gone(c));
  if (!answerCall(db, c.id, me, 'in chat')) throw new NeuronsError(gone(callById(db, id)));
  const msg = db.get('SELECT m.*, s.handle AS from_handle, s.agent AS from_agent FROM messages m JOIN sessions s ON s.id = m.from_session WHERE m.id = ?', c.message_id);
  if (msg) markRead(db, me, [msg.id]);
  return joinBlocks(CALL.connected(c.from_handle, c.id), msg && msg.kind !== 'call' ? formatMessage(db, msg) : null);
}

export default async function connect(a, me, { db, extra }) {
  settleRinging(db);
  if (a.call_id) return pickUp(db, me, a.call_id);
  if (!a.to) {
    const ringing = ringingFor(db, me);
    if (ringing.length === 1) return pickUp(db, me, ringing[0].id);
    throw new NeuronsError(ringing.length ? CALL.pickWhich(ringing) : CALL.nothingRinging);
  }

  // Dialling: an agent name rings each of its sessions, a handle rings just that one
  const target = resolveTarget(db, a.to);
  if (target.kind === 'any') throw new NeuronsError('connect calls an agent name ("codex") or a session handle.');
  if (target.kind === 'session' && target.target === me.id) throw new NeuronsError('That handle is you.');
  const line = lineFor(db, me, target);
  if (line) return CALL.already(line.peer.handle, line.id);
  assertReachable(db, target);
  let call = placeCall(db, me, target, { from: me.id, kind: 'call', body: CALL.body(me.handle), repo: me.repo });
  if (call.status === 'ringing' && a.wait_seconds) call = await waitForPickUp(db, call.id, a.wait_seconds, extra?.signal);
  if (call.status === 'connected') return CALL.pickedUp(call);
  if (call.status !== 'ringing') return CALL.ended(call);
  return CALL.ringing(call, target.label, candidates(db, call).map((s) => s.handle), LIMITS.ringSeconds);
}
