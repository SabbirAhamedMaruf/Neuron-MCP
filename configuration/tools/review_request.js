import { z } from 'zod';
import { LIMITS } from '../settings.js';

export default {
  name: 'review_request',
  title: 'Neurons Review Request',
  description: 'Ask a running agent to review a change: diff text, or base/head + files. Findings come back to your inbox. No secrets in the diff.',
  input: {
    title: z.string().min(3).max(LIMITS.title),
    to: z.string().optional(),
    repo: z.string().optional(),
    focus: z.string().max(4000).optional(),
    base: z.string().max(200).optional(),
    head: z.string().max(200).optional(),
    diff: z.string().max(LIMITS.diff).optional(),
    files: z.array(z.string().max(500)).max(200).optional(),
  },
};
