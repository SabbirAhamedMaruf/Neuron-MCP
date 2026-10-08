import { z } from 'zod';

export default {
  name: 'claims',
  title: 'Neurons Claims',
  description: 'Advisory edit locks so two sessions do not edit the same files. action claim (paths), release (paths, or all), list.',
  input: {
    action: z.enum(['claim', 'release', 'list']),
    paths: z.array(z.string().min(1).max(500)).max(100).optional(),
    repo: z.string().optional(),
    reason: z.string().max(300).optional(),
    ttl_minutes: z.number().int().min(5).max(1440).optional(),
    force: z.boolean().optional(),
  },
};
