import path from 'node:path';
import { connectionCheck } from './identity.js';
import { ago, now, repoRootOf } from './util.js';

// Absolute paths become relative to their git top-level so "src/a.js" and "/…/repo/src/a.js" collide
export function normalizeClaimPath(p, fallbackRepo) {
  const clean = p.trim().replace(/\/+$/, '');
  if (path.isAbsolute(clean)) {
    const top = repoRootOf(clean);
    if (top) return { repo: path.basename(top), path: path.relative(top, clean).split(path.sep).join('/') || '.' };
    return { repo: fallbackRepo, path: path.normalize(clean) };
  }
  // Relative claims are always stored with forward slashes, whatever the OS
  return { repo: fallbackRepo, path: path.posix.normalize(clean.replace(/\\/g, '/').replace(/^\.\//, '')) };
}

// Live claims per repo, looked up once each (and the live windows once in all) for a batch of paths
export function claimsByRepo(db) {
  const connected = connectionCheck(db);
  const byRepo = new Map();
  return (repo) => {
    if (!byRepo.has(repo)) byRepo.set(repo, liveClaims(db, repo, connected));
    return byRepo.get(repo);
  };
}

export const overlaps = (a, b) => a === b || a === '.' || b === '.' || a.startsWith(b + '/') || b.startsWith(a + '/');

// Unreleased, unexpired claims whose session is still connected
export function liveClaims(db, repo, connected = connectionCheck(db)) {
  return db
    .all(
      `SELECT c.*, s.handle, s.agent, s.server_pid, s.server_start, s.hook_pids, s.last_seen, s.ended_at FROM claims c
       JOIN sessions s ON s.id = c.session_id
       WHERE (? IS NULL OR c.repo = ?) AND c.released_at IS NULL AND c.expires_at > ?
       ORDER BY c.repo, c.path`,
      repo ?? null,
      repo ?? null,
      now(),
    )
    .filter(connected);
}

export const claimLine = (c) =>
  `${c.repo}/${c.path} · ${c.handle}${c.reason ? ` · ${c.reason}` : ''} · since ${ago(c.created_at)} · ${Math.max(1, Math.round((c.expires_at - now()) / 60000))}m left`;
