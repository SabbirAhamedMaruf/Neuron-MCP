// Finds a Node.js new enough for node:sqlite on Linux, macOS and Windows; editors started from a dock or menu often lack the shell's PATH
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// node:sqlite with FTS5: Node 22.16 and later, or 24 and later (23.x lacks it)
export const MIN_NODE = [22, 16];

function nodeVersion(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = out.match(/^v(\d+)\.(\d+)\.(\d+)/);
    return m ? { text: out, major: Number(m[1]), minor: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

const isSupported = (v) => !!v && v.major !== 23 && (v.major > MIN_NODE[0] || (v.major === MIN_NODE[0] && v.minor >= MIN_NODE[1]));

// Newest first, so "the latest nvm/fnm install" wins over older ones
function versionDirs(root, suffix) {
  try {
    return fs
      .readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => path.join(root, d, ...suffix));
  } catch {
    return [];
  }
}

function candidates(env, home) {
  const win = process.platform === 'win32';
  const exe = win ? 'node.exe' : 'node';
  const fromPath = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe));
  if (win) {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      ...fromPath,
      path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(local, 'Programs', 'nodejs', 'node.exe'),
      env.NVM_SYMLINK && path.join(env.NVM_SYMLINK, 'node.exe'),
      path.join(local, 'Volta', 'bin', 'node.exe'),
      path.join(home, 'scoop', 'shims', 'node.exe'),
      ...versionDirs(path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'nvm'), ['node.exe']),
    ].filter(Boolean);
  }
  return [
    ...fromPath,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
    path.join(home, '.asdf', 'shims', 'node'),
    path.join(home, '.local', 'share', 'mise', 'shims', 'node'),
    ...versionDirs(path.join(home, '.nvm', 'versions', 'node'), ['bin', 'node']),
    ...versionDirs(path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin', 'node']),
    ...versionDirs(path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), ['installation', 'bin', 'node']),
  ];
}

// The configured path, else the first supported Node found; null when there is none
export function findNode(configured) {
  const env = process.env;
  const home = os.homedir();
  if (configured) {
    const v = nodeVersion(configured);
    return isSupported(v) ? { path: configured, version: v.text } : null;
  }
  const seen = new Set();
  for (const c of candidates(env, home)) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (!fs.existsSync(c)) continue;
    const v = nodeVersion(c);
    if (isSupported(v)) return { path: c, version: v.text };
  }
  // Last resort on macOS/Linux: the login shell knows the user's real PATH
  if (process.platform !== 'win32') {
    try {
      const shell = env.SHELL || '/bin/sh';
      const found = execFileSync(shell, ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop();
      const v = found && nodeVersion(found);
      if (isSupported(v)) return { path: found, version: v.text };
    } catch {}
  }
  return null;
}
