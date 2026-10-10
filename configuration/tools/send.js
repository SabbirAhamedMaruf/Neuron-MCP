import { z } from 'zod';
import { LIMITS } from '../settings.js';

export default {
  name: 'send',
  title: 'Neurons Send',
  description:
    'Ask (question), tell (note) or suggest a memory change (proposal) to "codex", "claude", a handle, or "all" (every chat you are connected to, for a second opinion). Messages travel only over lines the user connected in the Neurons dashboard; without one this fails. "local" asks the free local model; local_first tries it before the target. Keep it short. wait_seconds blocks for the reply.',
  input: {
    to: z.string().min(1),
    body: z.string().min(1).max(LIMITS.message),
    kind: z.enum(['question', 'note', 'proposal']).optional(),
    subject: z.string().max(200).optional(),
    repo: z.string().optional(),
    refs: z.array(z.string().max(500)).max(30).optional(),
    local_first: z.boolean().optional(),
    wait_seconds: z.number().int().min(0).max(LIMITS.waitSeconds).optional(),
  },
};
