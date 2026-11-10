import 'dotenv/config';
import { createClient } from 'redis';
import { logger } from './logger.js';

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT || 6379;
const redisDb = process.env.REDIS_DB || 0;
const redisPassword = process.env.REDIS_PASSWORD || '';

const redisUrl = process.env.REDIS_URL || (redisPassword
  ? `redis://:${encodeURIComponent(redisPassword)}@${redisHost}:${redisPort}/${redisDb}`
  : `redis://${redisHost}:${redisPort}/${redisDb}`);

// Mask password for safe logging
const maskedUrl = redisUrl.replace(/:([^:@/]+)@/, ':****@');

const redisClient = createClient({
  url: redisUrl,
  pingInterval: 15000, // 15秒自动发送 PING 心跳，防止远程服务器/防火墙因空闲断开 TCP 连接
  socket: {
    keepAlive: 5000,   // 开启 TCP Keep-Alive
    connectTimeout: 10000,
    reconnectStrategy: (retries) => {
      // 指数退避重连，最大间隔 10000ms
      return Math.min(retries * 500, 10000);
    },
  },
});

let lastLoggedErrorTime = 0;
redisClient.on('error', (err) => {
  const now = Date.now();
  // 节流日志输出，15秒内只输出一次简要警告，防止刷屏
  if (now - lastLoggedErrorTime > 15000) {
    lastLoggedErrorTime = now;
    logger.warn(`[Redis] Connection Error: ${err.message} (Target: ${maskedUrl}, Auto-retrying...)`);
  }
});

redisClient.on('connect', () => {
  logger.info(`[Redis] Connected to ${maskedUrl}`);
});

redisClient.on('ready', () => {
  logger.info('[Redis] Client is ready for commands');
});

export default redisClient;

