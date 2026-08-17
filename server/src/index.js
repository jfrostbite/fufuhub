import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
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
let isShuttingDown = false;

async function handleShutdown(signal) {
  if (isShuttingDown) {
    logger.info(`Forced exit on repeated ${signal}`);
    process.exit(0);
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Safety fallback timeout to guarantee process exit within 2s
  const forceExitTimer = setTimeout(() => {
    logger.warn('Shutdown timed out, forcing exit...');
    process.exit(0);
  }, 2000);
  forceExitTimer.unref();

  try {
    if (taskScheduler) {
      taskScheduler.stop();
    }

    // Terminate all WebSocket client connections
    wsClients.forEach((ws) => {
      try {
        ws.terminate();
      } catch (e) {}
    });
    wsClients.clear();

    // Close WebSocket server
    wss.close(() => {
      logger.info('WebSocket server closed');
    });

    // Disconnect Redis client
    try {
      await redisClient.disconnect();
      logger.info('Redis client disconnected');
    } catch (err) {
      logger.warn(`Redis disconnect warning: ${err.message}`);
    }

    // Close HTTP Server
    httpServer.close(() => {
      logger.info('HTTP Server closed');
      process.exit(0);
    });

    // Fallback exit if HTTP server keep-alive connections linger
    setTimeout(() => {
      process.exit(0);
    }, 800);
  } catch (error) {
    logger.error('Error during shutdown:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
