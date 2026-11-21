#!/bin/bash
# 青蝉测试环境构建。
# 产物：
#   dist/client  上传 CDN 的静态资源（页面、screens、图片、H5 成品、公开 JSON）
#   dist/server  服务端代码 + 同一份静态资源（暂不走 CDN，由 app.js 直接提供）
# 启动：cd dist/server && sh bin/run.sh
# 与线上一致：bin/run.sh 交给 scf_bootstrap，先 source 目录里的 .env 再 node app.js。
# 测试构建把 .env.test 收成 .env，并复制一份非隐藏的 runtime.env（隐藏文件被丢掉时仍能读到）。
# 平台注入的 PORT 仍优先。不打包 .env.prod。
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

CLIENT="$ROOT/dist/client"
SERVER="$ROOT/dist/server"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/qingchan-server.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "▶ install H5 dependencies and build"
npm ci --prefix h5 --no-audit --no-fund
npm --prefix h5 run build
if [ ! -f h5/dist/index.html ]; then
  echo "H5 build did not produce h5/dist/index.html" >&2
  exit 1
fi

echo "▶ install server production dependencies"
if [ ! -f vendor/lianjia-jsbridge3-1.1.6.tgz ]; then
  echo "missing vendor/lianjia-jsbridge3-1.1.6.tgz" >&2
  exit 1
fi
mkdir -p "$STAGE/vendor"
cp -a package.json package-lock.json "$STAGE/"
cp -a vendor/lianjia-jsbridge3-1.1.6.tgz "$STAGE/vendor/"
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund)

echo "▶ assemble dist/client and dist/server"
rm -rf "$ROOT/dist"
mkdir -p "$CLIENT" "$SERVER/bin" "$SERVER/juzhu" "$CLIENT/juzhu" "$CLIENT/h5"

# CDN：H5 成品挂在站点 /h5/*（与 vite base 一致）
cp -a h5/dist/. "$CLIENT/h5/"
# 服务端 serveH5Spa 从 h5/dist 读成品
mkdir -p "$SERVER/h5"
cp -a h5/dist "$SERVER/h5/dist"

# CDN：根目录公开页面与前端脚本（不含 app.js / 测试脚本 / 密钥）
for f in *.html *.css guizhou-map.json shenyang-map.json \
  jiazheng-data.js jsbridgesdk.js jz-datepick.js \
  lvju-app-config.js lvju-app-price.js lvju-catalog.js
do
  if [ -f "$f" ]; then
    cp -a "$f" "$CLIENT/$f"
  fi
done

copy_public() {
  local src="$1"
  find "$src" \
    \( -path '*/uploads' -o -path '*/uploads/*' -o -path '*/_scratch' -o -path '*/_scratch/*' \) -prune -o \
    -type f \( \
      -name '*.html' -o -name '*.js' -o -name '*.css' -o \
      -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o \
      -name '*.webp' -o -name '*.svg' -o -name '*.gif' -o \
      -name '*.ico' -o -name '*.woff' -o -name '*.woff2' -o \
      -name '*.json' \
    \) ! -name '*.artifact.json' -print
}

while IFS= read -r f; do
  mkdir -p "$CLIENT/$(dirname "$f")"
  cp -a "$f" "$CLIENT/$f"
done < <(copy_public screens; copy_public assets)

for d in lvju-download zhijian-download; do
  if [ -d "$d" ]; then
    mkdir -p "$CLIENT/$d"
    cp -a "$d/." "$CLIENT/$d/"
  fi
done

# 公开房源 JSON：CDN 给页面兜底，服务端给空库种子
for f in app.js cities.json data.json data-nanjing.json data-guiyang.json data-shenyang.json; do
  if [ -f "juzhu/$f" ]; then
    cp -a "juzhu/$f" "$CLIENT/juzhu/$f"
    case "$f" in
      *.json) cp -a "juzhu/$f" "$SERVER/juzhu/$f" ;;
    esac
  fi
done

# 服务端运行时
cp -a app.js package.json package-lock.json scf_bootstrap "$SERVER/"
if [ ! -f .env.test ]; then
  echo "missing .env.test" >&2
  exit 1
fi
cp -a .env.test "$SERVER/.env"
cp -a .env.test "$SERVER/.env.test"
cp -a .env.test "$SERVER/runtime.env"
if [ -f .env.example ]; then
  cp -a .env.example "$SERVER/.env.example"
fi
find . -maxdepth 1 -type f -name '*.cjs' -exec cp -a {} "$SERVER/" \;
mkdir -p "$SERVER/server"
find server -maxdepth 1 -type f -exec cp -a {} "$SERVER/server/" \;
for d in server/*/; do
  base="$(basename "$d")"
  if [ "$base" = "test" ]; then
    continue
  fi
  cp -a "$d" "$SERVER/server/$base"
done
mkdir -p "$SERVER/commerce"
cp -a commerce/. "$SERVER/commerce/"
mv "$STAGE/node_modules" "$SERVER/node_modules"

cat > "$SERVER/bin/run.sh" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")/.."
exec bash ./scf_bootstrap
EOF
chmod +x "$SERVER/bin/run.sh"

# 暂不上传 CDN：静态资源同步进服务端目录。/h5 由 serveH5Spa 读 h5/dist，
# 不能把 client/h5 平铺到 server/h5，否则会盖住 h5/dist。
echo "▶ sync dist/client static files into dist/server"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude 'h5' "$CLIENT/" "$SERVER/"
else
  while IFS= read -r f; do
    rel="${f#"$CLIENT"/}"
    case "$rel" in
      h5|h5/*) continue ;;
    esac
    mkdir -p "$SERVER/$(dirname "$rel")"
    cp -a "$f" "$SERVER/$rel"
  done < <(find "$CLIENT" -type f)
fi

if [ ! -f "$CLIENT/index.html" ] || [ ! -f "$CLIENT/h5/index.html" ]; then
  echo "dist/client is missing index.html or h5/index.html" >&2
  exit 1
fi
if [ ! -f "$SERVER/app.js" ] || [ ! -d "$SERVER/node_modules/mysql2" ]; then
  echo "dist/server is missing app.js or production node_modules" >&2
  exit 1
fi
if [ ! -f "$SERVER/.env" ] || [ ! -f "$SERVER/runtime.env" ]; then
  echo "dist/server is missing .env / runtime.env" >&2
  exit 1
fi
if [ ! -f "$SERVER/index.html" ] || [ ! -f "$SERVER/screens/_nav.js" ] || [ ! -f "$SERVER/h5/dist/index.html" ]; then
  echo "dist/server is missing synced static files or h5/dist" >&2
  exit 1
fi

echo "✔ dist/client $(find "$CLIENT" -type f | wc -l | tr -d ' ') files"
echo "✔ dist/server $(find "$SERVER" -type f | wc -l | tr -d ' ') files"
echo "  CDN 静态资源: dist/client（当前同样已放入 dist/server）"
echo "  服务端启动:   cd dist/server && sh bin/run.sh"
