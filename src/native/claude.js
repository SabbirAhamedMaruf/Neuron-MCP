import path from 'node:path';
import { HOMES, REPO_MEMORY_FILES } from '../../configuration/settings.js';
import { resolveAllowed } from '../guard.js';
import { detectRepo, oneLine } from '../util.js';
import { cleanUserText, eachJsonLine, entry, exists, jsonLines, readHead, readTail, safeReaddir, statOrNull, toolSummary } from './common.js';

const PROJECTS = path.join(HOMES.claude, 'projects');

// Claude Code names a project folder after its cwd with every non-alphanumeric turned into "-"
const slugFor = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// The conversation entries one transcript line holds
function extract(o, includeTools) {
  if (o.isSidechain || o.isMeta) return [];
  const content = o.message?.content;
  if (o.type === 'user') {
    if (typeof content === 'string') {
      const text = cleanUserText(content);
      return text ? [entry('user', text, o.timestamp)] : [];
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => cleanUserText(c.text))
        .filter(Boolean)
        .join('\n');
      const images = content.filter((c) => c.type === 'image').length;
      return text || images ? [entry('user', text + (images ? ` [${images} image(s)]` : ''), o.timestamp)] : [];
    }
    return [];
  }
  if (o.type === 'assistant' && Array.isArray(content)) {
    const out = [];
    for (const c of content) {
      if (c.type === 'text' && c.text?.trim()) out.push(entry('assistant', c.text, o.timestamp));
      else if (c.type === 'tool_use' && includeTools) out.push(entry('tool', toolSummary(c.name, c.input), o.timestamp));
    }
    return out;
  }
  return [];
}

// Only user and assistant messages hold searchable text; their role comes early in a line, tool calls and tool output right after it
const ROLES = [Buffer.from('"role":"user"'), Buffer.from('"role":"assistant"')];
const TOOL_PARTS = [Buffer.from('"type":"tool_result"'), Buffer.from('"type":"tool_use"')];
const searchable = (head) => ROLES.some((m) => head.includes(m)) && !TOOL_PARTS.some((m) => head.includes(m));

function transcripts(cwd) {
  let dirs = safeReaddir(PROJECTS);
  if (cwd) dirs = dirs.filter((d) => d === slugFor(cwd));
  const files = [];
  for (const d of dirs) {
    for (const f of safeReaddir(path.join(PROJECTS, d))) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(PROJECTS, d, f);
      const st = statOrNull(full);
      if (st && st.size > 0) files.push({ full, mtime: st.mtimeMs, nativeId: path.basename(f, '.jsonl') });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

export const claude = {
  agent: 'claude',
  homeRoots: [HOMES.claude],
  transcriptRoots: [PROJECTS],
  extract,
  searchable,

  // Claude's own memory: every project's auto-memory dir, the global CLAUDE.md, and the CLAUDE.md of the repo in question
  memoryFiles({ repoRoot } = {}) {
    const out = [];
    for (const dir of safeReaddir(PROJECTS)) {
      const mem = path.join(PROJECTS, dir, 'memory');
      for (const f of safeReaddir(mem)) {
        if (f.endsWith('.md')) out.push({ path: path.join(mem, f), kind: f === 'MEMORY.md' ? 'memory-index' : 'memory' });
      }
    }
    const global = path.join(HOMES.claude, 'CLAUDE.md');
    if (exists(global)) out.push({ path: global, kind: 'instructions' });
    for (const name of repoRoot ? REPO_MEMORY_FILES.claude : []) {
      const file = path.join(repoRoot, name);
      if (exists(file)) out.push({ path: file, kind: 'instructions', repo: path.basename(repoRoot) });
    }
    return out;
  },

  transcripts,

  listSessions({ cwd, limit = 15 } = {}) {
    return transcripts(cwd)
      .slice(0, limit)
      .map(({ full, mtime }) => ({ ...this.sessionMeta(full), updatedAt: mtime }));
  },

  sessionMeta(file) {
    const meta = { agent: 'claude', nativeId: path.basename(file, '.jsonl'), path: file, cwd: null, title: null, model: null, branch: null };
    for (const o of jsonLines(readHead(file))) {
      if (o.cwd && !meta.cwd) {
        meta.cwd = o.cwd;
        meta.branch = o.gitBranch || null;
        break;
      }
    }
    let lastPrompt = null;
    for (const o of jsonLines(readTail(file))) {
      if (o.type === 'custom-title' && o.customTitle) meta.title = o.customTitle;
      if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt;
      if (o.type === 'assistant' && o.message?.model) meta.model = o.message.model;
    }
    if (!meta.title && lastPrompt) meta.title = oneLine(cleanUserText(lastPrompt), 80);
    meta.repo = meta.cwd ? detectRepo(meta.cwd) : null;
    return meta;
  },

  sessionTitle(nativeId) {
    const file = this.findTranscript(nativeId);
    return file ? this.sessionMeta(file).title : null;
  },

  findTranscript(nativeId) {
    if (!/^[0-9a-f-]{8,}$/i.test(nativeId)) return null;
    for (const d of safeReaddir(PROJECTS)) {
      const file = path.join(PROJECTS, d, `${nativeId}.jsonl`);
      if (exists(file)) return file;
    }
    return null;
  },

  async readSession(file, { includeTools = true } = {}) {
    const real = resolveAllowed(file, this.transcriptRoots, { exts: ['.jsonl'] });
    if (!real) return null;
    const meta = this.sessionMeta(real);
    const entries = [];
    await eachJsonLine(real, (o) => entries.push(...extract(o, includeTools)));
    return { meta, entries };
  },
};
