import fs from 'node:fs';
import { RECALL } from '../../configuration/settings.js';
import { NeuronsError, readAllowedText, redact, resolveAllowed } from '../guard.js';
import { oneLine, splitTerms } from '../util.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { describeNote, searchTranscript, snippetAround, transcriptWindow } from './common.js';
import { gemini, opencode } from './others.js';

/*
 * Native adapters read an agent's own memory and transcripts, and only ever
 * on that agent's behalf: every function here takes the CALLER's agent.
 * There is no path from one agent to another agent's files; to learn what
 * another agent knows, ask it.
 */
const ADAPTERS = { claude, codex, gemini, opencode };

function adapterFor(agent) {
  const a = ADAPTERS[agent];
  if (!a) throw new NeuronsError(`Neurons cannot search "${agent}"'s own memory or chats yet (supported: ${Object.keys(ADAPTERS).join(', ')}).`);
  return a;
}

// An agent's notes are readable only under its own home and the repo it is working in
const rootsFor = (adapter, repoRoot) => [...adapter.homeRoots, ...(repoRoot ? [repoRoot] : [])];

const realOrNull = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

const cache = new Map();

function loadNote(adapter, item, repoRoot) {
  const fresh = readAllowedText(item.path, rootsFor(adapter, repoRoot));
  if (!fresh) return null;
  const hit = cache.get(fresh.path);
  if (hit && hit.mtime === fresh.mtime) return { ...hit, ...item, path: fresh.path };
  const text = redact(fresh.text);
  const note = {
    ...item,
    path: fresh.path,
    mtime: fresh.mtime,
    text,
    body: text.replace(/^---\n[\s\S]*?\n---\n?/, ''),
    title: describeNote(fresh.path, fresh.text),
  };
  cache.set(fresh.path, note);
  return note;
}

export function ownNotes(agent, repoRoot) {
  const adapter = adapterFor(agent);
  const out = [];
  for (const item of adapter.memoryFiles({ repoRoot })) {
    const note = loadNote(adapter, item, repoRoot);
    if (note) out.push({ ...note, ref: `memory:${note.path}` });
  }
  for (const row of adapter.memoryRows?.() || []) out.push({ kind: 'memory', body: row.text, ...row });
  return out;
}

function score(text, terms) {
  const lower = text.toLowerCase();
  let matched = 0;
  let hits = 0;
  let first = -1;
  for (const term of terms) {
    let idx = lower.indexOf(term);
    if (idx === -1) continue;
    matched++;
    if (first === -1 || idx < first) first = idx;
    for (let n = 0; idx !== -1 && n < 20; n++) {
      hits++;
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  return { matched, hits, first };
}

export function searchOwnMemory(agent, query, { repoRoot, limit = 8 } = {}) {
  const terms = splitTerms(query);
  if (!terms.length) return [];
  const results = [];
  for (const note of ownNotes(agent, repoRoot)) {
    const body = note.body ?? note.text;
    const s = score(`${note.title}\n${body}`, terms);
    if (!s.matched) continue;
    const at = score(body, terms).first;
    results.push({
      ref: note.ref,
      kind: note.kind,
      title: note.title,
      mtime: note.mtime,
      snippet: snippetAround(body, Math.max(0, at)),
      rank: s.matched * 10 + score(note.title, terms).matched * 5 + Math.min(s.hits, 30) / 10,
    });
  }
  return results.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

export function getOwnNote(agent, ref, { repoRoot } = {}) {
  const rest = String(ref).replace(/^memory:/, '');
  if (rest.startsWith('memdb:')) {
    const row = (adapterFor(agent).memoryRows?.() || []).find((r) => r.ref === ref);
    if (!row) throw new NeuronsError(`Not found in your memory: ${ref}`);
    return { title: row.title, kind: 'memory', mtime: row.mtime, text: row.text };
  }
  const adapter = adapterFor(agent);
  const item = adapter.memoryFiles({ repoRoot }).find((f) => f.path === rest || realOrNull(f.path) === rest);
  const note = item && loadNote(adapter, item, repoRoot);
  if (!note) throw new NeuronsError(`Not one of your memory files: ${rest}`);
  return note;
}

// Keyword hits across the agent's own past chats, newest sessions first, within a time budget
export async function searchOwnSessions(agent, query, { excludeNativeId, limit = 8 } = {}) {
  const adapter = adapterFor(agent);
  const terms = splitTerms(query);
  const out = { hits: [], scanned: 0, partial: false };
  if (!terms.length || (!adapter.transcripts && !adapter.readSession)) return out;
  const deadline = Date.now() + RECALL.sessionBudgetMs;
  const hits = [];
  if (adapter.transcripts) {
    for (const t of adapter.transcripts().slice(0, RECALL.maxSessions)) {
      if (t.nativeId === excludeNativeId) continue;
      if (Date.now() > deadline) {
        out.partial = true;
        break;
      }
      const real = resolveAllowed(t.full, adapter.transcriptRoots, { exts: ['.jsonl'] });
      if (!real) continue;
      for (const h of await searchTranscript(real, terms, adapter, { deadline })) {
        hits.push({ ...h, nativeId: t.nativeId, mtime: t.mtime, ref: `session:${t.nativeId}@${h.line}` });
      }
      out.scanned++;
    }
  } else {
    for (const s of adapter.listSessions({ limit: RECALL.maxSessions })) {
      if (s.nativeId === excludeNativeId) continue;
      const r = await adapter.readSession(adapter.findTranscript(s.nativeId), { includeTools: false });
      out.scanned++;
      (r?.entries || []).forEach((e, i) => {
        const text = e.text.toLowerCase();
        const matched = terms.filter((t) => text.includes(t));
        if (!matched.length) return;
        hits.push({
          line: i,
          role: e.role,
          ts: e.ts,
          matched: matched.length,
          snippet: snippetAround(e.text, Math.min(...matched.map((t) => text.indexOf(t)))),
          nativeId: s.nativeId,
          mtime: s.updatedAt,
          title: s.title,
          ref: `session:${s.nativeId}@${i}`,
        });
      });
    }
  }
  out.hits = hits.sort((a, b) => b.matched - a.matched || b.mtime - a.mtime).slice(0, limit);
  for (const h of out.hits) if (!h.title) h.title = adapter.sessionTitle?.(h.nativeId) || null;
  return out;
}

// The conversation around one hit, for recall_get
export async function ownSessionWindow(agent, nativeId, line) {
  const adapter = adapterFor(agent);
  if (adapter.transcripts) {
    const file = adapter.findTranscript(nativeId);
    const real = file && resolveAllowed(file, adapter.transcriptRoots, { exts: ['.jsonl'] });
    if (!real) throw new NeuronsError(`Not one of your sessions: ${nativeId}`);
    return transcriptWindow(real, line, RECALL.windowLines, adapter.extract);
  }
  const r = adapter.readSession && (await adapter.readSession(adapter.findTranscript(nativeId), { includeTools: true }));
  if (!r) throw new NeuronsError(`Not one of your sessions: ${nativeId}`);
  const radius = Math.ceil(RECALL.windowLines / 4);
  return r.entries.slice(Math.max(0, line - radius), line + radius + 1).map((e, i) => ({ ...e, line: Math.max(0, line - radius) + i, hit: Math.max(0, line - radius) + i === line }));
}

export function listOwnSessions(agent, { cwd, repo, limit = 10 } = {}) {
  const adapter = adapterFor(agent);
  let rows = adapter.listSessions?.({ cwd, limit: repo ? limit * 4 : limit }) || [];
  // Sessions started outside any repo stay in a repo-filtered list
  if (repo) rows = rows.filter((r) => !r.repo || r.repo === repo);
  return rows.slice(0, limit).map((r) => ({ ...r, title: r.title ? oneLine(r.title, 80) : null }));
}

export async function readOwnSession(agent, { nativeId, transcriptPath, includeTools = true }) {
  const adapter = adapterFor(agent);
  if (!adapter.readSession) throw new NeuronsError(`Reading ${agent} transcripts is not supported yet.`);
  const target = transcriptPath || (nativeId && adapter.findTranscript(nativeId));
  if (!target) throw new NeuronsError(`No ${agent} transcript found for ${nativeId || 'that session'}.`);
  const result = await adapter.readSession(target, { includeTools });
  if (!result) throw new NeuronsError(`Transcript is outside ${agent}'s session folders or unreadable.`);
  return result;
}
