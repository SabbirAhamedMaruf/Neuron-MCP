import { CALL, delivered, deliveredAll, localAnswer, localFallback, localUnavailable, localUnknown, noReply, unreachable } from '../../configuration/prompts.js';
import { LIMITS, LOCAL_LLM } from '../../configuration/settings.js';
import { callById, candidates, expireCalls, isOpen, lineFor, placeCall } from '../calls.js';
import { joinBlocks, section } from '../format.js';
import { NeuronsError, assertClean, assertLength } from '../guard.js';
import { assertReachable, liveServers, resolveTarget } from '../identity.js';
import { connectedHandles, formatMessage, postMessage, waitForReplies } from '../inbox.js';
import { askLocal, hasModel, localBase, localModels } from '../local.js';

// The local model's answer, or why there is none: down | missing | unknown | error
async function tryLocal(question) {
  const models = await localModels();
  if (!models) return { why: 'down' };
  if (!hasModel(models, LOCAL_LLM.model)) return { why: 'missing' };
  try {
    const text = await askLocal(question);
    return text ? { text } : { why: 'unknown' };
  } catch {
    return { why: 'error' };
  }
}

// A ringing call stops the wait when nobody picks up; a pick-up during the wait is reported with the replies
async function withReplies(db, me, sent, ids, a, extra, call = null) {
  if (!a.wait_seconds) return sent;
  const stop = call
    ? () => {
        expireCalls(db);
        return !isOpen(db.get('SELECT status FROM calls WHERE id = ?', call.id));
      }
    : null;
  const replies = await waitForReplies(db, me, ids, a.wait_seconds, extra?.signal, { every: ids.length > 1, stop });
  const missing = ids.filter((id) => !replies.some((r) => r.reply_to === id));
  const latest = call && callById(db, call.id);
  let callNote = null;
  if (latest?.status === 'ringing') callNote = CALL.stillRinging(latest);
  else if (latest && latest.status !== 'connected') callNote = CALL.ended(latest);
  else if (latest && call.status === 'ringing') callNote = CALL.pickedUp(latest);
  const waiting = missing.length && (!latest || latest.status === 'connected') ? noReply(a.wait_seconds, missing) : null;
  return joinBlocks(sent, callNote, replies.length ? section('Replies', replies.map((r) => formatMessage(db, r)).join('\n\n')) : null, waiting);
}

// The line to this agent when there is exactly one; otherwise the agent as a whole
function lineOrNull(db, me, agent) {
  try {
    return lineFor(db, me, { kind: 'agent', target: agent });
  } catch {
    return null;
  }
}

export default async function send(a, me, { db, extra }) {
  assertLength('body', a.body, LIMITS.message);
  assertClean({ subject: a.subject, body: a.body, refs: a.refs || [] });
  const target = resolveTarget(db, a.to, { messages: true });
  if (target.kind === 'session' && target.target === me.id) throw new NeuronsError('That handle is you.');
  const kind = a.kind || 'question';
  const question = a.subject ? `${a.subject}\n\n${a.body}` : a.body;

  // The local model answers in this call; nothing is stored, and nothing leaves the machine
  if (target.kind === 'local') {
    if (kind !== 'question') throw new NeuronsError('The local model only answers questions.');
    const r = await tryLocal(question);
    if (r.text) return localAnswer(LOCAL_LLM.model, r.text);
    if (r.why === 'unknown') return localUnknown(LOCAL_LLM.model);
    throw new NeuronsError(localUnavailable(localBase(), LOCAL_LLM.model, r.why));
  }

  let fallback = null;
  if (a.local_first && kind === 'question') {
    const r = await tryLocal(question);
    if (r.text) return `${localAnswer(LOCAL_LLM.model, r.text)}\n(${target.label} was not asked; send again without local_first if this is not enough)`;
    fallback = localFallback(LOCAL_LLM.model, r.why);
  }

  const message = { from: me.id, kind, subject: a.subject, body: a.body, repo: a.repo || me.repo, refs: a.refs };

  // Second opinion: one message per other connected agent, grouped so the inbox shows the answers together
  if (target.kind === 'all') {
    const agents = [...new Set(liveServers(db).filter((s) => s.pid !== process.pid && s.agent !== me.agent).map((s) => s.agent))];
    if (!agents.length) throw new NeuronsError(unreachable(target));
    const lines = new Map(agents.map((agent) => [agent, lineOrNull(db, me, agent)]));
    const sent = db.tx(() => {
      const out = [];
      for (const agent of agents) {
        const peer = lines.get(agent)?.peer;
        const to = peer ? { toKind: 'session', toTarget: peer.id } : { toKind: 'agent', toTarget: agent };
        const id = postMessage(db, { ...message, ...to, linkType: 'group', linkId: out[0]?.id ?? null });
        if (!out.length) db.run('UPDATE messages SET link_id = ? WHERE id = ?', id, id);
        out.push({ id, agent });
      }
      return out;
    });
    return withReplies(db, me, joinBlocks(deliveredAll(sent), fallback), sent.map((s) => s.id), a, extra);
  }

  // An open line carries the message straight to the session on the other end
  const line = lineFor(db, me, target);
  if (line) {
    const id = postMessage(db, { ...message, toKind: 'session', toTarget: line.peer.id });
    return withReplies(db, me, joinBlocks(CALL.overLine(id, line.peer.handle, line.id), fallback), [id], a, extra);
  }

  // Nothing is stored for an agent that is not running; the sender hears so right away
  const servers = assertReachable(db, target);
  if (target.kind === 'any') {
    const id = postMessage(db, { ...message, toKind: 'any', toTarget: null });
    return withReplies(db, me, joinBlocks(delivered(id, target.label, connectedHandles(db, servers, me)), fallback), [id], a, extra);
  }

  // No line yet: the message rings every session it could reach until one picks up
  const call = placeCall(db, me, target, message);
  const head = call.status === 'connected' ? CALL.delivered(call) : CALL.ringing(call, target.label, candidates(db, call).map((s) => s.handle), LIMITS.ringSeconds);
  return withReplies(db, me, joinBlocks(head, fallback), [call.message_id], a, extra, call);
}
