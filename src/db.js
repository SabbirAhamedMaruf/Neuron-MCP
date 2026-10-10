import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from '../configuration/settings.js';

const MIGRATIONS = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    agent TEXT NOT NULL,
    client TEXT,
    model TEXT,
    native_id TEXT,
    transcript_path TEXT,
    cwd TEXT,
    repo TEXT,
    label TEXT,
    task TEXT,
    server_pid INTEGER,
    server_start INTEGER,
    hook_pids TEXT,
    hook_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE UNIQUE INDEX sessions_native ON sessions(agent, native_id) WHERE native_id IS NOT NULL;
  CREATE INDEX sessions_seen ON sessions(last_seen);

  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    owner_agent TEXT NOT NULL,
    author_session TEXT REFERENCES sessions(id),
    scope TEXT NOT NULL CHECK (scope IN ('global', 'repo')),
    repo TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('self', 'peer', 'direct-read')),
    evidence TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX memories_owner ON memories(owner_agent, status);
  CREATE VIRTUAL TABLE memories_fts USING fts5(
    title, body, tags, content='memories', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
    INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    from_session TEXT NOT NULL REFERENCES sessions(id),
    to_kind TEXT NOT NULL CHECK (to_kind IN ('session', 'agent', 'any')),
    to_target TEXT,
    kind TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    repo TEXT,
    refs TEXT,
    reply_to INTEGER REFERENCES messages(id),
    link_type TEXT,
    link_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_to ON messages(to_kind, to_target, created_at);
  CREATE INDEX messages_reply ON messages(reply_to);

  CREATE TABLE message_reads (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, session_id)
  );

  CREATE TABLE handoffs (
    id INTEGER PRIMARY KEY,
    author_session TEXT NOT NULL REFERENCES sessions(id),
    repo TEXT,
    title TEXT NOT NULL,
    goal TEXT,
    data TEXT NOT NULL,
    to_kind TEXT,
    to_target TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX handoffs_repo ON handoffs(repo, created_at);

  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    requester_session TEXT NOT NULL REFERENCES sessions(id),
    to_kind TEXT NOT NULL,
    to_target TEXT,
    repo TEXT,
    title TEXT NOT NULL,
    focus TEXT,
    base TEXT,
    head TEXT,
    diff TEXT,
    files TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    reviewer_session TEXT REFERENCES sessions(id),
    verdict TEXT,
    summary TEXT,
    findings TEXT,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    completed_at INTEGER
  );
  CREATE INDEX reviews_status ON reviews(status, created_at);

  CREATE TABLE claims (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    released_at INTEGER
  );
  CREATE INDEX claims_repo ON claims(repo, released_at, expires_at);
  `,
  `
  CREATE TABLE servers (
    pid INTEGER NOT NULL,
    start INTEGER NOT NULL,
    agent TEXT NOT NULL,
    client TEXT,
    host_key TEXT,
    started_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (pid, start)
  );
  CREATE INDEX servers_agent ON servers(agent);
  `,
  `
  ALTER TABLE sessions ADD COLUMN start_head TEXT;
  ALTER TABLE handoffs ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX handoffs_auto ON handoffs(author_session) WHERE auto = 1;

  CREATE TABLE session_files (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    edited_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, repo, path)
  );

  CREATE TABLE embeddings (
    agent TEXT NOT NULL,
    ref TEXT NOT NULL,
    model TEXT NOT NULL,
    hash TEXT NOT NULL,
    vec BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent, model, ref)
  );
  `,
  `
  ALTER TABLE servers ADD COLUMN cwd TEXT;
  `,
  `
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY,
    from_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    to_kind TEXT NOT NULL CHECK (to_kind IN ('agent', 'session')),
    to_target TEXT NOT NULL,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'connected', 'ended', 'missed', 'declined', 'cancelled')),
    answered_by TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    answered_how TEXT,
    ended_by TEXT,
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX calls_open ON calls(status) WHERE status IN ('ringing', 'connected');
  ALTER TABLE sessions ADD COLUMN auto_answer INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN listening_at INTEGER;
  `,
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  ALTER TABLE sessions ADD COLUMN listen_prompted_at INTEGER;
  ALTER TABLE sessions ADD COLUMN listened_at INTEGER;
  `,
  `
  ALTER TABLE servers ADD COLUMN popups INTEGER NOT NULL DEFAULT 0;
  `,
  // Databases that ran migration 3 before session_files was added to it never got the table
  `
  CREATE TABLE IF NOT EXISTS session_files (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    edited_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, repo, path)
  );
  `,
  // Set while the agent is in a turn (prompt → stop), so a message for an idle agent can start one
  `
  ALTER TABLE sessions ADD COLUMN busy_at INTEGER;
  `,
  // When the relay queued a message into Codex, so no process (after a leader change) queues it twice
  `
  ALTER TABLE messages ADD COLUMN relayed_at INTEGER;
  `,
  // Plain indexes for the every-second call queries and the heartbeat (calls_open, being partial, serves almost none)
  `
  CREATE INDEX IF NOT EXISTS calls_status ON calls(status);
  CREATE INDEX IF NOT EXISTS sessions_server ON sessions(server_pid, server_start);
  `,
  // Leftovers of the listening design that nothing reads any more (the user asked for the clean-up, 2026-10-08); SQLite
  // has no DROP COLUMN IF EXISTS, and a migration that throws would leave every agent without Neurons
  (raw) => {
    const has = (table, column) => raw.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
    raw.exec('DROP TABLE IF EXISTS settings; DROP INDEX IF EXISTS calls_open');
    for (const [table, column] of [['sessions', 'listening_at'], ['sessions', 'listen_prompted_at'], ['sessions', 'listened_at'], ['servers', 'popups']]) {
      if (has(table, column)) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  },
  // Calls no longer ring (the user draws lines in the dashboard): calls left ringing end as cancelled, their messages
  // undelivered. servers.surface: where the agent runs (its editor panel or a terminal), for the dashboard's canvas
  (raw) => {
    const t = Date.now();
    if (!raw.prepare("SELECT 1 FROM pragma_table_info('servers') WHERE name = 'surface'").get()) raw.exec('ALTER TABLE servers ADD COLUMN surface TEXT');
    raw.prepare("UPDATE messages SET status = 'cancelled' WHERE link_type = 'call' AND status = 'open' AND link_id IN (SELECT id FROM calls WHERE status = 'ringing')").run();
    raw.prepare("UPDATE calls SET status = 'cancelled', ended_by = 'calls no longer ring', ended_at = ? WHERE status = 'ringing'").run(t);
  },
  // Since when a line has waited for a closed chat to come back (a reload or a shut editor pauses a line, not ends it)
  (raw) => {
    if (!raw.prepare("SELECT 1 FROM pragma_table_info('calls') WHERE name = 'paused_at'").get()) raw.exec('ALTER TABLE calls ADD COLUMN paused_at INTEGER');
  },
  // The user's choices in the dashboard: providers turned off in Neurons (settings) and each chat's sending mode, plus
  // the messages of a chat set to Ask first, held until the user allows them
  (raw) => {
    if (!raw.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'send_mode'").get()) raw.exec('ALTER TABLE sessions ADD COLUMN send_mode TEXT');
    raw.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS asks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        message_ids TEXT,
        noticed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS asks_status ON asks(status);
    `);
  },
  // A Claude chat the user allowed to be woken by a message that reaches it while idle (off until they accept)
  (raw) => {
    if (!raw.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'wake'").get()) raw.exec('ALTER TABLE sessions ADD COLUMN wake INTEGER');
  },
  // The side of each box a line was drawn from and to (the canvas keeps it), and each chat's role (admin or worker)
  (raw) => {
    const has = (table, column) => raw.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
    if (!has('calls', 'from_side')) raw.exec('ALTER TABLE calls ADD COLUMN from_side TEXT');
    if (!has('calls', 'to_side')) raw.exec('ALTER TABLE calls ADD COLUMN to_side TEXT');
    if (!has('sessions', 'role')) raw.exec('ALTER TABLE sessions ADD COLUMN role TEXT');
  },
];

// node:sqlite rejects undefined, so absent optional values bind as NULL
const bindable = (params) => params.map((p) => (p === undefined ? null : p));

class Db {
  constructor(file = DB_PATH) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.cache = new Map();
    this.migrate();
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all(sql, ...params) {
    return this.stmt(sql).all(...bindable(params));
  }

  get(sql, ...params) {
    return this.stmt(sql).get(...bindable(params));
  }

  run(sql, ...params) {
    return this.stmt(sql).run(...bindable(params));
  }

  tx(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  migrate() {
    const version = () => this.raw.prepare('PRAGMA user_version').get().user_version;
    if (version() >= MIGRATIONS.length) return;
    // Two agents can start at the same moment; IMMEDIATE serialises them and the re-check skips done work
    this.tx(() => {
      for (let v = version(); v < MIGRATIONS.length; v++) {
        const step = MIGRATIONS[v];
        if (typeof step === 'function') step(this.raw);
        else this.raw.exec(step);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      }
    });
  }

  close() {
    try {
      this.raw.close();
    } catch {}
  }
}

let shared;
export function openDb() {
  if (!shared) shared = new Db();
  return shared;
}
