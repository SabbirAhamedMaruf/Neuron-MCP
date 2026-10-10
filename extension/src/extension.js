// Neurons for VS Code and VSCodium: a live dashboard of the agents on this machine, plus one-click global setup for each agent
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { Backend } from './backend.js';
import { findNode, MIN_NODE } from './node.js';
import { detectChats } from './chats.js';
import { AGENTS, agentStatus, appPaths, configStamp, connectAgent, disconnectAgent, installServer } from './setup.js';

// Backend commands the webview may call directly (reads, single deletes, connecting two chats and hanging up); bulk clears and agent setup go through the handlers below
const DIRECT = new Set(['snapshot', 'handoffs', 'handoff', 'reviews', 'review', 'notes', 'note', 'claims', 'backups', 'delete', 'link', 'hangup', 'conversations', 'conversation']);

// a > b for dotted version numbers
function newer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// The Live tab reloads on every change in the store; the agents' configs are read again only when one of them changed,
// or after this long (an agent installed meanwhile)
const AGENTS_TTL_MS = 30000;

const CLEAR_LABELS = {
  messages: 'all messages and replies',
  handoffs: 'all handoffs',
  reviews: 'all code reviews',
  claims: 'all file claims',
  notes: "all agents' Neurons notes",
  calls: 'the call log (open lines stay)',
  everything: 'EVERYTHING: messages, handoffs, reviews, claims, notes, the search cache, the call log and disconnected sessions',
};

export function activate(context) {
  const output = vscode.window.createOutputChannel('Neurons');
  const log = (line) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  const version = context.extension.packageJSON.version;
  const bundledServer = path.join(context.extensionPath, 'server');
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  // Each dashboard (the sidebar view, the editor panel) with whether it is on screen: a hidden one gets no updates,
  // so it does no work and slows nothing down, and one refresh when it shows again
  const webviews = new Map();
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

  const post = (msg) => {
    for (const [w, v] of webviews) {
      if (msg.type === 'changed' && !v.visible()) v.stale = true;
      else w.postMessage(msg);
    }
  };
  const visibilityChanged = (webview) => {
    const v = webviews.get(webview);
    if (!v) return;
    const visible = v.visible();
    webview.postMessage({ type: 'visibility', visible });
    if (visible && v.stale) {
      v.stale = false;
      webview.postMessage({ type: 'changed' });
    }
  };
  const stateMessage = () => ({ type: 'state', version, node: node?.version || null, nodePath: node?.path || null, minNode: MIN_NODE.join('.'), problem, info });

  // The build agents should run: a developer's own folder, or the copy this extension installs into the data folder
  const customServer = () => cfg().get('serverPath') || '';
  const target = () => {
    const dir = customServer();
    if (dir) return { server: path.join(dir, 'neurons-mcp.mjs'), hookScript: path.join(dir, 'neurons.mjs') };
    return appPaths(info.dataDir);
  };

  // Agents already connected through this extension get each new build on their next start; a window still running an
  // older extension never puts its older build back
  function keepInstalledServerCurrent() {
    if (customServer() || !info) return;
    const installed = appPaths(info.dataDir);
    if (installed.version && newer(version, installed.version) && fs.existsSync(installed.server)) {
      installServer({ sourceDir: bundledServer, dataDir: info.dataDir, version });
      log(`updated the installed server ${installed.version} → ${version}`);
    }
  }

  let statusTimer = null;
  function refreshStatusBar() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      try {
        const { nodes, lines } = (await backend.request('snapshot')).graph;
        const handle = new Map(nodes.map((n) => [n.id, n.handle]));
        statusBar.text = `$(pulse) Neurons ${nodes.length}${lines.length ? ` · $(link) ${lines.length}` : ''}`;
        statusBar.tooltip = nodes.length
          ? [`Chats: ${nodes.map((n) => n.handle).join(', ')}`, ...lines.map((l) => `Line #${l.id}: ${handle.get(l.source)} ⇄ ${handle.get(l.target)}`)].join('\n')
          : 'No chat connected to Neurons';
      } catch {}
    }, 400);
  }

  function start() {
    agentsCache = null;
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

  let agentsCache = null;
  const agents = (fresh = false) => {
    const stamp = configStamp();
    if (fresh || !agentsCache || agentsCache.stamp !== stamp || Date.now() - agentsCache.at > AGENTS_TTL_MS) {
      agentsCache = { at: Date.now(), stamp, list: agentStatus({ serverPath: info ? target().server : null }) };
    }
    return agentsCache.list;
  };

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
      // The agent chats open in this window, from its processes (sidebar or tab), joined to Neurons or not
      case 'chats':
        return detectChats();
      case 'connect':
        connect(args.id);
        return agents(true);
      case 'disconnect':
        disconnectAgent(args.id);
        log(`disconnected ${args.id}`);
        vscode.window.showInformationMessage(`${AGENTS[args.id].name} no longer loads Neurons. Restart its open sessions to apply.`);
        return agents(true);
      case 'clear':
        if (!backend) throw new Error('The Neurons backend is not running.');
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

  function attach(webview, visible) {
    webviews.set(webview, { visible, stale: false });
    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') return webview.postMessage(stateMessage());
      // A script error in the dashboard goes to the Neurons output (Show logs)
      if (msg?.type === 'log') return log(`webview: ${String(msg.text).slice(0, 2000)}`);
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
<link rel="stylesheet" href="${asset('canvas.css')}">
<title>Neurons</title>
</head>
<body data-mode="${mode}">
<div id="app"></div>
<script nonce="${nonce}" src="${asset('canvas.js')}"></script>
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
    // The panel is already disposed when this fires, and its webview getter throws then: keep the webview from before
    const webview = panel.webview;
    attach(webview, () => !!panel?.visible);
    panel.onDidChangeViewState(() => visibilityChanged(webview));
    panel.onDidDispose(() => {
      webviews.delete(webview);
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
          const webview = view.webview;
          attach(webview, () => view.visible);
          view.onDidChangeVisibility(() => visibilityChanged(webview));
          view.onDidDispose(() => webviews.delete(webview));
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('neurons.openDashboard', openPanel),
    vscode.commands.registerCommand('neurons.refresh', () => {
      agentsCache = null;
      return problem ? start() : post({ type: 'changed' });
    }),
    vscode.commands.registerCommand('neurons.showLogs', () => output.show(true)),
    vscode.commands.registerCommand('neurons.connectAgents', async () => {
      const list = agents(true);
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
      agentsCache = null;
      post({ type: 'changed' });
    }),
    vscode.commands.registerCommand('neurons.disconnectAgents', async () => {
      const picks = await vscode.window.showQuickPick(
        agents(true)
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
      agentsCache = null;
      post({ type: 'changed' });
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('neurons') && start()),
    { dispose: () => backend?.dispose() },
  );

  start();
}
