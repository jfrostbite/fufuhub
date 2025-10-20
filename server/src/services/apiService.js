import axios from 'axios';
import https from 'https';
import { logger } from '../utils/logger.js';

const API_BASE_URL = process.env.API_BASE_URL || 'https://h5-proxy.fdcompute.com';

// Error codes
export const ERROR_CODES = {
  TOKEN_EXPIRED: 3584901,
  PARAM_ERROR: 3584002,
  SUCCESS: 0,
};

class APIService {
  constructor() {
    // Create HTTPS agent that ignores TLS verification
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });

    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000, // Increase timeout to 30 seconds
      httpsAgent: httpsAgent,
    });
  }

  /**
   * Build common headers required by all API requests
   */
  buildHeaders(options = {}) {
    return {
      'Host': 'h5-proxy.fdcompute.com',
      'Content-Type': 'application/json',
      'user-agent': 'Dart/3.3 (dart:io)',
      'version': '1.5.0',
      'accept-encoding': 'gzip',
      'machineid': options.machineId || '830504a3-d020-43af-b3e6-4c8690f5d6be',
      'accesskey': options.accessKey || '90f8699a-e0d9-4ed2-8796-4ad2af58c27c',
      'platform': options.platform || 'mac',
      ...(options.authorization && { 'authorization': options.authorization }),
    };
  }

  /**
   * Check login and get token
   * @param {number} uid - User ID
   * @param {string} platform - Platform (mac/ios/android)
   * @param {string} accessKey - Access Key (optional)
   * @param {string} machineId - Machine ID (optional)
   * @param {string} token - Current token for authorization (optional)
   * @returns {Promise<Object>} - Token and user info
   */
  async checkLogin(uid, platform = 'mac', accessKey = '90f8699a-e0d9-4ed2-8796-4ad2af58c27c', machineId = '830504a3-d020-43af-b3e6-4c8690f5d6be', token = null) {
    try {
      logger.info(`[checklogin] Attempting login for uid: ${uid}`);
      
      const response = await this.client.post(
        '/v1/nika/client/checklogin',
        { uid },
        {
          headers: this.buildHeaders({
            platform,
            accessKey,
            machineId,
            authorization: token,
          }),
        }
      );

      if (response.data.ret.code === ERROR_CODES.SUCCESS) {
        logger.info(`[checklogin] ✅ Success for uid: ${uid}`);
        logger.info(`[checklogin] Token received: ${response.data.body.token.substring(0, 50)}...`);
        return response.data.body;
      } else {
        const errorMsg = `API Error: ${response.data.ret.msg} (Code: ${response.data.ret.code})`;
        logger.error(`[checklogin] ❌ ${errorMsg}`);
        throw new Error(errorMsg);
      }
    } catch (error) {
      // Log detailed error information
      if (error.response) {
        // API responded with error status
        logger.error(`[checklogin] ❌ API Error:`, {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        });
      } else if (error.request) {
        // Request made but no response received (timeout/network error)
        logger.error(`[checklogin] ❌ Network Error: No response received`, {
          message: error.message,
          code: error.code,
          timeout: error.config?.timeout,
        });
      } else {
        // Other errors
        logger.error(`[checklogin] ❌ Error:`, {
          message: error.message,
          stack: error.stack?.split('\n').slice(0, 3).join('\n'),
        });
      }
      throw error;
    }
  }

  /**
   * Get user info
   */
  async getUserInfo(flowId, uuid, uid, token, accessKey, machineId, platform = 'mac') {
    try {
      logger.info(`[getuserinfo] Fetching user info for uid: ${uid}`);
      
      const response = await this.client.post(
        '/v1/nika/client/getuserinfo',
        {
          flow_id: flowId,
          uuid,
          uid,
        },
        {
          headers: this.buildHeaders({
            authorization: token,
            accessKey,
            machineId,
            platform,
          }),
        }
      );

      if (response.data.ret.code === ERROR_CODES.SUCCESS) {
        logger.info(`[getuserinfo] ✅ Success for uid: ${uid}`);
        logger.info(`[getuserinfo] Response keys:`, Object.keys(response.data.body));
        logger.info(`[getuserinfo] Nickname:`, response.data.body?.nickname);
        logger.info(`[getuserinfo] Points:`, response.data.body?.points);
        logger.info(`[getuserinfo] Sign Days:`, response.data.body?.sign_day);
        return response.data.body;
      } else if (response.data.ret.code === ERROR_CODES.TOKEN_EXPIRED) {
        logger.warn('[getuserinfo] Token expired, need refresh');
        throw new Error('TOKEN_EXPIRED');
      } else {
        throw new Error(`API Error: ${response.data.ret.msg} (Code: ${response.data.ret.code})`);
      }
    } catch (error) {
      logger.error('[getuserinfo] ❌ Error:', error.message);
      throw error;
    }
  }

  /**
   * Get activity tasks
   */
  async getActivityTasks(flowId, uid, uuid, accessKey, token, machineId, platform = 'mac') {
    try {
      logger.info(`[getactivitytask] Fetching tasks for uid: ${uid}`);
      
      const response = await this.client.post(
        '/v1/nika/client/getactivitytask',
        {
          flow_id: flowId,
          uid,
          uuid,
          access_key: accessKey,
        },
        {
          headers: this.buildHeaders({
            authorization: token,
            accessKey,
            machineId,
            platform,
          }),
        }
      );

      if (response.data.ret.code === ERROR_CODES.SUCCESS) {
        logger.info(`[getactivitytask] ✅ Retrieved ${response.data.body.list.length} tasks for uid: ${uid}`);
        return response.data.body.list;
      } else if (response.data.ret.code === ERROR_CODES.TOKEN_EXPIRED) {
        logger.warn('[getactivitytask] Token expired, need refresh');
        throw new Error('TOKEN_EXPIRED');
      } else {
        throw new Error(`API Error: ${response.data.ret.msg} (Code: ${response.data.ret.code})`);
      }
    } catch (error) {
      logger.error('[getactivitytask] ❌ Error:', error.message);
      throw error;
    }
  }

  /**
   * Complete task
   */
  async completeTask(flowId, uid, uuid, accessKey, taskId, token, machineId, platform = 'mac') {
    try {
      logger.info(`[completetask] Attempting to complete task ${taskId} for uid: ${uid}`);
      
      const response = await this.client.post(
        '/v1/nika/client/completetask',
        {
          flow_id: flowId,
          uid,
          uuid,
          access_key: accessKey,
          task_id: taskId,
        },
        {
          headers: this.buildHeaders({
            authorization: token,
            accessKey,
            machineId,
            platform,
          }),
        }
      );

      if (response.data.ret.code === ERROR_CODES.SUCCESS) {
        logger.info(`[completetask] ✅ Task ${taskId} completed for uid: ${uid}`);
        return response.data.body;
      } else if (response.data.ret.code === ERROR_CODES.TOKEN_EXPIRED) {
        logger.warn('[completetask] Token expired, need refresh');
        throw new Error('TOKEN_EXPIRED');
      } else {
        logger.warn(`[completetask] Task ${taskId} - Code: ${response.data.ret.code}, Msg: ${response.data.ret.msg}`);
        return response.data.body;
      }
    } catch (error) {
      logger.error('[completetask] ❌ Error:', error.message);
      throw error;
    }
  }

  /**
   * Draw prize (lottery)
   */
  async drawPrize(flowId, uid, uuid, accessKey, token, machineId, platform = 'mac') {
    try {
      logger.info(`[drawprize] Attempting to draw prize for uid: ${uid}`);
      
      const response = await this.client.post(
        '/v1/nika/client/drawprize',
        {
          flow_id: flowId,
          uid,
          uuid,
          access_key: accessKey,
          draw_type: 1,
        },
        {
          headers: this.buildHeaders({
            authorization: token,
            accessKey,
            machineId,
            platform,
          }),
        }
      );

      if (response.data.ret.code === ERROR_CODES.SUCCESS) {
        logger.info(`[drawprize] ✅ Prize drawn for uid: ${uid}`);
        const prizeInfo = response.data.body?.prize;
        if (prizeInfo) {
          logger.info(`[drawprize] Prize: ${prizeInfo.prize_name} (${prizeInfo.prize_desc})`);
        }
        return response.data.body;
      } else if (response.data.ret.code === ERROR_CODES.TOKEN_EXPIRED) {
        logger.warn('[drawprize] Token expired, need refresh');
        throw new Error('TOKEN_EXPIRED');
      } else {
        throw new Error(`API Error: ${response.data.ret.msg} (Code: ${response.data.ret.code})`);
      }
    } catch (error) {
      logger.error('[drawprize] ❌ Error:', error.message);
      throw error;
    }
  }

  /**
   * Get order history (rewards)
   * @param {number} flowId - Flow ID
   * @param {number} uid - User ID
   * @param {string} uuid - UUID
   * @param {string} accessKey - Access Key
   * @param {string} token - Auth token
   * @param {string} machineId - Machine ID
   * @param {string} platform - Platform (mac/ios/android)
   * @returns {Promise<object>} Order history data
   */
  async getOrderHistory(flowId, uid, uuid, accessKey, token, machineId = '830504a3-d020-43af-b3e6-4c8690f5d6be', platform = 'mac') {
    try {
      const response = await this.client.post(
        '/v1/nika/client/orderhistory',
        {
          offset: 0,
          limit: 100,
          order: 'desc',
          sorts: 'update_time',
          cond_list: [],
          uid,
        },
        {
          headers: this.buildHeaders({
            authorization: token,
            accessKey,
            machineId,
            platform,
          }),
        }
      );

      if (response.data.ret.code === ERROR_CODES.SUCCESS) {
        logger.info(`[orderhistory] ✅ Order history fetched for uid: ${uid}`);
        return response.data.body;
      } else if (response.data.ret.code === ERROR_CODES.TOKEN_EXPIRED) {
        logger.warn('[orderhistory] Token expired, need refresh');
        throw new Error('TOKEN_EXPIRED');
      } else {
        throw new Error(`API Error: ${response.data.ret.msg} (Code: ${response.data.ret.code})`);
      }
    } catch (error) {
      logger.error('[orderhistory] ❌ Error:', error.message);
      throw error;
    }
  }
}

export default new APIService();
