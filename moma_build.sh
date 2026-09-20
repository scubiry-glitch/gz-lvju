#!/bin/bash
set -e

# 验证 Python 3 可用（本地构建用）
python3 --version

# 安装 Node.js 依赖（无外网时从 npmmirror 手动下载）
if [ ! -d "node_modules/bcryptjs" ]; then
  mkdir -p /tmp/_bcryptjs_dl
  curl -sL "https://registry.npmmirror.com/bcryptjs/-/bcryptjs-3.0.3.tgz" -o /tmp/_bcryptjs_dl/bcryptjs.tgz 2>/dev/null \
    && tar -xzf /tmp/_bcryptjs_dl/bcryptjs.tgz -C /tmp/_bcryptjs_dl/ \
    && mkdir -p node_modules/bcryptjs \
    && cp -r /tmp/_bcryptjs_dl/package/* node_modules/bcryptjs/ \
    && rm -rf /tmp/_bcryptjs_dl \
    || echo "bcryptjs install failed, continuing"
fi
if [ ! -d "node_modules/mysql2" ]; then
  npm install mysql2 --no-save --registry https://registry.npmmirror.com 2>/dev/null || echo "mysql2 install skipped"
fi

echo "Build complete"
