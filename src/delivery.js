import { HOOK } from '../configuration/prompts.js';
import { AUTO_LISTEN_DEFAULT } from '../configuration/settings.js';
import { settleRinging } from './calls.js';
import { connectionCheck } from './identity.js';
import { formatInbox, formatMessage, inboxRows, isRinging, markRead, unreadCount } from './inbox.js';
import { now, oneLine } from './util.js';

/*
 * What the agents' hooks put in front of the model, so a message from another agent shows up without an `inbox` call:
 *
 *   SessionStart / UserPromptSubmit   unread messages, whole
 *   PostToolUse (any tool)            new messages mid-task: "finish your task first, then reply"
 *   Stop                              unread messages → the stop is blocked and the agent answers them now;
 *                                     nothing unread and auto-listen on → the agent goes on listening in `inbox`
 *
 * Handed-over messages count as read. A ringing call is only announced, once: the user picks who takes it.
 */

export function autoListen(db) {
  const row = db.get("SELECT value FROM settings WHERE key = 'auto_listen'");
  return row ? row.value === '1' : AUTO_LISTEN_DEFAULT;
}

export function setAutoListen(db, on) {
  db.run("INSERT INTO settings (key, value) VALUES ('auto_listen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", on ? '1' : '0');
}

// Unread messages for this session, oldest first, within the hook budget, plus ringing calls when asked; returns the text and marks them read
export function handOver(db, me, header, { ringing: announce = true } = {}) {
  settleRinging(db);
  const n = unreadCount(db, me);
  if (!n) return null;
  const rows = inboxRows(db, me, { limit: HOOK.deliverCount }).reverse();
  const handed = [];
  let size = 0;
  for (const m of rows.filter((r) => !isRinging(r))) {
    size += formatMessage(db, m).length;
    if (handed.length && size > HOOK.deliverChars) break;
    handed.push(m);
  }
  const ringing = announce ? rows.filter(isRinging) : [];
  const lines = [];
  if (handed.length) lines.push(header(me.handle), formatInbox(db, handed));
  for (const m of ringing) lines.push(`- #${m.id} ${m.kind} from ${m.from_handle} (ringing call #${m.link_id}): ${oneLine(m.subject || m.body, HOOK.previewChars)}`);
  if (ringing.length) lines.push(HOOK.ringing);
  const left = n - handed.length - rows.filter(isRinging).length;
  if (left > 0) lines.push(HOOK.more(left));
  if (!lines.length) return null;
  markRead(db, me, [...handed, ...ringing].map((m) => m.id));
  return lines.join('\n');
}

/*
 * The Stop decision. Auto-listen asks once per stretch: it asks again only after the agent really listened (or the
 * user sent a new prompt), so an agent that cannot or will not listen is never pushed into a loop.
 */
export function stopDecision(db, me, { listen = true } = {}) {
  // A ringing call is left to the dashboard and to the popup of a listening session
  const pending = handOver(db, me, HOOK.atStop, { ringing: false });
  if (pending) return pending;
  if (!listen || !autoListen(db)) return null;
  const s = db.get('SELECT listen_prompted_at, listened_at FROM sessions WHERE id = ?', me.id);
  if (s.listen_prompted_at && !(s.listened_at > s.listen_prompted_at)) return null;
  // Only a window whose Neurons server is up can call `inbox`
  if (!connectionCheck(db)(me)) return null;
  db.run('UPDATE sessions SET listen_prompted_at = ? WHERE id = ?', now(), me.id);
  return HOOK.autoListen;
}
