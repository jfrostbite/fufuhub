import { createClient } from 'redis';
import { logger } from './logger.js';

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = process.env.REDIS_PORT || 6379;
const redisDb = process.env.REDIS_DB || 0;

const redisClient = createClient({
  url: `redis://${redisHost}:${redisPort}/${redisDb}`,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 500),
  },
});

redisClient.on('error', (err) => {
  logger.error('Redis Client Error', err);
});

redisClient.on('connect', () => {
  logger.info('Redis Client Connected');
});

export default redisClient;
