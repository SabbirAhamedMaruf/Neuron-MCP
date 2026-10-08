import { execFile } from 'node:child_process';
import path from 'node:path';
import { RECALL } from '../configuration/settings.js';
import { isSensitivePath, redact } from './guard.js';
import { oneLine } from './util.js';

// Tracked and untracked files, minus anything gitignored (.env, build output)
export function grepRepo(root, terms) {
  if (!terms.length) return Promise.resolve([]);
  const args = ['-C', root, 'grep', '--untracked', '-n', '-I', '-i', '-F', '--max-count=5', ...terms.flatMap((t) => ['-e', t]), '--', '.'];
  return new Promise((resolve) => {
    execFile('git', args, { timeout: RECALL.repoGrepTimeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // Exit code 1 means no match; anything else without output is a real failure
      if (err && !stdout) return resolve([]);
      const hits = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m || isSensitivePath(m[1])) continue;
        const lower = m[3].toLowerCase();
        const matched = terms.filter((t) => lower.includes(t)).length;
        if (!matched) continue;
        hits.push({ file: path.join(root, m[1]), rel: m[1], line: Number(m[2]), matched, text: redact(oneLine(m[3], 200)) });
      }
      resolve(hits.sort((a, b) => b.matched - a.matched).slice(0, RECALL.repoMaxHits));
    });
  });
}
