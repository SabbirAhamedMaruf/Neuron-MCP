// The Claude Code chats open in this editor window, found from the window's own processes: the extension host runs
// one `claude` process per chat (sidebar or tab). Each comes with the pid:start key the Neurons servers record as their
// host, so the dashboard can tell which chats have not joined Neurons yet. Codex is left out: its app-server runs
// whether or not its panel is open, so it says nothing about open chats. Windows reports no process ancestry.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Children of a process: Linux reads /proc, macOS asks ps once
function children(pid) {
  if (process.platform === 'linux') {
    const out = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[1]) !== pid) continue;
        out.push({ pid: Number(d), start: Number(fields[19]), args: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean) });
      } catch {}
    }
    return out;
  }
  if (process.platform === 'darwin') {
    try {
      return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8', timeout: 3000 })
        .split('\n')
        .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/))
        .filter((m) => m && Number(m[2]) === pid)
        .map((m) => ({ pid: Number(m[1]), start: Date.parse(m[3]) || 0, args: m[4].split(' ') }));
    } catch {
      return [];
    }
  }
  return [];
}

// Whether a process is a Claude Code chat
const isClaudeChat = (args) => /^claude(\.exe)?$/i.test(path.basename(args[0] || '')) && args.some((a) => /stream-json/.test(a));

export function detectChats() {
  return children(process.pid)
    .filter((p) => isClaudeChat(p.args))
    .map((p) => ({ agent: 'claude', host: `${p.pid}:${p.start}` }));
}
