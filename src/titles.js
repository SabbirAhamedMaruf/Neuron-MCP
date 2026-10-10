import fs from 'node:fs';
import path from 'node:path';
import { HOMES } from '../configuration/settings.js';
import { redact } from './guard.js';
import { readTail } from './native/common.js';
import { oneLine } from './util.js';

/*
 * The title each chat shows in its agent's own UI, for the dashboard's canvas only (agents never see it): Claude
 * Code appends `custom-title` (the user renamed the chat) and `ai-title` records to its transcript; Codex keeps
 * `thread_name` per thread id in session_index.jsonl. Only those fields are read, and each file is read again only
 * once it has changed.
 */
const TAIL_BYTES = 512 * 1024;
const MAX_CHARS = 80;
const claudeCache = new Map();
let codexIndex = { mtime: -1, names: new Map() };

const clean = (title) => (title ? redact(oneLine(title, MAX_CHARS)) : null);

// The newest value of one string field in JSON lines text, or null
function lastField(text, key) {
  let found = null;
  for (const m of text.matchAll(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.){1,400})"`, 'g'))) found = m[1];
  if (!found) return null;
  try {
    return JSON.parse(`"${found}"`);
  } catch {
    return null;
  }
}

function claudeTitle(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  const hit = claudeCache.get(file);
  if (hit?.size === size) return hit.title;
  let title = null;
  try {
    const text = readTail(file, TAIL_BYTES);
    title = lastField(text, 'customTitle') || lastField(text, 'aiTitle');
  } catch {}
  // A tail without a title record (long tool output) keeps the title already known
  title = clean(title) || hit?.title || null;
  claudeCache.set(file, { size, title });
  return title;
}

function codexTitle(threadId) {
  const file = path.join(HOMES.codex, 'session_index.jsonl');
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (mtime !== codexIndex.mtime) {
    const names = new Map();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row.id && row.thread_name) names.set(row.id, clean(row.thread_name));
        } catch {}
      }
    } catch {}
    codexIndex = { mtime, names };
  }
  return codexIndex.names.get(threadId) || null;
}

// A session's chat title, or null when its agent keeps none we can read
export function chatTitle(session) {
  if (session.agent === 'claude' && session.transcript_path) return claudeTitle(session.transcript_path);
  if (session.agent === 'codex' && session.native_id) return codexTitle(session.native_id);
  return null;
}
