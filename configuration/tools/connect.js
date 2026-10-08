import { z } from 'zod';
import { LIMITS } from '../settings.js';

export default {
  name: 'connect',
  title: 'Neurons Connect',
  description:
    'to: call an agent ("codex") or a handle; one of its sessions picks up and every later message goes over that line. call_id (or nothing, when one call rings): pick up a call ringing for you, only when the user says so. wait_seconds waits for the pick-up.',
  input: {
    to: z.string().min(1).optional(),
    call_id: z.number().int().optional(),
    wait_seconds: z.number().int().min(0).max(LIMITS.ringSeconds).optional(),
  },
};
