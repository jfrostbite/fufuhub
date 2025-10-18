#!/bin/bash

# FuFuHub Auto Sign Tool - 停止脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${YELLOW}停止 FuFuHub Auto Sign Tool...${NC}"
docker-compose down

echo ""
echo -e "${GREEN}✅ 服务已停止${NC}"
echo ""
