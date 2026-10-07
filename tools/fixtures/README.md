# 测试素材（fixtures）

这个目录的**素材文件不入 Git**，只有生成脚本入库。

## 为什么

这里的 PDF / 扫描图 / xlsx / csv 是**真实文档的扫描件与导出结果**，里面含真实企业名、
真实路名、真实金额。它们是 OCR 与导入功能的测试基准，不是随手造的假数据 ——
真实扫描件才有真实的噪声、倾斜和 JPEG 压缩痕迹，而这些正是 OCR 阈值要考的东西。

但正因为是真材料，它们**不进版本历史**：仓库以后可能转公开或被人 fork，
删掉文件也追不回来。

## 怎么恢复

| 素材 | 生成方式 |
|---|---|
| `import-projects.xlsx` / `import-partners.xlsx` / `import-contracts-*.csv` | `python tools/fixtures/make-fixtures.py` |
| `contract.pdf` / `invoice.pdf` / `contract-new.pdf` / `contract-scan.jpg` | 需自备（见下） |

生成脚本只产出导入用的表格类素材；**扫描件与 PDF 必须自己准备**，
因为它们来自真实文档，脚本无法凭空造出有意义的 OCR 噪声。

## 没素材会怎样

在**干净克隆**上实测（服务与测试同端口、同 `PMS_DATA_DIR`），
24 个套件里 **15 个通过、9 个跑不起来**：

| 套件 | 缺什么 |
|---|---|
| `batch-test.js` | `contract.pdf` |
| `import-test.js` | `import-*.xlsx` / `*.csv` |
| `features-test.js` | `contract.pdf` |
| `ocr-chain-test.js` | `contract.pdf` |
| `ui-react-test.js` | `contract.pdf`、`contract-scan.jpg` |
| `verify-installed.js` | `invoice.pdf`（另需先产出安装包 exe） |
| `ai-test.js` | `contract.pdf`（另需真实 AI 密钥） |

另外两个跑不起来，但**与素材无关**，原因是环境不具备：

- `verify-pro-edition.js` —— 需要真实 PostgreSQL + MinIO 栈
- `reseed-atomic-test.js` —— 示例数据重播不幂等（实测材料 13 条 ≠ 期望 12 条），
  这是个**真 bug**，不是缺素材

其余 15 个套件（单元、权限、授权、多租户、备份还原、迁移、凭据脱敏…）
**不依赖本目录，可以正常跑**。

`run-all.js` 的 OCR 自检环节有 `existsSync` 过滤，会自动跳过缺失的素材；
一份素材都没有时直接报"跳过"而不是"失败"。

CI 跑的是 `run-all.js --ci`，会主动跳过上面这些套件（清单在 `run-all.js` 的
`CI_SKIP`，逐条注明了原因）。

## 给接手的人

如果要在别的机器上跑完整测试，需要准备这 4 个文件：

- `contract-scan.jpg` —— 合同扫描件（走 OCR 通道）
- `contract.pdf` —— 带文字层的合同（走 pdf-text 通道）
- `invoice.pdf` —— 增值税发票（验证文字层能直接读出发票种类）
- `contract-new.pdf` —— 用 `contract-new.html` 生成的 PDF

字段值与断言强相关，不要随意改：

| 字段 | 期望值 | 断言位置 |
|---|---|---|
| 合同编号 | `HT-2026-088` | ocr-chain-test.js:57 |
| 合同金额 | `5860000` | ocr-chain-test.js:58 |
| 签订日期 | `2026-03-05` | ocr-chain-test.js:59 |
| 付款条款 | 含 `预付款 30%` | ocr-chain-test.js:60 |
| 甲方 | 需能在示例数据里匹配到 | ocr-chain-test.js:70 |
| 发票金额 | `327000` | ocr-chain-test.js:131 |
| 发票种类 | `增值税专用发票` | ocr-chain-test.js:129 |

甲方名称必须与 `tools/test-auth.js` 播种的示例数据一致
（搜 `市第一人民医院` 可定位全部 4 处引用），否则"自动匹配到已有项目"
那条断言会挂。