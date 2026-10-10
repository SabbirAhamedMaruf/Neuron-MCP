import { oneLine } from './util.js';

export const list = (items) => (items && items.length ? items.map((i) => `- ${i}`).join('\n') : '');

export const section = (title, body) => (body ? `## ${title}\n${body}` : '');

export const joinBlocks = (...blocks) => blocks.filter(Boolean).join('\n\n');

export function sessionLine(s) {
  return [s.handle, s.label ? oneLine(s.label, 40) : null, s.model || s.agent, s.repo, s.task ? oneLine(s.task, 60) : null].filter(Boolean).join(' · ');
}
