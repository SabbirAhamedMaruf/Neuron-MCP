import { z } from 'zod';
import { LIMITS, MEMORY_TYPES } from '../settings.js';

export default {
  name: 'memory_save',
  title: 'Neurons Memory Save',
  description:
    'Save, update (id) or archive (id + archive) a note in YOUR Neurons memory. Facts from a peer need source=peer and evidence of what you verified. No secrets.',
  input: {
    id: z.number().int().optional(),
    title: z.string().min(3).max(LIMITS.title).optional(),
    body: z.string().min(1).max(LIMITS.body).optional(),
    type: z.enum(MEMORY_TYPES).optional(),
    scope: z.enum(['global', 'repo']).optional(),
    repo: z.string().optional(),
    tags: z.array(z.string().max(40)).max(12).optional(),
    source: z.enum(['self', 'peer']).optional(),
    evidence: z.string().max(2000).optional(),
    confirm_new: z.boolean().optional(),
    archive: z.boolean().optional(),
  },
};
