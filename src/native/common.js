import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../guard.js';
import { oneLine } from '../util.js';

export function safeReaddir(dir, { withTypes = false } = {}) {
  try {
    return fs.readdirSync(dir, { withFileTypes: withTypes });
  } catch {
    return [];
  }
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// Text files under a dir, depth-limited; hidden folders are skipped
export function walkText(dir, { depth = 3, exts = ['.md', '.txt'], skipTop = [] } = {}) {
  const out = [];
  const visit = (d, level) => {
    for (const ent of safeReaddir(d, { withTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (level === 0 && skipTop.includes(ent.name)) continue;
        if (level < depth) visit(full, level + 1);
      } else if (ent.isFile() && exts.includes(path.extname(ent.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  visit(dir, 0);
  return out;
}

export function readHead(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readTail(file, bytes = 256 * 1024) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Drop the partial first line when we started mid-file
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

export function jsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

const CHUNK_BYTES = 8 * 1024 * 1024;
const NL = 0x0a;

function countLines(buf) {
  let n = 0;
  for (let i = buf.indexOf(NL); i !== -1; i = buf.indexOf(NL, i + 1)) n++;
  return buf.length && buf[buf.length - 1] !== NL ? n + 1 : n;
}

/*
 * Reads a file in large chunks that always end on a line break, so a chunk
 * can be searched as one string instead of line by line. fn(chunk, firstLine,
 * lineCount) gets the raw bytes and the 1-based number of the chunk's first
 * line; returning false stops early.
 */
async function eachChunk(file, fn) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let carry = null;
    let line = 1;
    for (let pos = 0; ; ) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
      pos += bytesRead;
      const eof = bytesRead === 0;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const end = eof ? data.length : data.lastIndexOf(NL) + 1;
      // The unfinished last line is copied out because buf is reused by the next read
      carry = eof ? null : Buffer.from(data.subarray(end));
      if (end > 0) {
        const chunk = data.subarray(0, end);
        const count = countLines(chunk);
        if (fn(chunk, line, count) === false) return;
        line += count;
      }
      if (eof) return;
    }
  } finally {
    await fh.close();
  }
}

export function snippetAround(text, index, width = 260) {
  let start = Math.max(0, index - Math.floor(width / 3));
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  return oneLine(text.slice(start, start + width), width);
}

// Bytes of a line's start that adapter.searchable() looks at
const HEAD_BYTES = 2048;

/*
 * Keyword hits in one transcript. Lines are found by scanning bytes, and the
 * adapter's searchable(head) rules out tool calls, tool output and bookkeeping
 * from a line's first bytes before anything is decoded; that is nearly all of
 * a transcript's size. The remaining lines are lowercased and matched, only
 * matching ones are JSON-parsed, and extract(obj) yields the user/assistant
 * text that counts.
 */
export async function searchTranscript(file, terms, { extract, searchable }, { deadline, perFile = 4 } = {}) {
  const hits = [];
  const consider = (raw, lineNo) => {
    const lower = raw.toLowerCase();
    if (!terms.some((t) => lower.includes(t))) return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    for (const e of extract(obj, false)) {
      if (e.role === 'tool') continue;
      const text = e.text.toLowerCase();
      const matched = terms.filter((t) => text.includes(t));
      if (!matched.length) continue;
      hits.push({ line: lineNo, role: e.role, ts: e.ts, matched: matched.length, snippet: snippetAround(e.text, Math.min(...matched.map((t) => text.indexOf(t)))) });
    }
  };
  await eachChunk(file, (chunk, firstLine) => {
    if (deadline && Date.now() > deadline) return false;
    let lineNo = firstLine;
    for (let s = 0; s < chunk.length; lineNo++) {
      let e = chunk.indexOf(NL, s);
      if (e === -1) e = chunk.length;
      if (e > s && (!searchable || searchable(chunk.subarray(s, Math.min(e, s + HEAD_BYTES))))) consider(chunk.toString('utf8', s, e), lineNo);
      s = e + 1;
    }
  });
  return hits.sort((a, b) => b.matched - a.matched || b.line - a.line).slice(0, perFile);
}

// Conversation entries from the lines around one line of a transcript; lines before the window are counted in bytes, never decoded
export async function transcriptWindow(file, lineNo, radius, extract) {
  const from = Math.max(1, lineNo - radius);
  const to = lineNo + radius;
  const out = [];
  await eachChunk(file, (chunk, first, count) => {
    const last = first + count - 1;
    if (last < from) return;
    let off = 0;
    for (let n = first; n < from; n++) off = chunk.indexOf(NL, off) + 1;
    for (let n = Math.max(first, from); n <= Math.min(last, to); n++) {
      const end = chunk.indexOf(NL, off);
      const raw = chunk.toString('utf8', off, end === -1 ? chunk.length : end);
      off = end + 1;
      if (!raw) continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const e of extract(obj, true)) out.push({ ...e, line: n, hit: n === lineNo });
    }
    if (last >= to) return false;
  });
  return out;
}

// Every parseable JSON line of a file, split on "\n" only (readline would also split on U+2028 inside a line)
export async function eachJsonLine(file, fn) {
  await eachChunk(file, (chunk) => {
    for (let s = 0; s < chunk.length; ) {
      let e = chunk.indexOf(NL, s);
      if (e === -1) e = chunk.length;
      if (e > s) {
        let obj;
        try {
          obj = JSON.parse(chunk.toString('utf8', s, e));
        } catch {
          obj = null;
        }
        if (obj) fn(obj);
      }
      s = e + 1;
    }
  });
}

// "name — description" from frontmatter, else the first heading, else the file name
export function describeNote(file, text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (name || desc) return [name, desc].filter(Boolean).join(' — ');
  }
  const heading = text.match(/^#{1,3}\s+(.+)$/m)?.[1];
  return heading ? heading.trim() : path.basename(file);
}

// Strips harness-injected wrappers so a transcript reads like the conversation
export function cleanUserText(text) {
  if (!text) return '';
  let t = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, '')
    .trim();
  if (/^<([a-z_-]+)[^>]*>[\s\S]*<\/\1>$/i.test(t)) return '';
  return t;
}

export function toolSummary(name, input) {
  let detail = '';
  if (input && typeof input === 'object') {
    detail =
      input.file_path ||
      input.path ||
      input.notebook_path ||
      input.pattern ||
      input.url ||
      input.command ||
      input.query ||
      input.skill ||
      input.description ||
      input.prompt ||
      '';
  } else if (typeof input === 'string') {
    detail = input;
  }
  return redact(`${name}${detail ? ': ' + oneLine(detail, 160) : ''}`);
}

export const entry = (role, text, ts) => ({ role, text: redact(String(text || '').trim()), ts: ts || null });
