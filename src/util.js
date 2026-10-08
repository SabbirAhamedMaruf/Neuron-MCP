import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const now = () => Date.now();

export function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

// Local wall-clock time, "YYYY-MM-DD HH:MM"
export const iso = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE').slice(0, 16) : '');

export function oneLine(text, max = 120) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function clip(text, max) {
  if (!text || text.length <= max) return text ?? '';
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

export const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

export function parseJson(text, fallback = null) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const rootCache = new Map();

// Git top-level of a directory (or of the nearest existing parent of a file path), or null outside a repo.
// Found by walking up to the nearest .git (a folder, or a file in worktrees and submodules): no git process, which hooks would pay for on every call
export function repoRootOf(target) {
  if (!target) return null;
  let dir = path.resolve(target);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  if (rootCache.has(dir)) return rootCache.get(dir);
  let top = null;
  for (let d = dir; ; d = path.dirname(d)) {
    // Inside a .git folder there is no work tree, as git itself says
    if (path.basename(d) === '.git') break;
    if (fs.existsSync(path.join(d, '.git'))) {
      top = d;
      break;
    }
    if (d === path.dirname(d)) break;
  }
  rootCache.set(dir, top);
  return top;
}

// Output of a git command, or null when it fails (not a repo, unknown ref, timeout)
export function git(dir, args, timeout = 1500) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export const headOf = (dir) => git(dir, ['rev-parse', 'HEAD'])?.trim() || null;

// Repo name = the git top-level folder's name; null outside a repo
export function detectRepo(cwd) {
  const top = repoRootOf(cwd);
  return top ? path.basename(top) : null;
}

export function splitTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [])].slice(0, 12);
}
