// Connects coding agents to Neurons by writing their GLOBAL (user-level) MCP config and hooks (a plugin for OpenCode), on Linux, macOS and Windows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPENCODE_PLUGIN_MARK, OPENCODE_PLUGIN_NAME, opencodePlugin } from './opencode-plugin.js';

// Listen mode keeps an inbox call open for up to 900 s; agents with a hard per-call limit get a little more than that
const TOOL_TIMEOUT_SEC = 960;

export const AGENTS = {
  claude: { name: 'Claude Code', hooks: true, bins: ['claude'] },
  codex: { name: 'Codex', hooks: true, bins: ['codex'] },
  gemini: { name: 'Gemini CLI', hooks: true, bins: ['gemini'] },
  opencode: { name: 'OpenCode', hooks: true, bins: ['opencode'] },
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
    throw new Error(`${file} is not valid JSON (${err.message}); fix it or edit it by hand.`);
  }
}

// The original's permissions carry over to the backup and the new file (~/.claude.json is 0600); new files start private
function writeFileSafely(file, text) {
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

const hookCommand = (node, script, agent) => `${quote(node)} ${quote(script)} hook --agent ${agent}`;

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

function withoutNeuronsHooks(hooks = {}) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isNeuronsHook(h)) })).filter((g) => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function countNeuronsHooks(hooks = {}) {
  return Object.values(hooks).filter((groups) => Array.isArray(groups) && groups.some((g) => (g.hooks || []).some(isNeuronsHook))).length;
}

function writeHooks(file, agent, command) {
  const cfg = readJson(file);
  const hooks = withoutNeuronsHooks(cfg.hooks);
  for (const [event, matcher] of Object.entries(HOOK_EVENTS[agent])) {
    hooks[event] = [...(hooks[event] || []), { ...(matcher ? { matcher } : {}), hooks: [hookEntry(agent, command)] }];
  }
  writeJson(file, { ...cfg, hooks });
}

function removeHooks(file) {
  if (!fs.existsSync(file)) return;
  const cfg = readJson(file);
  if (!countNeuronsHooks(cfg.hooks)) return;
  const hooks = withoutNeuronsHooks(cfg.hooks);
  const next = { ...cfg, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  writeJson(file, next);
}

// --- Codex's TOML: only our own [mcp_servers.neurons] tables are ever touched

const NEURONS_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*"?neurons"?\s*(\.[^\]]*)?\]\s*$/;
const ANY_TABLE = /^\s*\[/;

function withoutNeuronsTables(text) {
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (NEURONS_TABLE.test(line)) skipping = true;
    else if (ANY_TABLE.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// The server path and tool timeout of our [mcp_servers.neurons] table, or null when there is none
function codexEntry(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\s*mcp_servers\s*\.\s*"?neurons"?\s*\]\s*$/.test(l));
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

const stripJsonComments = (text) => text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');

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

// What is registered right now, per agent: the server path its MCP config points to, and how many Neurons hooks it has
export function agentStatus({ serverPath }) {
  const paths = agentPaths();
  return detectAgents(paths).map((agent) => {
    const p = paths[agent.id];
    let registered = null;
    let hooks = 0;
    // Registered with settings an older Neurons wrote (a tool timeout too short for listen mode)
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
    const hooksWanted = AGENTS[agent.id].hooks ? Object.keys(HOOK_EVENTS[agent.id]).length : 0;
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
 * neurons-mcp.mjs and neurons.mjs, `node` an absolute Node 22.13+ binary.
 * Running agent sessions pick it up when they are restarted.
 */
export function connectAgent(id, { node, server, hookScript, dataDir }) {
  const p = agentPaths()[id];
  const env = { NEURONS_AGENT: id, ...(dataDir ? { NEURONS_DATA_DIR: dataDir } : {}) };
  if (id === 'claude') {
    const cfg = readJson(p.mcp);
    writeJson(p.mcp, { ...cfg, mcpServers: { ...(cfg.mcpServers || {}), neurons: { type: 'stdio', command: node, args: [server], env } } });
    writeHooks(p.hooks, 'claude', hookCommand(node, hookScript, 'claude'));
  } else if (id === 'codex') {
    const text = fs.existsSync(p.mcp) ? fs.readFileSync(p.mcp, 'utf8') : '';
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
    writeFileSafely(p.mcp, `${rest ? `${rest}\n\n` : ''}${block}\n`);
    writeHooks(p.hooks, 'codex', hookCommand(node, hookScript, 'codex'));
  } else if (id === 'gemini') {
    const cfg = readJson(p.mcp);
    writeJson(p.mcp, { ...cfg, mcpServers: { ...(cfg.mcpServers || {}), neurons: { command: node, args: [server], env, timeout: TOOL_TIMEOUT_SEC * 1000 } } });
    writeHooks(p.hooks, 'gemini', hookCommand(node, hookScript, 'gemini'));
  } else if (id === 'opencode') {
    const { file, editable } = opencodeFile(p);
    if (!editable) throw new Error(`${file} has comments, which would be lost. Add "neurons" under "mcp" by hand: {"type":"local","command":[${JSON.stringify(node)},${JSON.stringify(server)}],"environment":{"NEURONS_AGENT":"opencode"},"enabled":true}`);
    if (fs.existsSync(p.plugin) && !ourPlugin(p.plugin)) throw new Error(`${p.plugin} is someone else's plugin; rename it, then connect again.`);
    const cfg = readJson(file);
    writeJson(file, { ...cfg, mcp: { ...(cfg.mcp || {}), neurons: { type: 'local', command: [node, server], environment: env, enabled: true } } });
    fs.mkdirSync(path.dirname(p.plugin), { recursive: true });
    writeFileSafely(p.plugin, opencodePlugin({ node, hookScript }));
  } else {
    throw new Error(`Unknown agent "${id}".`);
  }
}

export function disconnectAgent(id) {
  const p = agentPaths()[id];
  if (id === 'claude' || id === 'gemini') {
    const cfg = readJson(p.mcp);
    if (cfg.mcpServers?.neurons) {
      const { neurons, ...others } = cfg.mcpServers;
      writeJson(p.mcp, { ...cfg, mcpServers: others });
    }
  } else if (id === 'codex') {
    if (fs.existsSync(p.mcp)) {
      const text = fs.readFileSync(p.mcp, 'utf8');
      if (codexEntry(text) !== null || NEURONS_TABLE.test(text)) writeFileSafely(p.mcp, `${withoutNeuronsTables(text)}\n`);
    }
  } else if (id === 'opencode') {
    const { file, editable } = opencodeFile(p);
    const cfg = editable ? readJson(file) : null;
    if (cfg?.mcp?.neurons) {
      const { neurons, ...others } = cfg.mcp;
      writeJson(file, { ...cfg, mcp: others });
    } else if (!editable) {
      throw new Error(`${file} has comments; remove "neurons" under "mcp" by hand.`);
    }
    if (ourPlugin(p.plugin)) fs.rmSync(p.plugin);
  }
  if (p.hooks) removeHooks(p.hooks);
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
