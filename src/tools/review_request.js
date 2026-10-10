import { LIMITS } from '../../configuration/settings.js';
import { NeuronsError, assertClean, assertLength } from '../guard.js';
import { overLine } from '../lines.js';
import { assertReachable, resolveTarget } from '../identity.js';
import { postMessage } from '../inbox.js';
import { now } from '../util.js';

export default async function reviewRequest(a, me, { db }) {
  if (!a.diff && !a.base && !a.files?.length) throw new NeuronsError('Give the reviewer something: diff, base/head, or files.');
  assertLength('diff', a.diff, LIMITS.diff);
  assertLength('repo', a.repo, LIMITS.repoName);
  assertClean({ title: a.title, focus: a.focus, diff: a.diff, base: a.base, head: a.head, repo: a.repo, files: a.files || [] });
  const target = overLine(db, me, resolveTarget(db, a.to || 'any'));
  if (target.kind === 'session' && target.target === me.id) throw new NeuronsError('You cannot review your own request.');
  assertReachable(db, target);
  const repo = a.repo || me.repo;
  const summary = `${a.diff ? `${a.diff.split('\n').length}-line diff` : `${a.base || ''}..${a.head || ''}`}${a.files?.length ? ` · ${a.files.length} file(s)` : ''}`;
  const { id, msgId } = db.tx(() => {
    const res = db.run(
      `INSERT INTO reviews (requester_session, to_kind, to_target, repo, title, focus, base, head, diff, files, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      me.id,
      target.kind,
      target.target,
      repo,
      a.title,
      a.focus,
      a.base,
      a.head,
      a.diff,
      a.files?.length ? JSON.stringify(a.files) : null,
      now(),
    );
    const rid = Number(res.lastInsertRowid);
    const mid = postMessage(db, {
      from: me.id,
      toKind: target.kind,
      toTarget: target.target,
      kind: 'review',
      subject: `Review: ${a.title}`,
      body: a.focus || summary,
      repo,
      linkType: 'review',
      linkId: rid,
    });
    return { id: rid, msgId: mid };
  });
  return `Review #${id} requested from ${target.label} (inbox message #${msgId}). Findings arrive in your inbox (inbox wait_seconds=120 to block).`;
}
