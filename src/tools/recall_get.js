import path from 'node:path';
import { LIMITS, OUTPUT, RECALL } from '../../configuration/settings.js';
import { joinBlocks, list } from '../format.js';
import { NeuronsError, inAgentHome, readAllowedText, redact } from '../guard.js';
import { getOwnNote, ownSessionWindow } from '../native/index.js';
import { ago, clip, iso, repoRootOf } from '../util.js';

const LABEL = { user: 'USER', assistant: 'ASSISTANT', tool: 'TOOL' };

function neuronsNote(db, me, id) {
  const m = db.get('SELECT m.*, s.handle AS author FROM memories m LEFT JOIN sessions s ON s.id = m.author_session WHERE m.id = ?', id);
  if (!m || m.owner_agent !== me.agent) throw new NeuronsError(`#${id} is not one of your Neurons notes.`);
  return joinBlocks(
    `# ${m.title}`,
    list(
      [
        `type: ${m.type} · scope: ${m.scope === 'repo' ? `repo ${m.repo}` : 'global'} · status: ${m.status}`,
        `source: ${m.source}${m.evidence ? ` · evidence: ${m.evidence}` : ''}`,
        m.tags ? `tags: ${m.tags}` : null,
        `updated ${ago(m.updated_at)} by ${m.author || 'unknown'}`,
      ].filter(Boolean),
    ),
    m.body,
  );
}

async function sessionWindow(me, nativeId, line) {
  const entries = await ownSessionWindow(me.agent, nativeId, line);
  if (!entries.length) throw new NeuronsError(`Nothing readable around ${nativeId}@${line}.`);
  const lines = entries.map((e) => `${e.hit ? '>>' : '  '} [${e.line}] ${LABEL[e.role] || e.role}${e.ts ? ` ${iso(Date.parse(e.ts))}` : ''}: ${e.text.slice(0, OUTPUT.entryChars)}`);
  return joinBlocks(`# Your session ${nativeId}, around line ${line}`, clip(lines.join('\n\n'), LIMITS.outputChars));
}

function repoExcerpt(file, line) {
  const top = repoRootOf(file);
  const read = top && !inAgentHome(file) && readAllowedText(file, [top], { exts: null });
  if (!read) throw new NeuronsError(`Cannot open ${file}: it is outside a git repo or a protected file.`);
  const all = read.text.split('\n');
  const from = Math.max(1, line - RECALL.repoContextLines);
  const to = Math.min(all.length, line + RECALL.repoContextLines);
  const body = all
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(5)}${from + i === line ? '>' : ' '} ${l}`)
    .join('\n');
  return joinBlocks(`# ${file}:${line}`, '```\n' + redact(body) + '\n```');
}

export default async function recallGet({ ref }, me, { db }) {
  const r = ref.trim();
  const note = r.match(/^#?(\d+)$/);
  if (note) return neuronsNote(db, me, Number(note[1]));
  if (r.startsWith('memory:')) {
    const n = getOwnNote(me.agent, r);
    return joinBlocks(`# ${n.title}`, `[your ${n.kind || 'memory'}${n.mtime ? ` · modified ${ago(n.mtime)}` : ''}]`, clip(n.text, LIMITS.outputChars));
  }
  const session = r.match(/^session:([A-Za-z0-9_-]+)@(\d+)$/);
  if (session) return sessionWindow(me, session[1], Number(session[2]));
  // An absolute path on any OS (/home/…, C:\…), then the line
  const repo = r.match(/^repo:(.+):(\d+)$/);
  if (repo && path.isAbsolute(repo[1])) return repoExcerpt(repo[1], Number(repo[2]));
  throw new NeuronsError(`Unknown ref "${ref}". Use a ref exactly as \`recall\` printed it.`);
}
