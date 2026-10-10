import { LIMITS } from '../../configuration/settings.js';
import { assertClean, assertLength } from '../guard.js';
import { overLine } from '../lines.js';
import { assertReachable, resolveTarget } from '../identity.js';
import { postMessage } from '../inbox.js';
import { now } from '../util.js';

export default async function handoffPublish(a, me, { db }) {
  const { title, goal, repo, to, ...rest } = a;
  assertClean({ title, goal, repo, ...rest });
  assertLength('repo', repo, LIMITS.repoName);
  const target = to ? overLine(db, me, resolveTarget(db, to)) : null;
  if (target) assertReachable(db, target);
  const data = {
    ...rest,
    author: { handle: me.handle, agent: me.agent, model: me.model, native_id: me.native_id, transcript_linked: !!me.transcript_path },
  };
  const id = db.tx(() => {
    const res = db.run(
      'INSERT INTO handoffs (author_session, repo, title, goal, data, to_kind, to_target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      me.id,
      repo || me.repo,
      title,
      goal,
      JSON.stringify(data),
      target?.kind,
      target?.target,
      now(),
    );
    const hid = Number(res.lastInsertRowid);
    if (target) {
      postMessage(db, {
        from: me.id,
        toKind: target.kind,
        toTarget: target.target,
        kind: 'handoff',
        subject: title,
        body: goal || a.summary || title,
        repo: repo || me.repo,
        linkType: 'handoff',
        linkId: hid,
      });
    }
    return hid;
  });
  return `Published handoff #${id}${target ? ` to ${target.label}` : ''}. Read it with \`handoff_get\` id=${id}.`;
}
