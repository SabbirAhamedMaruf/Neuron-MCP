// Neurons dashboard webview. The extension host fetches everything from the Neurons backend; this file only renders it.
// Every value that comes from the database is escaped, and the page's CSP allows no inline script or style.
(function () {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  const KNOWN_AGENTS = ['claude', 'codex', 'gemini', 'opencode'];
  const KINDS = ['question', 'reply', 'note', 'proposal', 'review', 'review-result', 'handoff', 'call'];
  const TABS = [
    ['live', 'Live'],
    ['history', 'History'],
    ['handoffs', 'Handoffs'],
    ['reviews', 'Reviews'],
    ['notes', 'Notes'],
    ['claims', 'Claims'],
    ['storage', 'Storage'],
  ];
  const CLEARS = [
    ['messages', 'Messages and replies', 'messages'],
    ['handoffs', 'Handoffs', 'handoffs'],
    ['auto-handoffs', 'Automatic handoffs', 'autoHandoffs'],
    ['reviews', 'Code reviews', 'reviews'],
    ['claims', 'File claims', 'claims'],
    ['notes', 'Neurons notes', 'notes'],
    ['embeddings', 'Semantic search cache', 'embeddings'],
    ['calls', 'Call log', 'calls'],
  ];
  const BODY_CLIP = 600;

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
  const secondsLeft = (ms, now = Date.now()) => `${Math.max(0, Math.round((ms - now) / 1000))}s left`;
  const folder = (repo) => String(repo || '').split(/[\\/]/).filter(Boolean).pop() || '';

  function bytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  const agentClass = (a) => (KNOWN_AGENTS.includes(a) ? `agent-${a}` : 'agent-other');
  const who = (handle, agent) => `<span class="who ${agentClass(agent)}">${esc(handle || agent || 'unknown')}</span>`;
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
      if (a.connected) return { text: a.hooksWanted ? `Connected · MCP + ${a.hooks}/${a.hooksWanted} hooks` : 'Connected · MCP (this agent has no hooks)', cls: 'ok', actions: [['Disconnect', 'disconnect', 'secondary']] };
      if (a.registered && a.current && a.outdated) return { text: 'Settings out of date (tool timeout too short for listen mode)', cls: 'warn', actions: [['Repair', 'connect', ''], ['Disconnect', 'disconnect', 'secondary']] };
      if (a.registered && !a.current) return { text: `Connected to another Neurons build: ${a.serverPath}`, cls: 'warn', actions: [['Use this build', 'connect', ''], ['Disconnect', 'disconnect', 'secondary']] };
      if (a.registered) return { text: `Hooks missing (${a.hooks}/${a.hooksWanted})`, cls: 'warn', actions: [['Repair', 'connect', ''], ['Disconnect', 'disconnect', 'secondary']] };
      if (!a.installed) return { text: 'Not found on this machine', cls: 'muted', actions: [['Connect anyway', 'connect', 'secondary']] };
      return { text: 'Not connected', cls: 'muted', actions: [['Connect', 'connect', '']] };
    },

    agents(agents, connected, now) {
      if (!agents) return empty('Looking for agents…');
      const live = connected || [];
      const known = new Set(agents.map((a) => a.id));
      const rows = agents.map((a) => {
        const sessions = live.filter((s) => s.agent === a.id);
        const state = V.agentState(a);
        return `<div class="agent ${agentClass(a.id)}">
  <div class="agent-head"><span class="dot ${sessions.length ? 'on' : ''}"></span><b>${esc(a.name)}</b><span class="muted">${sessions.length ? `${sessions.length} running` : 'not running'}</span></div>
  <div class="agent-state ${state.cls}">${esc(state.text)}</div>
  ${a.id === 'codex' && a.connected ? `<div class="hint">Codex runs new hooks only after you trust them: open <code>/hooks</code> in Codex once.</div>` : ''}
  <div class="row">${state.actions.map(([label, act, cls]) => button(label, act, { id: a.id }, cls)).join('')}</div>
  ${sessions.map((s) => V.session(s, now)).join('')}
</div>`;
      });
      const others = live.filter((s) => !known.has(s.agent));
      if (others.length) rows.push(`<div class="agent agent-other"><div class="agent-head"><span class="dot on"></span><b>Other agents</b></div>${others.map((s) => V.session(s, now)).join('')}</div>`);
      return rows.join('');
    },

    session(s, now) {
      const bits = [s.model, s.repo, s.task].filter(Boolean).map(esc).join(' · ');
      const listening = s.listening ? ' <span class="badge listen">listening</span>' : '';
      const auto = s.handle ? button(s.autoAnswer ? 'Auto-answer on' : 'Auto-answer off', 'auto', { handle: s.handle, on: s.autoAnswer ? 0 : 1 }, `toggle${s.autoAnswer ? ' on' : ''}`) : '';
      return `<div class="session"><div class="session-line">${who(s.handle || `${s.agent} (starting)`, s.agent)}${listening}<span class="spacer"></span>${auto}</div>${bits ? `<div class="muted small">${bits}</div>` : ''}<div class="time">since ${esc(ago(s.since, now))}</div></div>`;
    },

    // The switch beside the Agents heading: agents with hooks keep listening after each turn
    autoListen(on) {
      return ` ${button(on ? 'Auto-listen on' : 'Auto-listen off', 'autolisten', { on: on ? 0 : 1 }, `toggle${on ? ' on' : ''}`)}`;
    },

    // Ringing calls with one Accept button per session that could take it, then the open lines
    calls(c, now) {
      if (!c || (!c.ringing.length && !c.lines.length)) return '';
      const ringing = c.ringing.map((r) => {
        const accept = r.candidates.length
          ? r.candidates.map((s) => button(['Accept on ' + s.handle, folder(s.repo), s.seen ? `used ${ago(s.seen, now)}` : ''].filter(Boolean).join(' · '), 'answer', { call: r.id, handle: s.handle })).join('')
          : '<span class="muted small">No session of this agent has started yet.</span>';
        return `<div class="call ringing">
  <div class="call-head"><span class="badge ring">ringing</span><span class="route">${who(r.from.handle, r.from.agent)}<span class="arrow">→</span>${who(r.to.handle || r.to.agent, r.to.agent)}</span><span class="spacer"></span><span class="time">#${esc(r.id)} · <span class="countdown" data-until="${esc(r.until)}">${esc(secondsLeft(r.until, now))}</span></span></div>
  ${r.preview ? `<div class="preview">${esc(r.preview)}</div>` : ''}
  <div class="row">${accept}${button('Decline', 'hangup', { call: r.id }, 'secondary')}</div>
</div>`;
      });
      const lines = c.lines.map(
        (l) => `<div class="call line">
  <div class="call-head"><span class="badge line">line</span><span class="route">${who(l.from.handle, l.from.agent)}<span class="arrow">⇄</span>${who(l.to.handle, l.to.agent)}</span><span class="spacer"></span><span class="time">#${esc(l.id)} · ${esc(ago(l.since, now))} · ${esc(l.how)}</span>${button('Hang up', 'hangup', { call: l.id }, 'secondary')}</div>
</div>`,
      );
      return section('Calls', [...ringing, ...lines].join(''));
    },

    message(m, { now, full, actions = true } = {}) {
      const to = m.to.handle || (m.to.agent === 'any' ? 'any agent' : m.to.agent);
      const body = m.body || '';
      const long = body.length > BODY_CLIP && !full;
      return `<div class="msg kind-${esc(m.kind)}">
  <div class="msg-head"><span class="badge kind">${esc(m.kind)}</span>${m.group ? '<span class="badge">second opinion</span>' : ''} ${who(m.from.handle, m.from.agent)} <span class="arrow">→</span> ${who(to, m.to.agent)}${m.replyTo ? ` <span class="muted">re #${esc(m.replyTo)}</span>` : ''}<span class="spacer"></span><span class="time">#${esc(m.id)} · ${esc(ago(m.at, now))}</span>${actions ? deleteIcon('message', m.id, 'Delete this message and its replies') : ''}</div>
  ${m.subject ? `<div class="msg-subject">${esc(m.subject)}</div>` : ''}
  <div class="msg-body">${esc(long ? `${body.slice(0, BODY_CLIP)}…` : body)}</div>
  ${long ? button('Show all', 'full', { id: m.id }, 'link') : ''}
  ${m.refs && m.refs.length ? `<div class="muted small">refs: ${esc(m.refs.join(', '))}</div>` : ''}
</div>`;
    },

    feedRow(m, open, now) {
      const to = m.to.handle || (m.to.agent === 'any' ? 'any agent' : m.to.agent);
      const text = m.subject ? `${m.subject}: ${m.body}` : m.body;
      return `<div class="feed-row ${open ? 'open' : ''}" data-act="thread" data-id="${esc(m.id)}">
  <div class="feed-head"><span class="badge kind kind-${esc(m.kind)}">${esc(m.kind)}</span><span class="route">${who(m.from.handle, m.from.agent)}<span class="arrow">→</span>${who(to, m.to.agent)}</span><span class="spacer"></span><span class="time">${esc(ago(m.at, now))}</span>${deleteIcon('message', m.id, 'Delete this message and its replies')}</div>
  <div class="preview">${esc(String(text || '').replace(/\s+/g, ' ').slice(0, 200))}</div>
</div>`;
    },

    thread(items, rootId, { now, full }) {
      if (!items) return `<div class="thread">${empty('Loading…')}</div>`;
      if (!items.length) return `<div class="thread">${empty('This conversation was deleted.')}</div>`;
      return `<div class="thread">${items.map((m) => V.message(m, { now, full: full[m.id] })).join('')}<div class="row">${button('Delete whole conversation', 'del', { what: 'thread', id: rootId }, 'danger')}</div></div>`;
    },

    feed(items, open, full, now) {
      if (!items || !items.length) return empty('No messages yet. When agents ask each other something, it shows up here live.');
      return items.map((m) => V.feedRow(m, !!open[`thread:${m.id}`], now) + (open[`thread:${m.id}`] ? V.thread(open[`thread:${m.id}`].data, m.id, { now, full }) : '')).join('');
    },

    handoffs(data, open, now) {
      if (!data) return empty('Loading…');
      if (!data.items.length) return empty('No handoffs.');
      return data.items
        .map((h) => {
          const o = open[`handoff:${h.id}`];
          return `<div class="item ${o ? 'open' : ''}">
  <div class="item-head" data-act="handoff" data-id="${esc(h.id)}">${h.auto ? '<span class="badge">auto</span>' : ''}<b>${esc(h.title)}</b><span class="spacer"></span><span class="time">${esc(ago(h.at, now))}</span></div>
  <div class="muted small">${who(h.author.handle, h.author.agent)} · ${esc(h.repo || 'workspace')}${h.to ? ` · to ${esc(h.to)}` : ''}</div>
  ${o ? V.handoffDetail(o.data) : ''}
</div>`;
        })
        .join('');
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
  ${o ? V.reviewDetail(o.data) : ''}
</div>`;
        })
        .join('');
    },

    reviewDetail(r) {
      if (!r) return empty('Loading…');
      const findings = (r.findings || []).map(
        (f) => `<div class="finding"><span class="badge sev-${esc(f.severity)}">${esc(f.severity || 'note')}</span> <b>${esc(f.title || '')}</b> <span class="muted">${esc(f.file || '')}${f.line ? `:${esc(f.line)}` : ''}</span>${f.detail || f.body ? `<div class="pre">${esc(f.detail || f.body)}</div>` : ''}${f.suggestion ? `<div class="pre muted">${esc(f.suggestion)}</div>` : ''}</div>`,
      );
      return `<div class="detail">
  ${r.focus ? section('Focus', `<div class="pre">${esc(r.focus)}</div>`) : ''}
  ${r.summary ? section('Summary', `<div class="pre">${esc(r.summary)}</div>`) : ''}
  ${findings.length ? section('Findings', findings.join('')) : ''}
  ${r.diff ? `<details><summary>Diff${r.diffTruncated ? ' (first 20,000 characters)' : ''}</summary><pre class="code">${esc(r.diff)}</pre></details>` : ''}
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
${section('History', `<table class="counts">${rows}</table><div class="row">${button('Delete everything…', 'clear', { what: 'everything' }, 'danger')}</div><div class="hint">Every clear saves a backup of the database first. Agents' own memory files and chats are never touched.</div>`)}
${section('Backups', kept ? `<table class="counts">${kept}</table>` : empty('No backups yet.'), info.backupDir ? ` ${button('Open folder', 'reveal', { path: info.backupDir }, 'link')}` : '')}`;
    },

    history(h, open, full, now) {
      const more = h.more ? button('Load more', 'more', {}, 'secondary') : '';
      const clear = h.items.length ? button('Delete all history…', 'clear', { what: 'messages' }, 'danger') : '';
      return `${V.feed(h.items, open, full, now)}${more || clear ? `<div class="row center">${more}${clear}</div>` : ''}`;
    },

    tabs(active, counts) {
      const badge = { claims: counts?.liveClaims, reviews: counts?.reviews, notes: counts?.notes };
      return TABS.map(([id, label]) => `<button class="tab ${id === active ? 'active' : ''}" data-act="tab" data-tab="${id}">${esc(label)}${badge[id] ? ` <span class="count">${esc(badge[id])}</span>` : ''}</button>`).join('');
    },

    historyToolbar(f) {
      const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
      return `<div class="toolbar">
  <input id="q" type="search" placeholder="Search messages" value="${esc(f.q)}">
  <select id="agent">${opt('', 'All agents', f.agent)}${KNOWN_AGENTS.map((a) => opt(a, a, f.agent)).join('')}</select>
  <select id="kind">${opt('', 'All kinds', f.kind)}${KINDS.map((k) => opt(k, k, f.kind)).join('')}</select>
</div>`;
    },
  };

  // ---------- controller (DOM, messaging)

  function init() {
    const app = document.getElementById('app');
    const sidebar = document.body.dataset.mode === 'sidebar';
    const S = { tab: 'live', st: null, snap: null, agents: null, history: null, handoffs: null, reviews: null, notes: null, claims: null, backups: null, open: {}, full: {}, filters: { q: '', agent: '', kind: '' }, historyLimit: 50 };

    let seq = 0;
    const waiting = new Map();
    const rpc = (cmd, args = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        vscode.postMessage({ type: 'rpc', id, cmd, args });
      });

    app.innerHTML = `<header class="top"><span class="title">Neurons</span><span class="live-count" id="live"></span><span class="spacer"></span>${sidebar ? button('Open in editor', 'openPanel', {}, 'link') : ''}</header><div id="banner"></div><nav class="tabs" id="tabs"></nav><div id="toolbar"></div><main id="content"></main><div id="toast" class="toast"></div>`;
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
      const live = S.snap?.connected?.length || 0;
      const ringing = S.snap?.calls?.ringing?.length || 0;
      $('live').textContent = S.snap ? `${live} connected${ringing ? ` · ${ringing} ringing` : ''}` : '';
      $('live').className = `live-count${ringing ? ' ring' : live ? ' on' : ''}`;
    }

    function renderToolbar() {
      $('toolbar').innerHTML = S.tab === 'history' ? V.historyToolbar(S.filters) : '';
    }

    function renderContent() {
      const now = Date.now();
      let html = '';
      if (S.tab === 'live') html = V.calls(S.snap?.calls, now) + section('Agents', V.agents(S.agents, S.snap?.connected, now), S.snap ? V.autoListen(S.snap.autoListen) : '') + section('Live feed', V.feed(S.snap?.feed, S.open, S.full, now));
      else if (S.tab === 'history') html = S.history ? V.history(S.history, S.open, S.full, now) : empty('Loading…');
      else if (S.tab === 'handoffs') html = V.handoffs(S.handoffs, S.open, now);
      else if (S.tab === 'reviews') html = V.reviews(S.reviews, S.open, now);
      else if (S.tab === 'notes') html = V.notes(S.notes, S.open, now);
      else if (S.tab === 'claims') html = V.claims(S.claims, now);
      else html = V.storage(S.st, S.snap, S.backups, now);
      $('content').innerHTML = html;
      renderFrame();
    }

    const OPENERS = { thread: 'thread', handoff: 'handoff', review: 'review', note: 'note' };

    async function load() {
      if (!S.st || S.st.problem) return renderContent();
      const jobs = [rpc('snapshot').then((d) => (S.snap = d))];
      if (S.tab === 'live') jobs.push(rpc('agents').then((d) => (S.agents = d)));
      if (S.tab === 'history') jobs.push(rpc('history', { ...S.filters, limit: S.historyLimit }).then((d) => (S.history = d)));
      if (S.tab === 'handoffs') jobs.push(rpc('handoffs').then((d) => (S.handoffs = d)));
      if (S.tab === 'reviews') jobs.push(rpc('reviews').then((d) => (S.reviews = d)));
      if (S.tab === 'notes') jobs.push(rpc('notes').then((d) => (S.notes = d)));
      if (S.tab === 'claims') jobs.push(rpc('claims').then((d) => (S.claims = d)));
      if (S.tab === 'storage') jobs.push(rpc('backups').then((d) => (S.backups = d)));
      for (const key of Object.keys(S.open)) {
        const [kind, id] = key.split(':');
        jobs.push(rpc(OPENERS[kind], { id: Number(id) }).then((d) => S.open[key] && (S.open[key].data = d)));
      }
      const results = await Promise.allSettled(jobs);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) toast(failed.reason.message, true);
      renderContent();
    }

    let pending = null;
    const scheduleLoad = () => {
      clearTimeout(pending);
      pending = setTimeout(load, 250);
    };

    async function toggle(kind, id) {
      const key = `${kind}:${id}`;
      if (S.open[key]) delete S.open[key];
      else {
        S.open[key] = { data: null };
        renderContent();
        try {
          S.open[key].data = await rpc(OPENERS[kind], { id });
        } catch (err) {
          delete S.open[key];
          toast(err.message, true);
        }
      }
      renderContent();
    }

    const describe = (counts) =>
      Object.entries(counts || {})
        .filter(([, n]) => n)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ') || 'nothing';

    async function act(el) {
      const { act: action, id, what, tab, path, call, handle, on } = el.dataset;
      const num = id !== undefined ? Number(id) : undefined;
      try {
        if (action === 'tab') {
          S.tab = tab;
          S.open = {};
          renderToolbar();
          renderContent();
          return load();
        }
        if (action === 'thread' || action === 'handoff' || action === 'review' || action === 'note') return toggle(action, num);
        if (action === 'full') {
          S.full[num] = true;
          return renderContent();
        }
        if (action === 'more') {
          S.historyLimit += 50;
          return load();
        }
        if (action === 'del') {
          const res = await rpc('delete', { what, id: num });
          toast(what === 'claim' ? 'Claim released.' : `Deleted ${describe(res)}.`);
          return load();
        }
        if (action === 'clear') {
          const res = await rpc('clear', { what });
          if (res?.cancelled) return;
          toast(`Deleted ${describe(res.deleted)}. Backup saved.`);
          return load();
        }
        if (action === 'answer') {
          el.disabled = true;
          await rpc('answer', { call: Number(call), handle });
          toast(`${handle} picked up call #${call}. It reads the message on its next turn, or right away if it is listening.`);
          return load();
        }
        if (action === 'hangup') {
          await rpc('hangup', { call: Number(call) });
          return load();
        }
        if (action === 'autolisten') {
          await rpc('setAutoListen', { on: on === '1' });
          toast(on === '1' ? 'Agents keep listening after each turn. Press Stop (or Esc) in an agent to give it new work.' : 'Agents stop after each turn again.');
          return load();
        }
        if (action === 'auto') {
          await rpc('autoAnswer', { handle, on: on === '1' });
          return load();
        }
        if (action === 'connect' || action === 'disconnect') {
          el.disabled = true;
          S.agents = await rpc(action, { id: el.dataset.id });
          return renderContent();
        }
        if (['reveal', 'logs', 'settings', 'openPanel', 'retry'].includes(action)) return rpc(action === 'openPanel' ? 'openPanel' : action, { path });
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

    let typing = null;
    app.addEventListener('input', (e) => {
      if (e.target.id !== 'q') return;
      clearTimeout(typing);
      typing = setTimeout(() => {
        S.filters.q = e.target.value.trim();
        S.historyLimit = 50;
        load();
      }, 300);
    });
    app.addEventListener('change', (e) => {
      if (e.target.id !== 'agent' && e.target.id !== 'kind') return;
      S.filters[e.target.id] = e.target.value;
      S.historyLimit = 50;
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
      else if (m.type === 'state') {
        S.st = m;
        renderFrame();
        load();
      }
    });

    // Relative times ("2m ago") stay current without refetching; a ringing call's countdown ticks in place, so buttons stay clickable
    setInterval(() => document.activeElement?.id !== 'q' && renderContent(), 30000);
    setInterval(() => document.querySelectorAll('.countdown').forEach((el) => (el.textContent = secondsLeft(Number(el.dataset.until)))), 1000);
    renderToolbar();
    renderContent();
    vscode.postMessage({ type: 'ready' });
  }

  if (vscode) init();
  else if (typeof module !== 'undefined') module.exports = { V, esc, ago, bytes };
})();
