// Connects coding agents to Neurons by writing their GLOBAL (user-level) MCP config and hooks (a plugin for OpenCode), on Linux, macOS and Windows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPENCODE_PLUGIN_MARK, OPENCODE_PLUGIN_NAME, opencodePlugin } from './opencode-plugin.js';

// send and inbox block for up to 120 s; agents with a hard per-call limit get a little more than that
const TOOL_TIMEOUT_SEC = 180;

export const AGENTS = {
  claude: { name: 'Claude Code', bins: ['claude'] },
  codex: { name: 'Codex', bins: ['codex'] },
  gemini: { name: 'Gemini CLI', bins: ['gemini'] },
  opencode: { name: 'OpenCode', bins: ['opencode'] },
};

// Where each agent keeps its user-level config; the same layout on every OS, under the home folder
function agentPaths() {
  const home = os.homedir();
  const env = process.env;
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const opencodeHome = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  return {
    claude: { home: claudeHome, mcp: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'), hooks: path.join(claudeHome, 'settings.json'), extraBins: [path.join(home, '.local', 'bin'), path.join(claudeHome, 'local')] },
    codex: { home: codexHome, mcp: path.join(codexHome, 'config.toml'), hooks: path.join(codexHome, 'hooks.json'), extraBins: [path.join(home, '.local', 'bin')] },
    gemini: { home: path.join(home, '.gemini'), mcp: path.join(home, '.gemini', 'settings.json'), hooks: path.join(home, '.gemini', 'settings.json'), extraBins: [] },
    opencode: { home: opencodeHome, mcp: path.join(opencodeHome, 'opencode.json'), jsonc: path.join(opencodeHome, 'opencode.jsonc'), plugin: path.join(opencodeHome, 'plugins', OPENCODE_PLUGIN_NAME), extraBins: [path.join(home, '.opencode', 'bin')] },
  };
}

const EXE_SUFFIXES = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

function findOnPath(name, extraDirs) {
  const dirs = [...(process.env.PATH || process.env.Path || '').split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    for (const suffix of EXE_SUFFIXES) {
      const full = path.join(dir, name + suffix);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  return null;
}

// --- file helpers: never clobber a file we cannot parse, keep one backup of the user's version, write atomically

const stripJsonComments = (text) => text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    let commented = false;
    try {
      JSON.parse(stripJsonComments(text));
      commented = true;
    } catch {}
    throw new Error(commented ? `${file} has comments, which rewriting it would lose; edit it by hand.` : `${file} is not valid JSON (${err.message}); fix it or edit it by hand.`);
  }
}

// The original's permissions carry over to the backup and the new file (~/.claude.json is 0600); new files start private.
// A config that is a symlink (dotfiles) is written through, so the link stays and its target changes
function writeFileSafely(link, text) {
  let file = link;
  try {
    file = fs.realpathSync(link);
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  if (fs.existsSync(file)) {
    mode = fs.statSync(file).mode & 0o777;
    fs.copyFileSync(file, `${file}.neurons.bak`);
    fs.chmodSync(`${file}.neurons.bak`, mode);
  }
  const tmp = `${file}.neurons-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows refuses to rename over a file another process holds open
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}

const writeJson = (file, obj) => writeFileSafely(file, JSON.stringify(obj, null, 2) + '\n');

// --- hooks (Claude Code and Codex share the format)

// Paths go in double quotes; Windows paths get forward slashes, which every shell and Node accept
function quote(p) {
  const v = process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
  return `"${v.replace(/(["$`\\])/g, '\\$1')}"`;
}

// A custom data folder rides along as a flag: each agent starts its hooks with its own environment
const hookCommand = (node, script, agent, dataDir) => `${quote(node)} ${quote(script)} hook --agent ${agent}${dataDir ? ` --data-dir ${quote(dataDir)}` : ''}`;

const isNeuronsHook = (h) => typeof h?.command === 'string' && /neurons(\.m?js)?["']?\s+hook\s+--agent\b/.test(h.command);

const HOOK_EVENTS = {
  claude: { SessionStart: '*', UserPromptSubmit: null, PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit', PostToolUse: '*', Stop: null },
  codex: { SessionStart: null, UserPromptSubmit: null, PreToolUse: '^apply_patch$', PostToolUse: '*', Stop: null },
  // Gemini CLI's names for the same moments; its tool matchers are regular expressions, its timeouts milliseconds
  gemini: { SessionStart: '*', BeforeAgent: '*', AfterTool: '.*', AfterAgent: '*' },
  // OpenCode has one plugin file instead of hooks
  opencode: { plugin: null },
};

const hookEntry = (agent, command) => (agent === 'gemini' ? { name: 'neurons', type: 'command', command, timeout: 10000 } : { type: 'command', command, timeout: 10 });

// Our plugin file, recognised by its first line so a user's own plugin of the same name is never touched
function ourPlugin(file) {
  try {
    return fs.readFileSync(file, 'utf8').startsWith(OPENCODE_PLUGIN_MARK);
  } catch {
    return false;
  }
}

// Hook groups are objects; any other list under "hooks" (Gemini's "disabled" names) is the user's and stays as it is
const isHookList = (groups) => Array.isArray(groups) && groups.every((g) => g && typeof g === 'object' && !Array.isArray(g));

function withoutNeuronsHooks(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!isHookList(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isNeuronsHook(h)) })).filter((g) => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function countNeuronsHooks(hooks) {
  return Object.values(hooks || {}).filter((groups) => isHookList(groups) && groups.some((g) => (g.hooks || []).some(isNeuronsHook))).length;
}

// The config with our hooks (re)added; a "hooks" value of a shape we do not know is refused, never overwritten
function withHooks(file, cfg, agent, command) {
  const bad = (what) => new Error(`${file}: ${what}; fix it or add the Neurons hooks by hand.`);
  if (cfg.hooks != null && (typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks))) throw bad('"hooks" is not an object');
  const hooks = withoutNeuronsHooks(cfg.hooks);
  for (const [event, matcher] of Object.entries(HOOK_EVENTS[agent])) {
    if (hooks[event] != null && !isHookList(hooks[event])) throw bad(`"hooks.${event}" is not a list of hook groups`);
    hooks[event] = [...(hooks[event] || []), { ...(matcher ? { matcher } : {}), hooks: [hookEntry(agent, command)] }];
  }
  return { ...cfg, hooks };
}

// The config without our hooks, or null when it has none
function withoutHooks(cfg) {
  if (!countNeuronsHooks(cfg.hooks)) return null;
  const hooks = withoutNeuronsHooks(cfg.hooks);
  const next = { ...cfg, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

function removeHooks(file) {
  if (!fs.existsSync(file)) return;
  const next = withoutHooks(readJson(file));
  if (next) writeJson(file, next);
}

// --- Codex's TOML: only our own [mcp_servers.neurons] tables are ever touched

// A table header may end in a comment: [mcp_servers.neurons]  # mine
const NEURONS_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*"?neurons"?\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const NEURONS_MAIN_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*"?neurons"?\s*\]\s*(#.*)?$/;
const ANY_TABLE = /^\s*\[/;

// Only the removed tables' own lines go, and the blank lines before them; the rest of the file (multi-line strings too) stays byte for byte
function withoutNeuronsTables(text) {
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (NEURONS_TABLE.test(line)) {
      if (!skipping) while (out.length && !out.at(-1).trim()) out.pop();
      skipping = true;
      continue;
    }
    if (skipping && ANY_TABLE.test(line)) {
      skipping = false;
      if (out.length) out.push('');
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').trimEnd();
}

// A "neurons" server written another way (an inline table under [mcp_servers], or dotted keys) cannot be replaced safely
function otherNeuronsEntry(text) {
  let table = '';
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/);
    if (header) table = header[1].replace(/\s+/g, '');
    else if (table === 'mcp_servers' && /^\s*"?neurons"?\s*[.=]/.test(line)) return true;
    else if (table === '' && /^\s*mcp_servers\s*\.\s*"?neurons"?\s*[.=]/.test(line)) return true;
  }
  return false;
}

// The server path and tool timeout of our [mcp_servers.neurons] table, or null when there is none
function codexEntry(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => NEURONS_MAIN_TABLE.test(l));
  if (start === -1) return null;
  const entry = { server: '', timeout: 0 };
  for (let i = start + 1; i < lines.length && !ANY_TABLE.test(lines[i]); i++) {
    const args = lines[i].match(/^\s*args\s*=\s*\[\s*("(?:[^"\\]|\\.)*"|'[^']*')/);
    if (args) entry.server = args[1].startsWith("'") ? args[1].slice(1, -1) : JSON.parse(args[1]);
    const timeout = lines[i].match(/^\s*tool_timeout_sec\s*=\s*(\d+)/);
    if (timeout) entry.timeout = Number(timeout[1]);
  }
  return entry;
}

// --- OpenCode: plain opencode.json is edited; a commented opencode.jsonc is never rewritten

function opencodeFile(p) {
  if (!fs.existsSync(p.jsonc)) return { file: p.mcp, editable: true };
  const text = fs.readFileSync(p.jsonc, 'utf8');
  return { file: p.jsonc, editable: stripJsonComments(text) === text };
}

function readOpencode(p) {
  const { file } = opencodeFile(p);
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')) || '{}');
  } catch {
    return {};
  }
}

// --- public API

function detectAgents(paths) {
  return Object.entries(AGENTS).map(([id, a]) => {
    const p = paths[id];
    const bin = a.bins.map((b) => findOnPath(b, p.extraBins)).find(Boolean) || null;
    return { id, name: a.name, installed: fs.existsSync(p.home) || !!bin, bin };
  });
}

// Moves whenever one of the agents' config files changes: a few stats instead of reading and parsing them all
export function configStamp() {
  return Object.values(agentPaths())
    .flatMap((p) => [p.mcp, p.hooks, p.jsonc, p.plugin].filter(Boolean))
    .map((f) => {
      try {
        return fs.statSync(f).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(',');
}

// What is registered right now, per agent: the server path its MCP config points to, and how many Neurons hooks it has
export function agentStatus({ serverPath }) {
  const paths = agentPaths();
  return detectAgents(paths).map((agent) => {
    const p = paths[agent.id];
    let registered = null;
    let hooks = 0;
    // Registered with settings an older Neurons wrote (a tool timeout too short for a blocking send)
    let outdated = false;
    let error = null;
    try {
      if (agent.id === 'claude') {
        registered = readJson(p.mcp).mcpServers?.neurons?.args?.[0] ?? null;
        hooks = countNeuronsHooks(readJson(p.hooks).hooks);
      } else if (agent.id === 'codex') {
        const entry = fs.existsSync(p.mcp) ? codexEntry(fs.readFileSync(p.mcp, 'utf8')) : null;
        registered = entry ? entry.server : null;
        outdated = !!entry && entry.timeout < TOOL_TIMEOUT_SEC;
        hooks = countNeuronsHooks(readJson(p.hooks).hooks);
      } else if (agent.id === 'gemini') {
        const entry = readJson(p.mcp).mcpServers?.neurons;
        registered = entry?.args?.[0] ?? null;
        outdated = !!entry && (entry.timeout || 0) < TOOL_TIMEOUT_SEC * 1000;
        hooks = countNeuronsHooks(readJson(p.hooks).hooks);
      } else {
        registered = readOpencode(p).mcp?.neurons?.command?.[1] ?? null;
        hooks = ourPlugin(p.plugin) ? 1 : 0;
      }
    } catch (err) {
      error = err.message;
    }
    const hooksWanted = Object.keys(HOOK_EVENTS[agent.id]).length;
    const norm = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
    const same = (a, b) => !!a && !!b && norm(a) === norm(b);
    return {
      ...agent,
      registered: registered !== null,
      serverPath: registered || null,
      current: same(registered, serverPath),
      hooks,
      hooksWanted,
      outdated,
      connected: registered !== null && same(registered, serverPath) && hooks >= hooksWanted && !outdated,
      error,
    };
  });
}

/*
 * Writes one agent's global MCP registration, plus its hooks (Claude Code,
 * Codex, Gemini CLI) or plugin (OpenCode). `server` and `hookScript` are absolute paths to the built
 * neurons-mcp.mjs and neurons.mjs, `node` an absolute Node 22.16+ binary.
 * Running agent sessions pick it up when they are restarted.
 */
export function connectAgent(id, { node, server, hookScript, dataDir }) {
  const p = agentPaths()[id];
  const env = { NEURONS_AGENT: id, ...(dataDir ? { NEURONS_DATA_DIR: dataDir } : {}) };
  const command = hookCommand(node, hookScript, id, dataDir);
  if (id === 'claude') {
    const cfg = readJson(p.mcp);
    const hooks = withHooks(p.hooks, readJson(p.hooks), 'claude', command);
    writeJson(p.mcp, { ...cfg, mcpServers: { ...(cfg.mcpServers || {}), neurons: { type: 'stdio', command: node, args: [server], env } } });
    writeJson(p.hooks, hooks);
  } else if (id === 'codex') {
    const text = fs.existsSync(p.mcp) ? fs.readFileSync(p.mcp, 'utf8') : '';
    const hooks = withHooks(p.hooks, readJson(p.hooks), 'codex', command);
    const block = [
      '[mcp_servers.neurons]',
      `command = ${JSON.stringify(node)}`,
      `args = [${JSON.stringify(server)}]`,
      `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
      '',
      '[mcp_servers.neurons.env]',
      ...Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
    ].join('\n');
    const rest = withoutNeuronsTables(text);
    if (otherNeuronsEntry(rest)) throw new Error(`${p.mcp} defines "neurons" as an inline table or dotted keys; remove that by hand, then connect again.`);
    writeFileSafely(p.mcp, `${rest ? `${rest}\n\n` : ''}${block}\n`);
    writeJson(p.hooks, hooks);
  } else if (id === 'gemini') {
    // The server and the hooks share settings.json: one write, so its backup is the user's own version
    const cfg = readJson(p.mcp);
    writeJson(p.mcp, withHooks(p.mcp, { ...cfg, mcpServers: { ...(cfg.mcpServers || {}), neurons: { command: node, args: [server], env, timeout: TOOL_TIMEOUT_SEC * 1000 } } }, 'gemini', command));
  } else if (id === 'opencode') {
    const { file, editable } = opencodeFile(p);
    if (!editable) throw new Error(`${file} has comments, which would be lost. Add "neurons" under "mcp" by hand: {"type":"local","command":[${JSON.stringify(node)},${JSON.stringify(server)}],"environment":{"NEURONS_AGENT":"opencode"},"enabled":true}`);
    if (fs.existsSync(p.plugin) && !ourPlugin(p.plugin)) throw new Error(`${p.plugin} is someone else's plugin; rename it, then connect again.`);
    const cfg = readJson(file);
    writeJson(file, { ...cfg, mcp: { ...(cfg.mcp || {}), neurons: { type: 'local', command: [node, server], environment: env, enabled: true } } });
    fs.mkdirSync(path.dirname(p.plugin), { recursive: true });
    writeFileSafely(p.plugin, opencodePlugin({ node, hookScript, dataDir }));
  } else {
    throw new Error(`Unknown agent "${id}".`);
  }
}

export function disconnectAgent(id) {
  const p = agentPaths()[id];
  if (!p) throw new Error(`Unknown agent "${id}".`);
  if (id === 'claude' || id === 'gemini') {
    const cfg = readJson(p.mcp);
    let next = cfg;
    if (cfg.mcpServers?.neurons) {
      const { neurons, ...others } = cfg.mcpServers;
      next = { ...cfg, mcpServers: others };
    }
    // Gemini keeps its hooks in the same file: one write
    if (p.hooks === p.mcp) next = withoutHooks(next) || next;
    if (next !== cfg) writeJson(p.mcp, next);
  } else if (id === 'codex') {
    if (fs.existsSync(p.mcp)) {
      const text = fs.readFileSync(p.mcp, 'utf8');
      if (text.split(/\r?\n/).some((l) => NEURONS_TABLE.test(l))) writeFileSafely(p.mcp, `${withoutNeuronsTables(text)}\n`);
    }
  } else if (id === 'opencode') {
    // The plugin goes first: a commented config that must be edited by hand does not keep it running
    if (ourPlugin(p.plugin)) fs.rmSync(p.plugin);
    const { file, editable } = opencodeFile(p);
    const cfg = editable ? readJson(file) : null;
    if (cfg?.mcp?.neurons) {
      const { neurons, ...others } = cfg.mcp;
      writeJson(file, { ...cfg, mcp: others });
    } else if (!editable) {
      throw new Error(`${file} has comments; remove "neurons" under "mcp" by hand.`);
    }
  }
  if (p.hooks && p.hooks !== p.mcp) removeHooks(p.hooks);
}

// Copies the built server into a stable folder, so agent configs survive extension updates; returns the paths to register
export function installServer({ sourceDir, dataDir, version }) {
  const dir = path.join(dataDir, 'app');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['neurons-mcp.mjs', 'neurons.mjs']) {
    const tmp = path.join(dir, `${f}.tmp`);
    fs.copyFileSync(path.join(sourceDir, f), tmp);
    try {
      fs.renameSync(tmp, path.join(dir, f));
    } catch {
      fs.copyFileSync(tmp, path.join(dir, f));
      fs.rmSync(tmp, { force: true });
    }
  }
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version }) + '\n');
  return appPaths(dataDir);
}

export function appPaths(dataDir) {
  const dir = path.join(dataDir, 'app');
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version;
  } catch {}
  return { dir, server: path.join(dir, 'neurons-mcp.mjs'), hookScript: path.join(dir, 'neurons.mjs'), version };
}
