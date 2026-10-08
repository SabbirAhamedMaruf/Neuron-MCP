import { CALL } from '../../configuration/prompts.js';
import { CALL_SELECT, callById, expireCalls, hangUp, linesOf, pruneLines, ringingFor } from '../calls.js';
import { NeuronsError } from '../guard.js';
import { resolveTarget } from '../identity.js';

// How a call reads in the result: "line #3 (codex-1a2b3c4)", "call #4 (codex)"
function describe(db, me, c) {
  if (c.status === 'connected') return `line #${c.id} (${c.from_session === me.id ? c.answer_handle : c.from_handle})`;
  const to = c.to_kind === 'agent' ? c.to_target : db.get('SELECT handle FROM sessions WHERE id = ?', c.to_target)?.handle;
  return c.from_session === me.id ? `call #${c.id} (to ${to})` : `call #${c.id} (from ${c.from_handle})`;
}

export default async function disconnect(a, me, { db }) {
  expireCalls(db);
  pruneLines(db);
  let calls;
  if (a.call_id) {
    const c = callById(db, a.call_id);
    const mine = c && (c.from_session === me.id || c.answered_by === me.id || ringingFor(db, me).some((r) => r.id === c.id));
    if (!mine) throw new NeuronsError(`Call #${a.call_id} is not yours.`);
    if (c.status !== 'ringing' && c.status !== 'connected') return CALL.ended(c);
    calls = [c];
  } else {
    // Lines and calls this session placed; a call ringing for it is declined by call_id, or when it is the only thing there
    calls = [...linesOf(db, me), ...db.all(`${CALL_SELECT} WHERE c.status = 'ringing' AND c.from_session = ? ORDER BY c.id`, me.id)];
    if (a.to && !/^(all|everyone)$/i.test(a.to.trim())) {
      const t = resolveTarget(db, a.to);
      const peerOf = (c) => (c.status === 'connected' ? (c.from_session === me.id ? c.answered_by : c.from_session) : null);
      calls = calls.filter((c) =>
        t.kind === 'session'
          ? peerOf(c) === t.target || (c.to_kind === 'session' && c.to_target === t.target)
          : t.kind === 'agent' && ((c.status === 'connected' && (c.from_session === me.id ? c.answer_agent : c.from_agent) === t.target) || (c.to_kind === 'agent' && c.to_target === t.target)),
      );
    } else if (!a.to) {
      if (!calls.length) calls = ringingFor(db, me);
      if (calls.length > 1) throw new NeuronsError(CALL.pickHangUp(calls.map((c) => describe(db, me, c))));
    }
  }
  const done = calls.filter((c) => hangUp(db, c, me.handle, me.id)).map((c) => describe(db, me, c));
  return done.length ? CALL.hungUp(done) : CALL.nothingToHangUp;
}
