import { z } from 'zod';
import { LIMITS, REVIEW_SEVERITIES, REVIEW_VERDICTS } from '../settings.js';

export default {
  name: 'review_submit',
  title: 'Neurons Review Submit',
  description: 'Finish a claimed review: verdict, short summary, findings. The requester gets it in its inbox.',
  input: {
    id: z.number().int(),
    verdict: z.enum(REVIEW_VERDICTS),
    summary: z.string().min(1).max(LIMITS.message),
    findings: z
      .array(
        z.object({
          file: z.string().max(500),
          line: z.number().int().optional(),
          severity: z.enum(REVIEW_SEVERITIES),
          title: z.string().max(300),
          detail: z.string().max(2000).optional(),
          suggestion: z.string().max(2000).optional(),
        }),
      )
      .max(100)
      .optional(),
  },
};
