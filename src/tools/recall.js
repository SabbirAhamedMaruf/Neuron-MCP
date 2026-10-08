import path from 'node:path';
import { OUTPUT, RECALL, RECALL_SOURCES } from '../../configuration/settings.js';
import { NeuronsError } from '../guard.js';
import { ftsQuery } from '../memory.js';
import { searchOwnMemory, searchOwnSessions } from '../native/index.js';
import { grepRepo } from '../repo.js';
import { fuse, semanticSearch } from '../semantic.js';
import { iso, oneLine, repoRootOf, splitTerms } from '../util.js';

// Errors from one source (an agent without native support, a broken transcript) must not sink the others
async function safely(fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: err instanceof NeuronsError ? err.message : `failed: ${err?.message || err}` };
  }
}

export default async function recall(a, me, { db }) {
  const sources = new Set(a.sources?.length ? a.sources : RECALL_SOURCES);
  const terms = splitTerms(a.query);
  if (!terms.length) throw new NeuronsError('Give `recall` a few words to search for.');
  const limit = a.limit || RECALL.hitsPerSource;
  const repoRoot = repoRootOf(a.repo_path ? path.resolve(me.cwd || process.cwd(), a.repo_path) : me.cwd);
  const lines = [];
  const empty = [];
  const add = (name, hits) => (hits.length ? lines.push(...hits) : empty.push(name));
  const noteLine = (h) => `${h.ref}\n  ${oneLine(h.title, 90)}: ${oneLine(h.snippet, OUTPUT.snippetChars)}`;

  // Meaning-based hits from the local embedding model, merged into the keyword hits of the same source; null when unavailable
  const semantic = sources.has('neurons') || sources.has('memory') ? await semanticSearch(db, me.agent, a.query, { repoRoot, limit: limit * 2 }) : null;
  const merged = (keyword, prefix) => (semantic ? fuse(keyword, semantic.filter((h) => h.ref.startsWith(prefix)), limit) : keyword.slice(0, limit));

  if (sources.has('neurons')) {
    const rows = db.all(
      `SELECT m.*, snippet(memories_fts, 1, '', '', '…', 16) AS snip FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.owner_agent = ? AND m.status = 'active'
       ORDER BY bm25(memories_fts, 5.0, 1.0, 2.0) LIMIT ?`,
      ftsQuery(terms),
      me.agent,
      limit,
    );
    add('notes', merged(rows.map((m) => ({ ref: `#${m.id}`, title: m.title, snippet: m.snip })), '#').map(noteLine));
  }

  if (sources.has('memory')) {
    const hits = await safely(() => searchOwnMemory(me.agent, a.query, { repoRoot, limit }));
    if (hits.error) lines.push(`memory: ${hits.error}`);
    else add('memory', merged(hits, 'memory:').map(noteLine));
  }

  if (sources.has('sessions')) {
    const res = await safely(() => searchOwnSessions(me.agent, a.query, { excludeNativeId: me.native_id, limit }));
    if (res.error) lines.push(`sessions: ${res.error}`);
    else add('chats', res.hits.map((h) => `${h.ref}\n  [${h.role}${h.ts ? ` ${iso(Date.parse(h.ts)).slice(0, 10)}` : ''}] ${oneLine(h.snippet, OUTPUT.snippetChars)}`));
  }

  if (sources.has('repo')) {
    if (!repoRoot) empty.push('repo (not in a git repo; pass repo_path)');
    else add('repo', (await grepRepo(repoRoot, terms)).slice(0, limit).map((h) => `repo:${h.file}:${h.line}\n  ${oneLine(h.text, OUTPUT.snippetChars)}`));
  }

  if (!lines.length) return `Nothing found for "${a.query}" in ${empty.join(', ')}.`;
  return [...lines, empty.length ? `(no hits in ${empty.join(', ')}; open a ref with recall_get)` : '(open a ref with recall_get)'].join('\n');
}
