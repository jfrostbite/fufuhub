import schedule from 'node-schedule';
import redisClient from '../utils/redis.js';
import { logger } from '../utils/logger.js';
import apiService from './apiService.js';
import { broadcastToClients } from '../index.js';

/**
 * 每天一次的签到任务调度器
 * 每天北京时间 10-11 点的随机时间触发（Asia/Shanghai 时区）
 * 1. 获取一次任务列表
 * 2. 按照任务条件（如 90 分钟等待）执行完成
 * 不频繁请求上游接口
 */
export class TaskScheduler {
  constructor() {
    this.jobs = new Map();
    this.isRunning = false;
    // 使用北京时区（Asia/Shanghai, UTC+8）
    this.timezone = process.env.SCHEDULER_TIMEZONE || 'Asia/Shanghai';
    this.workerInterval = null;
    this.checkIntervalMs = parseInt(process.env.TASK_CHECK_INTERVAL, 10) || 30000;
    this.heartbeatStartHour = parseInt(process.env.HEARTBEAT_START_HOUR, 10) || 10;
    this.heartbeatEndHour = parseInt(process.env.HEARTBEAT_END_HOUR, 10) || 22;
  }

  async initialize() {
    try {
      const users = await this.loadUsers();
      logger.info(`Loaded ${users.length} users from configuration`);
    } catch (error) {
      logger.error('Failed to initialize TaskScheduler:', error);
      throw error;
    }
  }

  async loadUsers() {
    try {
      const usersJson = await redisClient.get('config:users');
      if (usersJson) {
        return JSON.parse(usersJson);
      }
      return [];
    } catch (error) {
      logger.error('Failed to load users:', error);
      return [];
    }
  }

  start() {
    if (this.isRunning) {
      logger.warn('TaskScheduler is already running');
      return;
    }

    this.isRunning = true;
    logger.info(`TaskScheduler started - Minute heartbeat & Dual execution mode (${this.timezone})`);
    this.addSystemLog(`✅ 调度器已启动 - 每日 10:00 (上午10点) 自动签到抽奖与 10:00-22:00 心跳推进已就绪 (Timezone: ${this.timezone})`, 'success');

    // Schedule daily task execution at random time between 10-11 AM
    this.scheduleDailyExecution();

    // Start minute heartbeat worker for active users
    this.startHeartbeatWorker();
  }

  stop() {
    this.isRunning = false;
    this.jobs.forEach((job) => {
      job.cancel();
    });
    this.jobs.clear();

    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }

    logger.info('TaskScheduler stopped');
    this.addSystemLog('⏹️ 调度器已停止 (Scheduler stopped)', 'warning');
  }

  /**
   * Start 1-minute recurring heartbeat worker loop for Type 2 time-consuming tasks
   */
  startHeartbeatWorker() {
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
    }

    logger.info(`[Heartbeat Worker] Started with interval ${this.checkIntervalMs / 1000}s`);

    // Run first heartbeat check after 3 seconds
    setTimeout(() => {
      if (this.isRunning) {
        this.processHeartbeatForActiveUsers().catch(err => {
          logger.error('[Heartbeat Worker] Initial run error:', err.message);
        });
      }
    }, 3000);

    // Recurring interval loop
    this.workerInterval = setInterval(async () => {
      if (!this.isRunning) return;
      await this.processHeartbeatForActiveUsers();
    }, this.checkIntervalMs);
  }

  /**
   * Check if current time is within active heartbeat hours (10:00 - 22:00 Beijing Time)
   */
  isWithinHeartbeatHours() {
    try {
      const hourStr = new Intl.DateTimeFormat('en-US', {
        timeZone: this.timezone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date());
      let currentHour = parseInt(hourStr, 10);
      if (currentHour === 24) currentHour = 0;
      return currentHour >= this.heartbeatStartHour && currentHour < this.heartbeatEndHour;
    } catch (error) {
      logger.error('[Heartbeat] Error checking time window:', error.message);
      return false;
    }
  }

  /**
   * Run heartbeat task pulse for all active users
   */
  async processHeartbeatForActiveUsers() {
    try {
      if (!this.isWithinHeartbeatHours()) {
        logger.debug(`[Heartbeat] Outside active window (${this.heartbeatStartHour}:00 - ${this.heartbeatEndHour}:00 ${this.timezone}), skipping pulse check`);
        return;
      }

      const users = await this.loadUsers();
      const activeUsers = users.filter((u) => u.isActive);
      if (activeUsers.length === 0) return;

      logger.info(`[Heartbeat] Running task pulse check for ${activeUsers.length} active user(s)`);

      for (const user of activeUsers) {
        try {
          await this.pulseUserTasks(user);
        } catch (error) {
          logger.error(`[Heartbeat] Pulse failed for user ${user.uid}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('[Heartbeat] Error during periodic heartbeat loop:', error.message);
    }
  }

  /**
   * Pulse user tasks:
   * 1. Completes any Type 1 (sign-in) tasks immediately.
   * 2. If active incomplete Type 2 (time-consuming) tasks exist:
   *    Sends a completetask pulse to increment FuFuHub play time.
   * 3. Refreshes user info & task list from API, saves to Redis, and broadcasts WebSocket.
   * 4. Claims rewards automatically if progress reaches 100%.
   */
  async pulseUserTasks(user) {
    try {
      let userData = await this.getUserData(user.uid);
      if (!userData.token) {
        userData = await this.refreshUserToken(user);
      }

      // Fetch latest tasks
      let tasks;
      try {
        tasks = await apiService.getActivityTasks(
          user.flowId,
          user.uid,
          user.uuid,
          user.accessKey,
          userData.token,
          user.machineId,
          user.platform || 'mac'
        );
      } catch (error) {
        if (error.message === 'TOKEN_EXPIRED') {
          userData = await this.refreshUserToken(user);
          tasks = await apiService.getActivityTasks(
            user.flowId,
            user.uid,
            user.uuid,
            user.accessKey,
            userData.token,
            user.machineId,
            user.platform || 'mac'
          );
        } else {
          throw error;
        }
      }

      // Save latest tasks to Redis
      await redisClient.set(`tasks:${user.uid}`, JSON.stringify(tasks));

      // 1. Process Type 1 tasks (sign-in)
      const type1Tasks = tasks.filter((t) => t.task_type === 1);
      for (const task of type1Tasks) {
        await this.completeTaskCall(user, userData, task);
      }

      // 2. Process Type 2 & Type 3 tasks (time-consuming & 30s pulse tasks)
      const incompletePulseTasks = tasks.filter(
        (t) => (t.task_type === 2 || t.task_type === 3) && (t.task_value || 0) < (t.task_target || 0)
      );

      const completedPulseTasks = tasks.filter(
        (t) => (t.task_type === 2 || t.task_type === 3) && (t.task_target || 0) > 0 && (t.task_value || 0) >= (t.task_target || 0)
      );

      // Claim rewards for tasks that reached 100%
      for (const task of completedPulseTasks) {
        const completionKey = `task:${user.uid}:${task.task_id}:completed`;
        const alreadyDone = await redisClient.get(completionKey);
        if (!alreadyDone) {
          logger.info(`[Pulse] Claiming completed Task ${task.task_id} (${task.task_name}) Type: ${task.task_type}`);
          await this.completeTaskCall(user, userData, task);
        }
      }

      // Pulse incomplete Type 2 & Type 3 tasks based on individual interval requirement:
      // Type 3: 30 seconds interval (30,000 ms)
      // Type 2: 60 seconds interval (60,000 ms - 拟真1分钟一次)
      let pulsedAnyTask = false;

      if (incompletePulseTasks.length > 0) {
        for (const targetTask of incompletePulseTasks) {
          const lastPulseKey = `task:${user.uid}:${targetTask.task_id}:lastPulse`;
          const lastPulseStr = await redisClient.get(lastPulseKey);
          const lastPulseTime = lastPulseStr ? parseInt(lastPulseStr, 10) : 0;
          const now = Date.now();

          // Type 3 requires 30s, Type 2 requires 60s (1 min)
          const requiredIntervalMs = targetTask.task_type === 3 ? 30000 : 60000;

          if (now - lastPulseTime < requiredIntervalMs - 2000) {
            const elapsedSec = Math.round((now - lastPulseTime) / 1000);
            logger.info(
              `[Pulse] Skipping task ${targetTask.task_id} (${targetTask.task_name}, Type ${targetTask.task_type}) - last pulse was ${elapsedSec}s ago (required: ${requiredIntervalMs / 1000}s)`
            );
            continue;
          }

          pulsedAnyTask = true;
          const progress = targetTask.task_value || 0;
          const target = targetTask.task_target || 0;
          const intervalLabel = targetTask.task_type === 3 ? '30秒' : '1分钟';

          logger.info(
            `[Pulse] Sending pulse for user ${user.uid}, Task ${targetTask.task_id} (${targetTask.task_name}) Type: ${targetTask.task_type} (${progress}/${target}) Interval: ${intervalLabel}`
          );
          this.addSystemLog(
            `💓 正在为用户 ${user.uid} 发送心跳脉冲 (任务: ${targetTask.task_name}, Type ${targetTask.task_type}, 频率: ${intervalLabel}, 当前进度: ${progress}/${target})`,
            'info'
          );

          // Send completetask pulse
          try {
            await apiService.completeTask(
              user.flowId,
              user.uid,
              user.uuid,
              user.accessKey,
              targetTask.task_id,
              userData.token,
              user.machineId,
              user.platform || 'mac'
            );
            await redisClient.set(lastPulseKey, now.toString());
          } catch (pulseErr) {
            if (pulseErr.message === 'TOKEN_EXPIRED') {
              userData = await this.refreshUserToken(user);
              await apiService.completeTask(
                user.flowId,
                user.uid,
                user.uuid,
                user.accessKey,
                targetTask.task_id,
                userData.token,
                user.machineId,
                user.platform || 'mac'
              );
              await redisClient.set(lastPulseKey, now.toString());
            } else {
              logger.warn(`[Pulse] Pulse call note for task ${targetTask.task_id}: ${pulseErr.message}`);
            }
          }
        }

        // Fetch refreshed user info & tasks from API
        const updatedTasks = await apiService.getActivityTasks(
          user.flowId,
          user.uid,
          user.uuid,
          user.accessKey,
          userData.token,
          user.machineId,
          user.platform || 'mac'
        );

        const updatedUserInfo = await apiService.getUserInfo(
          user.flowId,
          user.uuid,
          user.uid,
          userData.token,
          user.accessKey,
          user.machineId,
          user.platform || 'mac'
        );

        // Save to Redis
        await redisClient.set(`tasks:${user.uid}`, JSON.stringify(updatedTasks));
        await redisClient.set(`tasks:${user.uid}:fetchedAt`, new Date().toISOString());

        // Broadcast to WebSocket clients
        broadcastToClients({
          type: 'tasksUpdated',
          uid: user.uid,
          tasks: updatedTasks,
          timestamp: new Date().toISOString(),
        });

        broadcastToClients({
          type: 'userInfoUpdated',
          uid: user.uid,
          userInfo: updatedUserInfo,
          timestamp: new Date().toISOString(),
        });

        logger.info(`[Pulse] ✅ Task progress pulse completed & broadcasted for user ${user.uid}`);
      }
    } catch (error) {
      logger.error(`[Pulse] Error pulsing tasks for user ${user.uid}:`, error.message);
    }
  }

  /**
   * Schedule daily sign-in task execution
   * First execution: Random time between 10:00 AM - 11:00 AM (10:00-11:00) Beijing Time (Asia/Shanghai)
   * Second execution: 4 hours after first execution completes
   */
  scheduleDailyExecution() {
    // CronJob: Run at 10:00 AM (10:00) Beijing Time with random minute/second
    // 0 10 * * * = Every day at 10:00 (10:00 AM) in specified timezone
    const job = schedule.scheduleJob(
      { hour: 10, minute: 0, tz: this.timezone },
      async () => {
        if (!this.isRunning) {
          logger.info('Scheduler not running, skipping daily execution');
          return;
        }

        // Add random delay (0-60 minutes) to spread execution between 10:00-11:00
        const randomDelay = Math.floor(Math.random() * 60 * 60 * 1000); // 0-60 minutes in ms
        const randomMinutes = Math.floor(randomDelay / 60000);

        logger.info(`[First Execution] Trigger at 10:00 AM (10:00) ${this.timezone}, scheduling for +${randomMinutes} minutes`);

        setTimeout(async () => {
          if (!this.isRunning) return;

          const users = await this.loadUsers();
          logger.info(`[First Execution] Starting for ${users.length} users`);
          this.addSystemLog(`📅 第一次执行开始 (${users.length} 个账户) - First execution started`, 'info');

          for (const user of users) {
            if (user.isActive) {
              try {
                await this.executeDailySignIn(user, 1);
              } catch (error) {
                logger.error(`[First Execution] Error for user ${user.uid}:`, error.message);
                this.addSystemLog(
                  `❌ 用户 ${user.uid} 第一次执行失败: ${error.message}`,
                  'error'
                );
              }
            }
          }

          logger.info('[First Execution] Completed');
          this.addSystemLog('✅ 第一次执行完成 (First execution completed)', 'success');

          // Schedule second execution 4 hours later
          this.scheduleSecondExecution();
        }, randomDelay);
      }
    );

    this.jobs.set('dailyExecution', job);
    logger.info(`First execution scheduled for 10:00 AM (10:00) ${this.timezone} (random time between 10:00-11:00)`);
    logger.info(`Second execution will be scheduled 4 hours after first execution completes`);
  }

  /**
   * Schedule second execution 4 hours after first execution
   */
  scheduleSecondExecution() {
    const fourHoursLater = new Date(Date.now() + 4 * 60 * 60 * 1000);
    logger.info(`[Second Execution] Scheduled for ${fourHoursLater.toLocaleString('zh-CN', { timeZone: this.timezone })}`);
    this.addSystemLog(
      `⏰ 第二次执行已安排在 4 小时后 (${fourHoursLater.toLocaleTimeString('zh-CN', { timeZone: this.timezone })})`,
      'info'
    );

    const job = schedule.scheduleJob(fourHoursLater, async () => {
      if (!this.isRunning) {
        logger.info('[Second Execution] Scheduler not running, skipping');
        return;
      }

      const users = await this.loadUsers();
      logger.info(`[Second Execution] Starting for ${users.length} users`);
      this.addSystemLog(`📅 第二次执行开始 (${users.length} 个账户) - Second execution started`, 'info');

      for (const user of users) {
        if (user.isActive) {
          try {
            await this.executeDailySignIn(user, 2);
          } catch (error) {
            logger.error(`[Second Execution] Error for user ${user.uid}:`, error.message);
            this.addSystemLog(
              `❌ 用户 ${user.uid} 第二次执行失败: ${error.message}`,
              'error'
            );
          }
        }
      }

      logger.info('[Second Execution] Completed');
      this.addSystemLog('✅ 第二次执行完成 (Second execution completed)', 'success');

      // Clean up this job
      this.jobs.delete('secondExecution');
    });

    this.jobs.set('secondExecution', job);
  }

  /**
   * Execute checkin for a user based on checkin list and date logic
   * @param {Object} user - User config
   * @param {Object} userData - User session data with token
   * @returns {Promise<Object>} Checkin result
   */
  async executeCheckin(user, userData) {
    try {
      logger.info(`[Checkin] Fetching checkin list for user ${user.uid}...`);
      this.addSystemLog(`📅 正在获取签到任务列表 (UID: ${user.uid})...`, 'info');

      let checkinData;
      try {
        checkinData = await apiService.getCheckinList(
          user.uid,
          userData.token,
          user.accessKey,
          user.machineId,
          user.platform || 'mac'
        );
      } catch (error) {
        if (error.message === 'TOKEN_EXPIRED') {
          logger.warn(`[Checkin] Token expired for user ${user.uid}, refreshing token...`);
          userData = await this.refreshUserToken(user);
          checkinData = await apiService.getCheckinList(
            user.uid,
            userData.token,
            user.accessKey,
            user.machineId,
            user.platform || 'mac'
          );
        } else {
          throw error;
        }
      }

      const checkinList = checkinData?.checkin_list || [];
      const checkinCount = checkinData?.checkin_count || 0;

      // Save checkin list to Redis
      await redisClient.set(`checkin:${user.uid}`, JSON.stringify(checkinData));

      // Filter items with non-empty date string
      const checkedInItems = checkinList.filter((item) => item.date && item.date.trim() !== '');

      // Get current date string in timezone (YYYY-MM-DD)
      const getTodayDateStr = () => {
        const formatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: this.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        return formatter.format(new Date());
      };

      const todayStr = getTodayDateStr();

      // Check the latest checked in date
      let latestCheckinDateStr = null;
      if (checkedInItems.length > 0) {
        const lastCheckedIn = checkedInItems[checkedInItems.length - 1];
        if (lastCheckedIn.date) {
          latestCheckinDateStr = lastCheckedIn.date.trim().split(' ')[0];
        }
      }

      logger.info(`[Checkin] User ${user.uid} - Today: ${todayStr}, Latest Checkin Date: ${latestCheckinDateStr || 'None'}, Checkin Count: ${checkinCount}`);

      if (latestCheckinDateStr && latestCheckinDateStr === todayStr) {
        logger.info(`[Checkin] ℹ️ Today (${todayStr}) is already checked in for user ${user.uid}`);
        this.addSystemLog(`ℹ️ 用户 ${user.uid} 今日已成功签到 (${latestCheckinDateStr})，跳过签到动作`, 'info');
        return { success: false, reason: 'ALREADY_CHECKED_IN', date: latestCheckinDateStr, checkinData };
      }

      // Today is not checked in yet, determine target prize_sec_id using smart logic
      const targetSecId = checkinCount + 1;
      let targetPrize = checkinList.find((item) => item.prize_sec_id === targetSecId);

      // Fallback: search for first item where date is empty
      if (!targetPrize) {
        targetPrize = checkinList.find((item) => !item.date || item.date.trim() === '');
      }

      if (!targetPrize) {
        logger.warn(`[Checkin] No available checkin prize found for user ${user.uid}`);
        this.addSystemLog(`⚠️ 用户 ${user.uid} 未找到可领取的签到礼包`, 'warning');
        return { success: false, reason: 'NO_PRIZE_AVAILABLE', checkinData };
      }

      logger.info(`[Checkin] User ${user.uid} preparing to check in for Day ${targetPrize.prize_sec_id} (${targetPrize.prize_name}, Prize ID: ${targetPrize.prize_id})...`);
      this.addSystemLog(`📝 正在为用户 ${user.uid} 执行第 ${targetPrize.prize_sec_id} 天签到 (${targetPrize.prize_name})...`, 'info');

      let claimResult;
      try {
        claimResult = await apiService.checkinPrize(
          targetPrize.prize_id,
          user.uid,
          userData.token,
          user.accessKey,
          user.machineId,
          user.platform || 'mac'
        );
      } catch (error) {
        if (error.message === 'TOKEN_EXPIRED') {
          logger.warn(`[Checkin] Token expired during checkinPrize, refreshing...`);
          userData = await this.refreshUserToken(user);
          claimResult = await apiService.checkinPrize(
            targetPrize.prize_id,
            user.uid,
            userData.token,
            user.accessKey,
            user.machineId,
            user.platform || 'mac'
          );
        } else {
          throw error;
        }
      }

      logger.info(`[Checkin] ✅ User ${user.uid} checked in successfully for ${targetPrize.prize_name}`);
      this.addSystemLog(
        `✅ 用户 ${user.uid} 签到成功！获得: ${claimResult?.prize_name || targetPrize.prize_name} (${claimResult?.date || '刚刚'})`,
        'success'
      );

      // Update Redis cache for checkin list after successful checkin
      try {
        const updatedCheckinData = await apiService.getCheckinList(
          user.uid,
          userData.token,
          user.accessKey,
          user.machineId,
          user.platform || 'mac'
        );
        await redisClient.set(`checkin:${user.uid}`, JSON.stringify(updatedCheckinData));
      } catch (e) {
        logger.warn(`[Checkin] Non-critical error updating checkin cache: ${e.message}`);
      }

      broadcastToClients({
        type: 'checkinCompleted',
        uid: user.uid,
        result: claimResult,
        timestamp: new Date().toISOString(),
      });

      return { success: true, data: claimResult };
    } catch (error) {
      logger.error(`[Checkin] ❌ Checkin failed for user ${user.uid}:`, error.message);
      this.addSystemLog(`❌ 用户 ${user.uid} 签到失败: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Execute daily sign-in for a user
   * 1. Fetch tasks once
   * 2. Process each task based on wait conditions
   * Auto-retry with token refresh on TOKEN_EXPIRED
   * @param {Object} user - User configuration
   * @param {number} executionNumber - 1 for first execution, 2 for second execution
   */
  async executeDailySignIn(user, executionNumber = 1) {
    try {
      const execLabel = executionNumber === 1 ? 'First' : 'Second';
      logger.info(`[${execLabel}] Executing daily sign-in for user ${user.uid}`);

      // Get user data
      let userData = await this.getUserData(user.uid);
      if (!userData.token) {
        logger.warn(`[${execLabel}] No token available for user ${user.uid}, refreshing...`);
        userData = await this.refreshUserToken(user);
        if (!userData.token) {
          throw new Error('Failed to refresh token');
        }
      }

      // ===== STEP 0: EXECUTE CHECK-IN (NEW API & LOGIC) =====
      try {
        await this.executeCheckin(user, userData);
      } catch (checkinErr) {
        logger.error(`[${execLabel}] Check-in step encountered error for user ${user.uid}: ${checkinErr.message}`);
      }

      // ===== FIRST API CALL: GET TASKS (Only once per day) =====
      logger.info(`[${execLabel}] Fetching tasks for user ${user.uid} (ONE TIME ONLY)`);
      this.addSystemLog(`📥 正在获取任务... (Fetching tasks for UID: ${user.uid})`, 'info');

      let tasks;
      try {
        tasks = await apiService.getActivityTasks(
          user.flowId,
          user.uid,
          user.uuid,
          user.accessKey,
          userData.token,
          user.machineId,
          user.platform || 'mac'
        );
      } catch (error) {
        // If token expired, refresh and retry once
        if (error.message === 'TOKEN_EXPIRED') {
          logger.warn(`[${execLabel}] Token expired, refreshing and retrying...`);
          this.addSystemLog(
            `🔄 Token 已过期，正在刷新并重试 (Token expired, retrying)`,
            'warning'
          );

          // Refresh token and get updated userData
          userData = await this.refreshUserToken(user);

          // Verify token was updated
          logger.info(`[${execLabel}] Using refreshed token for retry: ${userData.token.substring(0, 50)}...`);

          tasks = await apiService.getActivityTasks(
            user.flowId,
            user.uid,
            user.uuid,
            user.accessKey,
            userData.token,
            user.machineId,
            user.platform || 'mac'
          );
        } else {
          throw error;
        }
      }

      logger.info(`[${execLabel}] Received ${tasks.length} tasks for user ${user.uid}`);
      this.addSystemLog(
        `📋 获取到 ${tasks.length} 个任务 (Fetched ${tasks.length} tasks)`,
        'info'
      );

      // Save task list
      await redisClient.set(`tasks:${user.uid}`, JSON.stringify(tasks));
      await redisClient.set(
        `tasks:${user.uid}:fetchedAt`,
        new Date().toISOString()
      );

      broadcastToClients({
        type: 'tasksUpdated',
        uid: user.uid,
        tasks,
        timestamp: new Date().toISOString(),
      });

      // ===== CHECK AND PERFORM LOTTERY IF AVAILABLE =====
      // First, fetch fresh user info to check lottery_num
      try {
        logger.info(`[${execLabel}] Fetching user info to check lottery tickets for user ${user.uid}`);

        let userInfo;
        try {
          userInfo = await apiService.getUserInfo(
            user.flowId,
            user.uuid,
            user.uid,
            userData.token,
            user.accessKey,
            user.machineId,
            user.platform || 'mac'
          );
        } catch (error) {
          if (error.message === 'TOKEN_EXPIRED') {
            logger.warn(`[${execLabel}] Token expired while fetching user info, refreshing...`);
            userData = await this.refreshUserToken(user);

            userInfo = await apiService.getUserInfo(
              user.flowId,
              user.uuid,
              user.uid,
              userData.token,
              user.accessKey,
              user.machineId,
              user.platform || 'mac'
            );
          } else {
            throw error;
          }
        }

        // const lotteryNum = userInfo?.lottery_num || 0;
        // TODO: The lottery draw is temporarily disabled
        const lotteryNum = 0;
        if (lotteryNum > 0) {
          logger.info(`[${execLabel}] User ${user.uid} has ${lotteryNum} lottery tickets, performing ${lotteryNum} draws...`);
          this.addSystemLog(
            `🎰 用户 ${user.uid} 有 ${lotteryNum} 张盲盒券，开始抽奖... (Performing ${lotteryNum} draws)`,
            'info'
          );

          // Draw lottery for each ticket
          for (let i = 0; i < lotteryNum; i++) {
            try {
              logger.info(`[${execLabel}] Drawing lottery ${i + 1}/${lotteryNum} for user ${user.uid}...`);
              this.addSystemLog(
                `🎰 正在抽奖 ${i + 1}/${lotteryNum}... (Draw ${i + 1}/${lotteryNum})`,
                'info'
              );

              const drawResult = await apiService.drawPrize(
                user.flowId,
                user.uid,
                user.uuid,
                user.accessKey,
                userData.token,
                user.machineId,
                user.platform || 'mac'
              );

              if (drawResult) {
                const prize = drawResult.prize || {};
                logger.info(`[${execLabel}] ✅ Draw ${i + 1} successful, prize: ${prize.prize_name}`);
                this.addSystemLog(
                  `🎁 第 ${i + 1} 次抽奖成功！获得: ${prize.prize_name} (${prize.prize_desc})`,
                  'success'
                );
              }
            } catch (error) {
              if (error.message === 'TOKEN_EXPIRED') {
                logger.warn(`[${execLabel}] Token expired during draw ${i + 1}, will retry remaining draws next time`);
                this.addSystemLog(
                  `⚠️ 第 ${i + 1} 次抽奖时 Token 过期，剩余抽奖将在下次重试 (Remaining draws will retry later)`,
                  'warning'
                );
                break; // Stop remaining draws if token expires
              } else {
                logger.error(`[${execLabel}] Draw ${i + 1} failed for user ${user.uid}:`, error.message);
                this.addSystemLog(
                  `❌ 第 ${i + 1} 次抽奖失败: ${error.message}`,
                  'error'
                );
                // Continue to next draw even if one fails
              }
            }
          }
        } else {
          logger.info(`[${execLabel}] User ${user.uid} has no lottery tickets`);
        }
      } catch (error) {
        logger.error(`[${execLabel}] Failed to fetch user info for lottery check:`, error.message);
      }

      // ===== PROCESS EACH TASK & PULSE DURATION =====
      for (const task of tasks) {
        await this.processDailyTask(user, userData, task);
      }

      // Execute immediate heartbeat pulse to advance time-consuming tasks
      await this.pulseUserTasks(user);

      logger.info(`[${execLabel}] Completed processing for user ${user.uid}, refreshing user info and tasks...`);
      this.addSystemLog(
        `🔄 任务处理完成，正在刷新用户信息和任务列表... (Refreshing user info and tasks)`,
        'info'
      );

      // ===== REFRESH USER INFO AND TASK LIST AFTER COMPLETION =====
      try {
        // Refresh user info
        let userInfoAfter;
        try {
          userInfoAfter = await apiService.getUserInfo(
            user.flowId,
            user.uuid,
            user.uid,
            userData.token,
            user.accessKey,
            user.machineId,
            user.platform || 'mac'
          );
        } catch (error) {
          if (error.message === 'TOKEN_EXPIRED') {
            logger.warn(`[${execLabel}] Token expired while refreshing user info, refreshing token...`);
            userData = await this.refreshUserToken(user);

            userInfoAfter = await apiService.getUserInfo(
              user.flowId,
              user.uuid,
              user.uid,
              userData.token,
              user.accessKey,
              user.machineId,
              user.platform || 'mac'
            );
          } else {
            throw error;
          }
        }

        // Refresh task list
        let tasksAfter;
        try {
          tasksAfter = await apiService.getActivityTasks(
            user.flowId,
            user.uid,
            user.uuid,
            user.accessKey,
            userData.token,
            user.machineId,
            user.platform || 'mac'
          );
        } catch (error) {
          if (error.message === 'TOKEN_EXPIRED') {
            logger.warn(`[${execLabel}] Token expired while refreshing tasks, refreshing token...`);
            userData = await this.refreshUserToken(user);

            tasksAfter = await apiService.getActivityTasks(
              user.flowId,
              user.uid,
              user.uuid,
              user.accessKey,
              userData.token,
              user.machineId,
              user.platform || 'mac'
            );
          } else {
            throw error;
          }
        }

        // Update Redis with refreshed data
        await redisClient.set(`tasks:${user.uid}`, JSON.stringify(tasksAfter));
        await redisClient.set(
          `tasks:${user.uid}:fetchedAt`,
          new Date().toISOString()
        );

        // Broadcast updates to all connected clients
        broadcastToClients({
          type: 'tasksUpdated',
          uid: user.uid,
          tasks: tasksAfter,
          timestamp: new Date().toISOString(),
        });

        broadcastToClients({
          type: 'userInfoUpdated',
          uid: user.uid,
          userInfo: userInfoAfter,
          timestamp: new Date().toISOString(),
        });

        logger.info(`[${execLabel}] ✅ Successfully refreshed user info and tasks for user ${user.uid}`);
        this.addSystemLog(
          `✅ 用户信息和任务列表已刷新 (User info and tasks refreshed) - UID: ${user.uid}`,
          'success'
        );
      } catch (error) {
        logger.warn(`[${execLabel}] Failed to refresh user info/tasks after completion:`, error.message);
        this.addSystemLog(
          `⚠️ 刷新用户信息失败，但任务已完成 (Refresh failed but tasks completed): ${error.message}`,
          'warning'
        );
      }
    } catch (error) {
      if (error.message === 'TOKEN_EXPIRED') {
        logger.info(`[${execLabel}] Token expired for user ${user.uid}, will retry on next daily run`);
        this.addSystemLog(
          `⚠️ Token 已过期 (Token expired for UID: ${user.uid})`,
          'warning'
        );
      } else {
        logger.error(`[${execLabel}] Failed to execute daily sign-in for user ${user.uid}:`, {
          message: error.message,
          code: error.code,
          stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        });
        this.addSystemLog(
          `❌ 每日签到失败 (Daily sign-in failed for UID: ${user.uid}): ${error.message}`,
          'error'
        );
      }
    }
  }

  /**
   * Process a single task based on task type
   * Type 1: Sign-in tasks - can be executed immediately
   * Type 2: Time-consuming tasks - check progress completion (task_value/task_target)
   * Type 3: Ignored for now
   */
  async processDailyTask(user, userData, task) {
    try {
      logger.info(
        `[Task] Processing task ${task.task_id} (${task.task_name}) Type: ${task.task_type} for user ${user.uid}`
      );

      const taskType = task.task_type;

      // Type 3: 30-second pulse tasks
      if (taskType === 3) {
        const progress = task.task_value || 0;
        const target = task.task_target || 0;

        logger.info(
          `[Task] Task ${task.task_id} is Type 3 (30s pulse), Progress: ${progress}/${target}`
        );

        if (target > 0 && progress >= target) {
          logger.info(
            `[Task] Task ${task.task_id} progress complete (${progress}/${target}), executing completion`
          );
          this.addSystemLog(
            `✅ 任务 ${task.task_id} (Type 3) 进度已完成 ${progress}/${target}，开始完成任务`,
            'success'
          );
          await this.completeTaskCall(user, userData, task);
        } else {
          logger.info(
            `[Task] Task ${task.task_id} is Type 3, sending initial pulse (repeats every 30s during heartbeat)`
          );
          this.addSystemLog(
            `💓 任务 ${task.task_id} (Type 3) 发送推进脉冲 (当前进度: ${progress}/${target}, 半分钟一次心跳)`,
            'info'
          );
          try {
            await apiService.completeTask(
              user.flowId,
              user.uid,
              user.uuid,
              user.accessKey,
              task.task_id,
              userData.token,
              user.machineId,
              user.platform || 'mac'
            );
            await redisClient.set(`task:${user.uid}:${task.task_id}:lastPulse`, Date.now().toString());
          } catch (pulseErr) {
            logger.warn(`[Task] Type 3 initial pulse call note for task ${task.task_id}: ${pulseErr.message}`);
          }
        }
        return;
      }

      // Type 1: Sign-in tasks - execute immediately
      if (taskType === 1) {
        logger.info(`[Task] Task ${task.task_id} is Type 1 (sign-in), can be completed immediately`);
        this.addSystemLog(
          `✅ 任务 ${task.task_id} (签到任务) 可立即完成 (Sign-in task ready to complete)`,
          'info'
        );
        await this.completeTaskCall(user, userData, task);
        return;
      }

      // Type 2: Time-consuming tasks - check progress
      if (taskType === 2) {
        const progress = task.task_value || 0;
        const target = task.task_target || 0;

        logger.info(
          `[Task] Task ${task.task_id} is Type 2 (time-consuming), Progress: ${progress}/${target}`
        );

        if (progress >= target) {
          // Progress is complete, can execute task
          logger.info(
            `[Task] Task ${task.task_id} progress complete (${progress}/${target}), executing completion`
          );
          this.addSystemLog(
            `✅ 任务 ${task.task_id} 进度已完成 ${progress}/${target}，开始完成任务 (Progress complete, executing task)`,
            'success'
          );
          await this.completeTaskCall(user, userData, task);
        } else {
          // Progress not complete yet
          const remaining = target - progress;
          logger.info(
            `[Task] Task ${task.task_id} progress incomplete (${progress}/${target}), ${remaining} remaining`
          );
          this.addSystemLog(
            `⏳ 任务 ${task.task_id} 进度未完成 ${progress}/${target}，还需 ${remaining} (Progress incomplete, ${remaining} remaining)`,
            'warning'
          );
        }
        return;
      }

      // Unknown task type
      logger.warn(`[Task] Task ${task.task_id} has unknown type: ${taskType}`);
      this.addSystemLog(
        `⚠️ 任务 ${task.task_id} 类型未知 (Unknown task type: ${taskType})`,
        'warning'
      );
    } catch (error) {
      logger.error(
        `[Task] Failed to process task ${task.task_id}:`,
        error.message
      );
      this.addSystemLog(
        `❌ 任务处理失败 ${task.task_id}: ${error.message}`,
        'error'
      );
    }
  }

  /**
   * Make the completeTask API call (Second API call, minimal frequency)
   */
  async completeTaskCall(user, userData, task) {
    try {
      logger.info(
        `[Task] Making completeTask API call for task ${task.task_id}`
      );

      let result;
      try {
        result = await apiService.completeTask(
          user.flowId,
          user.uid,
          user.uuid,
          user.accessKey,
          task.task_id,
          userData.token,
          user.machineId,
          user.platform || 'mac'
        );
      } catch (error) {
        // If token expired, refresh and retry once
        if (error.message === 'TOKEN_EXPIRED') {
          logger.warn(`[Task] Token expired for task ${task.task_id}, refreshing and retrying...`);
          this.addSystemLog(
            `🔄 Token 已过期，正在刷新并重试完成任务 (Token expired, retrying task completion)`,
            'warning'
          );

          const updatedData = await this.refreshUserToken(user);

          result = await apiService.completeTask(
            user.flowId,
            user.uid,
            user.uuid,
            user.accessKey,
            task.task_id,
            updatedData.token,
            user.machineId,
            user.platform || 'mac'
          );
        } else {
          throw error;
        }
      }

      logger.info(`[Task] Task ${task.task_id} completed successfully`);
      this.addSystemLog(
        `✅ 任务 ${task.task_id} 已完成 (Task ${task.task_id} completed)`,
        'success'
      );

      broadcastToClients({
        type: 'taskCompleted',
        uid: user.uid,
        taskId: task.task_id,
        taskName: task.task_name,
        result,
        timestamp: new Date().toISOString(),
      });

      // Mark as completed
      const completionKey = `task:${user.uid}:${task.task_id}:completed`;
      await redisClient.set(
        completionKey,
        JSON.stringify({
          completedAt: new Date().toISOString(),
          result,
        })
      );
    } catch (error) {
      logger.error(`[Task] Failed to complete task ${task.task_id}:`, error.message);
      this.addSystemLog(
        `❌ 完成任务失败 ${task.task_id}: ${error.message}`,
        'error'
      );
      throw error;
    }
  }

  /**
   * Non-intrusive token refresh (every 4 hours)
  /**
   * Refresh user token
   * Always saves updated token back to Redis
   * Includes retry mechanism for network failures
   */
  async refreshUserToken(user, retries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        logger.info(`[Token] Refreshing token for user ${user.uid} (attempt ${attempt}/${retries})`);

        // Get latest user data from Redis
        let userData = await this.getUserData(user.uid);

        // If no userData exists in Redis, create initial structure
        if (!userData || Object.keys(userData).length === 0) {
          userData = {
            uid: user.uid,
            uuid: user.uuid,
            flowId: user.flowId,
            accessKey: user.accessKey,
            machineId: user.machineId || '830504a3-d020-43af-b3e6-4c8690f5d6be',
            platform: user.platform || 'mac',
            phone: user.phone,
          };
        }

        const currentToken = userData?.token;

        const loginResult = await apiService.checkLogin(
          user.uid,
          user.platform || 'mac',
          user.accessKey,
          user.machineId || '830504a3-d020-43af-b3e6-4c8690f5d6be',
          currentToken
        );

        // Update token and save to Redis
        userData.token = loginResult.token;
        userData.accessKey = loginResult.access_key || user.accessKey;
        userData.tokenUpdatedAt = new Date().toISOString();

        await redisClient.set(`user:${user.uid}`, JSON.stringify(userData));

        logger.info(`[Token] Token refreshed and saved to Redis for user ${user.uid}`);

        return userData; // Return updated userData
      } catch (error) {
        lastError = error;
        logger.error(`[Token] Attempt ${attempt}/${retries} failed for user ${user.uid}:`, error.message);

        // If this is not the last attempt, wait before retrying
        if (attempt < retries) {
          const waitTime = attempt * 2000; // Progressive delay: 2s, 4s, 6s
          logger.info(`[Token] Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // All retries failed
    logger.error(`[Token] All ${retries} attempts failed for user ${user.uid}`);
    throw lastError;
  }

  async getUserData(uid) {
    try {
      const userData = await redisClient.get(`user:${uid}`);
      if (userData) {
        return JSON.parse(userData);
      }
      return {};
    } catch (error) {
      logger.error(`Failed to get user data for ${uid}:`, error);
      return {};
    }
  }

  async addSystemLog(message, type = 'info') {
    try {
      const logs = await redisClient.get('system:logs');
      const logArray = logs ? JSON.parse(logs) : [];

      const newLog = {
        id: Date.now(),
        message,
        type,
        timestamp: new Date().toISOString(),
      };

      // Keep only last 100 logs
      logArray.unshift(newLog);
      if (logArray.length > 100) {
        logArray.pop();
      }

      await redisClient.set('system:logs', JSON.stringify(logArray));

      // Broadcast to WebSocket clients
      broadcastToClients({
        type: 'systemLog',
        log: newLog,
      });
    } catch (error) {
      logger.error('Failed to add system log:', error);
    }
  }
}
