import { ago } from './util.js';

export const HANDOFF_SELECT = `SELECT h.*, s.handle AS author_handle, s.agent AS author_agent, s.model AS author_model, s.native_id AS author_native
  FROM handoffs h JOIN sessions s ON s.id = h.author_session`;

export const handoffLine = (h) =>
  `#${h.id} [${h.repo || 'workspace'}] ${h.title} · by ${h.author_handle}${h.author_model ? ` (${h.author_model})` : ''} · ${ago(h.created_at)}${h.to_kind ? ` · to ${h.to_label}` : ''}`;
