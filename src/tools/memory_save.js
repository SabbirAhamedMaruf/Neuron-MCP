import { LIMITS, MIN_EVIDENCE_CHARS } from '../../configuration/settings.js';
import { list } from '../format.js';
import { NeuronsError, assertClean, assertLength } from '../guard.js';
import { getMemory, memoryLine, similarMemories } from '../memory.js';
import { now } from '../util.js';

function ownedOrThrow(db, me, id) {
  const row = getMemory(db, id);
  if (!row) throw new NeuronsError(`No memory #${id}.`);
  if (row.owner_agent !== me.agent) {
    throw new NeuronsError(`#${id} belongs to ${row.owner_agent}; only it changes its memory. Send it kind=proposal instead.`);
  }
  return row;
}

export default async function memorySave(a, me, { db }) {
  if (a.archive) {
    if (!a.id) throw new NeuronsError('archive needs the id of your note.');
    ownedOrThrow(db, me, a.id);
    assertClean({ evidence: a.evidence });
    db.run("UPDATE memories SET status = 'archived', evidence = COALESCE(?, evidence), updated_at = ?, author_session = ? WHERE id = ?", a.evidence, now(), me.id, a.id);
    return `Archived #${a.id}.`;
  }
  if (!a.title || !a.body) throw new NeuronsError('title and body are required.');
  const source = a.source || 'self';
  const type = a.type || 'project';
  assertLength('body', a.body, LIMITS.body);
  assertClean({ title: a.title, body: a.body, tags: a.tags || [], evidence: a.evidence });
  if (source !== 'self' && (!a.evidence || a.evidence.trim().length < MIN_EVIDENCE_CHARS)) {
    throw new NeuronsError('Validate first: source=peer needs `evidence` of what you checked (file read, command run, test done).');
  }
  const repo = a.repo || me.repo || null;
  const scope = a.scope || (repo ? 'repo' : 'global');
  if (scope === 'repo' && !repo) throw new NeuronsError('scope=repo needs a repo.');
  const tags = (a.tags || []).join(' ');
  const t = now();

  if (a.id) {
    ownedOrThrow(db, me, a.id);
    db.run(
      `UPDATE memories SET title = ?, body = ?, type = ?, scope = ?, repo = ?, tags = ?, source = ?, evidence = ?,
         author_session = ?, status = 'active', updated_at = ? WHERE id = ?`,
      a.title, a.body, type, scope, scope === 'repo' ? repo : null, tags, source, a.evidence, me.id, t, a.id,
    );
    return `Updated ${memoryLine(getMemory(db, a.id))}`;
  }
  if (!a.confirm_new) {
    const similar = similarMemories(db, me.agent, a.title);
    if (similar.length) return `Not saved, similar note exists:\n${list(similar.map(memoryLine))}\nUpdate it with id, or pass confirm_new.`;
  }
  const res = db.run(
    `INSERT INTO memories (owner_agent, author_session, scope, repo, type, title, body, tags, source, evidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    me.agent, me.id, scope, scope === 'repo' ? repo : null, type, a.title, a.body, tags, source, a.evidence, t, t,
  );
  return `Saved ${memoryLine(getMemory(db, Number(res.lastInsertRowid)))}`;
}
