#!/bin/bash

BASE_DIR="/usr/home/sir"
LOG_DIR="$BASE_DIR/logs"

mkdir -p "$LOG_DIR"

echo "[$(date)] Starting services..."

cd "$BASE_DIR" || exit 1

# ====== Redis ======
if pgrep -f "redis-server.*redis.conf" > /dev/null; then
    echo "Redis already running"
else
    echo "Starting Redis..."
    redis-server "$BASE_DIR/redis.conf" > "$LOG_DIR/redis.log" 2>&1 &
    echo $! > "$BASE_DIR/redis.pid"
    sleep 2
fi

# ====== FuFuHub ======
if pgrep -f "node.*src/index.js" > /dev/null; then
    echo "FuFuHub already running"
else
    echo "Starting FuFuHub..."
    node "$BASE_DIR/src/index.js" > "$LOG_DIR/fufuhub.log" 2>&1 &
    echo $! > "$BASE_DIR/fufuhub.pid"
fi

echo "[$(date)] Done."