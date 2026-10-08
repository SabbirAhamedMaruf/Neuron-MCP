import { REVIEW_SEVERITIES } from '../configuration/settings.js';
import { targetLabel } from './identity.js';
import { ago } from './util.js';

export const REVIEW_SELECT = `SELECT r.*, q.handle AS requester_handle, q.agent AS requester_agent, v.handle AS reviewer_handle
  FROM reviews r JOIN sessions q ON q.id = r.requester_session LEFT JOIN sessions v ON v.id = r.reviewer_session`;

export const getReview = (db, id) => db.get(`${REVIEW_SELECT} WHERE r.id = ?`, id);

export const reviewLine = (db, r) =>
  `#${r.id} [${r.status}${r.verdict ? ` · ${r.verdict}` : ''}] ${r.title} · ${r.repo || 'workspace'} · from ${r.requester_handle} → ${targetLabel(db, r.to_kind, r.to_target)}${r.reviewer_handle ? ` · reviewer ${r.reviewer_handle}` : ''} · ${ago(r.created_at)}`;

export const findingLine = (f) =>
  `**${f.severity.toUpperCase()}** \`${f.file}${f.line ? `:${f.line}` : ''}\`: ${f.title}${f.detail ? `\n  ${f.detail}` : ''}${f.suggestion ? `\n  Suggestion: ${f.suggestion}` : ''}`;

export const bySeverity = (findings) =>
  [...findings].sort((x, y) => REVIEW_SEVERITIES.indexOf(x.severity) - REVIEW_SEVERITIES.indexOf(y.severity));

// The review's inbox message stands in for the request, so replies and claims hang off it
export const requestMessage = (db, reviewId) =>
  db.get("SELECT * FROM messages WHERE link_type = 'review' AND link_id = ? AND kind = 'review'", reviewId);
