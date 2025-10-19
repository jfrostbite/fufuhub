# FuFuHub Auto Sign Tool

🎮 **一个全自动的 FuFuHub 签到和任务完成工具**，支持可视化仪表板管理、实时进度跟踪和智能任务调度。

## 🌟 主要特性

### ✨ 核心功能
- **自动签到** - 自动登录并获取 Token
- **智能 Token 管理** - 自动检测失效并刷新
- **任务自动完成** - 按照任务列表自动执行
- **智能任务识别** - 支持基于任务类型的自动处理：
  - Type 1（签到任务）- 立即执行
  - Type 2（消耗时间任务）- 检查进度是否完成（如 90/90）后执行
  - Type 3 - 暂时忽略
- **错误自恢复** - Token 失效自动重新登录
- **实时推送** - WebSocket 实时通知任务进度

### 🎨 用户界面
- **可视化仪表板** - 现代化的 React 前端界面
- **用户管理** - 支持多用户配置
- **任务监控** - 实时查看任务状态和进度
- **执行日志** - 完整的任务执行日志记录
- **响应式设计** - 支持桌面和移动设备

### 🐳 部署
- **Docker 容器化** - 一键启动所有服务
- **Docker Compose** - 包含 Redis、Server、Client
- **生产就绪** - 包含日志、监控健康检查等

## 📋 项目结构

```
fuhubsign/
├── server/                      # Node.js 后端服务
│   ├── src/
│   │   ├── index.js            # 主应用文件
│   │   ├── services/
│   │   │   ├── apiService.js   # FuFuHub API 封装
│   │   │   └── taskScheduler.js # 任务调度引擎
│   │   ├── routes/
│   │   │   └── api.js          # API 路由
│   │   ├── utils/
│   │   │   ├── redis.js        # Redis 连接
│   │   │   └── logger.js       # 日志系统
│   │   └── middleware/         # Express 中间件
│   ├── Dockerfile              # Docker 镜像配置
│   ├── package.json            # 依赖配置
│   └── .env.example            # 环境变量示例
├── client/                      # React 前端应用
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dashboard.jsx   # 主仪表板组件
│   │   │   └── Dashboard.css   # 样式
│   │   ├── index.jsx           # 入口文件
│   │   └── index.css           # 全局样式
│   ├── Dockerfile              # Docker 镜像配置
│   ├── nginx.conf              # Nginx 配置
│   ├── vite.config.js          # Vite 配置
│   ├── package.json            # 依赖配置
│   └── index.html              # HTML 模板
├── docker-compose.yml          # Docker Compose 配置
└── README.md                   # 本文档
```

## 🚀 快速开始

### 前置要求
- Docker 和 Docker Compose
- 或 Node.js 18+ 和 npm 9+

### 方式一：Docker Compose（推荐）

1. **克隆或下载项目**
   ```bash
   cd /path/to/fuhubsign
   ```

2. **启动服务**
   ```bash
   docker-compose up -d
   ```

3. **访问应用**
   - 打开浏览器访问：http://localhost:3000

4. **停止服务**
   ```bash
   docker-compose down
   ```

5. **查看日志**
   ```bash
   # 查看所有日志
   docker-compose logs -f
   
   # 查看特定服务日志
   docker-compose logs -f server
   docker-compose logs -f client
   docker-compose logs -f redis
   ```

### 方式二：本地开发

#### 启动后端服务

1. **进入 server 目录**
   ```bash
   cd server
   npm install
   ```

2. **配置环境变量**
   ```bash
   cp .env.example .env
   # 编辑 .env 文件，配置 Redis 连接等
   ```

3. **启动服务**
   ```bash
   # 开发模式
   npm run dev
   
   # 生产模式
   npm start
   ```

#### 启动前端应用

1. **进入 client 目录**
   ```bash
   cd client
   npm install
   ```

2. **启动开发服务器**
   ```bash
   npm run dev
   ```

3. **访问应用**
   - 打开浏览器访问：http://localhost:3000

4. **构建生产版本**
   ```bash
   npm run build
   ```

## 📝 使用指南

### 1. 添加用户

1. 点击左侧"➕ Add User"按钮
2. 填写用户信息：
   - **UID**: 用户 ID（从 HAR 文件获取，例：158672）
   - **UUID**: 用户 UUID（例：a890c866-c036-4890-bf6b-666ec297e461）
   - **Flow ID**: 流程 ID（例：NIKA_tWiCsGIdYaPI）
   - **Access Key**: 访问密钥（例：90f8699a-e0d9-4ed2-8796-4ad2af58c27c）
   - **Phone**: 电话号码（可选）

3. 点击"Save"保存用户配置

### 2. 查看任务

1. 从左侧用户列表选择用户
2. 主界面显示该用户的所有任务
3. 每个任务卡片显示：
   - 任务名称和描述
   - 任务状态（Ready/In Progress/Completed）
   - 进度条
   - 任务类型和奖励

### 3. 管理任务

- **自动执行**：系统会自动按照任务列表执行可完成的任务
- **手动执行**：点击任务卡片上的"Complete Task"按钮手动完成任务
- **刷新 Token**：如果 Token 失效，点击"🔄 Refresh Token"重新获取

### 4. 查看日志

- 在"Logs"标签查看所有执行日志
- 日志显示任务完成情况、错误信息等

## 🔌 API 文档

### 用户管理

#### 添加/更新用户
```
POST /api/users
Content-Type: application/json

{
  "uid": 158672,
  "uuid": "a890c866-c036-4890-bf6b-666ec297e461",
  "flowId": "NIKA_tWiCsGIdYaPI",
  "accessKey": "90f8699a-e0d9-4ed2-8796-4ad2af58c27c",
  "phone": "13325258934",
  "isActive": true
}
```

#### 获取所有用户
```
GET /api/users
```

#### 获取用户详情
```
GET /api/users/:uid
```

#### 删除用户
```
DELETE /api/users/:uid
```

#### 刷新 Token
```
POST /api/users/:uid/refresh-token
```

### 任务管理

#### 获取用户任务
```
GET /api/users/:uid/tasks
```

#### 手动完成任务
```
POST /api/users/:uid/tasks/:taskId/complete
```

### 日志

#### 获取执行日志
```
GET /api/users/:uid/logs
```

## ⚙️ 配置说明

### 服务器环境变量 (.env)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3001 | 服务器端口 |
| `NODE_ENV` | development | 运行环境 |
| `REDIS_HOST` | localhost | Redis 主机 |
| `REDIS_PORT` | 6379 | Redis 端口 |
| `REDIS_DB` | 0 | Redis 数据库 |
| `API_BASE_URL` | https://h5-proxy.fdcompute.com | API 基础 URL |
| `TOKEN_REFRESH_INTERVAL` | 300000 | Token 刷新间隔（ms） |
| `TASK_CHECK_INTERVAL` | 60000 | 任务检查间隔（ms） |
| `LOG_LEVEL` | info | 日志级别 |
| `TZ` | Asia/Shanghai | 系统时区（确保无论服务器在哪都使用北京时间） |
| `SCHEDULER_TIMEZONE` | Asia/Shanghai | 调度器时区（任务执行时间基准） |

### ⏰ 时区配置说明

**重要**：无论你的服务器部署在哪里（美国、欧洲、亚洲等），任务都会按照**北京时间（Asia/Shanghai, UTC+8）**的 8-9 点执行。

- **默认时区**：`Asia/Shanghai`（北京时间）
- **自动调度**：每天北京时间 8:00-9:00 随机时间执行
- **Token 刷新**：每 4 小时（00:00, 04:00, 08:00, 12:00, 16:00, 20:00 北京时间）

**如需修改时区**：
1. 修改 `docker-compose.yml` 中的 `TZ` 和 `SCHEDULER_TIMEZONE` 环境变量
2. 可选时区：`America/New_York`、`Europe/London`、`Asia/Tokyo` 等
3. 重新启动容器：`docker compose up -d --build`

**示例**：部署在美国但使用北京时间
```yaml
environment:
  - TZ=Asia/Shanghai          # 系统时区
  - SCHEDULER_TIMEZONE=Asia/Shanghai  # 调度器时区
```

## 🎯 工作流程

```
启动应用
    ↓
加载用户配置
    ↓
循环处理每个用户：
    ├─ 检查 Token 是否失效 → 失效时重新请求 checklogin
    ├─ 获取用户信息 (getuserinfo)
    ├─ 获取任务列表 (getactivitytask)
    └─ 处理每个任务：
        ├─ 检查任务类型 (task_type)
        ├─ Type 1 (签到任务) → 立即执行 (completetask)
        ├─ Type 2 (消耗时间任务) → 检查进度 (task_value/task_target)
        │   └─ 进度完成 → 执行任务 (completetask)
        │   └─ 进度未完成 → 跳过并等待
        ├─ Type 3 → 暂时忽略
        └─ 记录结果并推送前端
    ↓
实时通过 WebSocket 推送进度到前端
```

## 🔧 故障排查

### 问题：Token 失效错误

**症状**：日志显示 `token失效,请重新登录`

**解决方案**：
1. 点击"🔄 Refresh Token"手动刷新
2. 或删除用户后重新添加

### 问题：任务不执行

**可能原因**：
1. Token 失效 → 尝试手动刷新 Token
2. 任务已完成 → 查看任务状态
3. Type 2 任务进度未完成 → 等待进度达成
4. Type 3 任务 → 系统会自动跳过

**调试步骤**：
1. 查看执行日志
2. 检查任务类型和进度（Type 1/2/3, Progress: x/y）
3. 检查 Redis 连接是否正常
4. 查看服务器日志：`docker-compose logs -f server`

### 问题：无法连接到 Redis

**解决方案**：
1. 检查 Redis 容器是否运行：`docker-compose ps`
2. 查看 Redis 日志：`docker-compose logs redis`
3. 确保端口 6379 未被占用

### 问题：前端无法连接到后端 API

**解决方案**：
1. 检查后端服务是否运行：`docker-compose ps`
2. 查看防火墙设置
3. 检查 API URL 配置

## 📊 数据存储

所有数据存储在 Redis 中：

```
user:{uid}              # 用户数据
tasks:{uid}             # 任务列表
token:{uid}:lastRefresh # 上次刷新时间
task:{uid}:{taskId}:completed  # 任务完成标记
task:{uid}:{taskId}:waitTime   # 任务等待时间
config:users            # 用户配置列表
```

## 🔐 安全建议

1. **不要共享 Token**：Token 是敏感信息
2. **定期刷新 Token**：系统会自动刷新，但也可手动刷新
3. **使用 HTTPS**：在生产环境使用 HTTPS
4. **限制访问**：使用防火墙限制对仪表板的访问

## 📈 性能优化

### Token 刷新策略
- 定期检查 Token 有效期
- 自动刷新即将失效的 Token
- 错误时立即刷新

### 任务调度
- 每分钟检查一次任务列表
- 支持时间感知调度
- 自动处理任务状态

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

## ⚠️ 免责声明

本工具仅供学习和研究使用。使用本工具进行的任何操作由用户自己承担责任。不对任何损失或伤害负责。

## 📞 联系方式

有问题？请提交 Issue 或联系开发者。

---

**最后更新**：2025-10-18

**版本**：1.0.0
