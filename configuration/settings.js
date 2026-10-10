import os from 'node:os';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const env = process.env;
const HOME = os.homedir();
const XDG_DATA = env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const XDG_CONFIG = env.XDG_CONFIG_HOME || path.join(HOME, '.config');

// linux, darwin or win32; NEURONS_PLATFORM only exists to exercise another OS's process handling in tests
export const PLATFORM = env.NEURONS_PLATFORM || process.platform;

// Each OS's usual place for per-user app data
const APP_DATA = {
  darwin: path.join(HOME, 'Library', 'Application Support'),
  win32: env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
};

// The hooks get a custom data folder as a flag, since each agent starts them with its own environment
const flagDir = (() => {
  const i = process.argv.indexOf('--data-dir');
  return i > 1 ? process.argv[i + 1] : null;
})();

// Neurons' own database lives outside every agent's config dir
export const DATA_DIR = env.NEURONS_DATA_DIR || flagDir || path.join(APP_DATA[process.platform] || XDG_DATA, 'neurons-mcp');
export const DB_PATH = path.join(DATA_DIR, 'neurons.db');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Each agent's own standard home (the same on every OS); Neurons reads an agent's memory and transcripts only on that agent's behalf
export const HOMES = {
  claude: env.NEURONS_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'),
  codex: env.NEURONS_CODEX_HOME || env.CODEX_HOME || path.join(HOME, '.codex'),
  gemini: env.NEURONS_GEMINI_HOME || path.join(HOME, '.gemini'),
  opencodeConfig: path.join(XDG_CONFIG, 'opencode'),
  opencodeData: path.join(XDG_DATA, 'opencode'),
};

export const LIMITS = {
  title: 300,
  // Handoff summaries and notes
  body: 20000,
  // Questions and replies between agents; short messages keep both sides' token use down
  message: 8000,
  diff: 300000,
  // A repo name passed by hand
  repoName: 200,
  fileBytes: 512 * 1024,
  outputChars: 20000,
  // send and inbox wait_seconds: how long an agent may block for an answer (Codex's tool_timeout_sec must be above it)
  waitSeconds: 120,
};

// Default output sizes; an agent can ask for more per call
export const OUTPUT = {
  messageBodyChars: 2000,
  sessionTail: 20,
  sessionMaxChars: 6000,
  entryChars: 1500,
  snippetChars: 160,
};

export const RECALL = {
  // Newest transcripts searched per call; older ones are reachable with session_read
  maxSessions: 60,
  // Stop scanning transcripts after this long and return what was found
  sessionBudgetMs: 8000,
  // Lines of a transcript shown around a hit by recall_get
  windowLines: 16,
  repoContextLines: 12,
  hitsPerSource: 3,
  repoGrepTimeoutMs: 5000,
  repoMaxHits: 15,
};

// Broadcast notes stay in a new session's inbox for this long
export const BROADCAST_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// Session lists only consider sessions seen within this window before checking the connection
export const SESSION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Hook-linked sessions older than this are no longer matched to a running server
export const HOOK_LINK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A line whose chat closed (its window reloaded, the editor shut) waits this long for that same chat to come back, then ends
export const LINE_PAUSE_MS = 24 * 60 * 60 * 1000;

// Ask first: how long a message waits for the user's OK before nothing is sent (under Codex's 60 s tool timeout)
export const ASK_WAIT_MS = 45 * 1000;

// Poll interval for `inbox` and `send` with wait_seconds
export const WAIT_POLL_MS = 1000;

export const HEARTBEAT_MS = 60 * 1000;

// A server that has not heartbeated for this long is gone, even if its pid is alive again (Windows has no process start time to tell)
export const SERVER_STALE_MS = 3 * HEARTBEAT_MS;

// A turn with no prompt, tool or stop for this long is treated as over (a crashed turn never sends Stop)
export const BUSY_STALE_MS = 30 * 60 * 1000;

// The editor dashboard: how much it loads at once, how often it looks for changes, how many backups a bulk delete keeps
export const DASHBOARD = {
  pageSize: 50,
  pollMs: 700,
  presenceMs: 3000,
  backupsKept: 5,
};

// A local model server on this machine (Ollama, LM Studio: OpenAI-compatible API); Neurons refuses any non-loopback URL
export const LOCAL_LLM = {
  url: env.NEURONS_LLM_URL || 'http://127.0.0.1:11434/v1',
  model: env.NEURONS_LLM_MODEL || 'qwen2.5-coder:3b',
  timeoutMs: 90 * 1000,
  maxTokens: 400,
  // Is the server up? Checked with a short request, and the answer is reused for a while
  probeTimeoutMs: 1500,
  probeCacheMs: 30 * 1000,
};

// Embedding search over an agent's own memory files and Neurons notes; falls back to keywords when the local server is down
const EMBED_MODEL = env.NEURONS_EMBED_MODEL || 'nomic-embed-text';
const NOMIC = /nomic/i.test(EMBED_MODEL);
export const SEMANTIC = {
  enabled: env.NEURONS_SEMANTIC !== '0',
  model: EMBED_MODEL,
  // nomic-embed-text is trained with these task prefixes; other models get none
  docPrefix: NOMIC ? 'search_document: ' : '',
  queryPrefix: NOMIC ? 'search_query: ' : '',
  docChars: 1500,
  batch: 16,
  // Indexing new or changed notes stops after this long per recall; the rest is embedded on the next call
  indexBudgetMs: 6000,
  timeoutMs: 20 * 1000,
  minScore: 0.5,
};

// What the edit hook does when a file is claimed by another session: 'warn' tells the agent, 'block' refuses the edit
export const CLAIM_GUARD = env.NEURONS_CLAIM_GUARD === 'block' ? 'block' : 'warn';

// The Stop hook records each session's uncommitted files and new commits as an automatic handoff (git facts only, no chat text)
export const AUTO_HANDOFF = {
  maxFiles: 40,
  maxCommits: 10,
  gitTimeoutMs: 3000,
  // A new session in the same repo is told about other agents' snapshots this recent
  hintMaxAgeMs: 24 * 60 * 60 * 1000,
  hintCount: 2,
};

export const SERVER_NAME = 'neurons';
// One version for the server, the CLI and the editor extension: package.json's
export const VERSION = pkg.version;

// Instruction files an agent reads from the root of the repo it works in
export const REPO_MEMORY_FILES = {
  claude: ['CLAUDE.md', '.claude/CLAUDE.md'],
  codex: ['AGENTS.md', 'AGENTS.override.md'],
  gemini: ['GEMINI.md'],
  opencode: ['AGENTS.md'],
};

export const RECALL_SOURCES = ['neurons', 'memory', 'sessions', 'repo'];

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'finding'];

// Highest first; findings are sorted in this order
export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'];

export const REVIEW_VERDICTS = ['approve', 'request_changes', 'comment'];

// A new memory whose title overlaps an existing one by this much (Jaccard of title words) is flagged as a duplicate
export const DUPLICATE_TITLE_SIMILARITY = 0.6;

// Minimum length of `evidence` when saving something learned from a peer
export const MIN_EVIDENCE_CHARS = 15;
