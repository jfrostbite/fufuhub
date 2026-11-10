import express from 'express';
import redisClient from '../utils/redis.js';
import { logger } from '../utils/logger.js';
import { getLocalUsers, getLocalUser, saveLocalUser, deleteLocalUser } from '../utils/userStorage.js';
import { inMemoryLogs } from '../utils/logs.js';
import apiService from '../services/apiService.js';
import { broadcastToClients, getTaskScheduler } from '../utils/context.js';

const router = express.Router();

/**
 * Helper to get user data from Redis or fallback to local persistent storage.
 * Automatically restores Redis cache if local user exists.
 */
async function getUserOrFallback(uid) {
  const targetUid = parseInt(uid, 10);
  if (isNaN(targetUid)) return null;

  if (redisClient.isReady) {
    try {
      const userDataStr = await redisClient.get(`user:${targetUid}`);
      if (userDataStr) {
        return JSON.parse(userDataStr);
      }
    } catch (err) {
      // Quietly continue to local fallback
    }
  }

  // Fallback to local persistent storage
  const localUser = getLocalUser(targetUid);
  if (localUser) {
    if (redisClient.isReady) {
      try {
        await redisClient.set(`user:${targetUid}`, JSON.stringify(localUser));
      } catch (e) {}
    }
    return localUser;
  }
  return null;
}

/**
 * Add or update user configuration
 */
router.post('/users', async (req, res) => {
  try {
    let { uid, uuid, flowId, accessKey, token, machineId, platform, phone, isActive } = req.body;

    // Ensure uid is an integer
    uid = parseInt(uid, 10);

    if (!uid || !uuid || !flowId || !accessKey) {
      return res.status(400).json({
        code: 400,
        message: 'Missing required fields: uid, uuid, flowId, accessKey',
      });
    }

    const user = {
      uid,
      uuid,
      flowId,
      accessKey,
      token: token || null,
      machineId: machineId || '830504a3-d020-43af-b3e6-4c8690f5d6be',
      platform: platform || 'mac',
      phone,
      isActive: isActive !== false,
      createdAt: new Date().toISOString(),
    };

    // If token not provided, try to get login token
    if (!token) {
      try {
        logger.info(`[API] Getting initial token for user ${uid}`);
        const loginResult = await apiService.checkLogin(
          uid,
          user.platform,
          user.accessKey,
          user.machineId,
          null // No token for first login attempt
        );
        user.token = loginResult.token;
        user.tokenUpdatedAt = new Date().toISOString();
        logger.info(`[API] ✅ Token obtained for user ${uid}`);
      } catch (error) {
        logger.warn(`[API] Failed to get initial token for user ${uid}: ${error.message}`);
        // Don't fail, token can be refreshed later
        user.token = null;
      }
    } else {
      // Token was provided by user
      user.tokenUpdatedAt = new Date().toISOString();
      logger.info(`[API] User provided token for uid ${uid}`);
    }

    // Save to local persistent storage first
    saveLocalUser(user);

    // Save user data to Redis
    await redisClient.set(`user:${uid}`, JSON.stringify(user));

    // Add to users list in Redis
    let users = [];
    const usersJson = await redisClient.get('config:users');
    if (usersJson) {
      users = JSON.parse(usersJson);
    }

    const existingIndex = users.findIndex((u) => u.uid === uid);
    if (existingIndex >= 0) {
      users[existingIndex] = user;
    } else {
      users.push(user);
    }

    await redisClient.set('config:users', JSON.stringify(users));

    broadcastToClients({
      type: 'userAdded',
      user,
      timestamp: new Date().toISOString(),
    });

    res.json({
      code: 0,
      message: 'User configured successfully',
      data: user,
    });
  } catch (error) {
    logger.error('Failed to add user:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Get all users
 */
router.get('/users', async (req, res) => {
  try {
    let users = [];
    if (redisClient.isReady) {
      const usersJson = await redisClient.get('config:users');
      if (usersJson) {
        users = JSON.parse(usersJson);
      }
    }

    // If Redis has no users or is offline, fallback to local storage
    if (!users || users.length === 0) {
      const localUsers = getLocalUsers();
      if (localUsers.length > 0) {
        users = localUsers;
        if (redisClient.isReady) {
          try {
            await redisClient.set('config:users', JSON.stringify(users));
            for (const u of users) {
              await redisClient.set(`user:${u.uid}`, JSON.stringify(u));
            }
          } catch (e) {}
        }
      }
    }

    res.json({
      code: 0,
      data: users,
    });
  } catch (error) {
    const fallbackUsers = getLocalUsers();
    res.json({
      code: 0,
      data: fallbackUsers,
    });
  }
});

/**
 * Get user details
 */
router.get('/users/:uid', async (req, res) => {
  try {
    const user = await getUserOrFallback(req.params.uid);

    if (!user) {
      return res.status(404).json({
        code: 404,
        message: 'User not found',
      });
    }

    res.json({
      code: 0,
      data: user,
    });
  } catch (error) {
    logger.error('Failed to get user:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Get user tasks
 */
router.get('/users/:uid/tasks', async (req, res) => {
  try {
    let { uid } = req.params;
    uid = parseInt(uid, 10);
    const tasksJson = await redisClient.get(`tasks:${uid}`);
    const tasks = tasksJson ? JSON.parse(tasksJson) : [];

    res.json({
      code: 0,
      data: tasks,
    });
  } catch (error) {
    logger.error('Failed to get tasks:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Get user info from FuFuHub API
 * Also fetch latest tasks status
 * Auto-retry with token refresh on TOKEN_EXPIRED
 */
router.get('/users/:uid/info', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    const user = await getUserOrFallback(uid);
    if (!user) {
      return res.status(404).json({
        code: 404,
        message: 'User not found',
      });
    }

    // Get user info from API
    let userInfo;
    try {
      userInfo = await apiService.getUserInfo(
        user.flowId,
        user.uuid,
        user.uid,
        user.token,
        user.accessKey,
        user.machineId,
        user.platform || 'mac'
      );
    } catch (error) {
      // If token expired, refresh and retry once
      if (error.message === 'TOKEN_EXPIRED') {
        logger.warn(`[Get Info] Token expired for user ${uid}, refreshing and retrying...`);
        
        // Refresh token from scheduler
        const scheduler = getTaskScheduler();
        if (scheduler) {
          const updatedUserData = await scheduler.refreshUserToken(user);
          user.token = updatedUserData.token;
        }

        // Retry the getUserInfo call
        userInfo = await apiService.getUserInfo(
          user.flowId,
          user.uuid,
          user.uid,
          user.token,
          user.accessKey,
          user.machineId,
          user.platform || 'mac'
        );
      } else {
        throw error;
      }
    }

    // Also fetch latest tasks to update task status
    let tasks;
    try {
      tasks = await apiService.getActivityTasks(
        user.flowId,
        user.uid,
        user.uuid,
        user.accessKey,
        user.token,
        user.machineId,
        user.platform || 'mac'
      );
      
      // Save tasks to Redis with updated status
      await redisClient.set(`tasks:${user.uid}`, JSON.stringify(tasks));
      await redisClient.set(
        `tasks:${user.uid}:fetchedAt`,
        new Date().toISOString()
      );
      
      logger.info(`[Get Info] Updated ${tasks.length} tasks for user ${uid}`);
      
      broadcastToClients({
        type: 'tasksUpdated',
        uid: user.uid,
        tasks,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // If token expired during task fetch, refresh and retry once
      if (error.message === 'TOKEN_EXPIRED') {
        logger.warn(`[Get Info] Token expired during task fetch for user ${uid}, refreshing and retrying...`);
        
        const scheduler = getTaskScheduler();
        if (scheduler) {
          const updatedUserData = await scheduler.refreshUserToken(user);
          user.token = updatedUserData.token;
        }

        // Retry tasks fetch
        try {
          tasks = await apiService.getActivityTasks(
            user.flowId,
            user.uid,
            user.uuid,
            user.accessKey,
            user.token,
            user.machineId,
            user.platform || 'mac'
          );
          
          await redisClient.set(`tasks:${user.uid}`, JSON.stringify(tasks));
          await redisClient.set(
            `tasks:${user.uid}:fetchedAt`,
            new Date().toISOString()
          );
          
          logger.info(`[Get Info] Updated ${tasks.length} tasks for user ${uid} (after retry)`);
          
          broadcastToClients({
            type: 'tasksUpdated',
            uid: user.uid,
            tasks,
            timestamp: new Date().toISOString(),
          });
        } catch (retryError) {
          logger.warn(`[Get Info] Failed to fetch tasks after retry: ${retryError.message}`);
          // Don't fail the entire request, just log the warning
        }
      } else {
        logger.warn(`[Get Info] Failed to fetch tasks: ${error.message}`);
        // Don't fail the entire request, just log the warning
      }
    }

    res.json({
      code: 0,
      data: userInfo,
    });
  } catch (error) {
    logger.error('Failed to get user info:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Get execution logs
 */
router.get('/users/:uid/logs', async (req, res) => {
  try {
    let { uid } = req.params;
    uid = parseInt(uid, 10);
    const logsJson = await redisClient.get(`logs:${uid}`);
    const logs = logsJson ? JSON.parse(logsJson) : [];

    res.json({
      code: 0,
      data: logs,
    });
  } catch (error) {
    logger.error('Failed to get logs:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Manually refresh user token
 */
router.post('/users/:uid/refresh-token', async (req, res) => {
  try {
    const user = await getUserOrFallback(req.params.uid);
    if (!user) {
      return res.status(404).json({
        code: 404,
        message: 'User not found',
      });
    }

    const loginResult = await apiService.checkLogin(
      user.uid,
      user.platform || 'mac',
      user.accessKey,
      user.machineId,
      user.token
    );
    user.token = loginResult.token;
    user.tokenUpdatedAt = new Date().toISOString();

    // Persist to local storage & Redis
    saveLocalUser(user);
    await redisClient.set(`user:${user.uid}`, JSON.stringify(user));

    // Update config:users in Redis if present
    try {
      const usersJson = await redisClient.get('config:users');
      if (usersJson) {
        let users = JSON.parse(usersJson);
        const idx = users.findIndex((u) => u.uid === user.uid);
        if (idx >= 0) {
          users[idx] = user;
          await redisClient.set('config:users', JSON.stringify(users));
        }
      }
    } catch (err) {}

    res.json({
      code: 0,
      message: 'Token refreshed successfully',
      data: user,
    });
  } catch (error) {
    logger.error('Failed to refresh token:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Get user rewards (order_type=101 only)
 * Returns rewards grouped by expiry date with total duration
 */
router.get('/users/:uid/rewards', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    const user = await getUserOrFallback(uid);
    if (!user) {
      return res.status(404).json({
        code: 404,
        message: 'User not found',
      });
    }

    let orderData;

    try {
      orderData = await apiService.getOrderHistory(
        user.flowId,
        user.uid,
        user.uuid,
        user.accessKey,
        user.token,
        user.machineId,
        user.platform
      );
    } catch (error) {
      // If token expired, refresh and retry once
      if (error.message === 'TOKEN_EXPIRED') {
        logger.warn(`[Get Rewards] Token expired for user ${uid}, refreshing and retrying...`);
        
        // Refresh token from scheduler
        const scheduler = getTaskScheduler();
        if (scheduler) {
          const updatedUserData = await scheduler.refreshUserToken(user);
          user.token = updatedUserData.token;
        }

        // Retry the order history call
        orderData = await apiService.getOrderHistory(
          user.flowId,
          user.uid,
          user.uuid,
          user.accessKey,
          user.token,
          user.machineId,
          user.platform
        );
      } else {
        throw error;
      }
    }

    // Filter only order_type = 101 (task rewards)
    let taskRewards = (orderData.order_list || []).filter(order => order.order_type === 101);
    
    // Only keep the most recent reward (limit to 5)
    if (taskRewards.length > 1) {
      taskRewards = taskRewards.slice(0, 5);
    }
    
    logger.info(`[Get Rewards] Filtered to most recent reward: ${taskRewards.length}`);

    // Group by sale_duration and calculate total minutes
    const rewardsByExpiry = {};
    taskRewards.forEach(order => {
      const expiryDate = order.sale_duration;
      if (!rewardsByExpiry[expiryDate]) {
        rewardsByExpiry[expiryDate] = {
          expiryDate,
          rewards: [],
          totalMinutes: 0,
        };
      }
      
      // Extract minutes from sale_name (e.g., "15分钟卡" -> 15, "1小时卡" -> 60)
      let minutes = 0;
      const minutesMatch = order.sale_name.match(/(\d+)分钟/);
      const hoursMatch = order.sale_name.match(/(\d+)小时/);
      
      if (minutesMatch) {
        minutes = parseInt(minutesMatch[1]);
      } else if (hoursMatch) {
        minutes = parseInt(hoursMatch[1]) * 60;
      }
      
      rewardsByExpiry[expiryDate].rewards.push({
        id: order.id,
        saleName: order.sale_name,
        minutes: minutes,
        payType: order.pay_type,
        state: order.state,
        orderTime: order.order_time,
      });
      
      rewardsByExpiry[expiryDate].totalMinutes += minutes;
    });

    // Convert to array and sort by expiry date (oldest first)
    const rewardsList = Object.values(rewardsByExpiry).sort((a, b) => {
      return new Date(a.expiryDate) - new Date(b.expiryDate);
    });

    logger.info(`[Get Rewards] Retrieved ${taskRewards.length} task rewards (101) for user ${uid}`);

    res.json({
      code: 0,
      message: 'Rewards retrieved successfully',
      data: {
        totalRewards: taskRewards.length,
        rewardsByExpiry: rewardsList,
      },
    });
  } catch (error) {
    logger.error('Failed to get rewards:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Get user check-in status & list
 */
router.get('/users/:uid/checkin', async (req, res) => {
  try {
    const user = await getUserOrFallback(req.params.uid);
    if (!user) {
      return res.status(404).json({
        code: 404,
        message: 'User not found',
      });
    }

    let checkinData;

    try {
      checkinData = await apiService.getCheckinList(
        user.uid,
        user.token,
        user.accessKey,
        user.machineId,
        user.platform || 'mac'
      );
    } catch (error) {
      if (error.message === 'TOKEN_EXPIRED') {
        const scheduler = getTaskScheduler();
        if (scheduler) {
          const updatedUserData = await scheduler.refreshUserToken(user);
          user.token = updatedUserData.token;
        }

        checkinData = await apiService.getCheckinList(
          user.uid,
          user.token,
          user.accessKey,
          user.machineId,
          user.platform || 'mac'
        );
      } else {
        throw error;
      }
    }

    // Save to Redis cache
    await redisClient.set(`checkin:${user.uid}`, JSON.stringify(checkinData));

    res.json({
      code: 0,
      data: checkinData,
    });
  } catch (error) {
    logger.error('Failed to get check-in list:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Manually trigger daily check-in for a user
 */
router.post('/users/:uid/checkin', async (req, res) => {
  try {
    const user = await getUserOrFallback(req.params.uid);
    if (!user) {
      return res.status(404).json({
        code: 404,
        message: 'User not found',
      });
    }

    const scheduler = getTaskScheduler();

    if (!scheduler) {
      return res.status(500).json({
        code: 500,
        message: 'Task Scheduler not available',
      });
    }

    const result = await scheduler.executeCheckin(user, user);

    res.json({
      code: 0,
      message: result.success ? 'Check-in executed successfully' : 'Check-in skipped or already completed',
      data: result,
    });
  } catch (error) {
    logger.error('Failed to execute check-in:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Delete user
 */
router.delete('/users/:uid', async (req, res) => {
  try {
    let { uid } = req.params;
    uid = parseInt(uid, 10);

    // Remove from local persistent storage
    deleteLocalUser(uid);

    // Remove user data from Redis
    await redisClient.del(`user:${uid}`);
    await redisClient.del(`tasks:${uid}`);
    await redisClient.del(`logs:${uid}`);
    await redisClient.del(`token:${uid}:lastRefresh`);

    // Remove from users list in Redis
    let users = [];
    const usersJson = await redisClient.get('config:users');
    if (usersJson) {
      users = JSON.parse(usersJson);
      users = users.filter((u) => u.uid !== uid);
      await redisClient.set('config:users', JSON.stringify(users));
    }

    broadcastToClients({
      type: 'userRemoved',
      uid: uid,
      timestamp: new Date().toISOString(),
    });

    res.json({
      code: 0,
      message: 'User deleted successfully',
    });
  } catch (error) {
    logger.error('Failed to delete user:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Manually trigger task completion
 * Auto-retry with token refresh on TOKEN_EXPIRED
 */
router.post('/users/:uid/tasks/:taskId/complete', async (req, res) => {
  try {
    const { uid, taskId } = req.params;

    const user = await getUserOrFallback(uid);
    if (!user) {
      return res.status(404).json({
        code: 404,
        message: 'User not found',
      });
    }

    const tasksJson = await redisClient.get(`tasks:${uid}`);
    const tasks = tasksJson ? JSON.parse(tasksJson) : [];
    const task = tasks.find((t) => t.task_id === parseInt(taskId));

    if (!task) {
      return res.status(404).json({
        code: 404,
        message: 'Task not found',
      });
    }
    let result;

    try {
      result = await apiService.completeTask(
        user.flowId,
        user.uid,
        user.uuid,
        user.accessKey,
        task.task_id,
        user.token
      );
    } catch (error) {
      // If token expired, refresh and retry once
      if (error.message === 'TOKEN_EXPIRED') {
        logger.warn(`[Manual Complete] Token expired for user ${uid}, refreshing and retrying...`);
        
        // Refresh token from scheduler
        const scheduler = getTaskScheduler();
        if (scheduler) {
          const updatedUserData = await scheduler.refreshUserToken(user);
          user.token = updatedUserData.token;
        }

        // Retry the complete task call
        result = await apiService.completeTask(
          user.flowId,
          user.uid,
          user.uuid,
          user.accessKey,
          task.task_id,
          user.token
        );
      } else {
        throw error;
      }
    }

    res.json({
      code: 0,
      message: 'Task completed',
      data: result,
    });
  } catch (error) {
    logger.error('Failed to complete task:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Start task scheduler
 */
router.post('/scheduler/start', async (req, res) => {
  try {
    const scheduler = getTaskScheduler();
    if (scheduler) {
      scheduler.start();
      logger.info('Task Scheduler started');
      res.json({
        code: 0,
        message: 'Task Scheduler started',
      });
    } else {
      res.status(500).json({
        code: 500,
        message: 'Task Scheduler not available',
      });
    }
  } catch (error) {
    logger.error('Failed to start scheduler:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Stop task scheduler
 */
router.post('/scheduler/stop', async (req, res) => {
  try {
    const scheduler = getTaskScheduler();
    if (scheduler) {
      scheduler.stop();
      logger.info('Task Scheduler stopped');
      res.json({
        code: 0,
        message: 'Task Scheduler stopped',
      });
    } else {
      res.status(500).json({
        code: 500,
        message: 'Task Scheduler not available',
      });
    }
  } catch (error) {
    logger.error('Failed to stop scheduler:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Get scheduler status
 */
router.get('/scheduler/status', async (req, res) => {
  try {
    const scheduler = getTaskScheduler();
    if (scheduler) {
      res.json({
        code: 0,
        data: {
          isRunning: scheduler.isRunning,
          status: scheduler.isRunning ? 'running' : 'stopped',
        },
      });
    } else {
      res.status(500).json({
        code: 500,
        message: 'Task Scheduler not available',
      });
    }
  } catch (error) {
    logger.error('Failed to get scheduler status:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

/**
 * Get system logs
 */
router.get('/system/logs', async (req, res) => {
  try {
    let logs = [];
    if (redisClient.isReady) {
      const logsJson = await redisClient.get('system:logs');
      if (logsJson) {
        logs = JSON.parse(logsJson);
      }
    }

    // Fallback to in-memory logs if Redis returned empty or is offline
    if ((!logs || logs.length === 0) && inMemoryLogs.length > 0) {
      logs = inMemoryLogs;
    }

    res.json({
      code: 0,
      data: logs || [],
    });
  } catch (error) {
    res.json({
      code: 0,
      data: inMemoryLogs || [],
    });
  }
});

/**
 * Manually execute daily tasks for a specific user
 */
router.post('/users/:uid/execute-tasks', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    const user = await getUserOrFallback(uid);
    if (!user) {
      return res.status(404).json({
        code: 404,
        message: 'User not found',
      });
    }

    const scheduler = getTaskScheduler();
    
    if (!scheduler) {
      return res.status(500).json({
        code: 500,
        message: 'Task Scheduler not available',
      });
    }

    // Execute daily sign-in for this user
    logger.info(`[Manual Execute] Starting manual task execution for user ${uid}`);
    
    // Run in background
    scheduler.executeDailySignIn(user).catch(error => {
      logger.error(`[Manual Execute] Failed for user ${uid}:`, error.message);
    });

    res.json({
      code: 0,
      message: 'Task execution started for user ' + uid,
      data: {
        uid: user.uid,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Failed to execute tasks:', error);
    res.status(500).json({
      code: 500,
      message: error.message,
    });
  }
});

export default router;
