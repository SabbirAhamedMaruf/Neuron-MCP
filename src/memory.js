import { DUPLICATE_TITLE_SIMILARITY } from '../configuration/settings.js';
import { ago, splitTerms } from './util.js';

// Prefix match on every term, any term may hit
export const ftsQuery = (terms) => terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (new Set([...A, ...B]).size || 1);
}

export const memoryLine = (m) =>
  `#${m.id} [${m.owner_agent} · ${m.type} · ${m.scope === 'repo' ? `repo ${m.repo}` : 'global'} · ${m.source}] ${m.title} (updated ${ago(m.updated_at)})`;

export const getMemory = (db, id) => db.get('SELECT * FROM memories WHERE id = ?', id);

// The agent's own active entries whose titles say nearly the same thing
export function similarMemories(db, agent, title) {
  const terms = splitTerms(title);
  if (!terms.length) return [];
  return db
    .all(
      `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.owner_agent = ? AND m.status = 'active'
       ORDER BY bm25(memories_fts, 5.0, 1.0, 2.0) LIMIT 5`,
      ftsQuery(terms),
      agent,
    )
    .filter((m) => jaccard(terms, splitTerms(m.title)) >= DUPLICATE_TITLE_SIMILARITY);
}
