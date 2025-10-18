import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import redisClient from './utils/redis.js';
import { logger } from './utils/logger.js';
import apiRoutes from './routes/api.js';
import { TaskScheduler } from './services/taskScheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files (frontend)
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// Store WebSocket clients
const wsClients = new Set();

wss.on('connection', (ws) => {
  logger.info('New WebSocket client connected');
  wsClients.add(ws);

  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info('WebSocket client disconnected');
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
  });
});

// Broadcast message to all connected clients
export function broadcastToClients(data) {
  wsClients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN = 1
      client.send(JSON.stringify(data));
    }
  });
}

// Export taskScheduler for API control
export function getTaskScheduler() {
  return taskScheduler;
}

// Routes
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize services
let taskScheduler = null;

async function initializeServices() {
  try {
    // Connect to Redis
    await redisClient.connect();
    logger.info('Connected to Redis');

    // Initialize Task Scheduler (but don't start automatically)
    taskScheduler = new TaskScheduler();
    await taskScheduler.initialize();
    logger.info('Task Scheduler initialized (manual control mode)');

    // Don't start scheduling automatically - user must call /api/scheduler/start
    // taskScheduler.start();

  } catch (error) {
    logger.error('Failed to initialize services:', error);
    process.exit(1);
  }
}

// Start server
const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, async () => {
  logger.info(`Server is running on port ${PORT}`);
  await initializeServices();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  
  if (taskScheduler) {
    taskScheduler.stop();
  }
  
  wss.close(() => {
    logger.info('WebSocket server closed');
  });

  httpServer.close(async () => {
    await redisClient.disconnect();
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  
  if (taskScheduler) {
    taskScheduler.stop();
  }
  
  wss.close(() => {
    logger.info('WebSocket server closed');
  });

  httpServer.close(async () => {
    await redisClient.disconnect();
    logger.info('Server closed');
    process.exit(0);
  });
});
