import { CALL, deliveredAll, localAnswer, localFallback, localUnavailable, localUnknown, noReply } from '../../configuration/prompts.js';
import { LIMITS, LOCAL_LLM } from '../../configuration/settings.js';
import { joinBlocks, section } from '../format.js';
import { NeuronsError, assertClean, assertLength } from '../guard.js';
import { resolveTarget } from '../identity.js';
import { formatMessage, postMessage, waitForReplies } from '../inbox.js';
import { linesOf, pruneLines, requireLine } from '../lines.js';
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

// With wait_seconds, the replies that came in time are shown with the delivery note
async function withReplies(db, me, sent, ids, a, extra) {
  if (!a.wait_seconds) return sent;
  const replies = await waitForReplies(db, me, ids, a.wait_seconds, extra?.signal, { every: ids.length > 1 });
  const missing = ids.filter((id) => !replies.some((r) => r.reply_to === id));
  return joinBlocks(sent, replies.length ? section('Replies', replies.map((r) => formatMessage(db, r)).join('\n\n')) : null, missing.length ? noReply(a.wait_seconds, missing) : null);
}

export default async function send(a, me, { db, extra }) {
  assertLength('body', a.body, LIMITS.message);
  assertLength('repo', a.repo, LIMITS.repoName);
  assertClean({ subject: a.subject, body: a.body, repo: a.repo, refs: a.refs || [] });
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

  // Only lines the user connected carry messages: one line for an agent or a handle, every line for "all"
  if (target.kind !== 'agent' && target.kind !== 'session' && target.kind !== 'all') throw new NeuronsError('Send to "codex", "claude", a handle, "all" (every line) or "local".');
  pruneLines(db);
  const line = target.kind === 'all' ? null : requireLine(db, me, target);
  const peers = line ? [line.peer] : [...new Map(linesOf(db, me).map((l) => [l.peer.id, l.peer])).values()];
  if (!peers.length) throw new NeuronsError(CALL.notConnected('any chat'));

  let fallback = null;
  if (a.local_first && kind === 'question') {
    const r = await tryLocal(question);
    if (r.text) return `${localAnswer(LOCAL_LLM.model, r.text)}\n(${target.label} was not asked; send again without local_first if this is not enough)`;
    fallback = localFallback(LOCAL_LLM.model, r.why);
  }

  const message = { from: me.id, kind, subject: a.subject, body: a.body, repo: a.repo || me.repo, refs: a.refs };
  if (line) {
    const id = postMessage(db, { ...message, toKind: 'session', toTarget: line.peer.id });
    return withReplies(db, me, joinBlocks(CALL.overLine(id, line.peer.handle, line.id), fallback), [id], a, extra);
  }

  // Second opinion: one message per connected chat, grouped so the inbox shows the answers together
  const sent = db.tx(() => {
    const out = [];
    for (const peer of peers) {
      const id = postMessage(db, { ...message, toKind: 'session', toTarget: peer.id, linkType: 'group', linkId: out[0]?.id ?? null });
      if (!out.length) db.run('UPDATE messages SET link_id = ? WHERE id = ?', id, id);
      out.push({ id, handle: peer.handle });
    }
    return out;
  });
  return withReplies(db, me, joinBlocks(deliveredAll(sent), fallback), sent.map((s) => s.id), a, extra);
}
