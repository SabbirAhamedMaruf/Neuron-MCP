import { z } from 'zod';

export default {
  name: 'disconnect',
  title: 'Neurons Disconnect',
  description: 'Hang up your line to a handle or agent, or "all". call_id ends that call, or declines it while it rings for you. No arguments: your only line.',
  input: {
    to: z.string().min(1).optional(),
    call_id: z.number().int().optional(),
  },
};
