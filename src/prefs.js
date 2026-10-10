import { now, parseJson } from './util.js';

// The user's choices from the dashboard: providers turned off in Neurons, and each chat's sending mode over its lines

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', ollama: 'Ollama', lmstudio: 'LM Studio' };
export const agentLabel = (agent) => AGENT_NAMES[agent] || agent || 'this agent';

export const SEND_MODES = ['auto', 'ask'];
// Automatic (messages go over its lines right away) unless the user set the chat to Ask first
export const sendModeOf = (session) => (session?.send_mode === 'ask' ? 'ask' : 'auto');

export function setSendMode(db, sessionId, mode) {
  if (!SEND_MODES.includes(mode)) throw new Error(`Unknown sending mode "${mode}".`);
  return Number(db.run('UPDATE sessions SET send_mode = ? WHERE id = ?', mode === 'auto' ? null : mode, sessionId).changes) === 1;
}

// Claude chats only start a turn on a message by themselves once the user accepted it in the chat's ⚙ settings
export const WAKES = new Set(['claude']);
export const wakeOf = (session) => WAKES.has(session?.agent) && session?.wake === 1;

export function setWake(db, sessionId, on) {
  const s = db.get('SELECT agent FROM sessions WHERE id = ?', sessionId);
  if (!s || !WAKES.has(s.agent)) throw new Error('Only Claude Code chats can be woken by a message.');
  return Number(db.run('UPDATE sessions SET wake = ? WHERE id = ?', on ? 1 : null, sessionId).changes) === 1;
}

// A chat's role on its lines, set by the user: an admin hands out tasks, a worker does them; none (the default) is a peer
export const ROLES = ['admin', 'worker'];
export const roleOf = (session) => (ROLES.includes(session?.role) ? session.role : null);

export function setRole(db, sessionId, role) {
  if (role && !ROLES.includes(role)) throw new Error(`Unknown role "${role}".`);
  return Number(db.run('UPDATE sessions SET role = ? WHERE id = ?', role || null, sessionId).changes) === 1;
}

export function disabledAgents(db) {
  return new Set(parseJson(db.get("SELECT value FROM settings WHERE key = 'disabledAgents'")?.value, []));
}

export const isAgentOff = (db, agent) => !!agent && disabledAgents(db).has(agent);

// Turning a provider off ends its lines and drops what its chats were waiting to send; its chats leave the graph
export function setAgentOff(db, agent, off) {
  if (!/^[a-z0-9-]{2,24}$/.test(String(agent || ''))) throw new Error(`Unknown agent "${agent}".`);
  return db.tx(() => {
    const set = disabledAgents(db);
    if (off) set.add(agent);
    else set.delete(agent);
    const t = now();
    db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      'disabledAgents',
      JSON.stringify([...set].sort()),
      t,
    );
    if (!off) return { ended: 0 };
    const mine = 'SELECT id FROM sessions WHERE agent = ?';
    const ended = db.run(
      `UPDATE calls SET status = 'ended', ended_by = ?, ended_at = ? WHERE status = 'connected' AND (from_session IN (${mine}) OR answered_by IN (${mine}))`,
      `${agentLabel(agent)} turned off in Neurons`,
      t,
      agent,
      agent,
    ).changes;
    db.run(`UPDATE asks SET status = 'cancelled', decided_at = ? WHERE status = 'pending' AND from_session IN (${mine})`, t, agent);
    return { ended: Number(ended) };
  });
}
