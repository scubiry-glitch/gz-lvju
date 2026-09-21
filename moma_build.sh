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
  # mysql2 + 全量依赖：从 npmmirror curl 逐包安装
  _install_pkg() {
    local pkg="$1" tgz="$2"
    local tmp=/tmp/_npm_pkg_dl
    mkdir -p "$tmp"
    curl -sL "https://registry.npmmirror.com/${pkg}/-/${tgz}.tgz" -o "$tmp/${pkg##*/}.tgz" 2>/dev/null \
      && tar -xzf "$tmp/${pkg##*/}.tgz" -C "$tmp/" \
      && mkdir -p "node_modules/$pkg" \
      && cp -r "$tmp/package/." "node_modules/$pkg/" \
      && rm -rf "$tmp" \
      && echo "$pkg installed" \
      || echo "$pkg install failed, continuing"
  }
  _install_pkg mysql2          mysql2-3.23.3
  _install_pkg long            long-5.3.2
  _install_pkg lru.min         lru.min-1.1.4
  _install_pkg iconv-lite      iconv-lite-0.7.3
  _install_pkg safer-buffer    safer-buffer-2.1.2
  _install_pkg sql-escaper     sql-escaper-1.5.1
  _install_pkg aws-ssl-profiles aws-ssl-profiles-1.1.2
  _install_pkg generate-function generate-function-2.3.1
  _install_pkg is-property     is-property-1.0.2
  _install_pkg named-placeholders named-placeholders-1.1.6
fi

echo "Build complete"
