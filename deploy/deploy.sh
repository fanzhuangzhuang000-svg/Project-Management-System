#!/usr/bin/env bash
#
# elv-pms 一键部署（裸机 Linux，不用 Docker）
#
#   sudo ./deploy/deploy.sh
#
# 做什么：
#   1. 装依赖（Node、PostgreSQL 客户端、中文 OCR 引擎）
#   2. 建系统账号与目录（程序不以 root 跑）
#   3. 装程序到 /opt/elv-pms
#   4. 建库建账号
#   5. 装 systemd 服务与备份定时器
#   6. 启动并自检
#
# 幂等：重复执行安全，不会清数据。

set -euo pipefail

APP_DIR=/opt/elv-pms
APP_USER=elv-pms
ENV_FILE=/etc/elv-pms/elv-pms.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_DB=elvpms
PG_USER=elvpms

say ()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn () { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die  () { printf '\n\033[1;31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo $0"

# ───────────────────────── 1. 依赖 ─────────────────────────
say "安装依赖"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# postgresql-client：pg_dump / pg_restore。
#   ⚠ 没有它，备份会自动降级成「只有数据、没有结构」的 JSON。
#     所以这一条不是可选项，宁可装不上也要报错停在这。
apt-get install -y -qq curl ca-certificates gnupg postgresql-client \
  tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng poppler-utils tar

if ! command -v node >/dev/null 2>&1; then
  say "安装 Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node --version
pg_dump --version

# ───────────────────────── 2. 账号与目录 ─────────────────────────
say "准备账号与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

mkdir -p "$APP_DIR" "$APP_DIR/data" "$APP_DIR/backup" /etc/elv-pms
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ───────────────────────── 3. 装程序 ─────────────────────────
say "安装程序到 $APP_DIR"
# 只同步代码与依赖，不碰 data/backup（数据在，别覆盖）
for f in package.json package-lock.json; do
  [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$APP_DIR/"
done
cp "$SRC_DIR"/*.js "$APP_DIR/"
for d in tools public web/dist; do
  [ -d "$SRC_DIR/$d" ] && cp -r "$SRC_DIR/$d" "$APP_DIR/"
done
[ -f "$SRC_DIR/README.md" ] && cp "$SRC_DIR/README.md" "$APP_DIR/"

say "安装 Node 依赖"
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund
else
  sudo -u "$APP_USER" npm install --omit=dev --no-audit --no-fund
fi

# ───────────────────────── 4. 配置 ─────────────────────────
say "准备配置 $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  # 数据库密码随机生成，不写死默认值
  DB_PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
  cat > "$ENV_FILE" <<EOF
# elv-pms 运行配置（权限 600，里面是数据库密码）
NODE_ENV=production
TZ=Asia/Shanghai
# ★ 用 PMS_PORT，不要用 PORT。
#   server.js 认的是 PMS_PORT；早期只读 PMS_PORT，后来为了兼容 docker-compose
#   补了 PORT，结果 PORT 在 Node 里是保留变量（某些运行时/容器平台会改写它），
#   两边一起用就会出现「env 里明明写了 8899，程序还在 8787」的情况。
#
#   默认 8899 而不是 8787：8787 是 Windows 单机版的固定端口（测试基址 +
#   客户交付地址），开发机上两套并存时抢端口就是「单机版起不来」。
#   客户只有裸装这一套时，8899 和 8787 都不冲突。
PMS_PORT=8899

# ── 数据库 ──
# 本机 PostgreSQL。密码与下面创建的账号一致。
DB_URL=postgres://${PG_USER}:${DB_PASS}@127.0.0.1:5432/${PG_DB}

# ── 备份 ──
PMS_BACKUP_DIR=${APP_DIR}/backup

# ── 首次启动写入系统设置的内容 ──
PMS_COMPANY_NAME=
PMS_ADMIN_PASSWORD=

# ── 授权 ──
# ⚠ 留空用程序内置值。不要把自定义密钥写在这里 —— 读到这个文件就能自己造授权码。
PMS_LICENSE_SECRET=
EOF
  chmod 600 "$ENV_FILE"
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  echo "  已生成 $ENV_FILE（数据库密码随机生成，记在下面）"
  echo "  数据库密码：$DB_PASS"
else
  echo "  已存在，保持不变"
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# ───────────────────────── 5. 建库 ─────────────────────────
say "准备数据库 ${PG_DB}"
DB_NAME="$(printf '%s' "$DB_URL" | sed -E 's#.*/([^/?]+)$#\1#')"
DB_ROLE="$(printf '%s' "$DB_URL" | sed -E 's#.*://([^:]+):.*#\1#')"
DB_PASS_RAW="$(printf '%s' "$DB_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')"

su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_ROLE}'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${DB_PASS_RAW}'\"" >/dev/null

su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE DATABASE ${DB_NAME} OWNER ${DB_ROLE} ENCODING 'UTF8'\"" >/dev/null

# 中文排序：库里按中文名排序的地方不少，不设会乱
su postgres -c "psql -d ${DB_NAME} -c 'CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"'" >/dev/null 2>&1 || true

echo "  数据库就绪：${DB_NAME}（属主 ${DB_ROLE}）"

# ───────────────────────── 6. systemd ─────────────────────────
say "安装 systemd 服务"
cp "$SRC_DIR/deploy/elv-pms.service" /etc/systemd/system/
cp "$SRC_DIR/deploy/elv-pms-backup.service" /etc/systemd/system/
cp "$SRC_DIR/deploy/elv-pms-backup.timer" /etc/systemd/system/
# 单元文件不能带执行权限 —— systemd 会警告并忽略部分检查，
# 从 Windows 复制过来的文件常常是 755
chmod 644 /etc/systemd/system/elv-pms*.service /etc/systemd/system/elv-pms*.timer
systemctl daemon-reload

# 先验一遍单元文件：语法错了这里就会报出来，而不是等到重启才发现服务起不来
if ! systemd-analyze verify /etc/systemd/system/elv-pms.service 2>&1 | grep -v "marked executable"; then :; fi

systemctl enable --now elv-pms.service
systemctl enable --now elv-pms-backup.timer

# ───────────────────────── 7. 防火墙 ─────────────────────────
say "开放端口"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow "${PMS_PORT:-8899}/tcp" >/dev/null 2>&1 || true
  echo "  ufw 已放行 ${PMS_PORT:-8899}/tcp"
else
  echo "  未启用 ufw —— 云服务器请在控制台安全组里放行 ${PMS_PORT:-8899}/tcp"
fi

# ───────────────────────── 8. 自检 ─────────────────────────
say "等待服务就绪"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PMS_PORT:-8899}/api/health" >/dev/null 2>&1; then
    echo "  ✓ 服务正常： http://$(hostname -I | awk '{print $1}'):${PMS_PORT:-8899}"
    break
  fi
  sleep 1
  [ "$i" = 40 ] && { journalctl -u elv-pms -n 40 --no-pager || true; die "服务 40 秒内没起来，上面是日志"; }
done

echo ''
echo '  常用命令：'
echo "    systemctl status elv-pms      查看运行状态"
echo "    journalctl -u elv-pms -f      实时看日志"
echo "    systemctl restart elv-pms     重启"
echo "    sudo -u elv-pms node /opt/elv-pms/tools/backup.js   手动备份"
echo "    sudo -u elv-pms node /opt/elv-pms/tools/restore-backup.js   从备份还原"
echo "    systemctl list-timers elv-pms-backup.timer   看下次自动备份时间"
echo ''
echo "  ⚠ 云服务器记得在控制台安全组放行 ${PMS_PORT:-8899}/tcp 端口。"
echo "    数据库密码在 $ENV_FILE 里（改端口改这个文件，不是改 PORT）。"
echo ''