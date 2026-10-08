// Neurons for VS Code and VSCodium: a live dashboard of the agents on this machine, plus one-click global setup for each agent
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { Backend } from './backend.js';
import { findNode, MIN_NODE } from './node.js';
import { AGENTS, agentStatus, appPaths, connectAgent, disconnectAgent, installServer } from './setup.js';

// Backend commands the webview may call directly (reads, single deletes, picking up and hanging up); bulk clears and agent setup go through the handlers below
const DIRECT = new Set(['snapshot', 'history', 'thread', 'handoffs', 'handoff', 'reviews', 'review', 'notes', 'note', 'claims', 'backups', 'delete', 'answer', 'hangup', 'autoAnswer', 'setAutoListen']);

const CLEAR_LABELS = {
  messages: 'all messages and replies',
  handoffs: 'all handoffs',
  'auto-handoffs': 'all automatic handoffs',
  reviews: 'all code reviews',
  claims: 'all file claims',
  notes: "all agents' Neurons notes",
  embeddings: 'the semantic search cache',
  calls: 'the call log (open lines stay)',
  everything: 'EVERYTHING: messages, handoffs, reviews, claims, notes, the search cache, the call log and disconnected sessions',
};

export function activate(context) {
  const output = vscode.window.createOutputChannel('Neurons');
  const log = (line) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  const version = context.extension.packageJSON.version;
  const bundledServer = path.join(context.extensionPath, 'server');
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const webviews = new Set();
  const cfg = () => vscode.workspace.getConfiguration('neurons');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  statusBar.command = 'neurons.openDashboard';
  statusBar.text = '$(pulse) Neurons';
  statusBar.show();

  let backend = null;
  let node = null;
  let info = null;
  let problem = null;
  let panel = null;

  const post = (msg) => webviews.forEach((w) => w.postMessage(msg));
  const stateMessage = () => ({ type: 'state', version, node: node?.version || null, nodePath: node?.path || null, minNode: MIN_NODE.join('.'), problem, info });

  // The build agents should run: a developer's own folder, or the copy this extension installs into the data folder
  const customServer = () => cfg().get('serverPath') || '';
  const target = () => {
    const dir = customServer();
    if (dir) return { server: path.join(dir, 'neurons-mcp.mjs'), hookScript: path.join(dir, 'neurons.mjs') };
    return appPaths(info.dataDir);
  };

  // Agents already connected through this extension get each new build on their next start
  function keepInstalledServerCurrent() {
    if (customServer() || !info) return;
    const installed = appPaths(info.dataDir);
    if (installed.version && installed.version !== version && fs.existsSync(installed.server)) {
      installServer({ sourceDir: bundledServer, dataDir: info.dataDir, version });
      log(`updated the installed server ${installed.version} → ${version}`);
    }
  }

  let statusTimer = null;
  function refreshStatusBar() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      try {
        const snap = await backend.request('snapshot', { feedLimit: 0 });
        const live = snap.connected.length;
        const ringing = snap.calls.ringing;
        // A ringing call shows in the status bar until someone picks up; it never prompts an agent
        statusBar.text = ringing.length ? `$(bell) Neurons ${live} · ${ringing.length} ringing` : `$(pulse) Neurons ${live}`;
        statusBar.backgroundColor = ringing.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        statusBar.tooltip = ringing.length
          ? ringing.map((c) => `${c.from.handle} is calling ${c.to.handle || c.to.agent}`).join('\n')
          : live
            ? `Connected: ${snap.connected.map((s) => s.handle || s.agent).join(', ')}`
            : 'No agent connected to Neurons';
      } catch {}
    }, 400);
  }

  function start() {
    backend?.dispose();
    backend = null;
    info = null;
    problem = null;
    node = findNode(cfg().get('nodePath') || undefined);
    if (!node) {
      problem = 'node';
      statusBar.text = '$(warning) Neurons';
      statusBar.tooltip = `Neurons needs Node.js ${MIN_NODE.join('.')} or newer`;
      log(`no Node.js ${MIN_NODE.join('.')}+ found; set neurons.nodePath`);
      post(stateMessage());
      return;
    }
    const dataDir = cfg().get('dataDir');
    const script = path.join(customServer() || bundledServer, 'neurons.mjs');
    log(`node ${node.version} at ${node.path}; backend ${script}`);
    backend = new Backend({ node: node.path, script, env: dataDir ? { NEURONS_DATA_DIR: dataDir } : {}, log });
    backend.on('event', () => {
      post({ type: 'changed' });
      refreshStatusBar();
    });
    backend.on('dead', () => {
      problem = 'backend';
      statusBar.text = '$(error) Neurons';
      post(stateMessage());
    });
    backend
      .request('info')
      .then((i) => {
        info = i;
        keepInstalledServerCurrent();
        post(stateMessage());
        refreshStatusBar();
      })
      .catch((err) => log(`info failed: ${err.message}`));
  }

  const agents = () => agentStatus({ serverPath: info ? target().server : null });

  function connect(id) {
    if (!node || !info) throw new Error(`Neurons needs Node.js ${MIN_NODE.join('.')}+ and a running backend first.`);
    const paths = customServer() ? target() : installServer({ sourceDir: bundledServer, dataDir: info.dataDir, version });
    connectAgent(id, { node: node.path, server: paths.server, hookScript: paths.hookScript, dataDir: cfg().get('dataDir') || undefined });
    log(`connected ${id}: ${paths.server}`);
    const trust = id === 'codex' ? ' In Codex, open /hooks once and trust the Neurons hooks.' : '';
    vscode.window.showInformationMessage(`${AGENTS[id].name} is connected to Neurons globally. Restart its open sessions to load it.${trust}`);
  }

  async function confirmClear(what) {
    const choice = await vscode.window.showWarningMessage(
      `Delete ${CLEAR_LABELS[what] || what} from Neurons?`,
      { modal: true, detail: 'A backup of the database is saved first (the newest 5 are kept). Agents’ own memory files and chats are never touched.' },
      'Delete',
    );
    return choice === 'Delete';
  }

  async function handle(cmd, args = {}) {
    if (DIRECT.has(cmd)) {
      if (!backend) throw new Error(problem === 'node' ? `Node.js ${MIN_NODE.join('.')}+ was not found.` : 'The Neurons backend is not running.');
      return backend.request(cmd, args);
    }
    switch (cmd) {
      case 'agents':
        return agents();
      case 'connect':
        connect(args.id);
        return agents();
      case 'disconnect':
        disconnectAgent(args.id);
        log(`disconnected ${args.id}`);
        vscode.window.showInformationMessage(`${AGENTS[args.id].name} no longer loads Neurons. Restart its open sessions to apply.`);
        return agents();
      case 'clear':
        if (!(await confirmClear(args.what))) return { cancelled: true };
        return backend.request('clear', { what: args.what });
      case 'reveal':
        return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(args.path));
      case 'logs':
        return output.show(true);
      case 'settings':
        return vscode.commands.executeCommand('workbench.action.openSettings', 'neurons');
      case 'openPanel':
        return openPanel();
      case 'retry':
        start();
        return null;
      default:
        throw new Error(`Unknown request "${cmd}".`);
    }
  }

  function attach(webview) {
    webviews.add(webview);
    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') return webview.postMessage(stateMessage());
      if (msg?.type !== 'rpc') return;
      try {
        webview.postMessage({ type: 'rpc', id: msg.id, ok: true, data: (await handle(msg.cmd, msg.args)) ?? null });
      } catch (err) {
        log(`${msg.cmd} failed: ${err.message}`);
        webview.postMessage({ type: 'rpc', id: msg.id, ok: false, error: err.message });
      }
    });
  }

  function html(webview, mode) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('dashboard.css')}">
<title>Neurons</title>
</head>
<body data-mode="${mode}">
<div id="app"></div>
<script nonce="${nonce}" src="${asset('dashboard.js')}"></script>
</body>
</html>`;
  }

  const webviewOptions = { enableScripts: true, localResourceRoots: [media] };

  function openPanel() {
    if (panel) return panel.reveal();
    panel = vscode.window.createWebviewPanel('neurons.dashboardPanel', 'Neurons', vscode.ViewColumn.Active, { ...webviewOptions, retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(media, 'neurons.svg');
    panel.webview.html = html(panel.webview, 'panel');
    attach(panel.webview);
    panel.onDidDispose(() => {
      webviews.delete(panel.webview);
      panel = null;
    });
  }

  context.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerWebviewViewProvider(
      'neurons.dashboard',
      {
        resolveWebviewView(view) {
          view.webview.options = webviewOptions;
          view.webview.html = html(view.webview, 'sidebar');
          attach(view.webview);
          view.onDidDispose(() => webviews.delete(view.webview));
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('neurons.openDashboard', openPanel),
    vscode.commands.registerCommand('neurons.refresh', () => (problem ? start() : post({ type: 'changed' }))),
    vscode.commands.registerCommand('neurons.showLogs', () => output.show(true)),
    vscode.commands.registerCommand('neurons.connectAgents', async () => {
      const list = agents();
      const picks = await vscode.window.showQuickPick(
        list.map((a) => ({ label: a.name, id: a.id, description: a.connected ? 'connected' : a.installed ? 'installed' : 'not found on this machine', picked: a.installed && !a.connected })),
        { canPickMany: true, title: 'Connect agents to Neurons (global config)' },
      );
      for (const p of picks || []) {
        try {
          connect(p.id);
        } catch (err) {
          vscode.window.showErrorMessage(`${p.label}: ${err.message}`);
        }
      }
      post({ type: 'changed' });
    }),
    vscode.commands.registerCommand('neurons.disconnectAgents', async () => {
      const picks = await vscode.window.showQuickPick(
        agents()
          .filter((a) => a.registered || a.hooks)
          .map((a) => ({ label: a.name, id: a.id })),
        { canPickMany: true, title: 'Disconnect agents from Neurons' },
      );
      for (const p of picks || []) {
        try {
          disconnectAgent(p.id);
        } catch (err) {
          vscode.window.showErrorMessage(`${p.label}: ${err.message}`);
        }
      }
      post({ type: 'changed' });
    }),
    vscode.commands.registerCommand('neurons.clearEverything', async () => {
      try {
        const res = await handle('clear', { what: 'everything' });
        if (!res?.cancelled) vscode.window.showInformationMessage(`Neurons history deleted. Backup: ${res.backup}`);
      } catch (err) {
        vscode.window.showErrorMessage(err.message);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('neurons') && start()),
    { dispose: () => backend?.dispose() },
  );

  start();
}
