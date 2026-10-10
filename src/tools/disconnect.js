import { CALL } from '../../configuration/prompts.js';
import { NeuronsError } from '../guard.js';
import { resolveTarget } from '../identity.js';
import { hangUp, linesOf, pruneLines } from '../lines.js';

// How a line reads in the result: "line #3 (codex-1a2b3c4)"
const describe = (me, l) => `line #${l.id} (${l.from_session === me.id ? l.answer_handle : l.from_handle})`;

// Hangs up this session's lines: the one to a handle or an agent, every one ("all"), or the only one
export default async function disconnect(a, me, { db }) {
  pruneLines(db);
  let lines = linesOf(db, me);
  if (a.to && !/^(all|everyone)$/i.test(a.to.trim())) {
    const t = resolveTarget(db, a.to);
    lines = lines.filter((l) => (t.kind === 'session' ? l.peer.id === t.target : t.kind === 'agent' && l.peer.agent === t.target));
  } else if (!a.to && lines.length > 1) {
    throw new NeuronsError(CALL.pickHangUp(lines.map((l) => describe(me, l))));
  }
  const done = lines.filter((l) => hangUp(db, l, me.handle)).map((l) => describe(me, l));
  return done.length ? CALL.hungUp(done) : CALL.nothingToHangUp;
}
