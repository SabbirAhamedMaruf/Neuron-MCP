import fs from 'node:fs';
import path from 'node:path';
import { LIMIT } from '../configuration/prompts.js';
import { HOMES } from '../configuration/settings.js';
import { postMessage } from './inbox.js';
import { readTail } from './native/common.js';
import { clockTime, now, oneLine } from './util.js';

/*
 * A chat its provider stopped (a usage limit, a lost login) answers nothing, so the chats waiting on it would wait
 * forever. Its own Neurons server notices it in that chat's own transcript (Claude Code) or thread file (Codex), reading
 * the error records only, never what was said, and then:
 *   each message still waiting on it gets a reply saying so, sent by Neurons on its behalf ([BLOCKED] …)
 *   `send` refuses new messages to it until the time its provider gave, or HOLD_MS when none was given
 *   the dashboard shows its box as blocked
 * A tool call by the chat (it is working again) lifts it; so does the time passing.
 */
const TAIL_BYTES = 256 * 1024;
const HOLD_MS = 15 * 60 * 1000;
const WAITING_MS = 60 * 60 * 1000;

// Claude Code errors that stop every turn until something changes; server errors and the like pass by themselves
const CLAUDE_BLOCKING = new Set(['rate_limit', 'authentication_failed', 'billing_error', 'oauth_org_not_allowed']);
const CODEX_BLOCKING = /usage_limit|rate_limit|quota|unauthori|auth/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The local time a provider's message says the limit lifts ("resets 2:20pm", "resets Oct 10, 12pm", "try again at
// 3:19 PM"), the first such moment after the error; null when it gives none
export function resetTime(text, at) {
  const m = String(text || '').match(/(?:resets|try again at)\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i);
  if (!m) return null;
  const [, mon, day, h, min = '0', ap] = m;
  const d = new Date(at);
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return null;
    d.setMonth(month, Number(day));
  }
  d.setHours((Number(h) % 12) + (/p/i.test(ap) ? 12 : 0), Number(min), 0, 0);
  // A time already past at the error is the next day's (or, with a date, the next year's)
  while (d.getTime() < at - 60 * 1000) mon ? d.setFullYear(d.getFullYear() + 1) : d.setDate(d.getDate() + 1);
  return d.getTime();
}

const parseLines = (text) =>
  text
    .split('\n')
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// The newest Claude Code record of a turn decides: an API error that stops it, or anything else (null)
function claudeBlock(file) {
  for (const r of parseLines(readTail(file, TAIL_BYTES))) {
    if (r.type !== 'assistant' && r.type !== 'user') continue;
    if (r.type !== 'assistant' || !r.isApiErrorMessage || !CLAUDE_BLOCKING.has(r.error)) return null;
    const text = r.message?.content?.find?.((c) => c?.type === 'text')?.text || r.error;
    const at = Date.parse(r.timestamp) || now();
    return { at, until: resetTime(text, at), reason: oneLine(text, 120) };
  }
  return null;
}

// A Codex thread's file: rollout-<time>-<thread id>.jsonl under sessions/YYYY/MM/DD, newest days first
const rollouts = new Map();
function rolloutOf(threadId) {
  const hit = rollouts.get(threadId);
  // A file once found stays; a miss is looked for again soon (a new thread's file appears with its first turn)
  if (hit && (hit.file || now() - hit.at < 10 * 1000)) return hit.file;
  let file = null;
  const walk = (dir, depth) => {
    let names = [];
    try {
      names = fs.readdirSync(dir).sort().reverse();
    } catch {
      return;
    }
    for (const n of names) {
      if (file) return;
      const p = path.join(dir, n);
      if (depth < 3) walk(p, depth + 1);
      else if (n.endsWith(`-${threadId}.jsonl`)) file = p;
    }
  };
  walk(path.join(HOMES.codex, 'sessions'), 0);
  rollouts.set(threadId, { file, at: now() });
  return file;
}

// The newest Codex turn decides: one that ended with a usage or login error, or anything else (null). The rate limit
// record that turn wrote before it (older in the file) says when the limit lifts; failing that, the error's own text
function codexBlock(file) {
  let found = null;
  for (const r of parseLines(readTail(file, TAIL_BYTES))) {
    const p = r.type === 'event_msg' ? r.payload : null;
    if (!p) continue;
    if (found) {
      if (p.type === 'task_started') break;
      if (p.type !== 'token_count') continue;
      const full = [p.rate_limits?.primary, p.rate_limits?.secondary].filter((w) => w && w.used_percent >= 100 && w.resets_at);
      if (full.length) found.until = Math.max(...full.map((w) => w.resets_at * 1000));
      break;
    }
    if (p.type === 'task_started') return null;
    if (p.type !== 'task_complete') continue;
    const e = p.error;
    if (!e || !CODEX_BLOCKING.test(`${e.codex_error_info || ''} ${e.message || ''}`)) return null;
    const at = p.completed_at ? p.completed_at * (p.completed_at < 1e12 ? 1000 : 1) : now();
    const message = String(e.message || e.codex_error_info);
    const later = message.match(/try again at\s+([^.]+)/i)?.[1];
    const kind = /usage|limit|quota/i.test(`${e.codex_error_info} ${message}`) ? 'You hit your usage limit' : oneLine(message.replace(/\(?https?:\/\/\S+\)?/g, ''), 100);
    found = { at, until: resetTime(message, at), reason: later ? `${kind} · try again at ${later.trim()}` : kind };
  }
  return found;
}

// What stops this chat right now, read from its own files; null when nothing does
export function readBlock(session) {
  try {
    if (session.agent === 'claude' && session.transcript_path) return claudeBlock(session.transcript_path);
    if (session.agent === 'codex' && session.native_id) {
      const file = rolloutOf(session.native_id);
      return file ? codexBlock(file) : null;
    }
  } catch {}
  return null;
}

// A block still in force: until the time the provider gave, or HOLD_MS from when it was seen
export function blockedOf(session, t = now()) {
  if (!session?.blocked_at) return null;
  const until = session.blocked_until || session.blocked_at + HOLD_MS;
  if (until <= t) return null;
  return { at: session.blocked_at, until: session.blocked_until || null, untilText: session.blocked_until ? clockTime(session.blocked_until) : null, reason: session.blocked_reason || 'its provider stopped it' };
}

// Messages still waiting on this chat: unanswered questions, proposals and review requests, and anything it never read
const WAITING = `SELECT m.* FROM messages m
  WHERE m.to_kind = 'session' AND m.to_target = :me AND m.status = 'open' AND m.created_at > :since
    AND (m.kind IN ('question', 'proposal', 'review')
      OR NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.session_id = :me))
  ORDER BY m.id`;

/*
 * Checks a chat this server runs, while something waits on it. Blocked: the block is recorded, and each waiting
 * message is closed with a [BLOCKED] reply to its sender. Returns the block, or null.
 */
export function checkBlocked(db, session, t = now()) {
  const waiting = db.all(WAITING, { me: session.id, since: t - WAITING_MS });
  if (!waiting.length && !session.blocked_at) return null;
  const found = readBlock(session);
  const block = found && blockedOf({ blocked_at: found.at, blocked_until: found.until, blocked_reason: found.reason }, t);
  if (!block) {
    if (session.blocked_at) db.run('UPDATE sessions SET blocked_at = NULL, blocked_until = NULL, blocked_reason = NULL WHERE id = ?', session.id);
    return null;
  }
  db.tx(() => {
    db.run('UPDATE sessions SET blocked_at = ?, blocked_until = ?, blocked_reason = ? WHERE id = ?', block.at, block.until, block.reason, session.id);
    for (const m of waiting) {
      if (Number(db.run("UPDATE messages SET status = 'blocked' WHERE id = ? AND status = 'open'", m.id).changes) !== 1) continue;
      postMessage(db, {
        from: session.id,
        toKind: 'session',
        toTarget: m.from_session,
        kind: 'reply',
        subject: `Re: ${m.subject || oneLine(m.body, 60)}`,
        body: LIMIT.blockedReply(session.handle, block),
        replyTo: m.id,
        status: 'closed',
      });
    }
  });
  return block;
}

// Every few seconds, for the chats this server runs (a Codex app-server's threads only from the server leading it)
const WATCH_MS = 5000;
export function startBlockWatch({ db, identity, log }) {
  const timer = setInterval(() => {
    try {
      if (!identity.leadsHost()) return;
      const mine = identity.agent === 'codex' ? identity.hostSessions().filter((s) => s.native_id) : [identity.peek()].filter(Boolean);
      for (const s of mine) checkBlocked(db, s);
    } catch (err) {
      log(`block watch: ${err?.message || err}`);
    }
  }, WATCH_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// Working again (it called a tool): the block is over
export function clearBlock(db, session) {
  if (session?.blocked_at) db.run('UPDATE sessions SET blocked_at = NULL, blocked_until = NULL, blocked_reason = NULL WHERE id = ?', session.id);
}
