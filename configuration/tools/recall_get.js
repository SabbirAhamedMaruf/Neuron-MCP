import { z } from 'zod';

export default {
  name: 'recall_get',
  title: 'Neurons Recall Detail',
  description: 'Open a ref from recall ("#12", "memory:…", "session:<id>@<line>", "repo:<path>:<line>"). Your own data only.',
  readOnly: true,
  input: { ref: z.string().min(1).max(1000) },
};
