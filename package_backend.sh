#!/bin/bash
# ============================================================================
# 后端发行包打包脚本
# ----------------------------------------------------------------------------
# 产物        : dist/sy2-backend-<VER>.zip
# 范围        : 后端运行时(Node 入口 + 种子/鉴权/业务 CJS + Python 联调层)
#               + 前端静态页(app.js 以仓库根做静态根，需随后端一起发)
# 明确排除    : 图片资产(assets/、根目录 png/jpg) / PDF(exports/) /
#               office 文档(doc/docx/xlsx) / 地图 geojson / 密钥(.env*.local、config.ini) /
#               本地库(*.db/*.sqlite) / dump / git / .DS_Store / 测试产物
#
# 对应发行 git 地址（两个不同仓库，见 docs/release-packaging.md）：
#   后端  -> git.lianjia.com:btg-01/sy2-no-assets-20260812.git   (lianjia-no-assets)
#   前端  -> git.lianjia.com:btg-01/sy2-full.git                 (lianjia)
# ============================================================================
set -euo pipefail

VER="${1:-$(date +%Y%m%d)}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/dist"
ZIP="$OUT/sy2-backend-$VER.zip"

mkdir -p "$OUT"
rm -f "$ZIP"

echo "▶ 打包后端发行包 -> $ZIP"

# ── 1. 后端运行时（Node） ────────────────────────────────────────────────
zip -q "$ZIP" \
  app.js scf_bootstrap \
  package.json package-lock.json \
  moma_build.sh moma_build_local.sh moma_deploy.js \
  .env.example \
  *.cjs

# ── 2. 前端静态页（app.js 用仓库根做静态根，页面随包；不含图片/地图）──
zip -q "$ZIP" *.html *.css
zip -q "$ZIP" jiazheng-data.js jsbridgesdk.js jz-datepick.js

# ── 3. 目录 ──────────────────────────────────────────────────────────────
# screens：导航/工单/地域总线 + 全站页面，纯 html/js/css，无图片
zip -rq "$ZIP" screens/ -x "*/.DS_Store"

# juzhu：后端数据(JSON) + SQL schema + Python 联调层
#        剔除密钥/本地库/dump/字节码，保留 .env.example 与 config.ini.example 模板
zip -rq "$ZIP" juzhu/ \
  -x "*/.DS_Store" \
  -x "juzhu/__pycache__/*" -x "juzhu/*.pyc" \
  -x "juzhu/.env" -x "juzhu/.env.local" -x "juzhu/.env.prod" -x "juzhu/.env.test" \
  -x "juzhu/config.ini" \
  -x "juzhu/*.db" -x "juzhu/*.sqlite" -x "juzhu/*.sqlite3" \
  -x "juzhu/*_dump.json" -x "juzhu/*_dump.sql"

# scripts / vendor(jsbridge 离线包) / docs / node_modules(自包含部署)
zip -rq "$ZIP" scripts/ vendor/ docs/ node_modules/ \
  -x "*/.DS_Store" \
  -x "node_modules/.cache/*" -x "node_modules/.bin/*"

# ── 4. 汇总 ──────────────────────────────────────────────────────────────
echo "✔ 完成: $ZIP  ($(du -h "$ZIP" | cut -f1))"
echo "  条目数: $(unzip -l "$ZIP" | tail -1 | awk '{print $2}')"
