# 贡献指南

内部项目，感谢参与。动手前请先看这里，能省掉很多来回。

## 开发环境

| 项目 | 要求 |
|---|---|
| Node.js | 18 以上（推荐 22，与 Docker 镜像一致） |
| 数据库 | 默认 SQLite，**不需要装任何数据库**。测 PostgreSQL 才需要 |
| 依赖 | 纯 JS/WASM，**零原生二进制**，`npm install` 不会编译 |

```bash
npm install
npm start          # 启动，默认 http://localhost:8787
npm test           # 全量回归
```

前端：

```bash
cd web
npm install
npm run build      # 产物输出到 ../public（服务直接读这里）
```

⚠️ **改前端后必须重新构建**，否则刷新页面看不到变化（服务读的是 `public/` 里的打包文件，不是 `web/src` 源码）。

## 提交前必跑

```bash
npm test
```

### ⚠️ 第一次 clone：先准备测试素材

`tools/fixtures/` 里的素材**不入 Git**（是真实合同的扫描件与导出文件，不能进版本历史），
所以新克隆的仓库直接 `npm test` 会有 4 个测试因找不到素材而报错：

- `import-test.js`
- `ocr-chain-test.js`
- `ui-react-test.js`
- `ocr-selftest.js`

```bash
# 导入用的表格类素材，脚本能生成
python tools/fixtures/make-fixtures.py

# 扫描件与 PDF 必须自备，脚本造不出有意义的 OCR 噪声
# 字段期望值见 tools/fixtures/README.md
```

其余测试（单元、权限、授权、多租户、备份还原、迁移）**不依赖素材，正常跑**。
细节见 [tools/fixtures/README.md](tools/fixtures/README.md)。

如果改了前端，额外需要：

```bash
cd web && npx tsc --noEmit
```

**测试不是形式**。这个项目里多数历史 bug 都是"在真实环境跑一遍才暴露"——
比如 Windows OCR 和 Linux Tesseract 的中文通道参数不同，
只有真拿扫描件跑才知道哪个参数是对的。

## 端口

`server.js` 认的是 **`PMS_PORT`**（第 54 行，依次回退 `PMS_LISTEN_PORT` → `PORT` → 8787）。
测试脚本认的是 **`PMS_BASE`**（如 `run-all.js:17`、`test-auth.js:14`，回退 `http://127.0.0.1:8787`）。
测试用的临时数据目录是 **`PMS_DATA_DIR`**（`db-driver.js:20`、`storage.js:13`），**不是** `PMS_DATA`。

```
PMS_PORT=8801 PMS_DATA_DIR=./data-test npm start
```

⚠️ 变量名写错**不会报错**，只会静默用默认 8787，然后撞端口。

## 改数据库结构

`db.js` 里的 `PROJECT_CHILD_TABLES` 和 `attachments.js` 的子表清单是**同一份数据的两个副本**——
2026-10 修过一次漏查（漏了 `schedules`），原因是两边各写各的。

新增项目级子表时，**两处都要改**。后续会收敛成单一来源，但目前请手动同步。

## 提交信息

用中文或英文都行，说清楚"改了什么、为什么"：

```
修复：附件只挂 project_id 时删除项目会变成悬空脏数据

attachments.js 的子表枚举漏了 schedules，导致挂在收付款计划节点上的
附件既不会被保留也不会被清理。子表清单改为从 db.js 统一引用。
```

## 不要提交的东西

`.gitignore` 已经挡住了，但你新增文件时留意别用 `git add -A` 无脑全加：

- `.env`（含真实密码和 MinIO 密钥）
- `data/`（客户业务数据、扫描件原件）
- `backup/`（整库快照）
- `data-pgtest*` / `_probe_data*`（验证时的临时库）
- 安装包 `dist-installer/`（走 Release 挂附件）

**已经推上去又发现泄密了？** 单纯 `git rm` 没用——历史提交里还在。
需要 rotate 密钥（改密码）**加** 重写历史。见 [SECURITY.md](SECURITY.md)。
