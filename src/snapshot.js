import fs from 'node:fs';
import path from 'node:path';
import { AUTO_HANDOFF } from '../configuration/settings.js';
import { normalizeClaimPath } from './claims.js';
import { isSensitivePath, redact } from './guard.js';
import { git, now, repoRootOf } from './util.js';

/*
 * Model-free handoffs. The edit hook records which files a session edits
 * (session_files); the Stop hook turns that into one automatic handoff per
 * session: its edited files that are still uncommitted, and the commits since
 * it started that touch them. Only git facts are stored, never chat text.
 */
export function recordEdits(db, session, files) {
  const t = now();
  for (const file of files) {
    const { repo, path: rel } = normalizeClaimPath(file, null);
    if (repo) db.run('INSERT OR REPLACE INTO session_files (session_id, repo, path, edited_at) VALUES (?, ?, ?, ?)', session.id, repo, rel, t);
  }
}

const STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type changed' };

// Head, branch and uncommitted files from one `git status --porcelain=v2 --branch -z` call
function gitState(top) {
  const out = git(top, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], AUTO_HANDOFF.gitTimeoutMs);
  if (out === null) return null;
  const state = { head: null, branch: 'unknown', files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('# branch.oid ')) state.head = /^[0-9a-f]{40}$/.test(p.slice(13)) ? p.slice(13) : null;
    else if (p.startsWith('# branch.head ')) state.branch = p.slice(14).replace(/^\((.*)\)$/, '$1');
    else if (p.startsWith('? ')) state.files.push({ path: p.slice(2), status: 'new' });
    else if (/^[12u] /.test(p)) {
      // Ordinary, renamed and unmerged entries put the path after 8, 9 and 10 space-separated fields
      const fields = p.split(' ');
      const code = p[0] === '2' ? 'R' : p[0] === 'u' ? 'U' : fields[1].replace(/\./g, '')[0];
      state.files.push({ path: fields.slice({ 1: 8, 2: 9, u: 10 }[p[0]]).join(' '), status: STATUS[code] || 'changed' });
      // A rename's original path is the next NUL-separated field
      if (p[0] === '2') i++;
    }
  }
  return state;
}

export function snapshotSession(db, session, cwd) {
  const top = repoRootOf(cwd);
  if (!top) return null;
  const repo = path.basename(top);
  const existing = db.get('SELECT id FROM handoffs WHERE author_session = ? AND auto = 1', session.id);
  const touched = db.all('SELECT path FROM session_files WHERE session_id = ? AND repo = ?', session.id, repo).map((r) => r.path);
  // A session that edited nothing here costs no git call
  if (!touched.length) {
    if (existing) db.run('DELETE FROM handoffs WHERE id = ?', existing.id);
    return null;
  }
  const state = gitState(top);
  if (!state) return null;
  const { head, branch } = state;
  // An untracked folder is one `? dir/` entry in git status; the session's own new files inside it count one by one
  const inFolder = (f) => f.path.endsWith('/') && touched.some((t) => t.startsWith(f.path));
  const mine = state.files.flatMap((f) => (inFolder(f) ? touched.filter((t) => t.startsWith(f.path) && fs.existsSync(path.join(top, t))).map((t) => ({ path: t, status: 'new' })) : touched.includes(f.path) ? [f] : []));
  const commits =
    session.start_head && head && session.start_head !== head
      ? (git(top, ['log', '--format=%h %s', '-n', String(AUTO_HANDOFF.maxCommits), `${session.start_head}..HEAD`, '--', ...touched], AUTO_HANDOFF.gitTimeoutMs) || '')
          .split('\n')
          .filter(Boolean)
          .map((c) => redact(c))
      : [];

  if (!mine.length && !commits.length) {
    if (existing) db.run('DELETE FROM handoffs WHERE id = ?', existing.id);
    return null;
  }

  // Protected names (.env, credentials, ...) are counted, not listed
  const listed = mine.filter((f) => !isSensitivePath(path.join(top, f.path)));
  const hidden = mine.length - listed.length;
  const others = state.files.filter((f) => !inFolder(f) && !touched.includes(f.path)).length;
  const summary = [
    `Branch ${branch}${head ? ` at ${head.slice(0, 7)}` : ''}.`,
    hidden ? `${hidden} protected file(s) not listed.` : null,
    listed.length > AUTO_HANDOFF.maxFiles ? `${listed.length - AUTO_HANDOFF.maxFiles} more files not listed.` : null,
    others ? `${others} other uncommitted file(s) in the repo were not edited by this session.` : null,
    'Git facts only; ask the author what it was doing.',
  ]
    .filter(Boolean)
    .join(' ');
  const title = `auto: ${branch} · ${mine.length} uncommitted · ${commits.length} commit${commits.length === 1 ? '' : 's'}`;
  const data = JSON.stringify({
    auto: true,
    summary,
    files: listed.slice(0, AUTO_HANDOFF.maxFiles).map((f) => ({ path: f.path, note: f.status })),
    commits,
    author: { handle: session.handle, agent: session.agent, model: session.model, native_id: session.native_id },
  });
  const t = now();
  if (existing) {
    db.run('UPDATE handoffs SET repo = ?, title = ?, goal = ?, data = ?, created_at = ? WHERE id = ?', repo, title, session.task, data, t, existing.id);
    return existing.id;
  }
  const res = db.run('INSERT INTO handoffs (author_session, repo, title, goal, data, auto, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', session.id, repo, title, session.task, data, t);
  return Number(res.lastInsertRowid);
}
