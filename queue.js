import { Queue } from 'bullmq';
import { connection } from './redis.js';

export const messageQueue = new Queue('whatsapp-messages', {
  connection,
  defaultJobOptions: {
    attempts: 2,               // reintentos
    backoff: {
      type: 'exponential',
      delay: 3000
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});
