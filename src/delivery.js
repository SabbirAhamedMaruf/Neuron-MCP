import { HOOK } from '../configuration/prompts.js';
import { formatInbox, formatMessage, inboxRows, markRead, unreadCount } from './inbox.js';

/*
 * What the agents' hooks put in front of the model as hidden context, so a message from another agent arrives
 * without an `inbox` call and without anything showing up in the user's chat:
 *
 *   SessionStart / UserPromptSubmit   unread messages, whole
 *   PostToolUse (any tool)            new messages mid-task: "finish your step, reply, carry on"
 *
 * Handed-over messages count as read, oldest first.
 */
export function handOver(db, me, header) {
  if (!unreadCount(db, me)) return null;
  // From reading to marking read in one write transaction, so hooks firing together never hand a message over twice
  return db.tx(() => {
    const n = unreadCount(db, me);
    if (!n) return null;
    const rows = inboxRows(db, me, { limit: HOOK.deliverCount, oldestFirst: true });
    const handed = [];
    let size = 0;
    for (const m of rows) {
      size += formatMessage(db, m).length;
      if (handed.length && size > HOOK.deliverChars) break;
      handed.push(m);
    }
    markRead(db, me, handed.map((m) => m.id));
    const left = n - handed.length;
    return [header(me.handle), formatInbox(db, handed), left > 0 ? HOOK.more(left) : null].filter(Boolean).join('\n');
  });
}
