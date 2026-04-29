import { Redis } from 'ioredis';

export const connection = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  db: process.env.REDIS_DB || 0,
  maxRetriesPerRequest: null
});
