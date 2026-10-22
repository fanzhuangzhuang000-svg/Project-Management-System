# 测试素材（fixtures）

这 7 个文件**入库**，克隆下来就能跑 `npm test`，不需要任何额外准备。

```
contract.pdf              带文字层的合同（走 pdf-text 通道）
contract-new.pdf          第二份合同（不同编号/金额，防抽取器写死）
invoice.pdf               增值税专用发票（验证文字层能直接读出发票种类与金额）
contract-scan.png         合同扫描件（走 OCR 通道，验证没被文字层抢走）
import-partners.xlsx      导入：往来单位
import-projects.xlsx      导入：项目（含 Excel 日期序列号）
import-contracts-gbk.csv  导入：合同，GBK 编码（中文 Excel「另存为 CSV」的默认编码）
import-contracts-utf8.csv 导入：合同，UTF-8 带 BOM
```

## 都是合成的

单位名（市第一人民医院 / 上海鼎信智能科技有限公司）、编号、金额、法人姓名全部虚构，
不含任何真实客户信息。所以放进版本历史没有隐私问题 —— 这也是它们能入库的前提。

## 怎么重新生成

```bash
node tools/fixtures/make-fixtures.js
```

- **表格类**：纯 Node，自己写最小 ZIP + XML。不需要 openpyxl，CI 上也不用装 Python 包。
- **文档类**：用系统自带的 Edge/Chrome 无头模式渲染 HTML 再打印。
  `PMS_BROWSER=<路径>` 可以指定浏览器。
- GBK 那份靠 `iconv`。没有 iconv 时会退化成 UTF-8 **并打印警告** ——
  宁可少测一个编码，也不放一个「名字叫 gbk 其实是 utf8」的假素材，
  那会让对应断言永远假绿。

素材本身也入库了，所以只有想改字段值时才需要重跑这个脚本。

## 为什么是 PNG 不是 JPG

Node 内置没有 JPEG 编码器，为了一个测试素材去引 sharp 会打破本项目的「零依赖」。
识别链路对 png/jpg 的处理完全一样（同一套 BitmapDecoder/同一份 OCR_EXT），
所以用 png 验证「图片走 OCR、没被文字层抢走」没有任何削弱。

## 字段值不要随手改

下列值和 `tools/ocr-chain-test.js` 的断言一一对应，改了测试必挂：

| 字段 | 值 | 断言位置 |
|---|---|---|
| 合同编号 | `HT-2026-088` | ocr-chain-test.js:57 |
| 合同金额 | `5860000` | ocr-chain-test.js:58 |
| 签订日期 | `2026-03-05` | ocr-chain-test.js:59 |
| 付款条款 | 含 `预付款 30%` | ocr-chain-test.js:60 |
| 甲方 | `市第一人民医院` | ocr-chain-test.js:70 |
| 发票价税合计 | `327000` | ocr-chain-test.js:131 |
| 发票种类 | `增值税专用发票` | ocr-chain-test.js:129 |

甲方名称必须与 `db.js` 示例数据里的单位同名（搜 `市第一人民医院`），
否则「自动匹配到已有单位」那条会挂。

`项目名称` 同理，必须是示例项目里真实存在的名字
（`市第一人民医院新院区智能化弱电工程`），否则 `suggest.project_id` 为空。

## 扫描件的版式有讲究

`contract-scan.png` 里，**标签和值必须写在同一行**（`合同金额：5,860,000.00 元`）。
第一版做成了两列表格，WinRT OCR 按列读 —— 左边一列标签挤成一团、右边才是值，
抽取规则「标签后 16 字以内找数字」自然全部落空。
真实合同不会把标签和值分成两栏，所以那是版式不真实，不是引擎不行。

同理，图里保留了轻微旋转（-0.3°）和纸纹：太干净的渲染图会让识别率虚高，
测不出真实扫描件的表现。

## CI 上的 OCR

`contract.pdf` / `invoice.pdf` 走文字层（pdfjs 纯 JS 解析），**任何平台都能跑**。

`contract-scan.png` 需要系统级中文 OCR：

- Windows：PowerShell + WinRT（`zh-Hans-CN` 语言包）
- Linux：Tesseract + `chi_sim`

GitHub 的 `windows-latest` 是英文系统，默认没有中文 OCR 语言包。
`ocr-chain-test.js` 会先探测后端，不可用时把那几条**标记为跳过并写明原因**，
不会假装通过。
