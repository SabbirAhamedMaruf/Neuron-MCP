// Builds everything agents and editors run: dist/ (server + CLI) and the editor extension; --package also makes the .vsix
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ext = path.join(root, 'extension');
const outdir = path.join(root, 'dist');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(outdir, { recursive: true, force: true });

// 1. The MCP server and the CLI (hooks, status, watch, dashboard backend), each one self-contained file
await build({
  absWorkingDir: root,
  entryPoints: { 'neurons-mcp': 'src/index.js', neurons: 'bin/neurons.js' },
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.16',
  // Bundled CommonJS dependencies still call require()
  banner: { js: "import { createRequire as __neuronsRequire } from 'node:module'; const require = __neuronsRequire(import.meta.url);" },
  minifySyntax: true,
  minifyWhitespace: true,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
});
for (const f of fs.readdirSync(outdir)) fs.chmodSync(path.join(outdir, f), 0o755);

// 2. The editor extension: its host code, plus the server it installs for agents and runs as its own backend
const manifestPath = path.join(ext, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== version) {
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
fs.rmSync(path.join(ext, 'dist'), { recursive: true, force: true });
await build({
  absWorkingDir: ext,
  entryPoints: { extension: 'src/extension.js' },
  outdir: path.join(ext, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // The editor's own Node; the extension host only spawns processes and edits JSON/TOML files
  target: 'node18',
  external: ['vscode'],
  minifySyntax: true,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
});
// The dashboard's connection canvas (React Flow), one script and one stylesheet next to the hand-written webview files
await build({
  absWorkingDir: ext,
  entryPoints: { canvas: 'webview-src/canvas.jsx' },
  outdir: path.join(ext, 'media'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome110',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

const server = path.join(ext, 'server');
fs.rmSync(server, { recursive: true, force: true });
fs.mkdirSync(server);
for (const f of ['neurons-mcp.mjs', 'neurons.mjs']) fs.copyFileSync(path.join(outdir, f), path.join(server, f));

// 3. The installable package for VS Code and VSCodium (any OS: the server is plain JavaScript)
if (process.argv.includes('--package')) {
  const vsix = path.join(outdir, `neurons-${version}.vsix`);
  execFileSync(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce'), ['package', '--no-dependencies', '--skip-license', '--allow-missing-repository', '-o', vsix], { cwd: ext, stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(`\n  ${path.relative(root, vsix)}`);
}
