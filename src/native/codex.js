import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOMES, REPO_MEMORY_FILES } from '../../configuration/settings.js';
import { redact, resolveAllowed } from '../guard.js';
import { detectRepo } from '../util.js';
import { cleanUserText, eachJsonLine, entry, exists, jsonLines, statOrNull, toolSummary, walkText } from './common.js';

const SESSIONS = path.join(HOMES.codex, 'sessions');
const ARCHIVED = path.join(HOMES.codex, 'archived_sessions');
const MEMORY_DB = path.join(HOMES.codex, 'memories_1.sqlite');

function firstLine(file, max = 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (pos < max) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, nl)));
        break;
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function rolloutFiles() {
  const out = [];
  for (const root of [SESSIONS, ARCHIVED]) {
    for (const file of walkText(root, { depth: 4, exts: ['.jsonl'] })) {
      if (!path.basename(file).startsWith('rollout-')) continue;
      const st = statOrNull(file);
      if (st && st.size > 0) out.push({ full: file, mtime: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function threadNames() {
  const names = new Map();
  const file = path.join(HOMES.codex, 'session_index.jsonl');
  if (!exists(file)) return names;
  for (const o of jsonLines(fs.readFileSync(file, 'utf8'))) if (o.id && o.thread_name) names.set(o.id, o.thread_name);
  return names;
}

// Guardian reviews and other helper threads are not conversations anyone continues
const isHelperThread = (meta) => !!(meta.source && typeof meta.source === 'object' && meta.source.subagent) || meta.thread_source === 'guardian_review';

const textOf = (content, type) =>
  (content || [])
    .filter((c) => c.type === type && c.text)
    .map((c) => c.text)
    .join('\n');

// The conversation entries one rollout line holds; injected context (environment, AGENTS.md) is not conversation
function extract(o, includeTools) {
  if (o.type !== 'response_item') return [];
  const p = o.payload || {};
  if (p.type === 'message' && p.role === 'user') {
    const text = cleanUserText(textOf(p.content, 'input_text'));
    return text && !text.startsWith('# AGENTS.md instructions') ? [entry('user', text, o.timestamp)] : [];
  }
  if (p.type === 'message' && p.role === 'assistant') {
    const text = textOf(p.content, 'output_text');
    return text.trim() ? [entry('assistant', text, o.timestamp)] : [];
  }
  if (includeTools && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
    let input = p.input ?? p.arguments;
    if (typeof input === 'string' && input.trim().startsWith('{')) {
      try {
        input = JSON.parse(input);
      } catch {}
    }
    return [entry('tool', toolSummary(p.name, input), o.timestamp)];
  }
  return [];
}

// Searchable text lives only in response_item message lines
const RESPONSE_ITEM = Buffer.from('"type":"response_item"');
const MESSAGE = Buffer.from('"type":"message"');
const searchable = (head) => head.includes(RESPONSE_ITEM) && head.includes(MESSAGE);

function rolloutMeta(file) {
  try {
    return JSON.parse(firstLine(file)).payload || {};
  } catch {
    return null;
  }
}

// Conversation threads only, newest first
function transcripts(cwd) {
  const out = [];
  for (const f of rolloutFiles()) {
    const meta = rolloutMeta(f.full);
    if (!meta || isHelperThread(meta) || (cwd && meta.cwd !== cwd)) continue;
    out.push({ ...f, nativeId: meta.id, cwd: meta.cwd || null });
  }
  return out;
}

export const codex = {
  agent: 'codex',
  homeRoots: [HOMES.codex],
  transcriptRoots: [SESSIONS, ARCHIVED],
  extract,
  searchable,

  // Codex's own memory: global AGENTS.md, its memories folder, and the AGENTS.md of the repo in question
  memoryFiles({ repoRoot } = {}) {
    const out = [];
    for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
      const file = path.join(HOMES.codex, name);
      if (exists(file)) out.push({ path: file, kind: 'instructions' });
    }
    for (const file of walkText(path.join(HOMES.codex, 'memories'), { depth: 3 })) out.push({ path: file, kind: 'memory' });
    for (const name of repoRoot ? REPO_MEMORY_FILES.codex : []) {
      const file = path.join(repoRoot, name);
      if (exists(file)) out.push({ path: file, kind: 'instructions', repo: path.basename(repoRoot) });
    }
    return out;
  },

  // Codex's own memory pipeline output; empty while the "memories" feature is off
  memoryRows() {
    if (!exists(MEMORY_DB)) return [];
    let db;
    try {
      db = new DatabaseSync(MEMORY_DB, { readOnly: true });
      return db
        .prepare('SELECT thread_id, rollout_slug, raw_memory, rollout_summary, generated_at FROM stage1_outputs ORDER BY generated_at DESC LIMIT 200')
        .all()
        .map((r) => ({
          ref: `memory:memdb:${r.thread_id}`,
          title: r.rollout_slug || `thread ${r.thread_id}`,
          text: redact([r.rollout_summary, r.raw_memory].filter(Boolean).join('\n\n')),
          mtime: Number(r.generated_at) * (Number(r.generated_at) < 1e12 ? 1000 : 1),
        }));
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {}
    }
  },

  transcripts,

  listSessions({ cwd, limit = 15 } = {}) {
    const names = threadNames();
    return transcripts(cwd)
      .slice(0, limit)
      .map((t) => ({
        agent: 'codex',
        nativeId: t.nativeId,
        path: t.full,
        cwd: t.cwd,
        repo: t.cwd ? detectRepo(t.cwd) : null,
        title: names.get(t.nativeId) || null,
        model: null,
        updatedAt: t.mtime,
      }));
  },

  sessionTitle(nativeId) {
    return threadNames().get(nativeId) || null;
  },

  findTranscript(nativeId) {
    if (!/^[0-9a-f-]{8,}$/i.test(nativeId)) return null;
    return rolloutFiles().find((f) => path.basename(f.full).endsWith(`-${nativeId}.jsonl`))?.full || null;
  },

  async readSession(file, { includeTools = true } = {}) {
    const real = resolveAllowed(file, this.transcriptRoots, { exts: ['.jsonl'] });
    if (!real) return null;
    const meta = { agent: 'codex', nativeId: null, path: real, cwd: null, title: null, model: null };
    const entries = [];
    await eachJsonLine(real, (o) => {
      const p = o.payload || {};
      if (o.type === 'session_meta') {
        meta.nativeId = p.id;
        meta.cwd = p.cwd;
      } else if (o.type === 'turn_context' && p.model) {
        meta.model = p.model;
      }
      entries.push(...extract(o, includeTools));
    });
    meta.title = meta.nativeId ? threadNames().get(meta.nativeId) || null : null;
    meta.repo = meta.cwd ? detectRepo(meta.cwd) : null;
    return { meta, entries };
  },
};
