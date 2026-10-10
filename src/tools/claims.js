import { claimLine, claimsByRepo, liveClaims, normalizeClaimPath, overlaps } from '../claims.js';
import { list } from '../format.js';
import { NeuronsError, assertClean } from '../guard.js';
import { now } from '../util.js';

function claim(a, me, db) {
  if (!a.paths?.length) throw new NeuronsError('claim needs paths.');
  assertClean({ reason: a.reason, paths: a.paths });
  const wanted = a.paths.map((p) => normalizeClaimPath(p, a.repo || me.repo));
  if (wanted.some((w) => !w.repo)) throw new NeuronsError('Pass `repo` or absolute paths inside a git repo.');
  const held = claimsByRepo(db);
  const others = [...new Map(wanted.flatMap((w) => held(w.repo).filter((c) => c.session_id !== me.id && overlaps(c.path, w.path))).map((c) => [c.id, c])).values()];
  if (others.length && !a.force) return `Not claimed, held by another session:\n${list(others.map(claimLine))}\nAsk it first, or force.`;
  const t = now();
  const ttl = a.ttl_minutes || 120;
  const expires = t + ttl * 60 * 1000;
  db.tx(() => {
    for (const w of wanted) {
      const mine = db.get('SELECT id FROM claims WHERE session_id = ? AND repo = ? AND path = ? AND released_at IS NULL', me.id, w.repo, w.path);
      if (mine) db.run('UPDATE claims SET expires_at = ?, reason = COALESCE(?, reason) WHERE id = ?', expires, a.reason, mine.id);
      else db.run('INSERT INTO claims (session_id, repo, path, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', me.id, w.repo, w.path, a.reason, t, expires);
    }
  });
  return `Claimed ${ttl} min: ${wanted.map((w) => `${w.repo}/${w.path}`).join(', ')}${others.length ? ` (forced over ${others.map((c) => c.handle).join(', ')})` : ''}`;
}

function release(a, me, db) {
  const t = now();
  if (!a.paths?.length) return `Released ${db.run('UPDATE claims SET released_at = ? WHERE session_id = ? AND released_at IS NULL', t, me.id).changes} claim(s).`;
  let n = 0;
  for (const p of a.paths) {
    const w = normalizeClaimPath(p, a.repo || me.repo);
    n += db.run('UPDATE claims SET released_at = ? WHERE session_id = ? AND repo = ? AND path = ? AND released_at IS NULL', t, me.id, w.repo, w.path).changes;
  }
  return `Released ${n} claim(s).`;
}

export default async function claims(a, me, { db }) {
  if (a.action === 'claim') return claim(a, me, db);
  if (a.action === 'release') return release(a, me, db);
  const rows = liveClaims(db, a.repo);
  return rows.length ? list(rows.map((c) => `${claimLine(c)}${c.session_id === me.id ? ' (you)' : ''}`)) : 'No live claims.';
}
