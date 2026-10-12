// The Live tab's connection canvas (React Flow): every open chat is a node, every line the user drew is an edge.
// Drag from one chat's handle to another to connect them; select a line and press Delete (or its ×) to hang up.
// dashboard.js owns the data and the backend; it mounts this once and pushes each snapshot with update().
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Component, createElement, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './canvas.css';
import { AGENT_ICONS, GEAR_ICON, agentIconSvg } from './icons.js';

const AGENTS = {
  claude: { name: 'Claude Code', order: 0 },
  codex: { name: 'Codex', order: 1 },
  gemini: { name: 'Gemini CLI', order: 2 },
  opencode: { name: 'OpenCode', order: 3 },
  ollama: { name: 'Ollama', order: 4 },
  lmstudio: { name: 'LM Studio', order: 5 },
};
const agentName = (a) => AGENTS[a]?.name || a || 'Agent';
// A time of day ("3:19 PM"), with the date when it is not today
const clock = (ms) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
};
const agentKey = (a) => (AGENTS[a] ? a : 'other');
const SURFACES = { editor: 'Editor panel', terminal: 'Terminal', app: 'App' };

// A line glows for this long after its last message
const LIVE_MS = 20 * 1000;
// One message's dot takes this long to travel the line; several at once leave this far apart
const FLIGHT_MS = 1200;
const STAGGER_MS = 320;
// More new messages than this at once (a burst) send this many dots, not one each
const MAX_FLIGHTS = 8;
const COLUMN = 340;
const ROW = 210;

function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Every chat has its own color, the same each time: a hue from its id (theme decides lightness, in CSS)
function hueOf(key) {
  let h = 2166136261;
  for (const ch of String(key || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h) % 360;
}
const chatColor = (hue) => `hsl(${hue} var(--nc-chat-s) var(--nc-chat-l))`;

// Hues for the chats on screen, at least MIN_HUE_GAP apart: each keeps its own hue unless a neighbour already holds a
// close one, then it steps around the wheel by the golden angle (the same set always gets the same colors)
const MIN_HUE_GAP = 30;
function assignHues(keys) {
  const out = new Map();
  const taken = [];
  const gap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (const key of [...keys].sort()) {
    let hue = hueOf(key);
    for (let i = 0; i < 12 && taken.some((t) => gap(t, hue) < MIN_HUE_GAP); i++) hue = (hue + 137.508) % 360;
    hue = Math.round(hue);
    taken.push(hue);
    out.set(key, hue);
  }
  return out;
}

// The conversation key the Conversations tab uses for a pair of handles
const pairKey = (a, b) => [a, b].sort().join(' ⇄ ');

// An icon given as [tag, attrs] lists on a 24×24 grid (see icons.js)
const Glyph = ({ icon, size = 14 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
    {icon.map(([tag, attrs]) => createElement(tag, attrs))}
  </svg>
);

// The agent's own mark (Claude, Codex, Gemini, OpenCode, Ollama, LM Studio), or a robot for any other agent
function AgentIcon({ agent }) {
  const a = agentKey(agent);
  return (
    <span className={`nc-icon agent-${a}`} aria-hidden="true">
      <Glyph icon={AGENT_ICONS[a]} />
    </span>
  );
}

// A server front panel: PWR (open), ACT (in a turn, flickering like disk activity), TX and RX (a message sent or
// received). A blink restarts by remounting its LED, keyed by how many times it fired
function Leds({ busy, tx = 0, rx = 0 }) {
  return (
    <span className="nc-leds" aria-label={busy ? 'Working' : 'Idle'}>
      <span className="nc-led pwr on" title="Open" />
      <span className={`nc-led act${busy ? ' on' : ''}`} title={busy ? 'Working on a turn' : 'Idle'} />
      <span key={`tx${tx}`} className={`nc-led tx${tx ? ' blink' : ''}`} title="Sent a message" />
      <span key={`rx${rx}`} className={`nc-led rx${rx ? ' blink' : ''}`} title="Received a message" />
    </span>
  );
}

// A chat's box: agent and its server lights, the chat's name, handle and model, its status and ⚙ (the rest is in the ⚙ modal)
const ChatNode = memo(function ChatNode({ data, selected }) {
  const c = data.chat;
  const led = data.leds || {};
  const name = c.title || 'Untitled chat';
  return (
    <div className={`nc-node agent-${agentKey(c.agent)}${selected ? ' selected' : ''}${c.busy ? ' busy' : ''}`} style={{ '--chat-hue': data.hue }}>
      {led.flash ? <span key={`flash${led.flash}`} className="nc-flash" aria-hidden="true" /> : null}
      <Handle id="l" type="source" position={Position.Left} className="nc-handle" />
      <Handle id="r" type="source" position={Position.Right} className="nc-handle" />
      <div className="nc-head">
        <AgentIcon agent={c.agent} />
        <span className="nc-agent">{agentName(c.agent)}</span>
        <Leds busy={c.busy} tx={led.tx} rx={led.rx} />
      </div>
      <div className={`nc-title${c.title ? '' : ' untitled'}`} title={name}>
        {name}
      </div>
      <div className="nc-id" title="This chat's handle: other agents send to it by this name">
        {c.handle}
      </div>
      <div className="nc-model" title={c.model || 'Model not known yet'}>
        {c.model || 'Model not known yet'}
      </div>
      <div className="nc-foot">
        <div className="nc-chips">
          {c.blocked ? (
            <span className="nc-status blocked" title={`Its provider stopped it: ${c.blocked.reason}. Messages to it are refused until then.`}>
              <i />
              Blocked{c.blocked.until ? ` · until ${clock(c.blocked.until)}` : ''}
            </span>
          ) : (
            <span className={`nc-status ${c.busy ? 'busy' : 'idle'}`} title={c.busy ? 'In a turn right now' : 'Waiting for a prompt'}>
              <i />
              {c.busy ? 'Working' : 'Idle'}
            </span>
          )}
          {c.role ? (
            <span className={`nc-chip role-${c.role}`} title={c.role === 'admin' ? 'Hands out tasks to its workers' : 'Does the tasks its admin sends'}>
              {ROLE_NAMES[c.role]}
            </span>
          ) : null}
          {c.sendMode === 'ask' ? (
            <span className="nc-chip warn" title="Each message this chat sends waits for your OK">
              Ask first
            </span>
          ) : null}
          {c.unread ? (
            <span className="nc-chip accent" title={`${c.unread} unread message${c.unread === 1 ? '' : 's'}`}>
              {c.unread} unread
            </span>
          ) : null}
        </div>
        <button className="nc-icon-btn nc-gear nodrag" title="Info and settings" aria-label={`Info and settings for ${c.handle}`} onClick={(e) => (e.stopPropagation(), data.onSettings(c.id))}>
          <Glyph icon={GEAR_ICON} size={15} />
        </button>
      </div>
    </div>
  );
});

// A chat that is open in the editor but not on Neurons yet: why, and what makes it join
const GHOST_NOTES = {
  starting: () => 'Neurons is on in this chat; it joins at its first prompt.',
  claude: () => 'Open in this window, without Neurons yet. Restart this chat (or Connect Claude Code in Agents setup).',
  other: () => 'Open in this window, not on Neurons yet.',
};

const StartingNode = memo(function StartingNode({ data }) {
  const note = (GHOST_NOTES[data.kind] || GHOST_NOTES.other)();
  return (
    <div className={`nc-node ghost agent-${agentKey(data.agent)}`} style={{ '--chat-hue': data.hue }}>
      <div className="nc-head">
        <AgentIcon agent={data.agent} />
        <span className="nc-agent">{agentName(data.agent)}</span>
        <span className="nc-status starting">
          <i />
          {data.kind === 'starting' ? 'Starting' : 'Not joined'}
        </span>
      </div>
      <div className="nc-meta nc-note">{note}</div>
    </div>
  );
});

// One message travelling along its line: a dot from the sender to the receiver, started by hand (SMIL animations
// inserted after page load would otherwise count from the page's start and be over already)
function Flight({ path, fromSource, hue, delay, onDone }) {
  const dot = useRef(null);
  const motion = useRef(null);
  useEffect(() => {
    const start = setTimeout(() => {
      if (dot.current) dot.current.style.opacity = '1';
      motion.current?.beginElement();
    }, delay);
    const done = setTimeout(onDone, delay + FLIGHT_MS + 80);
    return () => {
      clearTimeout(start);
      clearTimeout(done);
    };
  }, []);
  return (
    <circle ref={dot} r="5.5" className="nc-dot" style={{ opacity: 0, '--dot': chatColor(hue) }}>
      <animateMotion
        ref={motion}
        begin="indefinite"
        dur={`${FLIGHT_MS}ms`}
        fill="freeze"
        path={path}
        keyPoints={fromSource ? '0;1' : '1;0'}
        keyTimes="0;1"
        calcMode="spline"
        keySplines="0.45 0 0.2 1"
      />
    </circle>
  );
}

// A line: a gradient from the source agent's color to the target's, a dot per new message, and a × to hang up once selected
const LineEdge = memo(function LineEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const l = data.line;
  const live = l.last && data.now - l.last.at < LIVE_MS;
  const gradient = `nc-grad-${id}`;
  return (
    <>
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0%" style={{ stopColor: chatColor(data.sourceHue) }} />
          <stop offset="100%" style={{ stopColor: chatColor(data.targetHue) }} />
        </linearGradient>
      </defs>
      <BaseEdge id={id} path={path} className={`nc-edge${selected ? ' selected' : ''}${live ? ' live' : ''}`} style={{ stroke: `url(#${gradient})` }} interactionWidth={22} />
      {data.flights.map((f) => (
        <Flight key={f.key} path={path} fromSource={f.fromSource} hue={f.fromSource ? data.sourceHue : data.targetHue} delay={f.delay} onDone={() => data.onLanded(f.key)} />
      ))}
      {selected ? (
        <EdgeLabelRenderer>
          <button
            className="nc-x nc-edge-x nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title="Hang up this line"
            aria-label={`Hang up line #${l.id}`}
            onClick={(e) => (e.stopPropagation(), data.onHangup(l.id))}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

const nodeTypes = { chat: ChatNode, starting: StartingNode };
// Before the first snapshot: one stable empty graph (a fresh object each render would re-run every effect, forever)
const EMPTY_GRAPH = { nodes: [], lines: [], starting: [] };
const edgeTypes = { line: LineEdge };

// Default spot for a node nobody has placed: one column per agent, newest at the bottom
function defaultPosition(chat, index) {
  return { x: (AGENTS[chat.agent]?.order ?? Object.keys(AGENTS).length) * COLUMN, y: index * ROW };
}

// A chat's role on its lines, set by the user
const ROLES = [
  ['', 'None', 'An equal peer: it asks and answers, nothing more.'],
  ['admin', 'Admin', 'Hands out tasks to the workers on its lines, reviews what they send back and answers their permission requests (asking you when it is not sure).'],
  ['worker', 'Worker', 'Does the tasks its admin sends, as if you gave them, within its usual permissions; replies with the result and asks its admin before anything risky.'],
];
const ROLE_NAMES = { admin: 'Admin', worker: 'Worker' };

// Ask first or Automatic: how a chat's messages go over its lines
const SEND_MODES = [
  ['auto', 'Automatic', 'Messages go to the chats on its lines right away.'],
  ['ask', 'Ask first', 'Each message waits for your OK: a notification in the editor and a card on this graph. Replies always go.'],
];

// The ⚙ on a chat's box: what the chat is, its lines, and its own settings
function ChatModal({ chat, hue, lines, chats, now, api, onClose }) {
  const peerOf = (l) => chats.get(l.source === chat.id ? l.target : l.source);
  const onHangup = api.hangup;
  const onOpen = api.openConversation;
  const agent = agentName(chat.agent);
  const [mode, setMode] = useState(chat.sendMode || 'auto');
  useEffect(() => setMode(chat.sendMode || 'auto'), [chat.sendMode]);
  const [confirmOff, setConfirmOff] = useState(false);
  // Waking by a message (Claude only): turning it on first shows what it means, and only Allow saves it
  const [wake, setWake] = useState(!!chat.wake);
  useEffect(() => setWake(!!chat.wake), [chat.wake]);
  const [consent, setConsent] = useState(false);
  const consentRef = useRef(null);
  useEffect(() => {
    if (consent) consentRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [consent]);
  const saveWake = (on) => {
    setWake(on);
    setConsent(false);
    api.wake(chat.id, on);
  };
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pick = (m) => {
    setMode(m);
    api.sendMode(chat.id, m);
  };
  const [role, setRole] = useState(chat.role || '');
  useEffect(() => setRole(chat.role || ''), [chat.role]);
  const pickRole = (r) => {
    setRole(r);
    api.role(chat.id, r || null);
  };
  return (
    <div className="nc-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`nc-modal agent-${agentKey(chat.agent)}`} role="dialog" aria-modal="true" aria-label={`${chat.title || chat.handle}: info and settings`} style={{ '--chat-hue': hue }}>
        <div className="nc-modal-head">
          <AgentIcon agent={chat.agent} />
          <div className="nc-modal-titles">
            <div className="nc-modal-title">{chat.title || 'Untitled chat'}</div>
            <div className="nc-handle-text">
              {chat.handle} · {agent}
            </div>
          </div>
          <button className="nc-icon-btn" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="nc-modal-body">
          <section>
            <div className="nc-section-title">Info</div>
            <dl className="nc-facts">
              <dt>Handle</dt>
              <dd className="nc-mono">{chat.handle}</dd>
              {chat.label ? (
                <>
                  <dt>Label</dt>
                  <dd>{chat.label}</dd>
                </>
              ) : null}
              {chat.model ? (
                <>
                  <dt>Model</dt>
                  <dd>{chat.model}</dd>
                </>
              ) : null}
              {chat.repo ? (
                <>
                  <dt>Repo</dt>
                  <dd>{chat.repo}</dd>
                </>
              ) : null}
              {chat.task ? (
                <>
                  <dt>Task</dt>
                  <dd>{chat.task}</dd>
                </>
              ) : null}
              <dt>Agent</dt>
              <dd>{agentName(chat.agent)}</dd>
              <dt>Runs in</dt>
              <dd>{SURFACES[chat.surface] || 'Unknown'}</dd>
              <dt>Status</dt>
              <dd>{chat.blocked ? `Blocked: ${chat.blocked.reason}${chat.blocked.until ? ` (until ${clock(chat.blocked.until)})` : ''}` : chat.busy ? 'Working on a turn' : 'Idle'}</dd>
              <dt>Unread</dt>
              <dd>{chat.unread || 'None'}</dd>
              <dt>Opened</dt>
              <dd>{ago(chat.since, now)}</dd>
              <dt>Last active</dt>
              <dd>{ago(chat.active, now)}</dd>
            </dl>
          </section>
          <section>
            <div className="nc-section-title">Lines</div>
            {lines.length ? (
              <ul className="nc-lines">
                {lines.map((l) => {
                  const peer = peerOf(l);
                  return (
                    <li key={l.id}>
                      <div className="nc-line-row">
                        <AgentIcon agent={peer?.agent} />
                        <span className="nc-peer">{peer?.handle || 'a closed chat'}</span>
                        <span className="quiet">
                          {l.messages} msg · {l.last ? ago(l.last.at, now) : `since ${ago(l.since, now)}`}
                        </span>
                      </div>
                      <div className="nc-line-actions">
                        {peer ? <button onClick={() => onOpen(pairKey(chat.handle, peer.handle))}>Open conversation</button> : null}
                        <button className="danger" onClick={() => onHangup(l.id)}>
                          Hang up
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="nc-empty-small">No lines yet. Drag from this chat's handle to another chat to connect them.</div>
            )}
          </section>
          <section>
            <div className="nc-section-title">Settings</div>
            <div className="nc-setting" role="radiogroup" aria-label="Role">
              <div className="nc-setting-name">Role</div>
              {ROLES.map(([value, name, about]) => (
                <label key={value || 'none'} className={`nc-choice${role === value ? ' on' : ''}`}>
                  <input type="radio" name={`role-${chat.id}`} value={value} checked={role === value} onChange={() => pickRole(value)} />
                  <span>
                    <b>{name}</b>
                    <span className="quiet">{about}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="nc-setting" role="radiogroup" aria-label="Sending over its lines">
              <div className="nc-setting-name">Sending over its lines</div>
              {SEND_MODES.map(([value, name, about]) => (
                <label key={value} className={`nc-choice${mode === value ? ' on' : ''}`}>
                  <input type="radio" name={`send-${chat.id}`} value={value} checked={mode === value} onChange={() => pick(value)} />
                  <span>
                    <b>{name}</b>
                    <span className="quiet">{about}</span>
                  </span>
                </label>
              ))}
            </div>
            {chat.wake !== null && chat.wake !== undefined ? (
              <div className="nc-setting nc-setting-row">
                <div>
                  <div className="nc-setting-name">Wake when a message arrives</div>
                  <div className="quiet">{wake ? 'On: a message that reaches this chat while it is idle starts a turn by itself.' : 'Off: a message waits until you next write in this chat.'}</div>
                </div>
                <button className={wake ? 'danger' : 'primary'} onClick={() => (wake ? saveWake(false) : setConsent(true))}>
                  {wake ? 'Turn off' : 'Turn on'}
                </button>
              </div>
            ) : null}
            {consent ? (
              <div ref={consentRef} className="nc-consent" role="alertdialog" aria-label="Let messages wake this chat?">
                <div className="nc-setting-name">Let messages wake this chat?</div>
                <ul>
                  <li>When a chat on one of its lines sends it a message while it is idle, Claude starts a turn by itself and answers. You do not have to type anything.</li>
                  <li>Each of those turns uses your Claude usage.</li>
                  <li>The message shows in this chat as coming from another session, not from you. It cannot approve permission prompts or run slash commands; Claude still asks you before anything that needs your OK.</li>
                  <li>Messages only come over lines you drew, and from an Ask first chat only after you allow them.</li>
                  <li>Turn it off here at any time; messages then wait until you next write in this chat.</li>
                </ul>
                <div className="nc-consent-actions">
                  <button onClick={() => setConsent(false)}>Cancel</button>
                  <button className="primary" onClick={() => saveWake(true)}>
                    Allow
                  </button>
                </div>
              </div>
            ) : null}
            <div className="nc-setting nc-setting-row">
              <div>
                <div className="nc-setting-name">{agent} in Neurons</div>
                <div className="quiet">Turning it off takes every {agent} chat off this graph and ends their lines. Turn it back on in Agents setup.</div>
              </div>
              <button className="danger" onClick={() => (confirmOff ? (api.agentOff(chat.agent, true), onClose()) : setConfirmOff(true))}>
                {confirmOff ? `Yes, turn off ${agent}` : `Turn off ${agent}`}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// Ask first: messages waiting for the user's OK; the editor shows a notification too, and either answer counts
function Asks({ asks, now, onDecide }) {
  const open = asks.filter((a) => a.expiresAt > now);
  if (!open.length) return null;
  return (
    <Panel position="top-center" className="nc-asks">
      {open.map((a) => (
        <div key={a.id} className="nc-ask" role="alertdialog" aria-label={`${a.from} wants to send a message`}>
          <div className="nc-ask-head">
            <AgentIcon agent={a.fromAgent} />
            <span>
              <b>{a.from}</b> wants to send <b>{a.to.join(', ')}</b> a {a.kind}
            </span>
          </div>
          <div className="nc-ask-text">{a.text}</div>
          <div className="nc-ask-actions">
            <span className="quiet">{Math.max(0, Math.ceil((a.expiresAt - now) / 1000))} s left</span>
            <button onClick={() => onDecide(a.id, false)}>Deny</button>
            <button className="primary" onClick={() => onDecide(a.id, true)}>
              Allow
            </button>
          </div>
        </div>
      ))}
    </Panel>
  );
}

function Canvas({ store, api }) {
  const [snap, setSnap] = useState(store.data);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState(null);
  // The chat whose ⚙ modal (info and settings) is open
  const [settingsFor, setSettingsFor] = useState(null);
  const [hint, setHint] = useState(() => !api.getState()?.hintDismissed);
  const [layout, setLayout] = useState(0);
  const positions = useRef(api.getState()?.positions || {});
  const { fitView } = useReactFlow();
  const fitted = useRef(false);

  const [visible, setVisible] = useState(store.visible);
  useEffect(() => store.listen(setSnap, setVisible), [store]);
  // Relative times and the "live" glow follow the clock without a reload, and only while the canvas is on screen; each
  // second while a message waits for the user's OK, for its countdown
  const asking = !!snap?.graph?.asks?.length;
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), asking ? 1000 : 5000);
    return () => clearInterval(t);
  }, [visible, asking]);

  /*
   * Traffic: every message written while the canvas is on screen sends a dot along its line, and blinks TX on the
   * sender and RX on the receiver (both boxes flash). Older ones, and those from while it was hidden, only count.
   */
  const seen = useRef(null);
  const timers = useRef(new Set());
  const [flights, setFlights] = useState([]);
  const [leds, setLeds] = useState({});
  const blink = useCallback((nodeId, kind) => setLeds((l) => ({ ...l, [nodeId]: { ...l[nodeId], [kind]: (l[nodeId]?.[kind] || 0) + 1, flash: (l[nodeId]?.flash || 0) + 1 } })), []);
  const later = useCallback((fn, ms) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const lines = snap?.graph?.lines || [];
    // Dots of a line that was hung up mid-flight never land; drop them
    const live = new Set(lines.map((l) => `line-${l.id}`));
    setFlights((f) => (f.every((x) => live.has(x.edgeId)) ? f : f.filter((x) => live.has(x.edgeId))));
    const all = lines.flatMap((l) => l.recent.map((m) => ({ line: l, m })));
    if (seen.current === null) seen.current = new Set();
    const fresh = all.filter((x) => !seen.current.has(x.m.id)).sort((a, b) => a.m.id - b.m.id);
    for (const x of fresh) seen.current.add(x.m.id);
    if (!visible) return;
    const shown = fresh.filter((x) => x.m.at >= store.visibleSince).slice(-MAX_FLIGHTS);
    if (!shown.length) return;
    setFlights((f) => [
      ...f,
      ...shown.map((x, i) => ({ key: `${x.m.id}`, edgeId: `line-${x.line.id}`, fromSource: x.m.fromSource, delay: i * STAGGER_MS })),
    ]);
    shown.forEach((x, i) => {
      const [from, to] = x.m.fromSource ? [x.line.source, x.line.target] : [x.line.target, x.line.source];
      later(() => blink(from, 'tx'), i * STAGGER_MS);
      later(() => blink(to, 'rx'), i * STAGGER_MS + FLIGHT_MS);
    });
  }, [snap, visible]);
  const onLanded = useCallback((key) => setFlights((f) => f.filter((x) => x.key !== key)), []);

  const graph = snap?.graph || EMPTY_GRAPH;
  const chats = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  // Chats open in this window that Neurons has no chat for yet (from the window's processes), plus windows whose chat
  // has not shown itself; each once, matched by the agent process the Neurons servers record as their host
  const detected = snap?.detected;
  const off = snap?.settings?.disabledAgents;
  const ghosts = useMemo(() => {
    const known = new Set([...graph.nodes, ...graph.starting].map((n) => n.host).filter(Boolean));
    const starting = graph.starting.map((s) => ({ ...s, kind: 'starting' }));
    // A provider the user turned off shows no ghost either
    const missing = (detected || []).filter((d) => !known.has(d.host) && !off?.includes(d.agent)).map((d) => ({ agent: d.agent, host: d.host, kind: AGENTS[d.agent] ? d.agent : 'other' }));
    return [...starting, ...missing];
  }, [graph, detected, off]);

  const hues = useMemo(() => assignHues([...graph.nodes.map((n) => n.id), ...ghosts.map((g) => g.host || g.agent)]), [graph.nodes, ghosts]);
  const hue = useCallback((key) => hues.get(key) ?? hueOf(key), [hues]);

  const lineCount = useMemo(() => {
    const m = new Map();
    for (const l of graph.lines) for (const id of [l.source, l.target]) m.set(id, (m.get(id) || 0) + 1);
    return m;
  }, [graph.lines]);

  const openSettings = useCallback((id) => setSettingsFor(id), []);
  const closeSettings = useCallback(() => setSettingsFor(null), []);

  // Rebuilt from each snapshot, keeping what React Flow measured and where the user put each chat
  const [nodes, setNodes] = useState([]);
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      const perAgent = new Map();
      const next = graph.nodes.map((c) => {
        const i = perAgent.get(c.agent) || 0;
        perAgent.set(c.agent, i + 1);
        return { ...old.get(c.id), id: c.id, type: 'chat', position: positions.current[c.id] || defaultPosition(c, i), data: { chat: c, hue: hue(c.id), now, lines: lineCount.get(c.id) || 0, leds: leds[c.id], onSettings: openSettings }, selected: c.id === selected };
      });
      ghosts.forEach((g, j) => {
        const id = `starting-${g.agent}-${g.host || j}`;
        const i = perAgent.get(g.agent) || 0;
        perAgent.set(g.agent, i + 1);
        next.push({ ...old.get(id), id, type: 'starting', position: defaultPosition(g, i), data: { ...g, hue: hue(g.host || g.agent) }, draggable: false, selectable: false, connectable: false });
      });
      return next;
    });
  }, [graph, ghosts, now, lineCount, selected, layout, leds, hue, openSettings]);

  const [edgeSelection, setEdgeSelection] = useState(() => new Set());

  const edges = useMemo(
    () =>
      graph.lines
        .filter((l) => chats.has(l.source) && chats.has(l.target))
        .map((l) => ({
          id: `line-${l.id}`,
          source: l.source,
          target: l.target,
          // The sides the user drew it between (older lines: right to left)
          sourceHandle: l.sourceSide || 'r',
          targetHandle: l.targetSide || 'l',
          type: 'line',
          selected: edgeSelection.has(`line-${l.id}`),
          data: {
            line: l,
            now,
            sourceHue: hue(l.source),
            targetHue: hue(l.target),
            flights: flights.filter((f) => f.edgeId === `line-${l.id}`),
            onLanded,
            onHangup: api.hangup,
          },
        })),
    [graph.lines, chats, now, api, edgeSelection, flights, onLanded, hue],
  );

  // Selecting a line is what Delete acts on
  const onEdgesChange = useCallback((changes) => {
    const picks = changes.filter((c) => c.type === 'select');
    if (!picks.length) return;
    setEdgeSelection((cur) => {
      const next = new Set(cur);
      for (const c of picks) c.selected ? next.add(c.id) : next.delete(c.id);
      return next;
    });
  }, []);

  // Fit once the first chats arrive; after that the view stays where the user left it
  useEffect(() => {
    if (!fitted.current && nodes.length) {
      fitted.current = true;
      requestAnimationFrame(() => fitView({ padding: 0.25, maxZoom: 1 }));
    }
  }, [nodes.length, fitView]);

  const save = (patch) => api.setState({ ...(api.getState() || {}), ...patch });

  const onNodesChange = useCallback((changes) => {
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type === 'position' || c.type === 'dimensions'), ns));
    for (const c of changes) if (c.type === 'position' && c.position && !c.id.startsWith('starting-')) positions.current[c.id] = c.position;
    if (changes.some((c) => c.type === 'position' && c.dragging === false)) save({ positions: positions.current });
  }, []);

  const linked = useCallback((a, b) => graph.lines.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a)), [graph.lines]);
  const isValidConnection = useCallback((c) => c.source !== c.target && chats.has(c.source) && chats.has(c.target) && !linked(c.source, c.target), [chats, linked]);
  const onConnect = useCallback((c) => api.link(c.source, c.target, c.sourceHandle, c.targetHandle), [api]);
  const onEdgesDelete = useCallback((es) => es.forEach((e) => api.hangup(e.data.line.id)), [api]);

  const arrange = () => {
    positions.current = {};
    save({ positions: {} });
    setLayout((n) => n + 1);
    requestAnimationFrame(() => fitView({ padding: 0.25, maxZoom: 1, duration: 300 }));
  };

  const chosen = settingsFor && chats.get(settingsFor);
  const agentsPresent = [...new Set([...graph.nodes, ...ghosts].map((n) => agentKey(n.agent)))];

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        isValidConnection={isValidConnection}
        connectionMode={ConnectionMode.Loose}
        connectionLineClassName="nc-connecting"
        onNodeClick={(_, n) => n.type === 'chat' && setSelected(n.id)}
        onNodeDoubleClick={(_, n) => n.type === 'chat' && openSettings(n.id)}
        onPaneClick={() => setSelected(null)}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.3}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} className="nc-bg" />
        <Controls showInteractive={false} className="nc-controls" />
        {store.mode === 'panel' ? <MiniMap pannable zoomable className="nc-minimap" nodeColor={(n) => `hsl(${n.data?.hue ?? 210} 62% 56%)`} /> : null}

        <Panel position="top-left" className="nc-legend">
          <div className="nc-legend-row">
            {(agentsPresent.length ? agentsPresent : ['claude', 'codex']).map((a) => (
              <span key={a} className="nc-legend-item">
                <AgentIcon agent={a} />
                {agentName(a === 'other' ? null : a)}
              </span>
            ))}
          </div>
          <div className="nc-legend-row quiet">
            <span className="nc-legend-item status busy">
              <i />
              Working
            </span>
            <span className="nc-legend-item status idle">
              <i />
              Idle
            </span>
            <span>
              {graph.nodes.length} chat{graph.nodes.length === 1 ? '' : 's'} · {graph.lines.length} line{graph.lines.length === 1 ? '' : 's'}
            </span>
          </div>
        </Panel>

        <Asks asks={graph.asks || []} now={now} onDecide={api.decideAsk} />

        <Panel position="top-right" className="nc-toolbar">
            <button onClick={() => fitView({ padding: 0.25, maxZoom: 1, duration: 300 })} title="Show every chat">
              Fit
            </button>
            <button onClick={arrange} title="Put every chat back in its agent's column">
              Arrange
            </button>
            <button onClick={api.toggleAgents} title="Connect or disconnect agents (their MCP config and hooks)">
              Agents setup
            </button>
          </Panel>

        {!graph.nodes.length ? (
          <Panel position="top-center" className="nc-empty">
            <div className="nc-empty-title">No chats yet</div>
            <div>Open Claude Code or Codex in the editor. Each chat appears here once it gets its first prompt.</div>
            <button onClick={api.toggleAgents} className="primary">
              Agents setup
            </button>
          </Panel>
        ) : graph.nodes.length < 2 ? null : hint ? (
          <Panel position="bottom-center" className="nc-hint">
            <span>
              Drag from one chat's <b>●</b> to another to connect them. Select a line and press <kbd>Delete</kbd> to hang up.
            </span>
            <button
              className="nc-icon-btn"
              aria-label="Dismiss"
              onClick={() => {
                setHint(false);
                save({ hintDismissed: true });
              }}
            >
              ×
            </button>
          </Panel>
        ) : null}
      </ReactFlow>
      {chosen ? (
        <ChatModal
          chat={chosen}
          hue={hue(chosen.id)}
          lines={graph.lines.filter((l) => l.source === chosen.id || l.target === chosen.id)}
          chats={chats}
          now={now}
          api={api}
          onClose={closeSettings}
        />
      ) : null}
    </>
  );
}

// A crash shows its message (and goes to the extension's log) instead of leaving a blank canvas
class CanvasErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    this.props.onError?.(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="nc-crash">
        <b>The canvas stopped with an error.</b>
        <div>{String(this.state.error?.message || this.state.error)}</div>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

// The bridge dashboard.js uses: mount once, then push every snapshot
// visibleSince: when the canvas last came on screen; only messages written after that move on it
function createStore(mode) {
  let onData = null;
  let onVisible = null;
  const store = {
    mode,
    data: null,
    visible: true,
    visibleSince: Date.now(),
    // A snapshot pushed before the canvas subscribed (React mounts a tick later) is handed over on subscribing
    listen(data, visible) {
      onData = data;
      onVisible = visible;
      data(store.data);
      visible(store.visible);
      return () => (onData = onVisible = null);
    },
    update(data) {
      store.data = data;
      onData?.(data);
    },
    setVisible(visible) {
      if (store.visible === visible) return;
      store.visible = visible;
      if (visible) store.visibleSince = Date.now();
      onVisible?.(visible);
    },
  };
  return store;
}

window.NeuronsCanvas = {
  // The same color per chat as the canvas, for the sidebar's list: key → hue
  hues: (keys) => Object.fromEntries(assignHues(keys)),
  // The canvas' agent icon as SVG markup, for the sidebar
  icon: (agent, size) => agentIconSvg(agentKey(agent), size),
  mount(el, api, mode) {
    const store = createStore(mode);
    createRoot(el).render(
      <CanvasErrorBoundary onError={(e) => api.report?.(`canvas: ${e?.stack || e}`)}>
        <ReactFlowProvider>
          <Canvas store={store} api={api} />
        </ReactFlowProvider>
      </CanvasErrorBoundary>,
    );
    return store;
  },
};
