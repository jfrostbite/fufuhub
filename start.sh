#!/bin/bash

# FuFuHub Auto Sign Tool - 一键启动脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     FuFuHub Auto Sign Tool - Docker Compose 启动          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# 检查 Docker 和 Docker Compose
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker 未安装，请先安装 Docker${NC}"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}❌ Docker Compose 未安装，请先安装 Docker Compose${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 检测到 Docker 和 Docker Compose${NC}"
echo ""

# 启动服务
echo -e "${YELLOW}📦 启动服务中...${NC}"
docker-compose up -d

# 等待服务启动
echo -e "${YELLOW}⏳ 等待服务启动（约 30-60 秒）...${NC}"
sleep 10

# 检查服务状态
echo ""
echo -e "${YELLOW}🔍 检查服务状态...${NC}"
docker-compose ps

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                  ✅ 服务启动成功!                         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📍 访问地址：${NC}"
echo -e "   🌐 前端应用: ${GREEN}http://localhost:3000${NC}"
echo -e "   🔌 后端 API: ${GREEN}http://localhost:3001${NC}"
echo -e "   📊 Redis: ${GREEN}localhost:6379${NC}"
echo ""
echo -e "${BLUE}📝 下一步操作：${NC}"
echo -e "   1️⃣  打开浏览器访问 http://localhost:3000"
echo -e "   2️⃣  点击 '➕ Add User' 添加用户"
echo -e "   3️⃣  从 HAR 文件中提取以下信息："
echo -e "       • UID (用户 ID)"
echo -e "       • UUID"
echo -e "       • Flow ID"
echo -e "       • Access Key"
echo -e "   4️⃣  点击 'Save' 保存用户"
echo -e "   5️⃣  选择用户查看任务列表"
echo ""
echo -e "${BLUE}🛑 停止服务：${NC}"
echo -e "   ${YELLOW}docker-compose down${NC}"
echo ""
echo -e "${BLUE}📊 查看日志：${NC}"
echo -e "   ${YELLOW}docker-compose logs -f${NC}"
echo ""
echo -e "${BLUE}ℹ️  更多帮助：${NC}"
echo -e "   • README.md - 完整文档"
echo -e "   • QUICKSTART.md - 快速启动指南"
echo -e "   • ARCHITECTURE.md - 架构设计"
echo -e "   • EXTRACT_CONFIG.md - 配置提取指南"
echo ""
