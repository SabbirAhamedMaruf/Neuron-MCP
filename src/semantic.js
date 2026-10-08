import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { SEMANTIC } from '../configuration/settings.js';
import { embed, hasModel, localModels } from './local.js';
import { ownNotes } from './native/index.js';

/*
 * Meaning-based search over an agent's OWN memory files and Neurons notes,
 * using an embedding model on the local model server. Vectors are cached in
 * the embeddings table and re-embedded only when a note's text changes. When
 * the server or the model is missing, recall quietly stays keyword-only.
 */
const hashOf = (text) => createHash('sha1').update(`${SEMANTIC.model}\0${SEMANTIC.docPrefix}\0${text}`).digest('hex');

function unit(v) {
  const f = Float32Array.from(v);
  let n = 0;
  for (const x of f) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}

const toBlob = (v) => {
  const f = unit(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
};
const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

function dot(a, b) {
  let s = 0;
  for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) s += a[i] * b[i];
  return s;
}

function ownDocs(db, agent, repoRoot) {
  const docs = [];
  let notes = [];
  // An agent without a native adapter still has its Neurons notes
  try {
    notes = ownNotes(agent, repoRoot);
  } catch {}
  for (const n of notes) docs.push({ ref: n.ref, title: n.title, body: n.body ?? n.text });
  for (const m of db.all("SELECT id, title, body, tags FROM memories WHERE owner_agent = ? AND status = 'active'", agent)) {
    docs.push({ ref: `#${m.id}`, title: m.title, body: m.tags ? `${m.body}\n${m.tags}` : m.body });
  }
  return docs.map((d) => {
    const text = `${d.title}\n${d.body || ''}`.slice(0, SEMANTIC.docChars);
    return { ...d, text, hash: hashOf(text) };
  });
}

// Rows for notes that were deleted or archived
function prune(db, agent) {
  for (const { ref } of db.all('SELECT ref FROM embeddings WHERE agent = ? AND model = ?', agent, SEMANTIC.model)) {
    const id = ref.match(/^#(\d+)$/)?.[1];
    const file = ref.startsWith('memory:') && !ref.startsWith('memory:memdb:') ? ref.slice(7) : null;
    const gone = id
      ? !db.get("SELECT 1 FROM memories WHERE id = ? AND status = 'active'", Number(id))
      : file
        ? !fs.existsSync(file)
        : false;
    if (gone) db.run('DELETE FROM embeddings WHERE agent = ? AND model = ? AND ref = ?', agent, SEMANTIC.model, ref);
  }
}

async function syncIndex(db, agent, docs) {
  const have = new Map(db.all('SELECT ref, hash FROM embeddings WHERE agent = ? AND model = ?', agent, SEMANTIC.model).map((r) => [r.ref, r.hash]));
  const todo = docs.filter((d) => have.get(d.ref) !== d.hash);
  const deadline = Date.now() + SEMANTIC.indexBudgetMs;
  for (let i = 0; i < todo.length && Date.now() < deadline; i += SEMANTIC.batch) {
    const chunk = todo.slice(i, i + SEMANTIC.batch);
    const vecs = await embed(SEMANTIC.model, chunk.map((d) => SEMANTIC.docPrefix + d.text), SEMANTIC.timeoutMs);
    const t = Date.now();
    db.tx(() => {
      chunk.forEach((d, j) => {
        db.run(
          'INSERT OR REPLACE INTO embeddings (agent, ref, model, hash, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          agent,
          d.ref,
          SEMANTIC.model,
          d.hash,
          toBlob(vecs[j]),
          t,
        );
      });
    });
  }
  if (todo.length) prune(db, agent);
}

let failedAt = 0;

// Closest notes by meaning, as { ref, title, snippet, score }; null when semantic search is unavailable
export async function semanticSearch(db, agent, query, { repoRoot, limit = 6 } = {}) {
  if (!SEMANTIC.enabled || Date.now() - failedAt < 60 * 1000) return null;
  try {
    if (!hasModel(await localModels(), SEMANTIC.model)) return null;
    const docs = ownDocs(db, agent, repoRoot);
    if (!docs.length) return [];
    await syncIndex(db, agent, docs);
    const [q] = await embed(SEMANTIC.model, [SEMANTIC.queryPrefix + query], SEMANTIC.timeoutMs);
    const qv = unit(q);
    const byRef = new Map(docs.map((d) => [d.ref, d]));
    const hits = [];
    for (const row of db.all('SELECT ref, hash, vec FROM embeddings WHERE agent = ? AND model = ?', agent, SEMANTIC.model)) {
      const d = byRef.get(row.ref);
      if (!d || d.hash !== row.hash) continue;
      const score = dot(qv, fromBlob(row.vec));
      if (score >= SEMANTIC.minScore) hits.push({ ref: d.ref, title: d.title, snippet: d.body || '', score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  } catch {
    // A half-started server or a missing model should not slow every recall down
    failedAt = Date.now();
    return null;
  }
}

// Reciprocal-rank fusion of keyword and semantic hits for one source; keyword hits keep their matched snippet
export function fuse(keyword, semantic, limit) {
  const score = new Map();
  const item = new Map();
  keyword.forEach((h, i) => {
    score.set(h.ref, (score.get(h.ref) || 0) + 1 / (60 + i));
    item.set(h.ref, h);
  });
  semantic.forEach((h, i) => {
    score.set(h.ref, (score.get(h.ref) || 0) + 1 / (60 + i));
    if (!item.has(h.ref)) item.set(h.ref, h);
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ref]) => item.get(ref));
}
