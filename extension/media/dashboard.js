// Neurons dashboard webview. The extension host fetches everything from the Neurons backend; this file only renders it.
// Every value that comes from the database is escaped, and the page's CSP allows no inline script or style.
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  const KNOWN_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'ollama', 'lmstudio'];
  const KINDS = ['question', 'reply', 'note', 'proposal', 'review', 'review-result', 'handoff'];
  const TABS = [
    ['live', 'Live'],
    ['conversations', 'Conversations'],
    ['handoffs', 'Handoffs'],
    ['reviews', 'Reviews'],
    ['notes', 'Notes'],
    ['claims', 'Claims'],
    ['storage', 'Storage'],
  ];
  const CLEARS = [
    ['messages', 'Messages and replies', 'messages'],
    ['handoffs', 'Handoffs', 'handoffs'],
    ['reviews', 'Code reviews', 'reviews'],
    ['claims', 'File claims', 'claims'],
    ['notes', 'Neurons notes', 'notes'],
    ['calls', 'Ended lines', 'calls'],
  ];
  // A message longer than this is shown collapsed (its first lines, faded) until the user expands it
  const COLLAPSE_CHARS = 400;
  const COLLAPSE_LINES = 6;

  // ---------- formatting (pure)

  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

  function ago(ms, now = Date.now()) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  const minutesLeft = (ms, now = Date.now()) => `${Math.max(1, Math.round((ms - now) / 60000))}m left`;
  const folder = (repo) => String(repo || '').split(/[\\/]/).filter(Boolean).pop() || '';

  function bytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  const agentClass = (a) => (KNOWN_AGENTS.includes(a) ? `agent-${a}` : 'agent-other');
  // The canvas bundle's agent icon: the agent's own mark, or a robot for any other agent
  const agentIcon = (agent) => `<span class="agent-icon ${agentClass(agent)}">${window.NeuronsCanvas?.icon(agent, 12) || ''}</span>`;
  const who = (handle, agent) => `<span class="who ${agentClass(agent)}">${agentIcon(agent)}${esc(handle || agent || 'unknown')}</span>`;
  const button = (label, act, data = {}, cls = '') =>
    `<button class="btn ${cls}" data-act="${esc(act)}"${Object.entries(data)
      .map(([k, v]) => ` data-${k}="${esc(v)}"`)
      .join('')}>${esc(label)}</button>`;
  const TRASH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.5 1h3l.5 1H13v1.2H3V2h3l.5-1zM4 4.5h8l-.6 9a1 1 0 0 1-1 .9H5.6a1 1 0 0 1-1-.9L4 4.5zm2.2 1.5.3 7h1l-.3-7h-1zm2.6 0-.3 7h1l.3-7h-1z"/></svg>';
  const deleteIcon = (what, id, title) => `<button class="icon-btn" title="${esc(title)}" aria-label="${esc(title)}" data-act="del" data-what="${esc(what)}" data-id="${esc(id)}">${TRASH}</button>`;
  const section = (title, body, extra = '') => `<section class="section"><h3>${esc(title)}${extra}</h3>${body}</section>`;
  const empty = (text) => `<div class="empty">${esc(text)}</div>`;
  const list = (items) => (items && items.length ? `<ul class="plain">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');

  // ---------- views (pure: data in, HTML out)

  const V = {
    banner(st) {
      if (!st) return `<div class="banner">Starting Neurons…</div>`;
      if (st.problem === 'node')
        return `<div class="banner error"><b>Node.js ${esc(st.minNode)} or newer was not found.</b> Neurons runs on your system's Node (it needs node:sqlite). Install it from nodejs.org, or set the path in settings.<div class="row">${button('Open settings', 'settings')}${button('Try again', 'retry')}</div></div>`;
      if (st.problem === 'backend') return `<div class="banner error"><b>The Neurons backend keeps stopping.</b><div class="row">${button('Show logs', 'logs')}${button('Try again', 'retry')}</div></div>`;
      return '';
    },

    agentState(a) {
      if (a.error) return { text: `Config could not be read: ${a.error}`, cls: 'bad', actions: [] };
      if (a.connected) return { text: `Connected · MCP + ${a.hooks}/${a.hooksWanted} hooks`, cls: 'ok', actions: [['Disconnect', 'disconnect', 'secondary']] };
      if (a.registered && a.current && a.outdated) return { text: 'Settings out of date (tool timeout too short)', cls: 'warn', actions: [['Repair', 'connect', ''], ['Disconnect', 'disconnect', 'secondary']] };
      if (a.registered && !a.current) return { text: `Connected to another Neurons build: ${a.serverPath}`, cls: 'warn', actions: [['Use this build', 'connect', ''], ['Disconnect', 'disconnect', 'secondary']] };
      if (a.registered) return { text: `Hooks missing (${a.hooks}/${a.hooksWanted})`, cls: 'warn', actions: [['Repair', 'connect', ''], ['Disconnect', 'disconnect', 'secondary']] };
      if (!a.installed) return { text: 'Not found on this machine', cls: 'muted', actions: [['Connect anyway', 'connect', 'secondary']] };
      return { text: 'Not connected', cls: 'muted', actions: [['Connect', 'connect', '']] };
    },

    // The sidebar's Live tab: the graph itself lives in the editor; here, the chats and lines at a glance
    live(graph, hues, now) {
      const nodes = graph?.nodes || [];
      const lines = graph?.lines || [];
      const paused = graph?.paused || [];
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const dot = (id) => `<span class="chat-dot" data-hue="${esc(hues[id] ?? 210)}"></span>`;
      const name = (n) => esc(n?.title || n?.handle || 'a closed chat');
      const open = `<div class="graph-cta"><div class="muted small">Connect chats by drawing lines between them on the graph.</div>${button('Open the connection graph', 'openPanel', {}, 'primary')}</div>`;
      const chats = nodes.length
        ? nodes
            .map(
              (n) => `<div class="chat-row">${dot(n.id)}${agentIcon(n.agent)}<div class="chat-main"><div class="chat-title">${name(n)}</div><div class="muted small">${esc(n.handle)} · ${esc(n.model || n.agent)}</div></div><span class="chat-state ${n.busy ? 'busy' : ''}">${n.busy ? 'Working' : 'Idle'}</span></div>`,
            )
            .join('')
        : empty('No chats yet. Each Claude Code or Codex chat appears here once it starts.');
      // A paused line waits for its closed chat to be reopened, and ends on its own after a day
      const waiting = (p) => `<div class="chat-row line-row paused" title="A chat on this line is closed. Reopen that same chat and the line is back."><span class="chat-title">${esc(p.ends[0])}</span><span class="arrow">⇄</span><span class="chat-title">${esc(p.ends[1])}</span><span class="spacer"></span><span class="time">paused · ends in ${Math.max(1, Math.ceil((p.until - now) / 3600000))}h</span></div>`;
      const rows = lines.length || paused.length
        ? lines
            .map((l) => `<div class="chat-row line-row">${dot(l.source)}<span class="chat-title">${name(byId.get(l.source))}</span><span class="arrow">⇄</span>${dot(l.target)}<span class="chat-title">${name(byId.get(l.target))}</span><span class="spacer"></span><span class="time">${esc(l.messages)} msg${l.last ? ` · ${esc(ago(l.last.at, now))}` : ''}</span></div>`)
            .join('') + paused.map(waiting).join('')
        : empty('No lines yet.');
      // Ask first: messages waiting for the user's OK (the editor shows a notification too; either answer counts)
      const asks = (graph?.asks || []).filter((a) => a.expiresAt > now);
      const pending = asks.length
        ? section(
            `Waiting for your OK (${asks.length})`,
            asks
              .map((a) => `<div class="ask-row"><div>${who(a.from, a.fromAgent)} <span class="muted">wants to send ${esc(a.to.join(', '))} a ${esc(a.kind)}</span></div><div class="ask-text">${esc(a.text)}</div><div class="row">${button('Allow', 'ask', { id: a.id, allow: 1 }, 'primary')}${button('Deny', 'ask', { id: a.id, allow: 0 }, 'secondary')}</div></div>`)
              .join(''),
          )
        : '';
      return `${pending}${open}${section(`Chats (${nodes.length})`, chats)}${section(`Lines (${lines.length + paused.length})`, rows)}`;
    },

    // The Agents setup drawer on the canvas: each agent's Neurons config, with Connect / Disconnect
    agents(agents, graph, off = []) {
      if (!agents) return empty('Looking for agents…');
      const running = (id) => (graph?.nodes || []).filter((n) => n.agent === id).length;
      return agents
        .map((a) => {
          // A provider the user turned off in Neurons keeps its config; it only needs turning back on
          const state = off.includes(a.id)
            ? { text: 'Turned off in Neurons: its chats are not on the graph and get no messages.', cls: 'muted', actions: [['Turn on', 'agentOn', '']] }
            : (({ actions, ...rest }) => ({ ...rest, actions: a.registered ? [...actions, ['Turn off', 'agentOff', 'secondary']] : actions }))(V.agentState(a));
          const n = running(a.id);
          return `<div class="agent ${agentClass(a.id)}">
  <div class="agent-head"><span class="dot ${n ? 'on' : ''}"></span>${agentIcon(a.id)}<b>${esc(a.name)}</b><span class="muted">${n ? `${n} chat${n === 1 ? '' : 's'} open` : 'no chat open'}</span></div>
  <div class="agent-state ${state.cls}">${esc(state.text)}</div>
  ${a.id === 'codex' && a.connected ? `<div class="hint">Codex runs new hooks only after you trust them: open <code>/hooks</code> in Codex once.</div>` : ''}
  <div class="row">${state.actions.map(([label, act, cls]) => button(label, act, { id: a.id }, cls)).join('')}</div>
</div>`;
        })
        .join('');
    },

    handoffs(data, open, now) {
      if (!data) return empty('Loading…');
      if (!data.items.length) return empty('No handoffs.');
      const more = data.more ? `<div class="row center">${button('Load more', 'morehandoffs', {}, 'secondary')}</div>` : '';
      return data.items
        .map((h) => {
          const o = open[`handoff:${h.id}`];
          return `<div class="item ${o ? 'open' : ''}">
  <div class="item-head" data-act="handoff" data-id="${esc(h.id)}">${h.auto ? '<span class="badge">auto</span>' : ''}<b>${esc(h.title)}</b><span class="spacer"></span><span class="time">${esc(ago(h.at, now))}</span></div>
  <div class="muted small">${who(h.author.handle, h.author.agent)} · ${esc(h.repo || 'workspace')}${h.to ? ` · to ${esc(h.to)}` : ''}</div>
  ${o ? V.handoffDetail(o.data) : ''}
</div>`;
        })
        .join('') + more;
    },

    handoffDetail(h) {
      if (!h) return empty('Loading…');
      const d = h.data || {};
      const files = (d.files || []).map((f) => (f.note ? `${f.path}: ${f.note}` : f.path));
      const parts = [
        h.goal && section('Goal', `<div class="pre">${esc(h.goal)}</div>`),
        d.summary && section('Summary', `<div class="pre">${esc(d.summary)}</div>`),
        d.done?.length && section('Done', list(d.done)),
        d.decisions?.length && section('Decisions', list(d.decisions)),
        d.next_steps?.length && section('Next steps', list(d.next_steps)),
        d.open_questions?.length && section('Open questions', list(d.open_questions)),
        d.gotchas?.length && section('Gotchas', list(d.gotchas)),
        files.length && section('Files', list(files)),
        d.commits?.length && section('Commits', list(d.commits)),
      ].filter(Boolean);
      return `<div class="detail">${parts.join('')}<div class="row">${button('Delete handoff', 'del', { what: 'handoff', id: h.id }, 'danger')}</div></div>`;
    },

    reviews(items, open, now) {
      if (!items) return empty('Loading…');
      if (!items.length) return empty('No code reviews.');
      return items
        .map((r) => {
          const o = open[`review:${r.id}`];
          return `<div class="item ${o ? 'open' : ''}">
  <div class="item-head" data-act="review" data-id="${esc(r.id)}"><span class="badge status-${esc(r.status)}">${esc(r.status)}</span>${r.verdict ? `<span class="badge">${esc(r.verdict)}</span>` : ''}<b>${esc(r.title)}</b><span class="spacer"></span><span class="time">${esc(ago(r.at, now))}</span></div>
  <div class="muted small">${who(r.requester.handle, r.requester.agent)} → ${esc(r.reviewer || 'unclaimed')} · ${esc(r.findings)} finding(s)${r.repo ? ` · ${esc(r.repo)}` : ''}</div>
  ${o ? V.reviewDetail(o.data, o.diffOpen) : ''}
</div>`;
        })
        .join('');
    },

    reviewDetail(r, diffOpen) {
      if (!r) return empty('Loading…');
      const findings = (r.findings || []).map(
        (f) => `<div class="finding"><span class="badge sev-${esc(f.severity)}">${esc(f.severity || 'note')}</span> <b>${esc(f.title || '')}</b> <span class="muted">${esc(f.file || '')}${f.line ? `:${esc(f.line)}` : ''}</span>${f.detail || f.body ? `<div class="pre">${esc(f.detail || f.body)}</div>` : ''}${f.suggestion ? `<div class="pre muted">${esc(f.suggestion)}</div>` : ''}</div>`,
      );
      return `<div class="detail">
  ${r.focus ? section('Focus', `<div class="pre">${esc(r.focus)}</div>`) : ''}
  ${r.summary ? section('Summary', `<div class="pre">${esc(r.summary)}</div>`) : ''}
  ${findings.length ? section('Findings', findings.join('')) : ''}
  ${r.diff ? `<details data-review="${esc(r.id)}"${diffOpen ? ' open' : ''}><summary>Diff${r.diffTruncated ? ' (first 20,000 characters)' : ''}</summary><pre class="code">${esc(r.diff)}</pre></details>` : ''}
  <div class="row">${button('Delete review', 'del', { what: 'review', id: r.id }, 'danger')}</div>
</div>`;
    },

    notes(items, open, now) {
      if (!items) return empty('Loading…');
      if (!items.length) return empty('No Neurons notes. Agents save their own notes with memory_save.');
      return items
        .map((n) => {
          const o = open[`note:${n.id}`];
          return `<div class="item ${o ? 'open' : ''}">
  <div class="item-head" data-act="note" data-id="${esc(n.id)}"><span class="badge ${agentClass(n.owner)}">${esc(n.owner)}</span>${n.status !== 'active' ? `<span class="badge">${esc(n.status)}</span>` : ''}<b>${esc(n.title)}</b><span class="spacer"></span><span class="time">${esc(ago(n.at, now))}</span></div>
  <div class="muted small">${esc(n.type)} · ${esc(n.scope === 'repo' ? `repo ${n.repo}` : 'global')} · ${esc(n.source)}</div>
  ${o ? V.noteDetail(o.data) : ''}
</div>`;
        })
        .join('');
    },

    noteDetail(n) {
      if (!n) return empty('Loading…');
      return `<div class="detail"><div class="pre">${esc(n.body)}</div>${n.evidence ? `<div class="muted small">evidence: ${esc(n.evidence)}</div>` : ''}${n.tags ? `<div class="muted small">tags: ${esc(n.tags)}</div>` : ''}<div class="row">${button('Delete note', 'del', { what: 'note', id: n.id }, 'danger')}</div></div>`;
    },

    claims(items, now) {
      if (!items) return empty('Loading…');
      if (!items.length) return empty('No file is claimed right now.');
      return items
        .map((c) => `<div class="item"><div class="item-head"><b>${esc(c.repo)}/${esc(c.path)}</b><span class="spacer"></span><span class="time">${esc(minutesLeft(c.expiresAt, now))}</span>${button('Release', 'del', { what: 'claim', id: c.id }, 'secondary')}</div><div class="muted small">${who(c.handle, c.agent)}${c.reason ? ` · ${esc(c.reason)}` : ''} · since ${esc(ago(c.at, now))}</div></div>`)
        .join('');
    },

    storage(st, snap, backups, now) {
      if (!snap) return empty('Loading…');
      const c = snap.counts;
      const info = st?.info || {};
      const rows = CLEARS.map(([what, label, key]) => `<tr><td>${esc(label)}</td><td class="num">${esc(c[key] ?? 0)}</td><td>${(c[key] ?? 0) > 0 ? button('Clear', 'clear', { what }, 'secondary') : ''}</td></tr>`).join('');
      const kept = (backups || []).map((b) => `<tr><td>${esc(ago(b.at, now))}</td><td class="num">${esc(bytes(b.size))}</td><td class="muted small">${esc(b.file)}</td></tr>`).join('');
      return `${section(
        'Database',
        `<table class="kv">
  <tr><td>Database</td><td>${esc(snap.db.path)} ${button('Reveal', 'reveal', { path: snap.db.path }, 'link')}</td></tr>
  <tr><td>Size</td><td>${esc(bytes(snap.db.size))}</td></tr>
  <tr><td>Sessions seen</td><td>${esc(c.sessions)}</td></tr>
  <tr><td>Neurons</td><td>${esc(st?.version || '')} · ${esc(info.platform || '')} · Node ${esc(st?.node || '?')}</td></tr>
</table>`,
      )}
${section('Stored data', `<table class="counts">${rows}</table><div class="row">${button('Delete everything…', 'clear', { what: 'everything' }, 'danger')}</div><div class="hint">Every clear saves a backup of the database first. Agents' own memory files and chats are never touched.</div>`)}
${section('Backups', kept ? `<table class="counts">${kept}</table>` : empty('No backups yet.'), info.backupDir ? ` ${button('Open folder', 'reveal', { path: info.backupDir }, 'link')}` : '')}`;
    },

    // Who talked with whom: one row per pair, newest first; the open one shows the whole exchange as a chat
    conversations(data, open, full, now, searching) {
      if (!data) return empty('Loading…');
      if (!data.items.length) return empty(searching ? 'No conversation matches.' : 'No conversations yet. When agents message each other, every exchange shows up here.');
      const more = data.more ? `<div class="row center">${button('Load more', 'more', {}, 'secondary')}</div>` : '';
      return (
        data.items
        .map((c) => {
          const [a, b] = c.parties;
          const isOpen = open?.key === c.key;
          const last = c.last;
          const text = last.subject ? `${last.subject}: ${last.body}` : last.body;
          return `<div class="item convo-item ${isOpen ? 'open' : ''}">
  <div class="item-head" data-act="convo" data-key="${esc(c.key)}"><span class="route">${who(a.handle || a.agent, a.agent)}<span class="arrow">⇄</span>${who(b.handle || b.agent, b.agent)}</span><span class="spacer"></span><span class="time">${esc(c.count)} · ${esc(ago(c.at, now))}</span></div>
  <div class="preview">${esc(last.from.handle)}: ${esc(String(text || '').replace(/\s+/g, ' ').slice(0, 160))}</div>
  ${isOpen ? V.chat(open.items, a, c.key, full, now) : ''}
</div>`;
        })
        .join('') + more
      );
    },

    // The exchange as chat bubbles: the first party on the left, the other on the right
    chat(items, left, key, full, now) {
      if (!items) return `<div class="chat">${empty('Loading…')}</div>`;
      const leftName = left.handle || left.agent;
      const bubbles = items.map((m) => {
        const body = m.body || '';
        const long = body.length > COLLAPSE_CHARS || body.split('\n').length > COLLAPSE_LINES;
        // Keyed with the time too: ids come back after the newest messages are deleted
        const fullKey = `${m.id}:${m.at}`;
        const open = !!full[fullKey];
        return `<div class="bubble ${m.from.handle === leftName ? 'left' : 'right'} ${agentClass(m.from.agent)}">
  <div class="bubble-head">${who(m.from.handle, m.from.agent)}<span class="badge kind kind-${esc(m.kind)}">${esc(m.kind)}</span><span class="spacer"></span><span class="time">#${esc(m.id)} · ${esc(ago(m.at, now))}</span>${deleteIcon('message', m.id, 'Delete this message and its replies')}</div>
  ${m.subject ? `<div class="msg-subject">${esc(m.subject)}</div>` : ''}
  <div class="msg-body${long && !open ? ' collapsed' : ''}">${esc(body)}</div>
  ${long ? button(open ? 'Show less' : 'Show more', open ? 'less' : 'full', { id: fullKey }, 'link') : ''}
</div>`;
      });
      return `<div class="chat">${bubbles.join('')}<div class="row">${button('Delete conversation', 'delconvo', { key }, 'danger')}</div></div>`;
    },

    tabs(active, counts) {
      const badge = { claims: counts?.liveClaims, reviews: counts?.reviews, notes: counts?.notes };
      return TABS.map(([id, label]) => `<button class="tab ${id === active ? 'active' : ''}" data-act="tab" data-tab="${id}">${esc(label)}${badge[id] ? ` <span class="count">${esc(badge[id])}</span>` : ''}</button>`).join('');
    },

    // Search over every stored message; a conversation shows when any of its messages matches
    searchToolbar(f) {
      const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
      return `<div class="toolbar">
  <input id="q" type="search" placeholder="Search conversations" value="${esc(f.q)}">
  <select id="agent">${opt('', 'All agents', f.agent)}${KNOWN_AGENTS.map((a) => opt(a, a, f.agent)).join('')}</select>
  <select id="kind">${opt('', 'All kinds', f.kind)}${KINDS.map((k) => opt(k, k, f.kind)).join('')}</select>
</div>`;
    },
  };

  // ---------- controller (DOM, messaging)

  function init() {
    const app = document.getElementById('app');
    const sidebar = document.body.dataset.mode === 'sidebar';
    const S = { tab: 'live', st: null, snap: null, agents: null, convos: null, convo: null, handoffs: null, reviews: null, notes: null, claims: null, backups: null, open: {}, full: {}, filters: { q: '', agent: '', kind: '' }, convoLimit: 50, handoffLimit: 50, shown: null, agentsOpen: false, visible: true };

    let seq = 0;
    const waiting = new Map();
    const rpc = (cmd, args = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        vscode.postMessage({ type: 'rpc', id, cmd, args });
      });

    app.innerHTML = `<header class="top"><span class="title">Neurons</span><span class="live-count" id="live"></span><span class="spacer"></span>${sidebar ? button('Open in editor', 'openPanel', {}, 'link') : ''}</header><div id="banner"></div><nav class="tabs" id="tabs"></nav><div id="toolbar"></div><main id="content"></main><section id="canvas-view" class="canvas-view" hidden><div id="canvas" class="nc-root"></div><aside id="agents-drawer" class="agents-drawer" hidden></aside></section><div id="toast" class="toast"></div>`;
    const $ = (id) => document.getElementById(id);

    function toast(text, bad) {
      const t = $('toast');
      t.textContent = text;
      t.className = `toast show${bad ? ' bad' : ''}`;
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => (t.className = 'toast'), 4000);
    }

    function renderFrame() {
      $('banner').innerHTML = V.banner(S.st);
      $('tabs').innerHTML = V.tabs(S.tab, S.snap?.counts);
      const chats = S.snap?.graph?.nodes.length || 0;
      const lines = S.snap?.graph?.lines.length || 0;
      $('live').textContent = S.snap ? `${chats} chat${chats === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'}` : '';
      $('live').className = `live-count${chats ? ' on' : ''}`;
    }

    function renderToolbar() {
      $('toolbar').innerHTML = S.tab === 'conversations' ? V.searchToolbar(S.filters) : '';
    }

    // Everything the current tab's content is drawn from; a reload that changes none of it leaves the DOM (and the
    // user's selection, scroll and open details) alone
    const contentSig = () =>
      JSON.stringify([
        S.tab,
        ...({
          live: [S.snap?.graph, S.detected, S.agents, S.agentsOpen],
          conversations: [S.convos, S.convo, S.full, S.filters],
          handoffs: [S.handoffs, S.open],
          reviews: [S.reviews, S.open],
          notes: [S.notes, S.open],
          claims: [S.claims],
          storage: [S.st, S.snap?.counts, S.snap?.db, S.backups],
        }[S.tab] || []),
      ]);

    // A message over the length limit that still fits in the collapsed height is shown whole, without fade or button
    function settleCollapsed() {
      for (const el of $('content').querySelectorAll('.msg-body.collapsed')) {
        if (!el.clientHeight || el.scrollHeight > el.clientHeight + 1) continue;
        el.classList.remove('collapsed');
        if (el.nextElementSibling?.dataset.act === 'full') el.nextElementSibling.remove();
      }
    }

    // The canvas (React Flow, media/canvas.js) is mounted once and fed each snapshot; it talks back through this bridge
    let canvas = null;
    const canvasApi = {
      link: (from, to, fromSide, toSide) =>
        rpc('link', { from, to, fromSide, toSide })
          .then(load)
          .catch((err) => toast(err.message, true)),
      hangup: (line) =>
        rpc('hangup', { line })
          .then(load)
          .catch((err) => toast(err.message, true)),
      openConversation: (key) => {
        S.tab = 'conversations';
        S.open = {};
        S.convo = { key, items: null };
        renderToolbar();
        renderContent();
        load();
      },
      // A chat's ⚙ settings, a provider turned off or on, and the user's answer to an Ask first message
      sendMode: (id, mode) =>
        rpc('sendMode', { id, mode })
          .then(load)
          .catch((err) => toast(err.message, true)),
      role: (id, role) =>
        rpc('role', { id, role })
          .then(load)
          .catch((err) => toast(err.message, true)),
      wake: (id, on) =>
        rpc('wake', { id, on })
          .then(load)
          .catch((err) => toast(err.message, true)),
      agentOff: (agent, off) =>
        rpc('agentOff', { agent, off })
          .then((r) => {
            toast(off ? `Turned off in Neurons${r?.ended ? `; ${r.ended} line(s) ended` : ''}. Turn it back on in Agents setup.` : 'Turned on in Neurons.');
            return load();
          })
          .catch((err) => toast(err.message, true)),
      decideAsk: (id, allow) =>
        rpc('decideAsk', { id, allow, by: 'dashboard' })
          .then((r) => {
            if (r?.status !== (allow ? 'allowed' : 'denied')) toast(`That message was already ${r?.status === 'cancelled' ? 'dropped (its line ended)' : r?.status}.`, true);
            return load();
          })
          .catch((err) => toast(err.message, true)),
      toggleAgents: () => {
        S.agentsOpen = !S.agentsOpen;
        renderContent();
        if (S.agentsOpen) load();
      },
      getState: () => vscode.getState(),
      setState: (state) => vscode.setState(state),
      report: (text) => vscode.postMessage({ type: 'log', text }),
    };

    // The canvas animates only while it is on screen, and only messages written after it came on screen
    function renderCanvas() {
      if (!canvas && window.NeuronsCanvas) canvas = window.NeuronsCanvas.mount($('canvas'), canvasApi, sidebar ? 'sidebar' : 'panel');
      canvas?.setVisible(S.visible);
      if (S.snap) canvas?.update({ ...S.snap, detected: S.detected || [] });
      const drawer = $('agents-drawer');
      drawer.hidden = !S.agentsOpen;
      if (S.agentsOpen) drawer.innerHTML = `<div class="drawer-head"><b>Agents setup</b><span class="spacer"></span>${button('Close', 'agents', {}, 'link')}</div>${V.agents(S.agents, S.snap?.graph, S.snap?.settings?.disabledAgents)}`;
    }

    // Colors set through the CSSOM: the page's CSP forbids style attributes in markup
    function paintHues() {
      for (const el of $('content').querySelectorAll('[data-hue]')) el.style.setProperty('--chat-hue', el.dataset.hue);
    }

    function renderContent() {
      S.shown = contentSig();
      // The graph is drawn in the editor; the sidebar's Live tab lists chats and lines and opens it
      const live = S.tab === 'live' && !sidebar;
      document.body.classList.toggle('canvas-mode', live);
      if (!live) canvas?.setVisible(false);
      $('canvas-view').hidden = !live;
      $('content').hidden = live;
      if (live) {
        renderCanvas();
        return renderFrame();
      }
      const now = Date.now();
      let html = '';
      if (S.tab === 'live') {
        const graph = S.snap?.graph;
        const hues = window.NeuronsCanvas?.hues([...(graph?.nodes || []).map((n) => n.id)]) || {};
        html = V.live(graph, hues, now) + section('Agents', V.agents(S.agents, graph, S.snap?.settings?.disabledAgents));
      } else if (S.tab === 'conversations') html = V.conversations(S.convos, S.convo, S.full, now, !!(S.filters.q || S.filters.agent || S.filters.kind));
      else if (S.tab === 'handoffs') html = V.handoffs(S.handoffs, S.open, now);
      else if (S.tab === 'reviews') html = V.reviews(S.reviews, S.open, now);
      else if (S.tab === 'notes') html = V.notes(S.notes, S.open, now);
      else if (S.tab === 'claims') html = V.claims(S.claims, now);
      else html = V.storage(S.st, S.snap, S.backups, now);
      $('content').innerHTML = html;
      paintHues();
      settleCollapsed();
      renderFrame();
    }

    const OPENERS = { handoff: 'handoff', review: 'review', note: 'note' };

    async function load() {
      if (!S.st || S.st.problem) return renderContent();
      const jobs = [rpc('snapshot').then((d) => (S.snap = d))];
      if (S.tab === 'live' && (S.agentsOpen || sidebar)) jobs.push(rpc('agents').then((d) => (S.agents = d)));
      if (S.tab === 'live' && !sidebar) jobs.push(rpc('chats').then((d) => (S.detected = d)));
      if (S.tab === 'conversations') jobs.push(rpc('conversations', { ...S.filters, limit: S.convoLimit }).then((d) => (S.convos = d)));
      // Answers land on the object they were asked for, so one opened meanwhile never shows another's messages
      const convo = S.tab === 'conversations' && S.convo;
      if (convo) jobs.push(rpc('conversation', { key: convo.key }).then((d) => (convo.items = d)));
      if (S.tab === 'handoffs') jobs.push(rpc('handoffs', { limit: S.handoffLimit }).then((d) => (S.handoffs = d)));
      if (S.tab === 'reviews') jobs.push(rpc('reviews').then((d) => (S.reviews = d)));
      if (S.tab === 'notes') jobs.push(rpc('notes').then((d) => (S.notes = d)));
      if (S.tab === 'claims') jobs.push(rpc('claims').then((d) => (S.claims = d)));
      if (S.tab === 'storage') jobs.push(rpc('backups').then((d) => (S.backups = d)));
      for (const [key, entry] of Object.entries(S.open)) {
        const [kind, id] = key.split(':');
        jobs.push(rpc(OPENERS[kind], { id: Number(id) }).then((d) => (entry.data = d)));
      }
      const results = await Promise.allSettled(jobs);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) toast(failed.reason.message, true);
      if (contentSig() === S.shown) renderFrame();
      else renderContent();
    }

    let pending = null;
    const scheduleLoad = () => {
      clearTimeout(pending);
      pending = setTimeout(load, 250);
    };

    // Closing a row while it loads is fine: the answer lands on the entry it was asked for, which is gone
    async function toggle(kind, id) {
      const key = `${kind}:${id}`;
      if (S.open[key]) {
        delete S.open[key];
        return renderContent();
      }
      const entry = (S.open[key] = { data: null });
      renderContent();
      try {
        entry.data = await rpc(OPENERS[kind], { id });
      } catch (err) {
        if (S.open[key] === entry) delete S.open[key];
        toast(err.message, true);
      }
      renderContent();
    }

    const describe = (counts) =>
      Object.entries(counts || {})
        .filter(([, n]) => n)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ') || 'nothing';

    async function act(el) {
      const { act: action, id, what, tab, path, key } = el.dataset;
      const num = id !== undefined ? Number(id) : undefined;
      try {
        if (action === 'tab') {
          S.tab = tab;
          S.open = {};
          S.convo = null;
          renderToolbar();
          renderContent();
          return load();
        }
        if (action === 'handoff' || action === 'review' || action === 'note') return toggle(action, num);
        if (action === 'less') {
          delete S.full[id];
          return renderContent();
        }
        if (action === 'full') {
          S.full[id] = true;
          return renderContent();
        }
        if (action === 'more') {
          S.convoLimit += 50;
          return load();
        }
        if (action === 'morehandoffs') {
          S.handoffLimit += 50;
          return load();
        }
        if (action === 'del') {
          const res = await rpc('delete', { what, id: num });
          delete S.open[`${what}:${num}`];
          toast(what === 'claim' ? 'Claim released.' : `Deleted ${describe(res)}.`);
          return load();
        }
        if (action === 'clear') {
          const res = await rpc('clear', { what });
          if (res?.cancelled) return;
          S.open = {};
          toast(`Deleted ${describe(res.deleted)}. Backup saved.`);
          return load();
        }
        if (action === 'convo') {
          S.convo = S.convo?.key === key ? null : { key, items: null };
          renderContent();
          return load();
        }
        if (action === 'delconvo') {
          const res = await rpc('delete', { what: 'conversation', key });
          S.convo = null;
          toast(`Deleted ${describe(res)}.`);
          return load();
        }
        if (action === 'agents') return canvasApi.toggleAgents();
        if (action === 'ask') return canvasApi.decideAsk(num, el.dataset.allow === '1');
        if (action === 'agentOff' || action === 'agentOn') {
          el.disabled = true;
          return canvasApi.agentOff(id, action === 'agentOff');
        }
        if (action === 'connect' || action === 'disconnect') {
          el.disabled = true;
          S.agents = await rpc(action, { id: el.dataset.id });
          return renderContent();
        }
        if (['reveal', 'logs', 'settings', 'openPanel', 'retry'].includes(action)) return rpc(action, { path });
      } catch (err) {
        toast(err.message, true);
        renderContent();
      }
    }

    app.addEventListener('click', (e) => {
      if (e.target.closest('summary')) return;
      const el = e.target.closest('[data-act]');
      if (!el) return;
      // A button inside a clickable row acts on its own, without toggling the row
      e.stopPropagation();
      act(el);
    });

    // A review's Diff stays open across reloads
    app.addEventListener(
      'toggle',
      (e) => {
        const id = e.target.dataset?.review;
        const entry = id && S.open[`review:${id}`];
        if (entry) entry.diffOpen = e.target.open;
      },
      true,
    );

    // Script errors show up in the Neurons output instead of disappearing
    window.addEventListener('error', (e) => vscode.postMessage({ type: 'log', text: e.error?.stack || e.message }));
    window.addEventListener('unhandledrejection', (e) => vscode.postMessage({ type: 'log', text: String(e.reason?.stack || e.reason) }));
    if (!window.NeuronsCanvas) vscode.postMessage({ type: 'log', text: 'canvas.js did not load' });

    // On screen or not: the editor says so for the panel and the sidebar view, and the page itself as a fallback
    function shown(visible) {
      if (visible === S.visible) return;
      S.visible = visible;
      document.body.classList.toggle('paused', !visible);
      if (S.tab === 'live') canvas?.setVisible(visible);
    }
    document.addEventListener('visibilitychange', () => shown(document.visibilityState === 'visible'));

    let typing = null;
    app.addEventListener('input', (e) => {
      if (e.target.id !== 'q') return;
      clearTimeout(typing);
      typing = setTimeout(() => {
        S.filters.q = e.target.value.trim();
        S.convoLimit = 50;
        load();
      }, 300);
    });
    app.addEventListener('change', (e) => {
      if (e.target.id !== 'agent' && e.target.id !== 'kind') return;
      S.filters[e.target.id] = e.target.value;
      S.convoLimit = 50;
      load();
    });

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'rpc') {
        const w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        m.ok ? w.resolve(m.data) : w.reject(new Error(m.error));
      } else if (m.type === 'changed') scheduleLoad();
      else if (m.type === 'visibility') shown(m.visible);
      else if (m.type === 'state') {
        S.st = m;
        renderFrame();
        load();
      }
    });

    // Relative times ("2m ago") stay current without refetching, unless the user is typing or selecting text (the canvas
    // keeps its own clock)
    setInterval(() => S.tab !== 'live' && document.activeElement?.id !== 'q' && document.getSelection()?.isCollapsed !== false && renderContent(), 30000);
    renderToolbar();
    renderContent();
    vscode.postMessage({ type: 'ready' });
  }

  if (vscode) init();
  else if (typeof module !== 'undefined') module.exports = { V, esc, ago, bytes };
})();
