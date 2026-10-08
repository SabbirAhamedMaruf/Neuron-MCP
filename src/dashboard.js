import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, DASHBOARD, DATA_DIR, DB_PATH, HOMES, LIMITS, PLATFORM, SESSION_LOOKBACK_MS, VERSION } from '../configuration/settings.js';
import { CALL_SELECT, answerCall, candidates, hangUp, pruneLines, settleRinging } from './calls.js';
import { liveClaims } from './claims.js';
import { autoListen, setAutoListen } from './delivery.js';
import { connectionCheck, liveServers } from './identity.js';
import { now, parseJson } from './util.js';

/*
 * Read and delete operations behind the editor dashboard. This is the human's
 * view of the whole store, so unlike the agent tools it is not scoped to one
 * agent. It never touches agents' own memory files or chats, only Neurons'
 * database.
 */
const MESSAGE_SELECT = `SELECT m.*, s.handle AS from_handle, s.agent AS from_agent, t.handle AS to_handle, t.agent AS to_agent
  FROM messages m
  JOIN sessions s ON s.id = m.from_session
  LEFT JOIN sessions t ON m.to_kind = 'session' AND t.id = m.to_target`;

const message = (m) => ({
  id: m.id,
  kind: m.kind,
  subject: m.subject,
  body: m.body,
  repo: m.repo,
  refs: parseJson(m.refs, []),
  replyTo: m.reply_to,
  group: m.link_type === 'group' ? m.link_id : null,
  link: m.link_type && m.link_type !== 'group' ? { type: m.link_type, id: m.link_id } : null,
  status: m.status,
  at: m.created_at,
  from: { handle: m.from_handle, agent: m.from_agent },
  to: m.to_kind === 'session' ? { handle: m.to_handle, agent: m.to_agent } : { handle: null, agent: m.to_kind === 'any' ? 'any' : m.to_target },
});

const marks = (ids) => ids.map(() => '?').join(', ');

// A message and every reply below it
function subtree(db, ids) {
  const all = new Set(ids);
  for (let frontier = [...ids]; frontier.length; ) {
    const next = db.all(`SELECT id FROM messages WHERE reply_to IN (${marks(frontier)})`, ...frontier).map((r) => r.id).filter((id) => !all.has(id));
    next.forEach((id) => all.add(id));
    frontier = next;
  }
  return [...all];
}

// The whole conversation a message belongs to: its root, a second-opinion fan-out's sibling questions, and all replies
function threadIds(db, id) {
  let root = db.get('SELECT id, reply_to, link_type, link_id FROM messages WHERE id = ?', id);
  if (!root) return [];
  while (root.reply_to) {
    const up = db.get('SELECT id, reply_to, link_type, link_id FROM messages WHERE id = ?', root.reply_to);
    if (!up) break;
    root = up;
  }
  const roots = root.link_type === 'group' ? db.all("SELECT id FROM messages WHERE link_type = 'group' AND link_id = ?", root.link_id).map((r) => r.id) : [root.id];
  return subtree(db, roots);
}

function deleteMessages(db, ids) {
  if (!ids.length) return 0;
  return Number(db.run(`DELETE FROM messages WHERE id IN (${marks(ids)})`, ...ids).changes);
}

const linkedMessages = (db, type, id) => db.all('SELECT id FROM messages WHERE link_type = ? AND link_id = ?', type, id).map((r) => r.id);
const linkedAll = (db, type) => db.all('SELECT id FROM messages WHERE link_type = ?', type).map((r) => r.id);

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function createDashboard(db) {
  const connected = () => {
    const servers = liveServers(db);
    const isConnected = connectionCheck(db, servers);
    const sessions = db
      .all('SELECT * FROM sessions WHERE ended_at IS NULL AND last_seen > ? ORDER BY last_seen DESC', now() - SESSION_LOOKBACK_MS)
      .filter(isConnected)
      .map((s) => ({ handle: s.handle, agent: s.agent, model: s.model, repo: s.repo, task: s.task, client: s.client, since: s.created_at, lastSeen: s.last_seen, listening: !!s.listening_at, autoAnswer: !!s.auto_answer }));
    // A window that is connected but has not been linked to a session yet still counts
    const linkedAgents = new Map();
    for (const s of sessions) linkedAgents.set(s.agent, (linkedAgents.get(s.agent) || 0) + 1);
    const starting = [];
    const serversByAgent = new Map();
    for (const s of servers) serversByAgent.set(s.agent, [...(serversByAgent.get(s.agent) || []), s]);
    for (const [agent, list] of serversByAgent) {
      for (const s of list.slice(linkedAgents.get(agent) || 0)) starting.push({ handle: null, agent, model: null, repo: null, task: null, client: s.client, since: s.started_at, lastSeen: s.last_seen });
    }
    return { sessions: [...sessions, ...starting], signature: servers.map((s) => `${s.pid}:${s.start}`).sort().join(','), isConnected };
  };

  // Ringing calls with the sessions that could pick each one up, and the open lines; stale ones are settled first
  const calls = (isConnected) => {
    settleRinging(db);
    pruneLines(db, isConnected);
    const person = (handle, agent) => ({ handle, agent });
    const ringing = db.all(`${CALL_SELECT} WHERE c.status = 'ringing' ORDER BY c.id`).map((c) => {
      const msg = c.message_id ? db.get('SELECT kind, subject, body FROM messages WHERE id = ?', c.message_id) : null;
      const toSession = c.to_kind === 'session' ? db.get('SELECT handle, agent FROM sessions WHERE id = ?', c.to_target) : null;
      return {
        id: c.id,
        from: person(c.from_handle, c.from_agent),
        to: toSession ? person(toSession.handle, toSession.agent) : person(null, c.to_target),
        at: c.created_at,
        until: c.created_at + LIMITS.ringSeconds * 1000,
        preview: msg && msg.kind !== 'call' ? (msg.subject ? `${msg.subject}: ${msg.body}` : msg.body).replace(/\s+/g, ' ').slice(0, 200) : null,
        candidates: candidates(db, c, isConnected).map((x) => ({ handle: x.handle, agent: x.agent, repo: x.repo, listening: !!x.listening_at, seen: x.hook_seen_at || x.last_seen })),
      };
    });
    const lines = db
      .all(`${CALL_SELECT} WHERE c.status = 'connected' ORDER BY c.answered_at DESC`)
      .map((c) => ({ id: c.id, from: person(c.from_handle, c.from_agent), to: person(c.answer_handle, c.answer_agent), since: c.answered_at, how: c.answered_how }));
    return { ringing, lines };
  };

  // A parameter, not an interpolated time: every distinct SQL string would be cached as its own statement
  const counts = () =>
    db.get(
      `SELECT
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM handoffs WHERE auto = 0) AS handoffs,
      (SELECT COUNT(*) FROM handoffs WHERE auto = 1) AS autoHandoffs,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM memories) AS notes,
      (SELECT COUNT(*) FROM claims WHERE released_at IS NULL AND expires_at > ?) AS liveClaims,
      (SELECT COUNT(*) FROM claims) AS claims,
      (SELECT COUNT(*) FROM embeddings) AS embeddings,
      (SELECT COUNT(*) FROM calls WHERE status NOT IN ('ringing', 'connected')) AS calls,
      (SELECT COUNT(*) FROM sessions) AS sessions`,
      now(),
    );

  const backups = () => {
    let files = [];
    try {
      files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db'));
    } catch {}
    return files
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        return { file: full, size: fileSize(full), at: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  };

  // A consistent copy of the whole DB (WAL included), taken before every bulk delete; only the newest few are kept
  const backup = () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(BACKUP_DIR, `neurons-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.run('VACUUM INTO ?', file);
    for (const old of backups().slice(DASHBOARD.backupsKept)) fs.rmSync(old.file, { force: true });
    return file;
  };

  const ops = {
    info: () => ({ version: VERSION, platform: PLATFORM, dataDir: DATA_DIR, dbPath: DB_PATH, backupDir: BACKUP_DIR, homes: HOMES }),

    snapshot: ({ feedLimit = DASHBOARD.feedLimit } = {}) => {
      const { sessions, signature, isConnected } = connected();
      return {
        now: now(),
        connected: sessions,
        calls: calls(isConnected),
        autoListen: autoListen(db),
        signature,
        feed: db.all(`${MESSAGE_SELECT} ORDER BY m.id DESC LIMIT ?`, feedLimit).map(message),
        counts: counts(),
        db: { path: DB_PATH, size: fileSize(DB_PATH) + fileSize(`${DB_PATH}-wal`), backups: backups().length },
      };
    },

    // Changes when a window opens or closes, a call rings, stops ringing or is picked up, or a line ends
    presence: () => {
      const { signature, isConnected } = connected();
      const c = calls(isConnected);
      return `${signature}|${c.ringing.map((r) => `${r.id}:${r.candidates.length}`).join(',')}|${c.lines.map((l) => l.id).join(',')}`;
    },

    // Picking up for a session, from the dashboard; the session reads the call's message on its next turn (or right away when listening)
    answer: ({ call, handle }) => {
      const session = db.get('SELECT * FROM sessions WHERE handle = ?', handle);
      const c = db.get('SELECT * FROM calls WHERE id = ?', call);
      if (!session || !c) throw new Error('That call or session is gone.');
      if (c.status !== 'ringing') throw new Error(`Call #${call} is no longer ringing.`);
      if (!candidates(db, c).some((x) => x.id === session.id)) throw new Error(`${handle} cannot take call #${call}.`);
      if (!answerCall(db, call, session, 'dashboard')) throw new Error(`Call #${call} is no longer ringing.`);
      return { connected: true };
    },

    // Declines a ringing call, or ends a line
    hangup: ({ call }) => {
      const c = db.get('SELECT * FROM calls WHERE id = ?', call);
      if (!c) throw new Error(`No call #${call}.`);
      return { ended: hangUp(db, c, 'the dashboard') };
    },

    // Every agent with hooks goes on listening when it finishes a turn, until the user presses Stop
    setAutoListen: ({ on }) => {
      setAutoListen(db, !!on);
      return { on: !!on };
    },

    // A session with auto-answer on picks up calls to its agent by itself; switching it on answers what is ringing now
    autoAnswer: ({ handle, on }) => {
      db.run('UPDATE sessions SET auto_answer = ? WHERE handle = ?', on ? now() : 0, handle);
      if (on) settleRinging(db);
      return { on: !!on };
    },

    history: ({ q, agent, kind, repo, before, limit = DASHBOARD.pageSize } = {}) => {
      const like = q ? `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const rows = db.all(
        `${MESSAGE_SELECT}
         WHERE (:before IS NULL OR m.id < :before)
           AND (:kind IS NULL OR m.kind = :kind)
           AND (:repo IS NULL OR m.repo = :repo)
           AND (:agent IS NULL OR s.agent = :agent OR m.to_target = :agent OR t.agent = :agent)
           AND (:like IS NULL OR m.body LIKE :like ESCAPE '\\' OR m.subject LIKE :like ESCAPE '\\')
         ORDER BY m.id DESC LIMIT :limit`,
        { before: before ?? null, kind: kind || null, repo: repo || null, agent: agent || null, like, limit: limit + 1 },
      );
      return { items: rows.slice(0, limit).map(message), more: rows.length > limit };
    },

    thread: ({ id }) => {
      const ids = threadIds(db, id);
      return ids.length ? db.all(`${MESSAGE_SELECT} WHERE m.id IN (${marks(ids)}) ORDER BY m.id`, ...ids).map(message) : [];
    },

    handoffs: ({ before, limit = DASHBOARD.pageSize } = {}) => {
      const rows = db.all(
        `SELECT h.id, h.repo, h.title, h.goal, h.auto, h.to_kind, h.to_target, h.created_at, s.handle, s.agent
         FROM handoffs h JOIN sessions s ON s.id = h.author_session
         WHERE (? IS NULL OR h.id < ?) ORDER BY h.created_at DESC LIMIT ?`,
        before ?? null,
        before ?? null,
        limit + 1,
      );
      return {
        items: rows.slice(0, limit).map((h) => ({ id: h.id, repo: h.repo, title: h.title, goal: h.goal, auto: !!h.auto, to: h.to_kind ? (h.to_kind === 'any' ? 'any' : h.to_target) : null, at: h.created_at, author: { handle: h.handle, agent: h.agent } })),
        more: rows.length > limit,
      };
    },

    handoff: ({ id }) => {
      const h = db.get('SELECT h.*, s.handle, s.agent FROM handoffs h JOIN sessions s ON s.id = h.author_session WHERE h.id = ?', id);
      return h && { id: h.id, repo: h.repo, title: h.title, goal: h.goal, auto: !!h.auto, at: h.created_at, author: { handle: h.handle, agent: h.agent }, data: parseJson(h.data, {}) };
    },

    reviews: () =>
      db
        .all(
          `SELECT r.id, r.title, r.repo, r.status, r.verdict, r.findings, r.created_at, r.completed_at, q.handle AS requester, q.agent AS requester_agent, v.handle AS reviewer
           FROM reviews r JOIN sessions q ON q.id = r.requester_session LEFT JOIN sessions v ON v.id = r.reviewer_session
           ORDER BY r.created_at DESC LIMIT 200`,
        )
        .map((r) => ({ id: r.id, title: r.title, repo: r.repo, status: r.status, verdict: r.verdict, findings: parseJson(r.findings, []).length, at: r.created_at, completedAt: r.completed_at, requester: { handle: r.requester, agent: r.requester_agent }, reviewer: r.reviewer })),

    review: ({ id }) => {
      const r = db.get('SELECT r.*, q.handle AS requester, v.handle AS reviewer FROM reviews r JOIN sessions q ON q.id = r.requester_session LEFT JOIN sessions v ON v.id = r.reviewer_session WHERE r.id = ?', id);
      if (!r) return null;
      const diff = r.diff || '';
      return { id: r.id, title: r.title, repo: r.repo, focus: r.focus, base: r.base, head: r.head, status: r.status, verdict: r.verdict, summary: r.summary, findings: parseJson(r.findings, []), files: parseJson(r.files, []), diff: diff.slice(0, 20000), diffTruncated: diff.length > 20000, requester: r.requester, reviewer: r.reviewer, at: r.created_at };
    },

    notes: () =>
      db
        .all('SELECT id, owner_agent, type, scope, repo, title, source, status, updated_at FROM memories ORDER BY updated_at DESC LIMIT 500')
        .map((m) => ({ id: m.id, owner: m.owner_agent, type: m.type, scope: m.scope, repo: m.repo, title: m.title, source: m.source, status: m.status, at: m.updated_at })),

    note: ({ id }) => {
      const m = db.get('SELECT * FROM memories WHERE id = ?', id);
      return m && { id: m.id, owner: m.owner_agent, title: m.title, body: m.body, tags: m.tags, evidence: m.evidence, type: m.type, scope: m.scope, repo: m.repo, source: m.source, status: m.status, at: m.updated_at };
    },

    claims: () => liveClaims(db).map((c) => ({ id: c.id, repo: c.repo, path: c.path, reason: c.reason, handle: c.handle, agent: c.agent, at: c.created_at, expiresAt: c.expires_at })),

    backups,

    delete: ({ what, id }) =>
      db.tx(() => {
        if (what === 'message') return { messages: deleteMessages(db, subtree(db, [id])) };
        if (what === 'thread') return { messages: deleteMessages(db, threadIds(db, id)) };
        if (what === 'handoff') {
          const messages = deleteMessages(db, subtree(db, linkedMessages(db, 'handoff', id)));
          return { handoffs: Number(db.run('DELETE FROM handoffs WHERE id = ?', id).changes), messages };
        }
        if (what === 'review') {
          const messages = deleteMessages(db, subtree(db, linkedMessages(db, 'review', id)));
          return { reviews: Number(db.run('DELETE FROM reviews WHERE id = ?', id).changes), messages };
        }
        if (what === 'note') {
          db.run('DELETE FROM embeddings WHERE ref = ?', `#${id}`);
          return { notes: Number(db.run('DELETE FROM memories WHERE id = ?', id).changes) };
        }
        if (what === 'claim') return { claims: Number(db.run('UPDATE claims SET released_at = ? WHERE id = ? AND released_at IS NULL', now(), id).changes) };
        throw new Error(`Cannot delete "${what}".`);
      }),

    // Bulk deletes; each one backs the DB up first
    clear: ({ what }) => {
      const steps = {
        messages: () => ({ messages: Number(db.run('DELETE FROM messages').changes) }),
        handoffs: () => ({ messages: deleteMessages(db, subtree(db, linkedAll(db, 'handoff'))), handoffs: Number(db.run('DELETE FROM handoffs').changes) }),
        'auto-handoffs': () => ({ handoffs: Number(db.run('DELETE FROM handoffs WHERE auto = 1').changes) }),
        reviews: () => ({ messages: deleteMessages(db, subtree(db, linkedAll(db, 'review'))), reviews: Number(db.run('DELETE FROM reviews').changes) }),
        claims: () => ({ claims: Number(db.run('DELETE FROM claims').changes) }),
        notes: () => ({ embeddings: Number(db.run("DELETE FROM embeddings WHERE ref LIKE '#%'").changes), notes: Number(db.run('DELETE FROM memories').changes) }),
        embeddings: () => ({ embeddings: Number(db.run('DELETE FROM embeddings').changes) }),
        // The call log; lines that are up and calls still ringing stay
        calls: () => ({ calls: Number(db.run("DELETE FROM calls WHERE status NOT IN ('ringing', 'connected')").changes) }),
      };
      const order = what === 'everything' ? ['messages', 'handoffs', 'reviews', 'claims', 'notes', 'embeddings', 'calls'] : [what];
      if (!order.every((k) => steps[k])) throw new Error(`Cannot clear "${what}".`);
      const file = backup();
      const deleted = db.tx(() => {
        const out = {};
        for (const k of order) Object.assign(out, steps[k]());
        if (what === 'everything') {
          db.run('DELETE FROM session_files');
          // Sessions of windows that are still open keep their identity
          const keep = new Set(connected().sessions.filter((s) => s.handle).map((s) => s.handle));
          const gone = db.all('SELECT id, handle FROM sessions').filter((s) => !keep.has(s.handle)).map((s) => s.id);
          if (gone.length) out.sessions = Number(db.run(`DELETE FROM sessions WHERE id IN (${marks(gone)})`, ...gone).changes);
        }
        return out;
      });
      return { backup: file, deleted };
    },
  };
  return ops;
}
