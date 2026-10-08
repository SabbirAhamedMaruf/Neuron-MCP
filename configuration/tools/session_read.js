import { z } from 'zod';
import { LIMITS } from '../settings.js';

export default {
  name: 'session_read',
  title: 'Neurons Past Chats',
  description: "Without handle/native_id: list your own agent's past sessions. With one: read it (text and tool names, redacted).",
  readOnly: true,
  input: {
    handle: z.string().optional(),
    native_id: z.string().optional(),
    tail: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(1000).max(LIMITS.outputChars).optional(),
    here: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
};
