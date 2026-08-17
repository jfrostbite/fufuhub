import 'dotenv/config';
import { createClient } from 'redis';
import { logger } from './logger.js';

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = process.env.REDIS_PORT || 6379;
const redisDb = process.env.REDIS_DB || 0;
const redisPassword = process.env.REDIS_PASSWORD || '';

const redisUrl = redisPassword
  ? `redis://:${encodeURIComponent(redisPassword)}@${redisHost}:${redisPort}/${redisDb}`
  : `redis://${redisHost}:${redisPort}/${redisDb}`;

const redisClient = createClient({
  url: redisUrl,
  pingInterval: 15000, // 15秒自动发送 PING 心跳，防止远程服务器/防火墙因空闲断开 TCP 连接
  socket: {
    keepAlive: 5000,   // 开启 TCP Keep-Alive
    connectTimeout: 10000,
    reconnectStrategy: (retries) => {
      // 指数退避重连，最大间隔 3000ms，避免频繁刷屏
      return Math.min(retries * 200, 3000);
    },
  },
});

redisClient.on('error', (err) => {
  logger.error('Redis Client Error', err);
});

redisClient.on('connect', () => {
  logger.info('Redis Client Connected');
});

export default redisClient;
