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
所以新克隆的仓库直接 `npm test` 会有测试因找不到素材而报错。

**实测（干净克隆、服务与测试同端口）跑不起来的 9 个套件**：

| 套件 | 缺什么 |
|---|---|
| `batch-test.js` | `fixtures/contract.pdf` |
| `import-test.js` | `fixtures/import-*.xlsx/csv` |
| `features-test.js` | `fixtures/contract.pdf` |
| `ocr-chain-test.js` | `fixtures/contract.pdf` |
| `ui-react-test.js` | `fixtures/contract.pdf`、`contract-scan.jpg` |
| `verify-installed.js` | `fixtures/invoice.pdf` + 先产出安装包 exe |
| `verify-pro-edition.js` | 真实 PG + MinIO 栈 |
| `ai-test.js` | 真实 AI 密钥（另有一处依赖 `contract.pdf`） |
| `reseed-atomic-test.js` | 与素材无关（见下） |

`reseed-atomic-test.js` 在干净克隆上被 CI 跳过，**不是因为缺素材**——它压的是
`/api/demo/seed` 反复重建的并发一致性，**需要服务全程在跑**（CI 的 GitHub Actions
runner 服务进程生命周期复杂，曾被观察到测试打到了别的实例上）。在本地与服务
同端口跑是正常的（材料数稳定在 12，读不到 0 也不累积 13）。

```bash
# 导入用的表格类素材，脚本能生成
python tools/fixtures/make-fixtures.py

# 扫描件与 PDF 必须自备，脚本造不出有意义的 OCR 噪声
# 字段期望值见 tools/fixtures/README.md
```

其余 16 个套件（单元、权限、授权、多租户、备份还原、迁移、凭据脱敏、发布工作流…）
**不依赖素材，正常跑**。细节见 [tools/fixtures/README.md](tools/fixtures/README.md)。

### CI 里跑什么

GitHub Actions 跑的是：

```bash
PMS_CI=1 node tools/run-all.js --ci
```

它会**跳过**上面那 9 个套件（跳过清单在 `tools/run-all.js` 的 `CI_SKIP`，
每一条都注明了跳过原因），只跑能在干净克隆上真正跑起来的那 16 个。
所以**推上去的 CI 是绿的，不代表全量回归是绿的** —— 素材相关的回归要靠本地有素材时手动跑。

恢复某个套件（比如素材改成脱敏件入库）时，从 `CI_SKIP` 里删掉对应行即可。

## 打交付包

```bash
node tools/build-artifacts.js            # 三平台全打
node tools/build-artifacts.js windows    # 只打某一个（windows / docker / linux）
node tools/verify-artifacts.js           # 校验包里东西齐全
```

产物在 `dist-artifacts/`（已 gitignore），发布时由 `.github/workflows/release.yml`
在 `v*` 标签上自动挂到 Release。

> 打包脚本靠扫描 `require` 语句推后端需要哪些文件，**扫不到条件分支里的懒加载**。
> `tools/ocr-tesseract.js` 就是这种（`ocr.js` 里只在 Linux 路径下 require 它），
> 所以它在 `TOOL_EXTRA` 里显式列出。**加新的条件加载模块时要同步加进去**，
> 否则只在某个平台上炸——漏进 Linux 包时表现为"服务起不来/识别用不了"。

## 端口

`server.js` 认的是 **`PMS_PORT`**（第 54 行，依次回退 `PMS_LISTEN_PORT` → `PORT` → 8787）。
测试脚本认的是 **`PMS_BASE`**（如 `run-all.js:17`、`test-auth.js:14`，回退 `http://127.0.0.1:8787`）。
测试用的临时数据目录是 **`PMS_DATA_DIR`**（`db-driver.js:20`、`storage.js:13`），**不是** `PMS_DATA`。

```
PMS_PORT=8801 PMS_DATA_DIR=./data-test npm start
```

⚠️ 变量名写错**不会报错**，只会静默用默认 8787，然后撞端口。

### ⚠️ 服务端和测试进程必须共享同一组变量

跑测试时 **`PMS_PORT` / `PMS_DATA_DIR` / `PMS_BASE` 要同时给服务端和测试进程**：

```bash
PMS_PORT=8899 PMS_DATA_DIR=./data-test PMS_BASE=http://127.0.0.1:8899 \
  node server.js &
PMS_PORT=8899 PMS_DATA_DIR=./data-test PMS_BASE=http://127.0.0.1:8899 \
  node tools/run-all.js
```

**为什么必须一致**：`tools/test-auth.js` 是**直接改本地数据库**来准备管理员账号的
（`require('../auth.js')`），它操作的是"测试进程自己的 `PMS_DATA_DIR`"；
而测试发 HTTP 请求打的是 `PMS_BASE`。两边不一致 = 测试写 A 库、请求打 B 库，
表现是**大面积莫名失败**（实测 25 个套件里 15 个假红），而且报错完全看不出根因。

## 三套环境的默认端口

同一台机器上三套可以并存，端口刻意分开了：

| 环境 | 端口 | 库 |
|---|---|---|
| Windows 单机版 | 8787 | SQLite `data/pms.db` |
| Docker 专业版 | 8790 | 容器内 PostgreSQL |
| Linux 裸装版 | 8899 | 独立 PostgreSQL |

⚠️ 8787 被单机版占着是因为它是测试基址 + 交付给客户的默认地址，
所以**专业版抢 8787 会让单机版直接起不来** —— 这也是 `docker-compose.yml`
的 `PORT` 兜底值是 8790 而不是 8787 的原因。

⚠️ 三套**数据互不相通**，是三个独立的库。

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
- 安装包 `dist-installer/`、交付包 `dist-artifacts/`（走 Release 挂附件）

**已经推上去又发现泄密了？** 单纯 `git rm` 没用——历史提交里还在。
需要 rotate 密钥（改密码）**加** 重写历史。见 [SECURITY.md](SECURITY.md)。
