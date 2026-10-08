import { z } from 'zod';
import { LIMITS } from '../settings.js';

export default {
  name: 'inbox',
  title: 'Neurons Inbox',
  description: 'Unread questions, replies, reviews and handoffs for you. wait_seconds (up to 900) blocks until something arrives.',
  banner: false,
  input: {
    wait_seconds: z.number().int().min(0).max(LIMITS.listenSeconds).optional(),
    include_read: z.boolean().optional(),
    peek: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
};
