import { CALL, unreadBanner } from '../configuration/prompts.js';
import { TOOLS } from '../configuration/tools/index.js';
import { NeuronsError, redact } from './guard.js';
import { unreadCount } from './inbox.js';
import { clearBlock } from './limits.js';
import { agentLabel, isAgentOff } from './prefs.js';
import { HANDLERS } from './tools/index.js';

export const log = (...args) => console.error('[neurons]', ...args);

// A config without a handler (or the reverse) is a wiring mistake; fail at startup instead of at call time
function pairToolsWithHandlers() {
  const names = TOOLS.map((t) => t.name);
  const missing = names.filter((n) => typeof HANDLERS[n] !== 'function');
  const orphans = Object.keys(HANDLERS).filter((n) => !names.includes(n));
  if (missing.length || orphans.length) {
    throw new Error(`Tool wiring mismatch. No handler: [${missing.join(', ')}]. No config: [${orphans.join(', ')}].`);
  }
  return TOOLS.map((config) => ({ config, handler: HANDLERS[config.name] }));
}

// Each call resolves the calling session, turns NeuronsError into a tool error, and appends the inbox banner
export function registerTools(server, db, identity) {
  for (const { config, handler } of pairToolsWithHandlers()) {
    const { name, title, description, input = {}, readOnly = false, banner = true } = config;
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: input,
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args, extra) => {
        try {
          // A tool call proves this window is alive, even if a sleep made its row look stale
          identity.heartbeat();
          const me = identity.current();
          // A provider the user turned off in the dashboard gets no Neurons at all
          if (isAgentOff(db, me.agent)) throw new NeuronsError(CALL.agentOff(agentLabel(me.agent)));
          // Calling a tool, it is working again: no longer blocked by its provider
          clearBlock(db, me);
          let text = await handler(args, me, { db, identity, extra });
          if (banner) {
            const n = unreadCount(db, me);
            if (n) text += `\n\n${unreadBanner(me.handle, n)}`;
          }
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          if (!(err instanceof NeuronsError)) log(`${name} failed:`, err?.stack || err);
          const msg = err instanceof NeuronsError ? err.message : `Internal error: ${err?.message || err}`;
          return { isError: true, content: [{ type: 'text', text: redact(msg) }] };
        }
      },
    );
  }
}
