# 弱电项目管理系统 —— 专业版（网络版）镜像
#
# 单机 exe 版不需要这个文件；这里是给 docker-compose 用的。
# 同一个代码库，靠环境变量区分单机 / 网络模式：
#   DB_URL          postgres://...   → 走 PostgreSQL（不配就是 SQLite）
#   STORAGE_DRIVER  minio            → 附件进 MinIO（不配就是本地目录）

FROM node:22-alpine

# 时区设成上海，否则日志和"今天"会差 8 小时
ENV TZ=Asia/Shanghai

# ⚠️ postgresql-client 绝对不能省。
# node:22-alpine 默认不带 pg_dump，没有它备份会自动降级成「只有数据、没有结构」
# 的 JSON —— 客户真要还原时才发现主键和索引全没了，备份等于废的。
# 装它只多几十 MB，比赔上客户整库数据便宜太多。
RUN apk add --no-cache tzdata curl postgresql17-client \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

WORKDIR /app

# 先只装依赖，改代码时不用重装（利用镜像层缓存）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 应用代码
COPY *.js ./
COPY tools ./tools
COPY public ./public

# 数据目录（挂出来的是数据库备份和附件缓存；真正的库在 postgres 容器里）
RUN mkdir -p /app/data/attachments /app/data/attach-cache /app/backup
VOLUME ["/app/data", "/app/backup"]

EXPOSE 8787

# 健康检查：compose 靠它判断容器是否真的可用，而不是"进程还活着"
HEALTHCHECK --interval=20s --timeout=8s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1

CMD ["node", "server.js"]

# 备份用 pg_dump 出真实结构；还原在容器里做（还原会先覆盖数据库，务必先停服务）
#   docker compose exec app node tools/backup.js
#   docker compose stop app && docker compose run --rm app node tools/restore-backup.js && docker compose start app
# tesseract（中文扫描件识别）在 alpine 上要额外装后端：
#   apk add --no-cache tesseract-ocr tesseract-ocr-data-chi_sim tesseract-ocr-data-eng poppler-utils
