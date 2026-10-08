import { z } from 'zod';

export default {
  name: 'discover',
  title: 'Neurons Discovery',
  description: 'Who is online, your open lines and ringing calls, your inbox count. Pass model/task/label to tell peers what you are doing.',
  readOnly: true,
  banner: false,
  input: {
    model: z.string().max(80).optional(),
    task: z.string().max(400).optional(),
    label: z.string().max(80).optional(),
  },
};
