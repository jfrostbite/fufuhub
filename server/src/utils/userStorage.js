import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the path to the users.json persistent storage file.
 * Defaults to `server/data/users.json` unless overridden by environment variables.
 */
export function getUsersFilePath() {
  if (process.env.USERS_FILE_PATH) {
    return path.resolve(process.env.USERS_FILE_PATH);
  }
  const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
  return path.join(dataDir, 'users.json');
}

/**
 * Ensure the directory for storing persistent user data exists.
 */
function ensureDataDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get all users stored in the local persistent JSON file.
 * @returns {Array<Object>} List of users
 */
export function getLocalUsers() {
  const filePath = getUsersFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) {
      return [];
    }
    const data = JSON.parse(content);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    logger.error(`[Storage] Failed to read local users from ${filePath}:`, error.message);
    return [];
  }
}

/**
 * Get a specific user by UID from local persistent storage.
 * @param {number|string} uid
 * @returns {Object|null}
 */
export function getLocalUser(uid) {
  const targetUid = parseInt(uid, 10);
  const users = getLocalUsers();
  return users.find((u) => parseInt(u.uid, 10) === targetUid) || null;
}

/**
 * Atomically save the entire users array to local persistent JSON file.
 * @param {Array<Object>} users
 */
export function saveLocalUsers(users) {
  const filePath = getUsersFilePath();
  try {
    ensureDataDir(filePath);
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(users, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
    logger.info(`[Storage] Persisted ${users.length} users to ${filePath}`);
    return true;
  } catch (error) {
    logger.error(`[Storage] Failed to persist users to ${filePath}:`, error.message);
    return false;
  }
}

/**
 * Add or update a user in local persistent storage.
 * @param {Object} user
 */
export function saveLocalUser(user) {
  if (!user || user.uid === undefined || user.uid === null) {
    logger.warn('[Storage] Cannot save invalid user object without UID');
    return false;
  }

  const targetUid = parseInt(user.uid, 10);
  const users = getLocalUsers();
  const index = users.findIndex((u) => parseInt(u.uid, 10) === targetUid);

  if (index >= 0) {
    users[index] = { ...users[index], ...user, uid: targetUid };
  } else {
    users.push({ ...user, uid: targetUid });
  }

  return saveLocalUsers(users);
}

/**
 * Remove a user by UID from local persistent storage.
 * @param {number|string} uid
 */
export function deleteLocalUser(uid) {
  const targetUid = parseInt(uid, 10);
  const users = getLocalUsers();
  const filteredUsers = users.filter((u) => parseInt(u.uid, 10) !== targetUid);

  if (filteredUsers.length !== users.length) {
    saveLocalUsers(filteredUsers);
    logger.info(`[Storage] Removed user ${targetUid} from local persistent storage`);
    return true;
  }
  return false;
}

/**
 * Synchronize users between local file storage and Redis.
 * Ensures Redis downtime/restart does not cause account data loss,
 * and recovers local storage if accounts were added directly into Redis.
 * @param {Object} redisClient
 * @returns {Promise<Array<Object>>} Synchronized users list
 */
export async function syncUsersWithRedis(redisClient) {
  try {
    const localUsers = getLocalUsers();
    let redisUsers = [];

    const redisUsersJson = await redisClient.get('config:users');
    if (redisUsersJson) {
      try {
        const parsed = JSON.parse(redisUsersJson);
        if (Array.isArray(parsed)) {
          redisUsers = parsed;
        }
      } catch (err) {
        logger.warn('[Storage] Failed to parse config:users from Redis:', err.message);
      }
    }

    // Case 1: Redis is empty, but local storage has users -> Restore into Redis
    if (redisUsers.length === 0 && localUsers.length > 0) {
      logger.info(`[Storage] Restoring ${localUsers.length} users from local storage into Redis...`);
      await redisClient.set('config:users', JSON.stringify(localUsers));
      for (const u of localUsers) {
        await redisClient.set(`user:${u.uid}`, JSON.stringify(u));
      }
      return localUsers;
    }

    // Case 2: Local storage is empty, but Redis has users -> Backup to local file
    if (localUsers.length === 0 && redisUsers.length > 0) {
      logger.info(`[Storage] Backing up ${redisUsers.length} users from Redis into local storage...`);
      saveLocalUsers(redisUsers);
      return redisUsers;
    }

    // Case 3: Both exist -> Merge by UID (newer tokenUpdatedAt / createdAt wins)
    const mergedMap = new Map();
    for (const u of localUsers) {
      mergedMap.set(parseInt(u.uid, 10), u);
    }

    for (const ru of redisUsers) {
      const uid = parseInt(ru.uid, 10);
      const existing = mergedMap.get(uid);
      if (!existing) {
        mergedMap.set(uid, ru);
      } else {
        // Compare updatedAt or tokenUpdatedAt
        const timeExisting = new Date(existing.tokenUpdatedAt || existing.createdAt || 0).getTime();
        const timeRedis = new Date(ru.tokenUpdatedAt || ru.createdAt || 0).getTime();
        if (timeRedis > timeExisting) {
          mergedMap.set(uid, { ...existing, ...ru });
        } else {
          mergedMap.set(uid, { ...ru, ...existing });
        }
      }
    }

    const mergedUsers = Array.from(mergedMap.values());

    // Update both Redis and Local storage with the merged dataset
    saveLocalUsers(mergedUsers);
    await redisClient.set('config:users', JSON.stringify(mergedUsers));
    for (const u of mergedUsers) {
      await redisClient.set(`user:${u.uid}`, JSON.stringify(u));
    }

    logger.info(`[Storage] Users sync complete. Total active accounts: ${mergedUsers.length}`);
    return mergedUsers;
  } catch (error) {
    logger.error('[Storage] Error during syncUsersWithRedis:', error);
    return getLocalUsers();
  }
}
