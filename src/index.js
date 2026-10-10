#!/usr/bin/env node
// Neurons MCP server: one stdio process per agent session, all sharing one SQLite file. stdout is the MCP channel; logs go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_INSTRUCTIONS } from '../configuration/prompts.js';
import { HEARTBEAT_MS, SERVER_NAME, VERSION } from '../configuration/settings.js';
import { openDb } from './db.js';
import { Identity } from './identity.js';
import { startMessageRelay } from './relay.js';
import { log, registerTools } from './registry.js';

const db = openDb();
const identity = new Identity(db);
const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
// Once the client says who it is, announce this window as connected so peers can reach it
// From the background: messages for an idle agent
const stops = [];
server.server.oninitialized = () => {
  identity.setClient(server.server.getClientVersion());
  identity.registerServer();
  stops.push(startMessageRelay({ server, db, identity, log }));
};

registerTools(server, db, identity);

const heartbeat = setInterval(() => {
  try {
    identity.heartbeat();
  } catch (err) {
    log('heartbeat failed:', err.message);
  }
}, HEARTBEAT_MS);
heartbeat.unref();

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const stop of stops) stop();
  try {
    identity.shutdown();
  } catch {}
  db.close();
  process.exit(0);
}
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await server.connect(new StdioServerTransport());
log(`ready (pid ${process.pid})`);
