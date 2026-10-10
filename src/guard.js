import fs from 'node:fs';
import path from 'node:path';
import { HOMES, LIMITS, PLATFORM } from '../configuration/settings.js';

export class NeuronsError extends Error {}

// Credential shapes; every write is scanned against these and every read is redacted with them
const PATTERNS = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai_style_key', /\bsk-(?:proj-|svcacct-|or-v1-)?[A-Za-z0-9_-]{20,}/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['gitlab_token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['slack_token', /\bxox[abprse]-[A-Za-z0-9-]{10,}/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['google_oauth_token', /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ['google_client_secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ['stripe_key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['supabase_token', /\b(?:sbp|sbp_oauth)_[A-Za-z0-9]{32,}|\bsb_secret_[A-Za-z0-9_-]{20,}/g],
  ['npm_token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['huggingface_token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer_token', /\b[Bb]earer\s+[A-Za-z0-9_\-.=+/]{20,}/g],
  ['url_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/gi],
  [
    'secret_assignment',
    /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|SERVICE_ROLE)[A-Z0-9_]*\s*[:=]\s*["']?([A-Za-z0-9_\-.+/=]{12,})/g,
  ],
  [
    'secret_json_field',
    /["'](?:api[_-]?key|secret|client[_-]?secret|password|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|private[_-]?key)["']\s*:\s*["']([^"'\s]{12,})["']/gi,
  ],
];

// Placeholders like ${TOKEN}, <redacted> or "your_key_here" are documentation, not secrets
const PLACEHOLDER = /^(?:\$|<|\{|process\.env|\*{3}|x{6,}|your[_-]|example|placeholder|redacted|changeme|dummy|test[_-]?key)/i;

// The generic assignment rules only fire on values that look machine-generated
const looksGenerated = (value) => /[A-Za-z]/.test(value) && /\d/.test(value) && !PLACEHOLDER.test(value);

function matches(text) {
  const hits = [];
  if (!text) return hits;
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (m[1] !== undefined && !looksGenerated(m[1])) continue;
      hits.push({ kind, index: m.index, length: m[0].length });
    }
  }
  return hits;
}

function findSecrets(text) {
  return [...new Set(matches(text).map((h) => h.kind))];
}

export function redact(text) {
  if (!text) return text;
  // Overlapping hits merge into one span, so a short match inside a longer secret never leaves the rest of it showing
  const spans = [];
  for (const h of matches(text).sort((a, b) => a.index - b.index || b.length - a.length)) {
    const last = spans.at(-1);
    if (last && h.index < last.end) last.end = Math.max(last.end, h.index + h.length);
    else spans.push({ start: h.index, end: h.index + h.length, kind: h.kind });
  }
  let out = text;
  for (const span of spans.reverse()) out = out.slice(0, span.start) + `[REDACTED:${span.kind}]` + out.slice(span.end);
  return out;
}

// Throws before anything that looks like a credential reaches the shared store
export function assertClean(fields) {
  const problems = [];
  for (const [name, value] of Object.entries(fields)) {
    const text = Array.isArray(value) ? value.join('\n') : typeof value === 'object' && value ? JSON.stringify(value) : value;
    const kinds = findSecrets(text);
    if (kinds.length) problems.push(`${name}: ${kinds.join(', ')}`);
  }
  if (problems.length) {
    throw new NeuronsError(
      `Rejected: this looks like it contains credentials (${problems.join('; ')}). ` +
        'Neurons never stores auth material. Remove the secret (describe it instead, e.g. "the key in .env") and retry.',
    );
  }
}

export function assertLength(name, value, max) {
  if (value && value.length > max) throw new NeuronsError(`${name} is too long (${value.length} chars, max ${max}).`);
}

// Agent auth and config files never pass, whatever directory they sit in
const SENSITIVE_NAMES = [
  /^auth\.json$/i,
  /^\.?credentials(\..*)?$/i,
  /^oauth/i,
  /^\.env/i,
  /\.env$/i,
  /^config\.toml$/i,
  /^settings(\.local)?\.json$/i,
  /^\.claude\.json/i,
  /^\.?mcp(\..*)?\.json$/i,
  /^id_[a-z0-9]+/i,
  /\.(pem|key|p12|pfx|keystore|jks|der|crt)$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  // A repo's git dir: its config can hold remote URLs with tokens
  /^\.git$/,
];

// Notes and transcripts may mention tokens in their name; their content is redacted instead
const NOTE_EXTS = new Set(['.md', '.txt', '.jsonl']);
const SENSITIVE_WORDS = /token|secret|credential|password|apikey|api_key/i;

export function isSensitivePath(p) {
  // Both separators: Windows paths often arrive with forward slashes (git, apply_patch)
  const parts = p.split(/[\\/]/);
  if (parts.some((part) => SENSITIVE_NAMES.some((re) => re.test(part)))) return true;
  const base = parts[parts.length - 1] || '';
  return !NOTE_EXTS.has(path.extname(base).toLowerCase()) && SENSITIVE_WORDS.test(base);
}

// Windows paths compare without case
const samePath = PLATFORM === 'win32' ? (p) => p.toLowerCase() : (p) => p;

// Every agent's own folder (memory, chats, auth), real paths; a dotfiles repo can hold one behind a symlink
let agentHomes = null;
function realHomes() {
  agentHomes ||= Object.values(HOMES).flatMap((h) => {
    try {
      return [samePath(fs.realpathSync(h))];
    } catch {
      return [];
    }
  });
  return agentHomes;
}

// True for a file inside any agent's folder: those are read only by that agent's own memory and session readers,
// never through a repo path, so one agent cannot reach another's memory or chats
export function inAgentHome(file) {
  let real;
  try {
    real = samePath(fs.realpathSync(file));
  } catch {
    real = samePath(path.resolve(file));
  }
  return realHomes().some((h) => real === h || real.startsWith(h + path.sep));
}

// Resolves symlinks and accepts the file only when it really lives under one of the roots
export function resolveAllowed(file, roots, { exts = ['.md', '.txt'] } = {}) {
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return null;
  }
  if (isSensitivePath(real)) return null;
  if (exts && !exts.includes(path.extname(real).toLowerCase())) return null;
  const inside = roots.some((root) => {
    let r;
    try {
      r = samePath(fs.realpathSync(root));
    } catch {
      return false;
    }
    return samePath(real) === r || samePath(real).startsWith(r + path.sep);
  });
  return inside ? real : null;
}

export function readAllowedText(file, roots, opts) {
  const real = resolveAllowed(file, roots, opts);
  if (!real) return null;
  const stat = fs.statSync(real);
  if (!stat.isFile()) return null;
  const fd = fs.openSync(real, 'r');
  try {
    const size = Math.min(stat.size, LIMITS.fileBytes);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return { path: real, text: buf.toString('utf8'), mtime: stat.mtimeMs, truncated: stat.size > size };
  } finally {
    fs.closeSync(fd);
  }
}
