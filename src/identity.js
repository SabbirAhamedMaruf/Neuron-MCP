import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unreachable } from '../configuration/prompts.js';
import { HOOK_LINK_MAX_AGE_MS, PLATFORM, SERVER_STALE_MS } from '../configuration/settings.js';
import { NeuronsError } from './guard.js';
import { detectRepo, headOf, json, now, parseJson } from './util.js';

const KNOWN_AGENTS = [
  [/claude/i, 'claude'],
  [/codex/i, 'codex'],
  [/gemini/i, 'gemini'],
  [/opencode/i, 'opencode'],
  [/lm ?studio/i, 'lmstudio'],
  [/ollama/i, 'ollama'],
  [/cursor/i, 'cursor'],
  [/copilot/i, 'copilot'],
  [/windsurf|codeium/i, 'windsurf'],
  [/goose/i, 'goose'],
  [/crush/i, 'crush'],
  [/qwen/i, 'qwen'],
  [/cline/i, 'cline'],
  [/zed/i, 'zed'],
];

export function normalizeAgent(name) {
  if (!name) return null;
  for (const [re, id] of KNOWN_AGENTS) if (re.test(name)) return id;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return slug || null;
}

/*
 * Process facts, per OS. Each process is keyed "pid:start", where the start
 * time tells a live process apart from a recycled pid.
 *   linux   /proc/<pid>/stat: parent, start time and name, no process spawned
 *   darwin  one `ps -A` call lists every process, cached briefly
 *   win32   Node only knows its own parent and whether a pid exists, so the
 *           start is 0; stale heartbeats and cwd matching cover the rest
 */
let psCache = { at: 0, table: null };

function psTable(fresh = false) {
  if (!fresh && psCache.table && Date.now() - psCache.at < 2000) return psCache.table;
  const table = new Map();
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
      if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), start: Date.parse(m[3]) || 0, comm: path.basename(m[4].trim()) });
    }
  } catch {}
  psCache = { at: Date.now(), table };
  return table;
}

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function procInfo(pid) {
  if (PLATFORM === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      return { pid, ppid: Number(fields[1]), start: Number(fields[19]), comm };
    } catch {
      return null;
    }
  }
  if (PLATFORM === 'win32') {
    if (pid === process.pid) return { pid, ppid: process.ppid, start: 0, comm: 'node' };
    return exists(pid) ? { pid, ppid: 0, start: 0, comm: '' } : null;
  }
  // A process newer than the cached table is looked up again; a pid that does not exist costs no ps call
  return psTable().get(pid) || (exists(pid) ? psTable(true).get(pid) : null) || null;
}

const procKey = (info) => `${info.pid}:${info.start}`;

// Every ancestor of a process, nearest first, as pid:start keys
export function ancestorKeys(pid = process.pid, depth = 10) {
  const keys = [];
  let info = procInfo(pid);
  for (let i = 0; info && info.ppid > 1 && i < depth; i++) {
    const parent = procInfo(info.ppid);
    if (!parent) break;
    keys.push(procKey(parent));
    info = parent;
  }
  return keys;
}

// Launchers that sit between an agent and this server; the agent is the first ancestor that is not one of these
const WRAPPERS = new Set(['npm', 'npx', 'pnpm', 'bunx', 'uv', 'uvx', 'sh', 'bash', 'dash', 'zsh', 'env', 'timeout', 'nice']);

function hostKeys(pid = process.pid) {
  const keys = [];
  let info = procInfo(pid);
  for (let i = 0; info && info.ppid > 1 && i < 4; i++) {
    const parent = procInfo(info.ppid);
    if (!parent) break;
    keys.push(procKey(parent));
    if (!WRAPPERS.has(parent.comm)) break;
    info = parent;
  }
  return keys;
}

function isAlive(pid, start) {
  if (!pid) return false;
  const info = procInfo(pid);
  return !!info && (!start || info.start === start);
}

const SESSION_COLUMNS = [
  'agent',
  'client',
  'model',
  'native_id',
  'transcript_path',
  'cwd',
  'repo',
  'server_pid',
  'server_start',
  'hook_pids',
  'hook_seen_at',
  'start_head',
];

function createSession(db, fields) {
  const t = now();
  for (let i = 0; i < 50; i++) {
    const id = randomUUID();
    const handle = `${fields.agent}-${id.replace(/-/g, '').slice(0, 7)}`;
    if (db.get('SELECT 1 FROM sessions WHERE handle = ?', handle)) continue;
    db.run(
      `INSERT INTO sessions (id, handle, ${SESSION_COLUMNS.join(', ')}, created_at, last_seen)
       VALUES (?, ?, ${SESSION_COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      id,
      handle,
      ...SESSION_COLUMNS.map((c) => fields[c] ?? null),
      t,
      t,
    );
    return db.get('SELECT * FROM sessions WHERE id = ?', id);
  }
  throw new NeuronsError('Could not allocate a unique session handle.');
}

// Called by the agent's prompt hook: one Neurons session per native session, so a resumed chat keeps its handle
export function upsertNativeSession(db, { agent, nativeId, transcriptPath, cwd, model, hookPids }) {
  const t = now();
  const repo = cwd ? detectRepo(cwd) : null;
  // Where the session started, so the automatic handoff can list the commits made since; git runs before the write
  // lock is taken, and only once per session in a repo
  const known = db.get('SELECT start_head FROM sessions WHERE agent = ? AND native_id = ?', agent, nativeId);
  const head = repo && !known?.start_head ? headOf(cwd) : null;
  return db.tx(() => {
    const existing = db.get('SELECT * FROM sessions WHERE agent = ? AND native_id = ?', agent, nativeId);
    if (!existing) {
      return createSession(db, {
        agent,
        native_id: nativeId,
        transcript_path: transcriptPath,
        cwd,
        repo,
        model,
        hook_pids: json(hookPids),
        hook_seen_at: t,
        start_head: head,
      });
    }
    // The repo follows the cwd, including out of a repo; a cwd-less hook keeps what was known
    db.run(
      `UPDATE sessions SET transcript_path = COALESCE(?, transcript_path), cwd = COALESCE(?, cwd),
         repo = CASE WHEN ? IS NULL THEN repo ELSE ? END, model = COALESCE(?, model), hook_pids = ?, hook_seen_at = ?,
         start_head = COALESCE(start_head, ?), last_seen = ?, ended_at = NULL
       WHERE id = ?`,
      transcriptPath,
      cwd,
      cwd,
      repo,
      model,
      json(hookPids),
      t,
      head,
      t,
      existing.id,
    );
    return db.get('SELECT * FROM sessions WHERE id = ?', existing.id);
  });
}

// Where the agent runs, for the dashboard: 'editor' (a VS Code panel), 'terminal', 'app' or null when unknown.
// Claude Code says so in CLAUDE_CODE_ENTRYPOINT; Codex's editor panel and desktop app run it under `codex app-server`.
function surfaceOf(agent) {
  if (agent === 'claude') {
    const entry = process.env.CLAUDE_CODE_ENTRYPOINT || '';
    return /vscode|jetbrains|ide/i.test(entry) ? 'editor' : entry === 'cli' ? 'terminal' : entry ? 'app' : null;
  }
  if (agent === 'codex') {
    let args = '';
    try {
      if (PLATFORM === 'linux') args = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      else if (PLATFORM === 'darwin') args = execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 3000 });
    } catch {}
    return args ? (/\bapp-server\b/.test(args) ? 'editor' : 'terminal') : null;
  }
  return agent === 'gemini' || agent === 'opencode' ? 'terminal' : null;
}

/*
 * Which session is calling?
 *
 *   agent process (claude / codex app-server)
 *     ├── neurons MCP server  (this process; hostKeys = the agent)
 *     └── prompt hook         (records native session id + its ancestor keys)
 *
 * The newest hook-linked session whose ancestors include our host wins. A
 * Codex app-server hosts several threads, so "newest prompt" picks the one
 * that is talking right now. Without hooks we fall back to one session per
 * server process.
 */
export class Identity {
  constructor(db) {
    this.db = db;
    this.agent = normalizeAgent(process.env.NEURONS_AGENT) || null;
    this.client = null;
    const self = procInfo(process.pid);
    this.serverPid = process.pid;
    this.serverStart = self?.start ?? 0;
    this.hostKeys = hostKeys(process.pid);
    this.cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    this.processSessionId = null;
    this.registered = false;
  }

  setClient(info) {
    this.client = info?.name ? `${info.name}${info.version ? ' ' + info.version : ''}` : null;
    if (!this.agent) this.agent = normalizeAgent(info?.name) || 'unknown';
  }

  // The newest hook-linked native session running under this window's agent process
  linkedSession(t) {
    if (!this.hostKeys.length) return null;
    const marks = this.hostKeys.map(() => '?').join(', ');
    return this.db.get(
      `SELECT s.* FROM sessions s
       WHERE s.agent = ? AND s.native_id IS NOT NULL AND s.hook_seen_at > ?
         AND EXISTS (SELECT 1 FROM json_each(s.hook_pids) j WHERE j.value IN (${marks}))
       ORDER BY s.hook_seen_at DESC LIMIT 1`,
      this.agent || 'unknown',
      t - HOOK_LINK_MAX_AGE_MS,
      ...this.hostKeys,
    );
  }

  // Where process ancestry is unknown (Windows), the native session the hook tied to this server directly
  directSession(t) {
    return this.db.get(
      `SELECT * FROM sessions WHERE agent = ? AND native_id IS NOT NULL AND server_pid = ? AND server_start = ? AND hook_seen_at > ?
       ORDER BY hook_seen_at DESC LIMIT 1`,
      this.agent || 'unknown',
      this.serverPid,
      this.serverStart,
      t - HOOK_LINK_MAX_AGE_MS,
    );
  }

  // Codex runs one Neurons server per thread under the same app-server; background work runs in only one of them, the lowest pid
  leadsHost() {
    if (!this.hostKeys.length) return true;
    const first = this.db.get('SELECT MIN(pid) AS pid FROM servers WHERE agent = ? AND host_key = ? AND last_seen > ?', this.agent || 'unknown', this.hostKeys.at(-1), now() - SERVER_STALE_MS);
    return !first?.pid || first.pid === this.serverPid;
  }

  // The session current() would answer for, without writing anything; for background checks that run every second
  peek() {
    const t = now();
    return this.linkedSession(t) || this.directSession(t) || (this.processSessionId && this.db.get('SELECT * FROM sessions WHERE id = ?', this.processSessionId)) || null;
  }

  // Every open hook-linked session under this window's agent process, the one peek() names first (a Codex app-server hosts several threads)
  hostSessions() {
    const first = this.peek();
    if (!this.hostKeys.length) return first ? [first] : [];
    const rows = this.db.all(
      `SELECT s.* FROM sessions s
       WHERE s.agent = ? AND s.native_id IS NOT NULL AND s.ended_at IS NULL AND s.hook_seen_at > ?
         AND EXISTS (SELECT 1 FROM json_each(s.hook_pids) j WHERE j.value IN (${this.hostKeys.map(() => '?').join(', ')}))
       ORDER BY s.hook_seen_at DESC`,
      this.agent || 'unknown',
      now() - HOOK_LINK_MAX_AGE_MS,
      ...this.hostKeys,
    );
    return first ? [first, ...rows.filter((s) => s.id !== first.id)] : rows;
  }

  current() {
    const db = this.db;
    const agent = this.agent || 'unknown';
    const t = now();
    const linked = this.linkedSession(t);
    if (linked) {
      db.run(
        'UPDATE sessions SET server_pid = ?, server_start = ?, client = COALESCE(?, client), last_seen = ?, ended_at = NULL WHERE id = ?',
        this.serverPid,
        this.serverStart,
        this.client,
        t,
        linked.id,
      );
      // A fallback session made before the hook linked us is superseded by the native one
      if (this.processSessionId && this.processSessionId !== linked.id) {
        db.run('UPDATE sessions SET ended_at = ? WHERE id = ?', t, this.processSessionId);
        this.processSessionId = null;
      }
      return db.get('SELECT * FROM sessions WHERE id = ?', linked.id);
    }
    const direct = this.directSession(t);
    if (direct) {
      db.run('UPDATE sessions SET client = COALESCE(?, client), last_seen = ?, ended_at = NULL WHERE id = ?', this.client, t, direct.id);
      if (this.processSessionId && this.processSessionId !== direct.id) {
        db.run('UPDATE sessions SET ended_at = ? WHERE id = ?', t, this.processSessionId);
        this.processSessionId = null;
      }
      return db.get('SELECT * FROM sessions WHERE id = ?', direct.id);
    }
    if (this.processSessionId) {
      const row = db.get('SELECT * FROM sessions WHERE id = ?', this.processSessionId);
      if (row) {
        db.run('UPDATE sessions SET last_seen = ?, ended_at = NULL WHERE id = ?', t, row.id);
        return { ...row, last_seen: t };
      }
    }
    const row = createSession(db, {
      agent,
      client: this.client,
      cwd: this.cwd,
      repo: detectRepo(this.cwd),
      server_pid: this.serverPid,
      server_start: this.serverStart,
    });
    this.processSessionId = row.id;
    return row;
  }

  // Presence: this agent window is connected and can be reached, even before it calls a tool
  registerServer() {
    const t = now();
    this.registered = true;
    this.surface ??= surfaceOf(this.agent);
    this.db.run(
      'INSERT OR REPLACE INTO servers (pid, start, agent, client, host_key, cwd, surface, started_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      this.serverPid,
      this.serverStart,
      this.agent || 'unknown',
      this.client,
      this.hostKeys.at(-1) ?? null,
      this.cwd,
      this.surface,
      t,
      t,
    );
  }


  // After the machine sleeps, other processes prune this window's row as stale; it comes back here
  heartbeat() {
    const t = now();
    const res = this.db.run('UPDATE servers SET last_seen = ? WHERE pid = ? AND start = ?', t, this.serverPid, this.serverStart);
    if (!res.changes && this.registered) this.registerServer();
    this.db.run('UPDATE sessions SET last_seen = ? WHERE server_pid = ? AND server_start = ? AND ended_at IS NULL', t, this.serverPid, this.serverStart);
  }

  shutdown() {
    const t = now();
    this.db.run('DELETE FROM servers WHERE pid = ? AND start = ?', this.serverPid, this.serverStart);
    const mine = this.db.all('SELECT id FROM sessions WHERE server_pid = ? AND server_start = ?', this.serverPid, this.serverStart);
    for (const { id } of mine) {
      this.db.run('UPDATE sessions SET ended_at = ? WHERE id = ?', t, id);
      this.db.run('UPDATE claims SET released_at = ? WHERE session_id = ? AND released_at IS NULL', t, id);
    }
  }
}

// Neurons servers whose process is still alive and heartbeating, i.e. agent windows that are connected right now; dead rows are pruned
export function liveServers(db) {
  const live = [];
  const fresh = now() - SERVER_STALE_MS;
  for (const s of db.all('SELECT * FROM servers')) {
    // A known start time pins the process, so a heartbeat late after the machine slept does not end its lines; only
    // where it is unknown (Windows) does a silent row count as gone
    if ((s.start || s.last_seen > fresh) && isAlive(s.pid, s.start)) live.push(s);
    else db.run('DELETE FROM servers WHERE pid = ? AND start = ?', s.pid, s.start);
  }
  return live;
}

// Predicate for "is this session's agent window connected?", built once per list
export function connectionCheck(db, servers = liveServers(db)) {
  const byProcess = new Set(servers.map((s) => `${s.pid}:${s.start}`));
  const byHost = new Set(servers.map((s) => `${s.agent}|${s.host_key}`));
  return (session) => {
    if (session.ended_at) return false;
    if (session.server_pid && byProcess.has(`${session.server_pid}:${session.server_start}`)) return true;
    return parseJson(session.hook_pids, []).some((key) => byHost.has(`${session.agent}|${key}`));
  };
}

// The hook knows the native session; tie it to the one live server running under the same agent process,
// or, where ancestry is unknown (Windows), the one server of that agent started in the session's folder
export function linkSessionToServer(db, session, hookPids) {
  const mine = liveServers(db).filter((s) => s.agent === session.agent);
  let matches = mine.filter((s) => hookPids.includes(s.host_key));
  if (!matches.length && session.cwd) matches = mine.filter((s) => s.cwd && path.resolve(s.cwd) === path.resolve(session.cwd));
  if (matches.length === 1) {
    db.run('UPDATE sessions SET server_pid = ?, server_start = ? WHERE id = ?', matches[0].pid, matches[0].start, session.id);
  }
}

// Live servers a message to this target would reach, excluding the sender's own
function reachableServers(db, target, selfPid = process.pid) {
  const servers = liveServers(db).filter((s) => s.pid !== selfPid);
  if (target.kind === 'any') return servers;
  if (target.kind === 'agent') return servers.filter((s) => s.agent === target.target);
  const s = target.session;
  const keys = parseJson(s.hook_pids, []);
  return servers.filter((v) => v.agent === s.agent && ((v.pid === s.server_pid && v.start === s.server_start) || keys.includes(v.host_key)));
}

export function assertReachable(db, target) {
  const servers = reachableServers(db, target);
  if (!servers.length) throw new NeuronsError(unreachable(target));
  return servers;
}

const HANDLE_LIKE = /^[a-z0-9-]+-[0-9a-f]{3,7}$/i;

// "codex" → every codex session, "codex-1a2b3c4" → one session, "any" → whoever answers first, "all" → each other agent
// Only `send` fans out to "all" or asks "local"; for handoffs and reviews "all" means "any", and "local" is refused
export function resolveTarget(db, to, { messages = false } = {}) {
  const t = String(to || '').trim();
  if (!t) throw new NeuronsError('`to` is required: an agent name (claude, codex, gemini, ...), a session handle, "any" or "all".');
  if (/^(any|\*)$/i.test(t) || (!messages && /^(all|everyone)$/i.test(t))) return { kind: 'any', target: null, label: 'any agent' };
  if (/^(all|everyone)$/i.test(t)) return { kind: 'all', target: null, label: 'every other agent' };
  if (/^local$/i.test(t)) {
    if (!messages) throw new NeuronsError('The local model only answers questions sent with `send`.');
    return { kind: 'local', target: null, label: 'the local model' };
  }
  const exact = db.get('SELECT * FROM sessions WHERE handle = ? OR id = ?', t.toLowerCase(), t);
  if (exact) return { kind: 'session', target: exact.id, label: exact.handle, session: exact };
  if (HANDLE_LIKE.test(t)) {
    const rows = db.all('SELECT * FROM sessions WHERE handle LIKE ? LIMIT 3', t.toLowerCase() + '%');
    if (rows.length === 1) return { kind: 'session', target: rows[0].id, label: rows[0].handle, session: rows[0] };
    if (rows.length > 1) throw new NeuronsError(`"${t}" matches several sessions (${rows.map((r) => r.handle).join(', ')}).`);
    throw new NeuronsError(`No session with handle "${t}". Use \`discover\` to see who is online, or send to an agent name.`);
  }
  const agent = normalizeAgent(t);
  if (agent && /^[a-z0-9-]{2,24}$/.test(agent)) return { kind: 'agent', target: agent, label: `${agent} (any session)` };
  throw new NeuronsError(`Unknown target "${t}".`);
}

export function targetLabel(db, kind, target) {
  if (kind === 'any') return 'any agent';
  if (kind === 'agent') return `${target} (any session)`;
  const s = db.get('SELECT handle FROM sessions WHERE id = ?', target);
  return s ? s.handle : 'unknown session';
}
