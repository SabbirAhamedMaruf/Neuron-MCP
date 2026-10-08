import { z } from 'zod';
import { LIMITS } from '../settings.js';

const items = z.array(z.string().max(2000)).max(40).optional();

export default {
  name: 'handoff_publish',
  title: 'Neurons Handoff',
  description: 'Hand work over: goal, done, decisions (with reasons), next steps, open questions, gotchas, files, commits. `to` notifies a running agent.',
  input: {
    title: z.string().min(3).max(LIMITS.title),
    goal: z.string().max(4000).optional(),
    summary: z.string().max(LIMITS.body).optional(),
    done: items,
    decisions: items,
    next_steps: items,
    open_questions: items,
    gotchas: items,
    files: z.array(z.object({ path: z.string().max(500), note: z.string().max(500).optional() })).max(100).optional(),
    commits: z.array(z.string().max(200)).max(50).optional(),
    repo: z.string().optional(),
    to: z.string().optional(),
  },
};
