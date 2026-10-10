import { z } from 'zod';
import { LIMITS } from '../settings.js';

export default {
  name: 'reply',
  title: 'Neurons Reply',
  description: 'Answer a message addressed to you. Only what was asked, short, with sources. Proposals: status accepted or rejected. A permission request (a question): accepted allows it, rejected denies it.',
  input: {
    message_id: z.number().int(),
    body: z.string().min(1).max(LIMITS.message),
    status: z.enum(['answered', 'accepted', 'rejected']).optional(),
    refs: z.array(z.string().max(500)).max(30).optional(),
  },
};
