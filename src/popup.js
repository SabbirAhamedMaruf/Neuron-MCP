import { CALL } from '../configuration/prompts.js';
import { LIMITS } from '../configuration/settings.js';
import { answerCall, hangUp, ringingFor, settleRinging } from './calls.js';
import { oneLine } from './util.js';

/*
 * The call popup: while a session listens in `inbox`, each call ringing for it is shown once as a form in its
 * agent's window (MCP elicitation). The model never sees it.
 *
 *   Pick up   → this session takes the call; its message arrives in the waiting inbox
 *   Not here  → only this popup closes; the call keeps ringing elsewhere
 *   Decline   → the call stops ringing everywhere and the caller hears so
 *
 * A popup closes by itself when the call is picked up elsewhere, stops ringing, or the listen ends; only in the
 * last case does it come back, on the next listen, since nobody answered it.
 */

// Calls shown (or showing) per session, so a popup comes once per call and window
const shown = new Set();

// Answered sooner than a person could click: the client declines popups by itself, so it is treated as having none
const AUTO_DECLINE_MS = 1500;

export class CallPopups {
  constructor(db, me, ask, identity) {
    this.db = db;
    this.me = me;
    this.ask = ask;
    this.identity = identity;
    this.open = new Map();
  }

  // Shows new ringing calls, closes popups whose call stopped ringing
  tick() {
    const ringing = ringingFor(this.db, this.me);
    const ids = new Set(ringing.map((c) => c.id));
    for (const [id, controller] of this.open) if (!ids.has(id)) controller.abort('call');
    if (!this.identity.popups) return;
    for (const c of ringing) {
      const key = `${this.me.id}:${c.id}`;
      if (shown.has(key)) continue;
      shown.add(key);
      this.show(c, key);
    }
  }

  show(c, key) {
    const controller = new AbortController();
    this.open.set(c.id, controller);
    const msg = c.message_id ? this.db.get('SELECT kind, subject, body FROM messages WHERE id = ?', c.message_id) : null;
    const preview = msg && msg.kind !== 'call' ? oneLine(msg.subject || msg.body, 100) : null;
    const started = Date.now();
    this.ask(
      {
        mode: 'form',
        message: CALL.popup(c, preview),
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'string', title: 'Answer', oneOf: CALL.popupAnswers, default: 'pickup' } },
          required: ['answer'],
        },
      },
      { signal: controller.signal, timeout: LIMITS.ringSeconds * 1000 },
    )
      .then((result) => {
        const answer = result.action === 'accept' ? result.content?.answer : null;
        if (!answer && Date.now() - started < AUTO_DECLINE_MS) return this.fallBack();
        if (answer === 'pickup') answerCall(this.db, c.id, this.me, 'popup');
        else if (answer === 'decline') hangUp(this.db, c, `${this.me.handle} (popup)`, this.me.id);
      })
      .catch(() => {
        // Closed by us, timed out, or refused by the client; only an instant refusal means the client cannot show popups
        if (controller.signal.reason === 'listen') shown.delete(key);
        else if (!controller.signal.aborted && Date.now() - started < AUTO_DECLINE_MS) this.fallBack();
      })
      .finally(() => this.open.delete(c.id));
  }

  // This window cannot show popups after all: the usual auto pick-up rules take over for what is ringing
  fallBack() {
    this.identity.popupsBroken();
    settleRinging(this.db);
  }

  close() {
    for (const controller of this.open.values()) controller.abort('listen');
  }
}
