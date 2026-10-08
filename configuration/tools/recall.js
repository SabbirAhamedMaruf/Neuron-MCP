import { z } from 'zod';
import { RECALL_SOURCES } from '../settings.js';

export default {
  name: 'recall',
  title: 'Neurons Recall',
  description:
    "Search YOUR OWN knowledge: your memory files, past chats, Neurons notes and the repo. Use it to answer a peer's question. Open hits with recall_get.",
  readOnly: true,
  input: {
    query: z.string().min(2).max(300),
    sources: z.array(z.enum(RECALL_SOURCES)).optional(),
    repo_path: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  },
};
