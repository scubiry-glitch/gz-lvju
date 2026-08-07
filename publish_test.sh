#!/bin/bash
# ============================================================
# publish_test.sh - 发布代码到测试服务器并重启 8765 端口服务
# 用法: bash publish_test.sh [-db]
#   -db  同步本地 juzhu.db 数据库到服务器（默认不推送）
# ============================================================
set -euo pipefail

# ---- 远程服务器配置 ----
REMOTE_HOST="49.232.103.71"
REMOTE_USER="root"
REMOTE_PASS=',c!7U9b#eBhke.wuTFU5vTL2Y5EdxB'
REMOTE_DIR="/projects/beike"
SERVICE_PORT=8765

# ---- 本地项目根目录（脚本所在目录） ----
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- 颜色输出 ----
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---- 导出密码到环境变量（sshpass 会从 SSHPASS 环境变量读取） ----
export SSHPASS="${REMOTE_PASS}"

# ---- SSH 公共选项 ----
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

# ---- SSH/SCP 命令封装（使用 sshpass -e 从环境变量读取密码） ----
ssh_cmd() {
    sshpass -e ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

scp_cmd() {
    sshpass -e scp ${SSH_OPTS} "$@"
}

# ---- 检查 sshpass ----
check_sshpass() {
    if ! command -v sshpass &>/dev/null; then
        log_warn "sshpass 未安装，尝试自动安装..."
        if command -v brew &>/dev/null; then
            brew install hudochenkov/sshpass/sshpass
        elif command -v apt-get &>/dev/null; then
            sudo apt-get update && sudo apt-get install -y sshpass
        elif command -v yum &>/dev/null; then
            sudo yum install -y sshpass
        else
            log_error "请手动安装 sshpass 后重试: brew install hudochenkov/sshpass/sshpass"
            exit 1
        fi
        log_info "sshpass 安装完成"
    fi
}

# ---- 步骤1: 同步代码 ----
sync_code() {
    log_info "开始同步代码到 ${REMOTE_HOST}:${REMOTE_DIR} ..."

    # 确保远程目录存在
    ssh_cmd "mkdir -p ${REMOTE_DIR}"

    # 构建公共排除列表（根据 -db 参数决定是否排除 juzhu.db）
    local EXCLUDES=(
        --exclude='.git'
        --exclude='__pycache__'
        --exclude='*.pyc'
        --exclude='.DS_Store'
        --exclude='exports/'
        --exclude='publish_test.sh'
    )
    if [ "${INCLUDE_DB}" != "true" ]; then
        EXCLUDES+=( --exclude='juzhu.db' )
        log_info "跳过 juzhu.db（加 -db 参数可同步数据库）"
    else
        log_warn "将同步本地 juzhu.db 到服务器！"
    fi

    # 使用 rsync 同步（如果可用），否则用 tar+scp
    if command -v rsync &>/dev/null && ssh_cmd "command -v rsync &>/dev/null" 2>/dev/null; then
        log_info "使用 rsync 增量同步..."
        sshpass -e rsync -avz --progress \
            "${EXCLUDES[@]}" \
            -e "ssh ${SSH_OPTS}" \
            "${LOCAL_DIR}/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
    else
        log_info "使用 tar+scp 全量同步..."
        local TAR_EXCLUDES=()
        for exc in "${EXCLUDES[@]}"; do
            # rsync --exclude='xxx' → tar --exclude='xxx'
            TAR_EXCLUDES+=( "${exc}" )
        done
        local TMP_TAR
        TMP_TAR="$(mktemp /tmp/publish_XXXXX.tar.gz)"
        cd "${LOCAL_DIR}"
        tar "${TAR_EXCLUDES[@]}" -czf "${TMP_TAR}" .
        scp_cmd "${TMP_TAR}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
        ssh_cmd "cd ${REMOTE_DIR} && tar -xzf $(basename "${TMP_TAR}") && rm -f $(basename "${TMP_TAR}")"
        rm -f "${TMP_TAR}"
    fi

    log_info "代码同步完成"
}

# ---- 步骤2: 检查并重启 8765 端口服务 ----
restart_service() {
    log_info "检查 ${SERVICE_PORT} 端口服务..."

    ssh_cmd bash <<'ENDSCRIPT'
PORT=8765
PROJECT_DIR=/projects/beike
LOG_FILE=/tmp/beike_server.log

# 查找监听该端口的进程
PID=$(lsof -ti:${PORT} 2>/dev/null || true)

if [ -n "${PID}" ]; then
    echo "[REMOTE] 发现占用端口 ${PORT} 的进程 PID=${PID}，正在停止..."
    kill ${PID} 2>/dev/null || true
    sleep 2
    if kill -0 ${PID} 2>/dev/null; then
        echo "[REMOTE] 进程未响应，强制终止..."
        kill -9 ${PID} 2>/dev/null || true
        sleep 1
    fi
    echo "[REMOTE] 旧进程已停止"
else
    echo "[REMOTE] 端口 ${PORT} 当前无服务运行"
fi

# 确认端口已释放
sleep 1
if lsof -ti:${PORT} >/dev/null 2>&1; then
    echo "[REMOTE] ERROR: 端口 ${PORT} 仍被占用，无法启动服务"
    exit 1
fi

# 启动服务
cd ${PROJECT_DIR}
nohup python3 juzhu/server.py > ${LOG_FILE} 2>&1 &
NEW_PID=$!
echo "[REMOTE] 服务已启动，PID=${NEW_PID}，日志: ${LOG_FILE}"

# 等待服务就绪（最多等 15 秒）
for i in $(seq 1 15); do
    sleep 1
    if lsof -ti:${PORT} >/dev/null 2>&1; then
        echo "[REMOTE] 服务启动成功，端口 ${PORT} 已监听"
        exit 0
    fi
    if ! kill -0 ${NEW_PID} 2>/dev/null; then
        echo "[REMOTE] ERROR: 进程已退出，请检查日志: tail -20 ${LOG_FILE}"
        exit 1
    fi
    if [ $((i % 5)) -eq 0 ]; then
        echo "[REMOTE] 等待服务启动... (${i}/15)"
    fi
done

echo "[REMOTE] WARN: 启动超时但进程仍在运行，请检查日志: tail -f ${LOG_FILE}"
exit 0
ENDSCRIPT
}

# ---- 清理敏感信息 ----
cleanup() {
    unset SSHPASS
}

# ---- 主流程 ----
main() {
    # 注册退出清理
    trap cleanup EXIT

    # 解析参数
    INCLUDE_DB="false"
    for arg in "$@"; do
        case "$arg" in
            -db|--db)
                INCLUDE_DB="true"
                ;;
            -h|--help)
                echo "用法: bash publish_test.sh [-db]"
                echo "  -db  同步本地 juzhu.db 数据库到服务器（默认不推送）"
                exit 0
                ;;
            *)
                log_error "未知参数: $arg（使用 -h 查看帮助）"
                exit 1
                ;;
        esac
    done

    echo ""
    echo "============================================"
    echo "  测试环境发布脚本"
    echo "  目标: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
    echo "  服务端口: ${SERVICE_PORT}"
    if [ "${INCLUDE_DB}" = "true" ]; then
        echo -e "  ${YELLOW}数据库: 同步 juzhu.db${NC}"
    else
        echo "  数据库: 跳过 juzhu.db"
    fi
    echo "============================================"
    echo ""

    check_sshpass

    # 测试连接
    log_info "测试 SSH 连接..."
    if ! ssh_cmd "echo OK" 2>/dev/null; then
        log_error "无法连接到 ${REMOTE_HOST}，请检查网络和凭据"
        exit 1
    fi
    log_info "SSH 连接正常"

    sync_code
    restart_service

    echo ""
    echo "============================================"
    echo -e "${GREEN}  发布完成!${NC}"
    echo ""
    echo "  访问链接:"
    echo -e "  ${GREEN}http://${REMOTE_HOST}:${SERVICE_PORT}/${NC}"
    echo ""
    echo "  主要页面:"
    echo "  前台: http://${REMOTE_HOST}:${SERVICE_PORT}/juzhu-channel-v3-grid.html"
    echo "  后台: http://${REMOTE_HOST}:${SERVICE_PORT}/juzhu-admin.html"
    echo "============================================"
}

main "$@"
