import { z } from 'zod';

export default {
  name: 'handoff_get',
  title: 'Neurons Handoffs',
  description: "With id: the full handoff. Without: recent handoffs, including auto snapshots of other sessions' uncommitted work (filter by repo/agent).",
  readOnly: true,
  input: {
    id: z.number().int().optional(),
    repo: z.string().optional(),
    agent: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
};
