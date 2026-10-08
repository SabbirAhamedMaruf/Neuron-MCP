import { z } from 'zod';

export default {
  name: 'review_get',
  title: 'Neurons Reviews',
  description: 'With id: open (and claim) a review request or its result. Without: list reviews (status, mine).',
  input: {
    id: z.number().int().optional(),
    claim: z.boolean().optional(),
    status: z.enum(['open', 'claimed', 'done', 'all']).optional(),
    mine: z.boolean().optional(),
    repo: z.string().optional(),
  },
};
