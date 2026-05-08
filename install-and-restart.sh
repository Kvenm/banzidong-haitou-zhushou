#!/bin/bash

echo "正在安装 Puppeteer..."

# 检查是否需要修复 npm 权限
if [ -d "/Users/kven/.npm" ] && [ "$(stat -f '%Su' /Users/kven/.npm)" != "$(whoami)" ]; then
  echo "检测到 npm 缓存权限问题，正在修复..."
  echo "需要管理员权限来修复 npm 缓存权限"
  sudo chown -R $(whoami) /Users/kven/.npm
fi

# 安装 Puppeteer
npm install

echo ""
echo "安装完成！"
echo ""
echo "重启服务器..."
echo ""

# 停止旧的服务器
lsof -ti:4173 | xargs kill -9 2>/dev/null

# 启动新的服务器
node src/server.js
