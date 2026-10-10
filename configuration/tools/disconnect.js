import { z } from 'zod';

export default {
  name: 'disconnect',
  title: 'Neurons Disconnect',
  description: 'Hang up your line to a handle or agent, or "all". No arguments: your only line.',
  input: {
    to: z.string().min(1).optional(),
  },
};
