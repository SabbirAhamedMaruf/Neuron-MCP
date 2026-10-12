import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, BUSY_STALE_MS, DASHBOARD, DATA_DIR, DB_PATH, LINE_PAUSE_MS, PLATFORM, SESSION_LOOKBACK_MS } from '../configuration/settings.js';
import { claimAskNotice, decideAsk, pendingAsks } from './asks.js';
import { blockedOf } from './limits.js';
import { liveClaims } from './claims.js';
import { connectionCheck, liveServers } from './identity.js';
import { unreadCount } from './inbox.js';
import { LINE_SELECT, hangUp, lineById, newestPerWindow, openLine, pruneLines } from './lines.js';
import { WAKES, disabledAgents, roleOf, sendModeOf, setAgentOff, setRole, setSendMode, setWake, wakeOf } from './prefs.js';
import { chatTitle } from './titles.js';
import { now, oneLine, parseJson } from './util.js';

/*
 * Read and delete operations behind the editor dashboard. This is the human's
 * view of the whole store, so unlike the agent tools it is not scoped to one
 * agent. It never touches agents' own memory files or chats, only Neurons'
 * database.
 */

/*
 * A conversation is everything between two parties: two sessions, or a session and the agent it wrote to
 * before anyone picked up ("any" for questions to whoever answers first). The notice of a missed or declined call
 * (to the caller itself) belongs with the party it called. The key is built in SQL, so a conversation of any age is
 * found, searched and deleted whole.
 */
const MESSAGE_FROM = `FROM messages m
  JOIN sessions s ON s.id = m.from_session
  LEFT JOIN sessions t ON m.to_kind = 'session' AND t.id = m.to_target
  LEFT JOIN calls k ON m.link_type = 'call-ended' AND k.id = m.link_id
  LEFT JOIN sessions kt ON k.to_kind = 'session' AND kt.id = k.to_target`;
const PARTY = `CASE WHEN k.id IS NOT NULL THEN COALESCE(kt.handle, k.to_target)
  WHEN m.to_kind = 'session' THEN COALESCE(t.handle, m.to_target) WHEN m.to_kind = 'any' THEN 'any' ELSE m.to_target END`;
const PARTY_HANDLE = `CASE WHEN k.id IS NOT NULL THEN kt.handle WHEN m.to_kind = 'session' THEN t.handle END`;
const PARTY_AGENT = `CASE WHEN k.id IS NOT NULL THEN COALESCE(kt.agent, k.to_target)
  WHEN m.to_kind = 'session' THEN t.agent WHEN m.to_kind = 'any' THEN 'any' ELSE m.to_target END`;
const PAIR = `min(s.handle, ${PARTY}) || ' ⇄ ' || max(s.handle, ${PARTY})`;
const MESSAGE_SELECT = `SELECT m.*, s.handle AS from_handle, s.agent AS from_agent, ${PARTY_HANDLE} AS party_handle, ${PARTY_AGENT} AS party_agent ${MESSAGE_FROM}`;

// What the chat view shows of a message
const message = (m) => ({ id: m.id, kind: m.kind, subject: m.subject, body: m.body, at: m.created_at, from: { handle: m.from_handle, agent: m.from_agent } });

// The other side of a message, as the SQL above names it
const toParty = (m) => ({ handle: m.party_handle, agent: m.party_agent });
const partyName = (p) => p.handle || p.agent;

// The newest messages of one conversation that the chat view shows
const CONVERSATION_MAX = 3000;
// How many of a line's newest messages the canvas sees (each new one travels along the line as a dot)
const RECENT_PER_LINE = 20;
// A window this young may be the Claude extension's short-lived probe rather than a chat; it shows once it has lasted
const SETTLE_MS = 5000;

// Id lists travel as one JSON parameter: one cached statement for any count, and no limit on how many
const ids = (list) => JSON.stringify(list);

// A message and every reply below it
const subtree = (db, list) =>
  db
    .all('WITH RECURSIVE t(id) AS (SELECT value FROM json_each(?) UNION SELECT m.id FROM messages m JOIN t ON m.reply_to = t.id) SELECT id FROM t', ids(list))
    .map((r) => r.id);

function deleteMessages(db, list) {
  if (!list.length) return 0;
  return Number(db.run('DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))', ids(list)).changes);
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
  // Search folds case like JavaScript does (SQLite's lower() knows only ASCII)
  db.raw.function('neurons_fold', { deterministic: true }, (text) => String(text ?? '').toLowerCase());

  /*
   * The canvas: every open chat (one per agent window, the session lines route to) with what it is doing, the lines
   * the user drew between them with their traffic, and windows whose chat has not shown itself yet
   */
  const graph = () => {
    const servers = liveServers(db);
    const isConnected = connectionCheck(db, servers);
    pruneLines(db, isConnected);
    const t = now();
    const serverOf = new Map(servers.map((v) => [`${v.pid}:${v.start}`, v]));
    const settled = servers.filter((v) => t - v.started_at >= SETTLE_MS);
    const young = new Set(servers.filter((v) => t - v.started_at < SETTLE_MS).map((v) => `${v.pid}:${v.start}`));
    // A chat's server: the one it called a tool through, else the one under the agent process its hook ran in (a chat
    // that has had a prompt but no Neurons tool call yet), so its box knows its host and no ghost doubles it
    const serverFor = (s) => serverOf.get(`${s.server_pid}:${s.server_start}`) || servers.find((v) => v.agent === s.agent && v.host_key && parseJson(s.hook_pids, []).includes(v.host_key));
    const keyOf = (v) => (v ? `${v.pid}:${v.start}` : null);
    // A provider the user turned off has no place on the graph
    const off = disabledAgents(db);
    const chats = newestPerWindow(
      db.all('SELECT * FROM sessions WHERE ended_at IS NULL AND last_seen > ?', t - SESSION_LOOKBACK_MS).filter((s) => isConnected(s) && !off.has(s.agent) && !young.has(keyOf(serverFor(s)))),
    );
    const nodes = chats
      .sort((a, b) => a.created_at - b.created_at)
      .map((s) => {
        const server = serverFor(s);
        return {
          id: s.id,
          handle: s.handle,
          title: chatTitle(s),
          agent: s.agent,
          model: s.model,
          repo: s.repo,
          task: s.task,
          label: s.label,
          client: server?.client || s.client,
          surface: server?.surface ?? null,
          host: server?.host_key ?? null,
          since: s.created_at,
          active: Math.max(s.hook_seen_at || 0, s.last_seen || 0),
          busy: !!s.busy_at && t - s.busy_at < BUSY_STALE_MS,
          unread: unreadCount(db, s),
          sendMode: sendModeOf(s),
          role: roleOf(s),
          // Stopped by its provider (a usage limit, a lost login): why, and until when if it said
          blocked: blockedOf(s, t),
          // null: this agent cannot be woken; otherwise whether the user allowed it
          wake: WAKES.has(s.agent) ? wakeOf(s) : null,
        };
      });
    const open = db.all(`${LINE_SELECT} WHERE c.status = 'connected' ORDER BY c.answered_at`);
    // A line waiting for a closed chat to come back is listed apart; the canvas draws lines between chats it shows
    const paused = open
      .filter((c) => c.paused_at)
      .map((c) => ({ id: c.id, ends: [c.from_handle, c.answer_handle], since: c.paused_at, until: c.paused_at + LINE_PAUSE_MS }));
    const onCanvas = new Set(nodes.map((n) => n.id));
    const lines = open.filter((c) => !c.paused_at && onCanvas.has(c.from_session) && onCanvas.has(c.answered_by)).map((c) => {
      const pair = [c.answered_at, c.from_session, c.answered_by, c.answered_by, c.from_session];
      const between = "created_at >= ? AND to_kind = 'session' AND ((from_session = ? AND to_target = ?) OR (from_session = ? AND to_target = ?))";
      const traffic = db.get(`SELECT COUNT(*) AS n FROM messages WHERE ${between}`, ...pair);
      const last = db.get(`SELECT m.kind, m.subject, m.body, m.created_at, s.handle FROM messages m JOIN sessions s ON s.id = m.from_session WHERE ${between.replace(/(created_at|to_kind|from_session|to_target)/g, 'm.$1')} ORDER BY m.id DESC LIMIT 1`, ...pair);
      // The newest messages with their direction, so the canvas sends one dot along the line for each new one
      const recent = db
        .all(`SELECT id, from_session, created_at FROM messages WHERE ${between} ORDER BY id DESC LIMIT ?`, ...pair, RECENT_PER_LINE)
        .reverse()
        .map((m) => ({ id: m.id, fromSource: m.from_session === c.from_session, at: m.created_at }));
      return {
        id: c.id,
        source: c.from_session,
        target: c.answered_by,
        sourceSide: c.from_side || 'r',
        targetSide: c.to_side || 'l',
        since: c.answered_at,
        messages: traffic.n,
        last: last && { from: last.handle, kind: last.kind, at: last.created_at, text: oneLine(last.subject || last.body, 140) },
        recent,
      };
    });
    // Connected windows beyond the chats shown for their agent: open, but no prompt or tool call yet. They are the
    // servers no shown chat runs on (a Codex app-server runs one per thread, so it is counted, not matched by host)
    const shown = new Map();
    for (const n of nodes) shown.set(n.agent, (shown.get(n.agent) || 0) + 1);
    const used = new Set(chats.map((s) => keyOf(serverFor(s))));
    const byAgent = new Map();
    for (const v of settled.filter((v) => !off.has(v.agent))) byAgent.set(v.agent, [...(byAgent.get(v.agent) || []), v]);
    const starting = [...byAgent].flatMap(([agent, list]) =>
      list
        .filter((v) => !used.has(keyOf(v)))
        .slice(0, Math.max(0, list.length - (shown.get(agent) || 0)))
        .map((v) => ({ agent, client: v.client, surface: v.surface ?? null, host: v.host_key ?? null, since: v.started_at })),
    );
    return { nodes, lines, paused, starting, asks: pendingAsks(db), off: [...off].sort(), signature: servers.map((v) => `${v.pid}:${v.start}`).sort().join(','), isConnected };
  };

  // The Claims badge counts what the Claims tab lists: claims of windows that are still connected
  const counts = (isConnected) => ({
    ...db.get(
      `SELECT
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM handoffs) AS handoffs,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM memories) AS notes,
      (SELECT COUNT(*) FROM claims) AS claims,
      (SELECT COUNT(*) FROM calls WHERE status != 'connected') AS calls,
      (SELECT COUNT(*) FROM sessions) AS sessions`,
    ),
    liveClaims: liveClaims(db, null, isConnected).length,
  });

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
    info: () => ({ platform: PLATFORM, dataDir: DATA_DIR, backupDir: BACKUP_DIR }),

    snapshot: () => {
      const { nodes, lines, paused, starting, asks, off, isConnected } = graph();
      return {
        graph: { nodes, lines, paused, starting, asks },
        settings: { disabledAgents: off },
        counts: counts(isConnected),
        db: { path: DB_PATH, size: fileSize(DB_PATH) + fileSize(`${DB_PATH}-wal`) },
      };
    },

    // Changes when a window opens or closes, or a line opens, pauses or ends
    presence: () => {
      const { nodes, lines, paused, signature } = graph();
      return `${signature}|${nodes.map((n) => n.id).join(',')}|${lines.map((l) => l.id).join(',')}|${paused.map((l) => l.id).join(',')}`;
    },

    // A chat's own settings (the ⚙ on its box): Automatic sends over its lines right away, Ask first waits for the user
    sendMode: ({ id, mode }) => ({ ok: setSendMode(db, id, mode) }),

    // A chat's role on its lines: admin hands out tasks, worker does them, none is a peer
    role: ({ id, role }) => ({ ok: setRole(db, id, role) }),

    // A Claude chat allowed (after the user read what it means) to start a turn when a message reaches it idle
    wake: ({ id, on }) => ({ ok: setWake(db, id, !!on) }),

    // A provider turned off in Neurons: its chats leave the graph and get no Neurons until it is turned back on
    agentOff: ({ agent, off }) => setAgentOff(db, agent, !!off),

    // Ask first: the user's answer from the editor notification or the dashboard card; the first window to claim an ask notifies
    decideAsk: ({ id, allow, by }) => decideAsk(db, Number(id), !!allow, by === 'notification' ? 'notification' : 'dashboard'),
    claimAskNotice: ({ id, by }) => ({ claimed: claimAskNotice(db, Number(id), by) }),

    // The user connects two chats by drawing a line between them
    link: ({ from, to, fromSide, toSide }) => {
      const line = openLine(db, from, to, 'dashboard', { fromSide, toSide });
      return { id: line.id };
    },

    // Ends a line
    hangup: ({ line }) => {
      const l = lineById(db, line);
      if (!l) throw new Error(`No line #${line}.`);
      return { ended: hangUp(db, l, 'the dashboard') };
    },

    // Pairs that have a message matching the search (text, an agent on either side, a kind), newest first
    conversations: ({ q, agent, kind, limit = DASHBOARD.pageSize } = {}) => {
      const groups = db.all(
        `SELECT ${PAIR} AS pair, COUNT(*) AS count, MAX(m.id) AS last ${MESSAGE_FROM}
         GROUP BY pair
         HAVING MAX((:kind = '' OR m.kind = :kind)
           AND (:agent = '' OR s.agent = :agent OR ${PARTY_AGENT} = :agent)
           AND CASE WHEN :q = '' THEN 1 ELSE instr(neurons_fold(COALESCE(m.subject, '') || char(10) || m.body), :q) > 0 END)
         ORDER BY last DESC LIMIT :limit`,
        { q: String(q || '').toLowerCase(), agent: agent || '', kind: kind || '', limit: limit + 1 },
      );
      const items = groups.slice(0, limit).map((g) => {
        const m = db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, g.last);
        const parties = [{ handle: m.from_handle, agent: m.from_agent }, toParty(m)].sort((x, y) => String(partyName(x)).localeCompare(String(partyName(y))));
        return { key: g.pair, parties, count: g.count, at: m.created_at, last: message(m) };
      });
      return { items, more: groups.length > limit };
    },

    conversation: ({ key }) => db.all(`${MESSAGE_SELECT} WHERE ${PAIR} = ? ORDER BY m.id DESC LIMIT ?`, key, CONVERSATION_MAX).reverse().map(message),

    // Newest first; Load more asks for a longer page
    handoffs: ({ limit = DASHBOARD.pageSize } = {}) => {
      const rows = db.all(
        `SELECT h.id, h.repo, h.title, h.auto, h.to_kind, h.to_target, h.created_at, s.handle, s.agent, t.handle AS to_handle
         FROM handoffs h JOIN sessions s ON s.id = h.author_session LEFT JOIN sessions t ON h.to_kind = 'session' AND t.id = h.to_target
         ORDER BY h.created_at DESC LIMIT ?`,
        limit + 1,
      );
      const to = (h) => (h.to_kind === 'any' ? 'any' : h.to_kind === 'session' ? h.to_handle || 'a closed session' : h.to_target);
      return {
        items: rows.slice(0, limit).map((h) => ({ id: h.id, repo: h.repo, title: h.title, auto: !!h.auto, to: h.to_kind ? to(h) : null, at: h.created_at, author: { handle: h.handle, agent: h.agent } })),
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
        .map((r) => ({ id: r.id, title: r.title, repo: r.repo, status: r.status, verdict: r.verdict, findings: parseJson(r.findings, []).length, at: r.created_at, requester: { handle: r.requester, agent: r.requester_agent }, reviewer: r.reviewer })),

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

    delete: ({ what, id, key }) =>
      db.tx(() => {
        if (what === 'message') return { messages: deleteMessages(db, subtree(db, [id])) };
        if (what === 'conversation') {
          // Only this conversation's messages; replies to them that belong to another conversation stay, unlinked
          const list = ids(db.all(`SELECT m.id ${MESSAGE_FROM} WHERE ${PAIR} = ?`, key).map((r) => r.id));
          db.run('UPDATE messages SET reply_to = NULL WHERE reply_to IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))', list, list);
          return { messages: Number(db.run('DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))', list).changes) };
        }
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
        reviews: () => ({ messages: deleteMessages(db, subtree(db, linkedAll(db, 'review'))), reviews: Number(db.run('DELETE FROM reviews').changes) }),
        claims: () => ({ claims: Number(db.run('DELETE FROM claims').changes) }),
        notes: () => ({ embeddings: Number(db.run("DELETE FROM embeddings WHERE ref LIKE '#%'").changes), notes: Number(db.run('DELETE FROM memories').changes) }),
        // The semantic search cache rebuilds itself; it goes only with everything else
        embeddings: () => ({ embeddings: Number(db.run('DELETE FROM embeddings').changes) }),
        // Ended lines; the ones that are up stay
        calls: () => ({ calls: Number(db.run("DELETE FROM calls WHERE status != 'connected'").changes) }),
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
          const { isConnected } = graph();
          const gone = db.all('SELECT * FROM sessions').filter((s) => !isConnected(s)).map((s) => s.id);
          if (gone.length) out.sessions = Number(db.run('DELETE FROM sessions WHERE id IN (SELECT value FROM json_each(?))', ids(gone)).changes);
        }
        return out;
      });
      return { backup: file, deleted };
    },
  };
  return ops;
}
