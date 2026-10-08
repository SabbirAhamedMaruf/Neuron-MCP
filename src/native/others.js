import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOMES, REPO_MEMORY_FILES } from '../../configuration/settings.js';
import { detectRepo } from '../util.js';
import { entry, exists, toolSummary } from './common.js';

function repoFiles(agent, repoRoot) {
  const out = [];
  for (const name of repoRoot ? REPO_MEMORY_FILES[agent] : []) {
    const file = path.join(repoRoot, name);
    if (exists(file)) out.push({ path: file, kind: 'instructions', repo: path.basename(repoRoot) });
  }
  return out;
}

// Gemini CLI keeps durable memory in GEMINI.md (its save_memory tool appends there)
export const gemini = {
  agent: 'gemini',
  homeRoots: [HOMES.gemini],

  memoryFiles({ repoRoot } = {}) {
    const global = path.join(HOMES.gemini, 'GEMINI.md');
    return [...(exists(global) ? [{ path: global, kind: 'memory' }] : []), ...repoFiles('gemini', repoRoot)];
  },

  listSessions() {
    return [];
  },
};

const OPENCODE_DB = path.join(HOMES.opencodeData, 'opencode.db');

// Only the session/message/part tables are ever queried; the same file holds account tokens
function withOpencodeDb(fn) {
  if (!exists(OPENCODE_DB)) return null;
  let db;
  try {
    db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

// OpenCode runs any model provider (OpenRouter, Ollama, LM Studio, ...), so its sessions cover those too
export const opencode = {
  agent: 'opencode',
  homeRoots: [HOMES.opencodeConfig],

  memoryFiles({ repoRoot } = {}) {
    const file = path.join(HOMES.opencodeConfig, 'AGENTS.md');
    return [...(exists(file) ? [{ path: file, kind: 'instructions' }] : []), ...repoFiles('opencode', repoRoot)];
  },

  listSessions({ cwd, limit = 15 } = {}) {
    return (
      withOpencodeDb((db) =>
        db
          .prepare(
            `SELECT id, title, directory, model, time_updated FROM session
             WHERE parent_id IS NULL AND (? IS NULL OR directory = ?)
             ORDER BY time_updated DESC LIMIT ?`,
          )
          .all(cwd ?? null, cwd ?? null, limit)
          .map((r) => ({
            agent: 'opencode',
            nativeId: r.id,
            path: null,
            cwd: r.directory,
            repo: r.directory ? detectRepo(r.directory) : null,
            title: r.title,
            model: r.model,
            updatedAt: Number(r.time_updated),
          })),
      ) || []
    );
  },

  findTranscript(nativeId) {
    return /^[A-Za-z0-9_-]{6,}$/.test(nativeId) ? `opencode:${nativeId}` : null;
  },

  async readSession(ref, { includeTools = true } = {}) {
    const id = String(ref).replace(/^opencode:/, '');
    return withOpencodeDb((db) => {
      const s = db.prepare('SELECT id, title, directory, model FROM session WHERE id = ?').get(id);
      if (!s) return null;
      const roles = new Map();
      let model = s.model;
      for (const m of db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created').all(id)) {
        const d = parse(m.data);
        roles.set(m.id, d.role);
        if (d.modelID) model = d.providerID ? `${d.providerID}/${d.modelID}` : d.modelID;
      }
      const entries = [];
      for (const p of db.prepare('SELECT message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created').all(id)) {
        const d = parse(p.data);
        const ts = new Date(Number(p.time_created)).toISOString();
        if (d.type === 'text' && d.text?.trim()) entries.push(entry(roles.get(p.message_id) === 'user' ? 'user' : 'assistant', d.text, ts));
        else if (d.type === 'tool' && includeTools) entries.push(entry('tool', toolSummary(d.tool || 'tool', d.state?.input), ts));
      }
      return {
        meta: { agent: 'opencode', nativeId: id, path: null, cwd: s.directory, repo: s.directory ? detectRepo(s.directory) : null, title: s.title, model },
        entries,
      };
    });
  },
};
