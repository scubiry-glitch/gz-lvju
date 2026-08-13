#!/bin/bash
set -e

# 验证 Python 3 可用（本地构建用）
python3 --version

# 安装 Node.js 可选依赖（mysql2 fallback）
if [ ! -d "node_modules/mysql2" ]; then
  npm install mysql2 --no-save 2>/dev/null || echo "mysql2 install skipped"
fi

echo "Build complete"
