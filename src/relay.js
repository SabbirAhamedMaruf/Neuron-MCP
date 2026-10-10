import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { CALL, HOOK } from '../configuration/prompts.js';
import { BUSY_STALE_MS, PLATFORM, WAIT_POLL_MS } from '../configuration/settings.js';
import { formatInbox, formatMessage, inboxRows, markRead } from './inbox.js';
import { isAgentOff, wakeOf } from './prefs.js';
import { now } from './util.js';

/*
 * Messages for an idle agent, from its own Neurons server in the background (a message reaches it only once the
 * sender's setting let it go: Automatic at once, Ask first after the user allowed it):
 *
 *   Codex   the messages are queued into the thread they are for (`codex queue`), so they show in its chat as a
 *           prompt and Codex answers at once; while that thread is in a turn they wait for the hooks (mid-task) or its stop
 *   Claude  only in a chat the user allowed to be woken (its ⚙ settings): the messages go to the session's own inbox
 *           socket (Claude Code's cross-session messaging), which starts a turn in an idle session; this server is
 *           that session's child, which Claude Code accepts as its own
 *   others  a popup in the agent's panel shows them; the agent answers at its next turn
 *
 * Only messages to one session (line traffic, replies) are relayed; one sent to every session of an agent waits
 * for the hooks, so several windows never all answer it. A question the hooks handed over that is still unanswered
 * when the agent stops (a model may skip hidden context) is queued once more, as a prompt. A message is relayed at
 * most once (messages.relayed_at), whichever process does it: it is marked before it is handed over, so the turn's own
 * prompt hook does not hand it over again, and unmarked if handing it over fails.
 */

// The Codex binary this server runs under (its parent process); NEURONS_CODEX_BIN overrides it
function codexBinary() {
  if (process.env.NEURONS_CODEX_BIN) return process.env.NEURONS_CODEX_BIN;
  let exe = null;
  try {
    if (PLATFORM === 'linux') exe = fs.readlinkSync(`/proc/${process.ppid}/exe`);
    else if (PLATFORM === 'darwin') exe = execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {}
  return exe && /^codex(\.exe)?$/i.test(path.basename(exe)) ? exe : null;
}

// Claude Code gives the processes it starts (this server) the session's inbox socket; a line written there is a message
// from another session, shown as one and never able to approve anything. The line format is the one Claude Code itself
// suggests in its debug output. Linux checks the sender is the session's child, so the token is only sent elsewhere
const CLAUDE_INBOX = process.env.CLAUDE_CODE_MESSAGING_SOCKET || null;
const INBOX_WAIT_MS = 5000;

function postToClaude(from, text, done) {
  const lines = [];
  if (PLATFORM !== 'linux' && process.env.CLAUDE_CODE_MESSAGING_TOKEN) lines.push(JSON.stringify({ type: 'auth', token: process.env.CLAUDE_CODE_MESSAGING_TOKEN }));
  lines.push(JSON.stringify({ type: 'user', from, message: { role: 'user', content: text } }));
  let finished = false;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    sock.destroy();
    done(err);
  };
  const sock = net.createConnection(CLAUDE_INBOX);
  sock.on('error', finish);
  sock.on('connect', () => sock.end(`${lines.join('\n')}\n`));
  // Written in full: delivered once Claude Code closes the connection, or after a short wait if it keeps it open
  sock.on('close', () => finish(null));
  sock.setTimeout(INBOX_WAIT_MS, () => finish(null));
}

// After a failed hand-over, how long until that session is tried again; it doubles on each failure in a row, up to the cap
const RETRY_MS = 30 * 1000;
const RETRY_MAX_MS = 10 * 60 * 1000;

// A Claude turn started from its inbox counts as busy until its Stop hook, or this long if no turn came of it
const CLAUDE_TURN_HOLD_MS = 2 * 60 * 1000;

// At most this many messages, and this much text, go into one queued prompt; the rest follow on the next one
const QUEUE_COUNT = 10;
const QUEUE_CHARS = HOOK.deliverChars;

// A client that refuses forms this many times in a row, faster than a person could click, gets no more popups
const INSTANT_MS = 1500;
const STRIKES = 2;

// Questions to this session that were handed over by the hooks, are still unanswered and were never queued, recent ones only
const UNANSWERED = `SELECT m.*, s.handle AS from_handle, s.agent AS from_agent FROM messages m
  JOIN sessions s ON s.id = m.from_session
  JOIN message_reads r ON r.message_id = m.id AND r.session_id = :me
  WHERE m.to_kind = 'session' AND m.to_target = :me AND m.kind IN ('question', 'proposal') AND m.status = 'open'
    AND m.relayed_at IS NULL AND m.created_at > :since
  ORDER BY m.id LIMIT :limit`;
const UNANSWERED_MAX_AGE_MS = 60 * 60 * 1000;

// The oldest messages that fit in one prompt (always at least one)
function fit(db, rows) {
  const out = [];
  let size = 0;
  for (const m of rows.slice(0, QUEUE_COUNT)) {
    size += formatMessage(db, m).length;
    if (out.length && size > QUEUE_CHARS) break;
    out.push(m);
  }
  return out;
}

// A message row's identity for this process: ids come back after the dashboard deletes the newest rows
const keyOf = (m) => `${m.id}:${m.created_at}`;

export function startMessageRelay({ server, db, identity, log }) {
  const codex = identity.agent === 'codex' ? codexBinary() : null;
  const popped = new Set();
  const retry = new Map();
  let queuing = false;
  let popups = !!server.server.getClientCapabilities()?.elicitation?.form;
  let strikes = 0;

  const failed = (session) => {
    const wait = Math.min((retry.get(session.id)?.wait || RETRY_MS / 2) * 2, RETRY_MAX_MS);
    retry.set(session.id, { at: Date.now() + wait, wait });
  };

  /*
   * In one transaction: claim the idle session (no other process queues for it, and its own prompt hook sees it busy),
   * and mark the messages read and relayed. Returns the claim's time, or null if the session is in a turn.
   */
  function claim(session, rows, unread) {
    return db.tx(() => {
      const t = now();
      if (Number(db.run('UPDATE sessions SET busy_at = ? WHERE id = ? AND (busy_at IS NULL OR busy_at < ?)', t, session.id, t - BUSY_STALE_MS).changes) !== 1) return null;
      markRead(db, session, unread);
      db.run('UPDATE messages SET relayed_at = ? WHERE id IN (SELECT value FROM json_each(?))', t, JSON.stringify(rows.map((m) => m.id)));
      return t;
    });
  }

  // The hand-over did not take the messages: they are unread and unrelayed again, and the session is idle again unless a turn began
  function unclaim(session, rows, unread, claimed) {
    db.tx(() => {
      db.run('DELETE FROM message_reads WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))', session.id, JSON.stringify(unread));
      db.run('UPDATE messages SET relayed_at = NULL WHERE relayed_at = ? AND id IN (SELECT value FROM json_each(?))', claimed, JSON.stringify(rows.map((m) => m.id)));
      db.run('UPDATE sessions SET busy_at = NULL WHERE id = ? AND busy_at = ?', session.id, claimed);
    });
  }

  // Hands the messages to the agent: `codex queue` into its thread, or a line into Claude's inbox socket
  function deliver(session, rows, text, done) {
    if (codex) return execFile(codex, ['queue', '--thread', session.native_id, '--message', text], { timeout: 30000 }, done);
    const senders = [...new Set(rows.map((m) => m.from_handle).filter(Boolean))];
    postToClaude(senders.length === 1 ? senders[0] : 'neurons', text, done);
  }

  function queue(session, rows, unread) {
    const claimed = claim(session, rows, unread);
    if (!claimed) return;
    queuing = true;
    const text = `${HOOK.queued(session.handle)}\n${formatInbox(db, rows)}`;
    deliver(session, rows, text, (err) => {
      queuing = false;
      if (!err) {
        // No turn may come of it (Claude Code held the message): the session is idle again after a while
        if (!codex) setTimeout(() => db.run('UPDATE sessions SET busy_at = NULL WHERE id = ? AND busy_at = ?', session.id, claimed), CLAUDE_TURN_HOLD_MS).unref();
        return retry.delete(session.id);
      }
      try {
        failed(session);
        // Killed at the timeout, Codex may have taken the prompt already: the messages stay relayed (at most once)
        if (err.killed) db.run('UPDATE sessions SET busy_at = NULL WHERE id = ? AND busy_at = ?', session.id, claimed);
        else unclaim(session, rows, unread, claimed);
      } catch (e) {
        log(`relay cleanup: ${e?.message || e}`);
      }
      log(`${codex ? 'codex queue' : 'claude inbox'} failed: ${err.message}`);
    });
  }

  // For one Codex thread or Claude session: unread messages plus handed-over questions nobody answered
  function pending(session) {
    const unread = inboxRows(db, session, { limit: QUEUE_COUNT * 2, sessionOnly: true, oldestFirst: true });
    const fresh = unread.filter((m) => !m.relayed_at);
    const ids = new Set(fresh.map((m) => m.id));
    const missed = db.all(UNANSWERED, { me: session.id, since: now() - UNANSWERED_MAX_AGE_MS, limit: QUEUE_COUNT }).filter((m) => !ids.has(m.id));
    const rows = fit(db, [...fresh, ...missed].sort((x, y) => x.id - y.id));
    return { rows, unread: rows.filter((m) => ids.has(m.id)).map((m) => m.id) };
  }

  // One session per poll: the first idle one with something waiting, the Codex thread on screen first
  function relayIdle(threads) {
    for (const session of threads) {
      if (session.busy_at && now() - session.busy_at < BUSY_STALE_MS) continue;
      if (Date.now() < (retry.get(session.id)?.at || 0)) continue;
      const { rows, unread } = pending(session);
      if (rows.length) return queue(session, rows, unread);
    }
  }

  // A refusal faster than a person could click counts as a strike; a real answer clears them
  const judge = (started, accepted) => {
    if (accepted || Date.now() - started >= INSTANT_MS) strikes = 0;
    else if (++strikes >= STRIKES) popups = false;
  };

  function popup(rows) {
    for (const m of rows) popped.add(keyOf(m));
    const started = Date.now();
    server.server
      .elicitInput({ mode: 'form', message: CALL.messagePopup(rows), requestedSchema: { type: 'object', properties: {} } }, { timeout: 5 * 60 * 1000 })
      .then((r) => judge(started, r.action === 'accept'))
      .catch(() => {
        // Not shown after all: try these again on the next poll, unless the client keeps refusing at once
        for (const m of rows) popped.delete(keyOf(m));
        judge(started, false);
      });
  }

  // A read-only look every poll; it writes only when it hands something over
  const timer = setInterval(() => {
    try {
      if (queuing || !identity.leadsHost() || isAgentOff(db, identity.agent)) return;
      // Codex threads the hooks have tied to this window get queued prompts; a Claude session the user allowed to be
      // woken gets its inbox; otherwise popups as for other agents
      if (codex) {
        const threads = identity.hostSessions().filter((s) => s.native_id);
        if (threads.length) return relayIdle(threads);
      } else if (identity.agent === 'claude' && CLAUDE_INBOX) {
        const me = identity.peek();
        if (me && wakeOf(me)) return relayIdle([me]);
      }
      if (!popups) return;
      const me = identity.peek();
      if (!me) return;
      // The newest ones: a popup only tells of new messages (the hooks deliver them), so shown but unread ones never hold new ones back
      const fresh = inboxRows(db, me, { limit: QUEUE_COUNT, sessionOnly: true })
        .reverse()
        .filter((m) => !popped.has(keyOf(m)));
      if (fresh.length) popup(fresh);
    } catch (err) {
      log(`message relay: ${err?.message || err}`);
    }
  }, WAIT_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
