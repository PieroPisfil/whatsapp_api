import { Queue } from 'bullmq';
import { connection } from './redis.js';

export const messageQueue = new Queue('whatsapp-messages', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 3000
    },
    removeOnComplete: {
      age: 3600,
      count: 200
    },
    // Evita crecimiento infinito de fallos en Redis
    removeOnFail: {
      age: 7 * 24 * 3600,
      count: 500
    }
  }
});
