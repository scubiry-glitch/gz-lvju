#!/usr/bin/env bash
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-$HOME/.jdks/jdk-21.0.12.1+1/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 远程 URL 模式：无需前端构建，确保 www 占位存在即可
if [ ! -f www/index.html ]; then
  echo "缺少 www/index.html（Capacitor webDir 占位）" >&2
  exit 1
fi

npx cap sync android
cd android
./gradlew assembleDebug --no-daemon

APK="app/build/outputs/apk/debug/app-debug.apk"
OUT="$HOME/Downloads/lvju-debug.apk"
cp "$APK" "$OUT"
echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"
echo "OK: $ROOT/android/$APK"
