import React from 'react';
import './Dashboard.css';

export default function Dashboard() {
  const [users, setUsers] = React.useState([]);
  const [selectedUser, setSelectedUser] = React.useState(null);
  const [tasks, setTasks] = React.useState([]);
  const [userInfo, setUserInfo] = React.useState(null);
  const [rewards, setRewards] = React.useState(null);
  const [logs, setLogs] = React.useState([]);
  const [showAddUser, setShowAddUser] = React.useState(false);
  const [ws, setWs] = React.useState(null);
  const [schedulerRunning, setSchedulerRunning] = React.useState(false);
  const [systemLogs, setSystemLogs] = React.useState([]);

  // Form state
  const [formData, setFormData] = React.useState({
    uid: '',
    uuid: '',
    flowId: '',
    accessKey: '',
    token: '',
    machineId: '830504a3-d020-43af-b3e6-4c8690f5d6be',
    platform: 'mac',
    phone: '',
  });

  React.useEffect(() => {
    // Connect to WebSocket
    // If on port 3000, use 3001 (backend); otherwise use same port
    const wsPort = window.location.port === '3000' ? '3001' : window.location.port;
    // Use wss:// for HTTPS, ws:// for HTTP
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.hostname}:${wsPort}`;
    console.log('Connecting to WebSocket:', wsUrl);
    
    const wsConnection = new WebSocket(wsUrl);

    wsConnection.onopen = () => {
      console.log('✅ WebSocket connected');
    };

    wsConnection.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('WebSocket message:', data);

      if (data.type === 'tasksUpdated' && selectedUser?.uid === data.uid) {
        setTasks(data.tasks);
      } else if (data.type === 'taskCompleted') {
        addLog(`✅ Task completed: ${data.taskName}`, 'success');
      } else if (data.type === 'taskWaiting') {
        addLog(
          `⏳ Task waiting: ${data.taskName} (${data.waitMinutes} min)`,
          'info'
        );
      } else if (data.type === 'error') {
        addLog(`❌ Error: ${data.message}`, 'error');
      } else if (data.type === 'systemLog') {
        setSystemLogs((prev) => [data.log, ...prev.slice(0, 99)]);
      }
    };

    wsConnection.onerror = (error) => {
      console.error('WebSocket error:', error);
      // Only log error on first connection, not on normal disconnections
      if (wsConnection.readyState === 0) {
        console.warn('WebSocket connection failed');
      }
    };

    wsConnection.onclose = () => {
      console.log('WebSocket closed');
    };

    setWs(wsConnection);

    return () => {
      wsConnection.close();
    };
  }, [selectedUser]);

  // Load users on mount
  React.useEffect(() => {
    loadUsers();
    loadSystemLogs();
    checkSchedulerStatus();
    
    // Refresh system logs every 5 seconds
    const interval = setInterval(loadSystemLogs, 5000);
    
    // Check scheduler status every 10 seconds
    const statusInterval = setInterval(checkSchedulerStatus, 10000);
    
    return () => {
      clearInterval(interval);
      clearInterval(statusInterval);
    };
  }, []);

  const loadUsers = async () => {
    try {
      const response = await fetch('/api/users');
      const data = await response.json();
      setUsers(data.data || []);
    } catch (error) {
      console.error('Failed to load users:', error);
      addLog('Failed to load users', 'error');
    }
  };

  const loadSystemLogs = async () => {
    try {
      const response = await fetch('/api/system/logs');
      const data = await response.json();
      setSystemLogs(data.data || []);
    } catch (error) {
      console.error('Failed to load system logs:', error);
    }
  };

  const checkSchedulerStatus = async () => {
    try {
      const response = await fetch('/api/scheduler/status');
      const data = await response.json();
      if (data.code === 0) {
        setSchedulerRunning(data.data.isRunning);
      }
    } catch (error) {
      console.error('Failed to check scheduler status:', error);
    }
  };

  const loadUserTasks = async (uid) => {
    try {
      const response = await fetch(`/api/users/${uid}/tasks`);
      const data = await response.json();
      setTasks(data.data || []);
    } catch (error) {
      console.error('Failed to load tasks:', error);
      addLog('Failed to load tasks', 'error');
    }
  };

  const loadUserInfo = async (uid) => {
    try {
      const response = await fetch(`/api/users/${uid}/info`);
      const data = await response.json();
      if (data.code === 0) {
        setUserInfo(data.data);
      } else {
        console.warn('Failed to load user info:', data.message);
        setUserInfo(null);
      }
    } catch (error) {
      console.error('Failed to load user info:', error);
      setUserInfo(null);
    }
  };

  const loadUserRewards = async (uid) => {
    try {
      const response = await fetch(`/api/users/${uid}/rewards`);
      const data = await response.json();
      if (data.code === 0) {
        setRewards(data.data);
      } else {
        console.warn('Failed to load rewards:', data.message);
        setRewards(null);
      }
    } catch (error) {
      console.error('Failed to load rewards:', error);
      setRewards(null);
    }
  };

  const loadUserLogs = async (uid) => {
    try {
      const response = await fetch(`/api/users/${uid}/logs`);
      const data = await response.json();
      setLogs(data.data || []);
    } catch (error) {
      console.error('Failed to load logs:', error);
    }
  };

  const addLog = (message, type = 'info') => {
    const newLog = {
      id: Date.now(),
      message,
      type,
      timestamp: new Date().toLocaleString(),
    };
    setLogs((prev) => [newLog, ...prev.slice(0, 99)]);
  };

  const handleUserSelect = (user) => {
    setSelectedUser(user);
    loadUserTasks(user.uid);
    loadUserInfo(user.uid);
    loadUserRewards(user.uid);
    loadUserLogs(user.uid);
  };

  const handleAddUser = async (e) => {
    e.preventDefault();

    try {
      // Ensure uid is an integer
      const dataToSend = {
        ...formData,
        uid: parseInt(formData.uid, 10),
      };

      const response = await fetch('/api/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dataToSend),
      });

      const data = await response.json();

      if (data.code === 0) {
        addLog(`✅ User added: ${formData.uid}`, 'success');
        setFormData({
          uid: '',
          uuid: '',
          flowId: '',
          accessKey: '',
          token: '',
          machineId: '830504a3-d020-43af-b3e6-4c8690f5d6be',
          platform: 'mac',
          phone: '',
        });
        setShowAddUser(false);
        loadUsers();
      } else {
        addLog(`❌ Failed to add user: ${data.message}`, 'error');
      }
    } catch (error) {
      console.error('Failed to add user:', error);
      addLog('Failed to add user', 'error');
    }
  };

  const handleDeleteUser = async (uid) => {
    if (!confirm('Are you sure you want to delete this user?')) return;

    try {
      const response = await fetch(`/api/users/${uid}`, {
        method: 'DELETE',
      });

      const data = await response.json();

      if (data.code === 0) {
        addLog(`✅ User deleted: ${uid}`, 'success');
        setSelectedUser(null);
        loadUsers();
      } else {
        addLog(`❌ Failed to delete user: ${data.message}`, 'error');
      }
    } catch (error) {
      console.error('Failed to delete user:', error);
      addLog('Failed to delete user', 'error');
    }
  };

  const handleRefreshToken = async (uid) => {
    try {
      const response = await fetch(`/api/users/${uid}/refresh-token`, {
        method: 'POST',
      });

      const data = await response.json();

      if (data.code === 0) {
        addLog(`✅ Token refreshed for user ${uid}`, 'success');
        loadUsers();
      } else {
        addLog(`❌ Failed to refresh token: ${data.message}`, 'error');
      }
    } catch (error) {
      console.error('Failed to refresh token:', error);
      addLog('Failed to refresh token', 'error');
    }
  };

  const handleCompleteTask = async (taskId) => {
    if (!selectedUser) return;

    try {
      const response = await fetch(
        `/api/users/${selectedUser.uid}/tasks/${taskId}/complete`,
        {
          method: 'POST',
        }
      );

      const data = await response.json();

      if (data.code === 0) {
        addLog(`✅ Task ${taskId} manually completed`, 'success');
        // Refresh user info, tasks, and rewards after completion
        await loadUserInfo(selectedUser.uid);
        await loadUserTasks(selectedUser.uid);
        await loadUserRewards(selectedUser.uid);
      } else {
        addLog(`❌ Failed to complete task: ${data.message}`, 'error');
      }
    } catch (error) {
      console.error('Failed to complete task:', error);
      addLog('Failed to complete task', 'error');
    }
  };

  const handleStartScheduler = async () => {
    try {
      const response = await fetch('/api/scheduler/start', {
        method: 'POST',
      });

      const data = await response.json();

      if (data.code === 0) {
        setSchedulerRunning(true);
        addLog('✅ 调度器已启动 (Scheduler started)', 'success');
      } else {
        addLog(`❌ 启动失败: ${data.message}`, 'error');
      }
    } catch (error) {
      console.error('Failed to start scheduler:', error);
      addLog('❌ Failed to start scheduler', 'error');
    }
  };

  const handleStopScheduler = async () => {
    try {
      const response = await fetch('/api/scheduler/stop', {
        method: 'POST',
      });

      const data = await response.json();

      if (data.code === 0) {
        setSchedulerRunning(false);
        addLog('✅ 调度器已停止 (Scheduler stopped)', 'success');
      } else {
        addLog(`❌ 停止失败: ${data.message}`, 'error');
      }
    } catch (error) {
      console.error('Failed to stop scheduler:', error);
      addLog('❌ Failed to stop scheduler', 'error');
    }
  };

  const getTaskStatusColor = (taskState) => {
    switch (taskState) {
      case 1:
        return '#ffa500'; // Orange - Ready
      case 2:
        return '#ff0000'; // Red - In progress
      case 3:
        return '#00cc00'; // Green - Completed
      default:
        return '#888888'; // Gray - Unknown
    }
  };

  const getTaskStatusText = (taskState) => {
    switch (taskState) {
      case 1:
        return 'Ready';
      case 2:
        return 'In Progress';
      case 3:
        return 'Completed';
      default:
        return 'Unknown';
    }
  };

  return (
    <div className="dashboard">
      <header className="header">
        <div className="header-left">
          <h1>🎮 FuFuHub Auto Sign Tool</h1>
          <p>Automated Task Management Dashboard</p>
        </div>
        <div className="header-right">
          <button
            className={`btn btn-lg ${schedulerRunning ? 'btn-danger' : 'btn-success'}`}
            onClick={schedulerRunning ? handleStopScheduler : handleStartScheduler}
          >
            {schedulerRunning ? '⏹️ Stop Scheduler' : '▶️ Start Scheduler'}
          </button>
          <div className={`status-indicator ${schedulerRunning ? 'running' : 'stopped'}`}>
            {schedulerRunning ? '🟢 Running' : '🔴 Stopped'}
          </div>
        </div>
      </header>

      <div className="container">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <h3>Users</h3>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setShowAddUser(!showAddUser)}
            >
              {showAddUser ? '✕' : '➕'} Add User
            </button>
          </div>

          {showAddUser && (
            <form onSubmit={handleAddUser} className="add-user-form">
              <input
                type="number"
                placeholder="UID"
                value={formData.uid}
                onChange={(e) =>
                  setFormData({ ...formData, uid: e.target.value })
                }
                required
              />
              <input
                type="text"
                placeholder="UUID"
                value={formData.uuid}
                onChange={(e) =>
                  setFormData({ ...formData, uuid: e.target.value })
                }
                required
              />
              <input
                type="text"
                placeholder="Flow ID"
                value={formData.flowId}
                onChange={(e) =>
                  setFormData({ ...formData, flowId: e.target.value })
                }
                required
              />
              <input
                type="text"
                placeholder="Access Key"
                value={formData.accessKey}
                onChange={(e) =>
                  setFormData({ ...formData, accessKey: e.target.value })
                }
                required
              />
              <input
                type="text"
                placeholder="Token (Authorization)"
                value={formData.token}
                onChange={(e) =>
                  setFormData({ ...formData, token: e.target.value })
                }
              />
              <input
                type="text"
                placeholder="Machine ID"
                value={formData.machineId}
                onChange={(e) =>
                  setFormData({ ...formData, machineId: e.target.value })
                }
              />
              <select
                value={formData.platform}
                onChange={(e) =>
                  setFormData({ ...formData, platform: e.target.value })
                }
              >
                <option value="mac">macOS</option>
                <option value="ios">iOS</option>
                <option value="android">Android</option>
              </select>
              <input
                type="tel"
                placeholder="Phone"
                value={formData.phone}
                onChange={(e) =>
                  setFormData({ ...formData, phone: e.target.value })
                }
              />
              <button type="submit" className="btn btn-success btn-sm">
                Save
              </button>
            </form>
          )}

          <div className="users-list">
            {users.length === 0 ? (
              <p className="empty-state">No users configured</p>
            ) : (
              users.map((user) => (
                <div
                  key={user.uid}
                  className={`user-item ${
                    selectedUser?.uid === user.uid ? 'active' : ''
                  }`}
                  onClick={() => handleUserSelect(user)}
                >
                  <div className="user-info">
                    <div className="user-name">{user.phone || `User ${user.uid}`}</div>
                    <div className="user-uid">UID: {user.uid}</div>
                    <div className="user-status">
                      {user.isActive ? '🟢 Active' : '🔴 Inactive'}
                    </div>
                  </div>
                  <button
                    className="btn-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteUser(user.uid);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Main Content */}
        <main className="main-content">
          {/* System Logs - Always visible */}
          <div className="section system-logs-section">
            <h3>🖥️ System Logs</h3>
            <div className="logs-container compact">
              {systemLogs.length === 0 ? (
                <p className="empty-state">No system logs yet</p>
              ) : (
                systemLogs.slice(0, 10).map((log) => (
                  <div
                    key={log.id}
                    className={`log-entry log-${log.type}`}
                  >
                    <span className="log-timestamp">{new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span className="log-message">{log.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {selectedUser ? (
            <>
              {/* User Header */}
              <div className="user-header">
                <div>
                  <h2>{selectedUser.phone || `User ${selectedUser.uid}`}</h2>
                  <p>UID: {selectedUser.uid}</p>
                </div>
                <div className="user-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => handleRefreshToken(selectedUser.uid)}
                  >
                    🔄 Refresh Token
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="tabs">
                <button className="tab-button active">Tasks</button>
                <button className="tab-button">Logs</button>
              </div>

              {/* Tasks Section */}
              <div className="section">
                <h3>📋 Tasks</h3>
                {tasks.length === 0 ? (
                  <p className="empty-state">No tasks loaded</p>
                ) : (
                  <div className="tasks-grid">
                    {tasks.map((task) => (
                      <div key={task.task_id} className="task-card">
                        <div className="task-header">
                          <h4>{task.task_name}</h4>
                          <span
                            className="task-status"
                            style={{
                              backgroundColor: getTaskStatusColor(
                                task.task_state
                              ),
                            }}
                          >
                            {getTaskStatusText(task.task_state)}
                          </span>
                        </div>
                        <p className="task-desc">{task.task_desc}</p>
                        <div className="task-details">
                          <span>
                            Progress: {task.task_value}/{task.task_target}
                          </span>
                          <span>Type: {task.task_type}</span>
                        </div>
                        <div className="task-progress">
                          <div
                            className="progress-bar"
                            style={{
                              width: `${
                                (task.task_value / task.task_target) * 100
                              }%`,
                            }}
                          />
                        </div>
                        {(task.task_state === 1 || task.task_state === 2) && (
                          <button
                            className="btn btn-success btn-sm"
                            onClick={() => handleCompleteTask(task.task_id)}
                          >
                            Complete Task
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* User Info Section */}
              {userInfo && (
                <div className="section user-info-section">
                  <h3>👤 User Information</h3>
                  <div className="user-info-grid">
                    <div className="info-item">
                      <span className="info-label">Phone:</span>
                      <span className="info-value">{userInfo.phone || 'N/A'}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Name:</span>
                      <span className="info-value">{userInfo.name || 'N/A'}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Coin (Points):</span>
                      <span className="info-value">{userInfo.coin || 0}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Duration (Minutes):</span>
                      <span className="info-value">{userInfo.duration || 0}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Business ID:</span>
                      <span className="info-value">{userInfo.biz_id || 'N/A'}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Zone:</span>
                      <span className="info-value">{userInfo.zone_name || 'N/A'}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Is Real Name:</span>
                      <span className="info-value">{userInfo.is_real_name ? '✅ Yes' : '❌ No'}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Login Time:</span>
                      <span className="info-value">{userInfo.login_time || 'N/A'}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Update Time:</span>
                      <span className="info-value">{userInfo.update_time || 'N/A'}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Queue No:</span>
                      <span className="info-value">{userInfo.queue_no || 0}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">🎁 Lottery Coupons:</span>
                      <span className="info-value">{userInfo.lottery_num || 0}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Rewards History Section */}
              {rewards && (
                <div className="section rewards-section">
                  <h3>🎁 Rewards History (Expiry Date)</h3>
                  <div className="rewards-summary">
                    <p>Total Rewards: <strong>{rewards.totalRewards}</strong></p>
                  </div>
                  {rewards.rewardsByExpiry && rewards.rewardsByExpiry.length > 0 ? (
                    <div className="rewards-list">
                      {rewards.rewardsByExpiry.map((group, idx) => (
                        <div key={idx} className="reward-group">
                          <div className="reward-group-header">
                            <span className="expiry-date">
                              📅 Expires: {new Date(group.expiryDate).toLocaleDateString()}
                            </span>
                            <span className="total-duration">
                              ⏱️ Total: <strong>{group.totalMinutes} minutes</strong>
                            </span>
                          </div>
                          <div className="reward-items">
                            {group.rewards.map((reward, ridx) => (
                              <div key={ridx} className="reward-item">
                                <span className="reward-name">{reward.saleName}</span>
                                <span className="reward-time">({reward.minutes} min)</span>
                                <span className="reward-type">{reward.payType}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-state">No rewards found</p>
                  )}
                </div>
              )}

              {/* Logs Section */}
              <div className="section">
                <h3>📊 Execution Logs</h3>
                <div className="logs-container">
                  {logs.length === 0 ? (
                    <p className="empty-state">No logs yet</p>
                  ) : (
                    logs.map((log) => (
                      <div
                        key={log.id}
                        className={`log-entry log-${log.type}`}
                      >
                        <span className="log-timestamp">{log.timestamp}</span>
                        <span className="log-message">{log.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state-full">
              <p>Select a user to view their tasks and logs</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
