'use strict';
/**
 * 生成测试素材（fixtures）
 *
 *   node tools/fixtures/make-fixtures.js
 *
 * 产出的文件**要提交进仓库**：它们全是合成的假数据（虚构的公司名、写死的编号），
 * 不含任何真实客户信息。以前不提交是因为素材来自真实扫描件，现在没这个顾虑了 ——
 * 换成合成件之后，干净克隆和 CI 都能直接跑，不用再靠「本机恰好有这几个文件」。
 *
 * 依赖：
 *   · 表格类（xlsx/csv）—— 纯 Node，自己写最小 ZIP 与 XML，不需要 openpyxl。
 *   · 文档类（pdf/png）—— 用系统自带的 Edge/Chrome 无头模式渲染。
 *     不引入任何 npm 包：本项目的卖点之一就是零依赖，测试工具不该先破例。
 *
 * 为什么用浏览器渲染而不是直接手写 PDF：
 *   pdf-text 通道靠的是**文字层**，必须是真的文字对象，不能是画上去的图形。
 *   浏览器 print-to-pdf 产出的就是标准文字层，正好是这条链路要验证的东西。
 *
 * ---- 字段值不要随手改 ----
 * 下列值和 tools/ocr-chain-test.js 的断言一一对应，改了测试必挂：
 *   合同编号 HT-2026-088 · 金额 5,860,000.00 · 签订日期 2026-03-05
 *   付款条款含「预付款 30%」· 甲方「市第一人民医院」· 发票价税合计 ¥327,000.00
 * 甲方名称必须与 db.js 的示例数据同名，否则"自动匹配到已有单位"那条会挂。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;
const TMP = path.join(HERE, '.tmp');

// ============================================================
// 一、最小 ZIP 写入器（只为产出 xlsx）
// ============================================================
/** 写一个 ZIP（deflate）。Excel 与项目自带的 tools/tabular.js 都能读 */
function zip (files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // 需要的版本
    local.writeUInt16LE(0x0800, 6);      // 标志：文件名 UTF-8
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0, 10);          // 时间
    local.writeUInt16LE(0x21, 12);       // 日期（1980-01-01，固定值保证可重复）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

let CRC_TABLE = null;
function crc32 (buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ============================================================
// 二、最小 XLSX 写入器
// ============================================================
const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function colName (i) {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0);
  return s;
}

/**
 * 写 xlsx。
 * 字符串用 inlineStr（不建 sharedStrings 表，结构简单一层）；
 * 数字直接写 <v>，日期也写成序列号 —— 导入逻辑里 excelSerialToDate 认的就是它。
 */
function writeXlsx (file, sheetName, rows) {
  const sheetRows = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      const ref = colName(c) + (r + 1);
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  fs.writeFileSync(file, zip(files));
  console.log('  ✓ ' + path.basename(file) + `  ${rows.length - 1} 行`);
}

/** Excel 日期序列号（1900 系统，序列 1 = 1900-01-01，含 1900 闰年 bug 的补偿） */
function excelSerial (isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

// ============================================================
// 三、表格素材
// ============================================================
function makeTables () {
  console.log('表格素材：');

  // 往来单位：三行，三种类型，验证列名映射与中文
  writeXlsx(path.join(HERE, 'import-partners.xlsx'), '往来单位', [
    ['单位名称', '单位类型', '简称', '联系人', '联系电话', '备注'],
    ['测试甲方建设集团有限公司', '甲方', '测试甲方', '王主任', '13900001111', '导入测试数据'],
    ['测试供应商科技有限公司', '供应商', '测试供应商', '李经理', '13900002222', '导入测试数据'],
    ['测试分包劳务有限公司', '分包商', '测试分包', '赵工', '13900003333', '导入测试数据'],
  ]);

  // 项目：第 1 行的日期用 Excel 序列号（模拟真实 Excel 里点日期选择器录进去的值），
  //      第 2 行用两种文字写法，验证「数字」和「文字」两条解析路径都通。
  writeXlsx(path.join(HERE, 'import-projects.xlsx'), '项目', [
    ['项目编号', '项目名称', '甲方单位', '子系统类别', '项目状态',
      '项目经理', '完工进度', '开工日期', '竣工日期', '项目地点', '备注'],
    ['TEST-IMP-001', '测试项目·智慧园区弱电工程', '测试甲方建设集团有限公司', '安防监控',
      '进行中', '测试员甲', 30, excelSerial('2026-01-10'), excelSerial('2026-11-30'),
      '测试市测试路 1 号', '导入测试数据'],
    ['TEST-IMP-002', '测试项目·办公楼机房改造', '测试甲方建设集团有限公司', '机房工程',
      '未开工', '测试员乙', 0, '2026/3/1', '2026年9月30日', '测试市测试路 2 号', '导入测试数据'],
  ]);

  // 合同 CSV：同样内容两份，一份 GBK 一份 UTF-8(BOM)。
  // 中文 Excel「另存为 CSV」默认就是 GBK，不测这个编码等于没测真实场景。
  const header = '合同编号,合同名称,所属项目,合同类别,收支方向,对方单位,合同金额,税率,签订日期,合同状态,付款条款';
  const rows = [
    'TEST-HT-001,测试项目智慧园区施工合同,测试项目·智慧园区弱电工程,项目合同,收入,测试甲方建设集团有限公司,'
    + '"2,180,000.00",9,2026-01-05,执行中,"预付款30%，验收款65%，质保金5%"',
    'TEST-CG-001,测试监控设备采购合同,测试项目·智慧园区弱电工程,采购合同,支出,测试供应商科技有限公司,'
    + '"1,130,000.00",13,2026-01-08,执行中,"预付40%，到货50%，质保10%"',
  ];
  const body = header + '\r\n' + rows.join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(HERE, 'import-contracts-utf8.csv'), '\uFEFF' + body, 'utf8');
  console.log('  ✓ import-contracts-utf8.csv  2 行');

  // GBK：Node 没有 GBK 编码器（只有解码），借系统的 iconv。
  // 拿不到 iconv 时退化成 UTF-8 并明确警告 —— 宁可少测一个编码，
  // 也不要偷偷放一个「名字叫 gbk 其实是 utf8」的假素材，那会让对应断言永远假绿。
  const gbkPath = path.join(HERE, 'import-contracts-gbk.csv');
  try {
    fs.writeFileSync(path.join(TMP, 'contracts-utf8.csv'), body, 'utf8');
    execFileSync('iconv', ['-f', 'UTF-8', '-t', 'GBK', path.join(TMP, 'contracts-utf8.csv')],
      { stdio: ['ignore', fs.openSync(gbkPath, 'w'), 'pipe'] });
    console.log('  ✓ import-contracts-gbk.csv  2 行（iconv 转 GBK）');
  } catch (e) {
    fs.copyFileSync(path.join(HERE, 'import-contracts-utf8.csv'), gbkPath);
    console.log('  ! import-contracts-gbk.csv 生成失败（' + e.message.split('\n')[0] + '），'
      + '已退化为 UTF-8 —— 这个文件的 GBK 断言将失去意义，请在有 iconv 的机器上重跑');
  }
}

// ============================================================
// 四、文档素材（浏览器渲染）
// ============================================================
function findBrowser () {
  const cands = [
    process.env.PMS_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of cands) { try { if (fs.existsSync(p)) return p } catch { /* 忽略 */ } }
  return null;
}

const PAGE_CSS = `
  @page { size: A4; margin: 22mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: "SimSun", "Songti SC", serif; font-size: 12pt; line-height: 1.9; color: #111; }
  h1 { font-family: "SimHei", "Heiti SC", sans-serif; font-size: 20pt; text-align: center;
       letter-spacing: 6px; margin: 0 0 4mm; }
  h2 { font-family: "SimHei", "Heiti SC", sans-serif; font-size: 13pt; text-align: center;
       font-weight: normal; margin: 0 0 8mm; letter-spacing: 2px; }
  table.meta { width: 100%; border-collapse: collapse; margin-bottom: 6mm; }
  table.meta td { padding: 1.2mm 0; vertical-align: top; }
  table.meta td.k { width: 30mm; color: #333; }
  p { margin: 0 0 3mm; text-indent: 2em; }
  .sign { margin-top: 12mm; }
  .sign td { width: 50%; padding-top: 10mm; }
`;

/** 合同正文（PDF 版与扫描件版共用同一份文字，只有版式不同） */
function contractHtml () {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>弱电智能化工程施工合同</title><style>${PAGE_CSS}</style></head><body>
<h1>弱电智能化工程施工合同</h1>
<h2>合同编号：HT-2026-088</h2>
<table class="meta">
  <tr><td class="k">合同名称：</td><td>市第一人民医院新院区智能化弱电工程施工合同</td></tr>
  <tr><td class="k">项目名称：</td><td>市第一人民医院新院区智能化弱电工程</td></tr>
  <tr><td class="k">甲方：</td><td>市第一人民医院</td></tr>
  <tr><td class="k">乙方：</td><td>上海鼎信智能科技有限公司</td></tr>
  <tr><td class="k">工程地点：</td><td>本市高新区文一西路 1000 号</td></tr>
  <tr><td class="k">签订日期：</td><td>2026 年 03 月 05 日</td></tr>
  <tr><td class="k">开工日期：</td><td>2026 年 03 月 20 日</td></tr>
  <tr><td class="k">竣工日期：</td><td>2026 年 12 月 31 日</td></tr>
  <tr><td class="k">合同金额：</td><td>5,860,000.00 元</td></tr>
  <tr><td class="k">付款条款：</td><td>预付款 30%，进度款按月计量经监理确认后支付 60%，验收合格后支付 7%，余款 3% 作为质保金于质保期满后无息付清。</td></tr>
</table>
<p>根据《中华人民共和国民法典》及有关法律法规，甲乙双方本着平等自愿、诚实信用的原则，
就市第一人民医院新院区智能化弱电工程的施工事宜协商一致，订立本合同。</p>
<p>一、工程范围：综合布线系统、安防监控系统、门禁一卡通系统、机房工程的设备供货、
安装、调试及验收，具体以施工图纸与工程量清单为准。</p>
<p>二、工期：自 2026 年 03 月 20 日开工，至 2026 年 12 月 31 日竣工，总工期 287 日历天。
因甲方原因或不可抗力导致停工的，工期相应顺延。</p>
<p>三、质量标准：符合国家现行施工验收规范，一次性验收合格。</p>
<p>四、违约责任：任何一方违约，应向对方支付合同金额 5% 的违约金；损失超过违约金的，
按实际损失赔偿。</p>
<p>五、争议解决：协商不成的，提交工程所在地人民法院诉讼解决。</p>
<p>六、本合同一式肆份，甲乙双方各执贰份，自双方盖章之日起生效。</p>
<table class="sign">
  <tr><td>甲方（盖章）：市第一人民医院</td><td>乙方（盖章）：上海鼎信智能科技有限公司</td></tr>
  <tr><td>法定代表人：陈建国</td><td>法定代表人：周立群</td></tr>
  <tr><td>日期：2026 年 03 月 05 日</td><td>日期：2026 年 03 月 05 日</td></tr>
</table>
</body></html>`;
}

function contractNewHtml () {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>弱电工程施工合同</title><style>${PAGE_CSS}</style></head><body>
<h1>弱电工程施工合同</h1>
<h2>合同编号：HT-2026-089</h2>
<table class="meta">
  <tr><td class="k">合同名称：</td><td>城建·云鼎广场弱电智能化工程施工合同</td></tr>
  <tr><td class="k">项目名称：</td><td>城建·云鼎广场弱电智能化工程</td></tr>
  <tr><td class="k">甲方：</td><td>城建置业有限公司</td></tr>
  <tr><td class="k">乙方：</td><td>上海鼎信智能科技有限公司</td></tr>
  <tr><td class="k">签订日期：</td><td>2026 年 04 月 18 日</td></tr>
  <tr><td class="k">开工日期：</td><td>2026 年 05 月 06 日</td></tr>
  <tr><td class="k">竣工日期：</td><td>2026 年 11 月 30 日</td></tr>
  <tr><td class="k">合同金额：</td><td>1,280,000.00 元</td></tr>
  <tr><td class="k">付款条款：</td><td>预付款 20%，进度款按季度支付 70%，尾款 10% 于验收合格后支付。</td></tr>
</table>
<p>甲乙双方就城建·云鼎广场弱电智能化工程的施工达成如下协议，共同遵守。</p>
<p>一、工程内容：视频监控系统、停车管理系统、网络通信系统的设备供货与安装调试。</p>
<p>二、工期：自 2026 年 05 月 06 日起至 2026 年 11 月 30 日止。</p>
<p>三、验收标准：按设计图纸及国家现行验收规范执行，一次性验收合格。</p>
<p>四、本合同自双方签字盖章之日起生效，一式贰份，双方各执壹份。</p>
<table class="sign">
  <tr><td>甲方（盖章）：城建置业有限公司</td><td>乙方（盖章）：上海鼎信智能科技有限公司</td></tr>
  <tr><td>日期：2026 年 04 月 18 日</td><td>日期：2026 年 04 月 18 日</td></tr>
</table>
</body></html>`;
}

function invoiceHtml () {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>增值税专用发票</title><style>
  @page { size: A4; margin: 20mm 16mm; }
  body { font-family: "SimSun", serif; font-size: 11pt; line-height: 1.8; color: #111; }
  h1 { font-size: 17pt; text-align: center; letter-spacing: 4px; margin: 0 0 2mm; }
  .no { text-align: center; font-size: 9pt; color: #333; margin-bottom: 6mm; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; }
  td { border: 1px solid #999; padding: 1.6mm 2mm; vertical-align: top; }
  td.k { width: 26mm; background: #f6f6f6; white-space: nowrap; }
  .right { text-align: right; }
  .total { font-weight: bold; }
</style></head><body>
<h1>增值税专用发票</h1>
<div class="no">发票号码：26312000006153870301　　开票日期：2026 年 09 月 28 日</div>
<table>
  <tr><td class="k">购买方</td><td>名称：市第一人民医院<br>纳税人识别号：12330100MB1A2B3C4D</td></tr>
  <tr><td class="k">销售方</td><td>名称：上海鼎信智能科技有限公司<br>纳税人识别号：91310115MA1K8X2Y3Z</td></tr>
</table>
<table style="margin-top:-1px">
  <tr><td class="k">项目名称</td><td>规格型号</td><td>数量</td><td class="right">单价</td><td class="right">金额</td><td class="right">税率</td><td class="right">税额</td></tr>
  <tr><td>弱电工程款</td><td>—</td><td class="right">1</td><td class="right">300,000.00</td><td class="right">¥300000.00</td><td class="right">9%</td><td class="right">¥27000.00</td></tr>
  <tr><td class="k">合计</td><td colspan="4">—</td><td class="right">—</td><td class="right">¥27000.00</td></tr>
</table>
<table style="margin-top:-1px">
  <tr><td class="k">价税合计（大写）</td><td>叁拾贰万柒仟元整</td><td class="k" style="width:20mm">（小写）</td><td class="right total">¥327000.00</td></tr>
</table>
<p style="margin-top:6mm;font-size:9pt;color:#444">
开票人：李文华　　收款人：李文华　　复核：张海燕<br>
销售方（章）：上海鼎信智能科技有限公司发票专用章
</p>
</body></html>`;
}

/** 打印成 PDF */
function printPdf (browser, htmlFile, pdfFile) {
  const url = 'file:///' + htmlFile.replace(/\\/g, '/');
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--disable-sync', '--virtual-time-budget=3000',
    '--print-to-pdf=' + pdfFile, '--no-pdf-header-footer', url,
  ], { stdio: 'ignore', timeout: 120000 });
  if (!fs.existsSync(pdfFile)) throw new Error('没有产出 PDF：' + path.basename(pdfFile));
  return fs.statSync(pdfFile).size;
}

/**
 * 打印成图片（模拟扫描件）。
 *
 * 用 PNG 而不是 JPG：Node 内置没有 JPEG 编码器，而为了一个测试素材去引 sharp
 * 会打破「零依赖」。识别链路对 png/jpg 的处理完全一样（同一套 BitmapDecoder），
 * 所以拿 png 验证「图片走 OCR 而非文字层」没有任何削弱。
 *
 * 加了一点旋转和纸纹：不是为了好看，是为了让 OCR 面对**不完美**的输入。
 * 太干净的渲染图会让识别率虚高，测不出真实扫描件的表现。
 */
function printPng (browser, htmlFile, pngFile, height) {
  const url = 'file:///' + htmlFile.replace(/\\/g, '/');
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=1240,${height}`,
    '--virtual-time-budget=3000',
    '--screenshot=' + pngFile, url,
  ], { stdio: 'ignore', timeout: 120000 });
  if (!fs.existsSync(pngFile)) throw new Error('没有产出图片：' + path.basename(pngFile));
  return fs.statSync(pngFile).size;
}

/**
 * 扫描件版式：把合同正文塞进一张「拍了照的纸」里。
 *
 * 关键：标签和值必须写在**同一行**（合同原件就是这样的）。
 * 第一版我把它做成了两列表格，结果 WinRT OCR 按列读 ——
 * 左边一列标签 "合同名称：项目名称：甲方：…" 全挤在一起，右边一列才是值，
 * 抽取器按「标签后面 16 个字以内找数字」的规则自然一条都抽不到。
 * 那不是素材不好，是版式不真实：真实合同不会把标签和值分成两栏。
 */
function scanHtml () {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #9a9a94; }
  .shot { width: 1200px; height: 1680px; margin: 0; padding: 56px 70px; overflow: hidden;
          background: #fbfaf6;
          background-image: repeating-linear-gradient(0deg, rgba(0,0,0,.022) 0 1px, transparent 1px 3px),
                            repeating-linear-gradient(90deg, rgba(0,0,0,.018) 0 1px, transparent 1px 4px);
          box-shadow: inset 0 0 90px rgba(120,110,90,.30);
          transform: rotate(-0.3deg); }
  .shot * { font-family: "SimSun", serif; color: #171717; }
  h1 { font-size: 42px; text-align: center; letter-spacing: 8px; margin: 4px 0 8px; font-family: "SimHei", sans-serif; }
  h2 { font-size: 24px; text-align: center; font-weight: normal; letter-spacing: 2px; margin: 0 0 30px; }
  .meta { font-size: 23px; line-height: 2.05; }
  .meta div { white-space: nowrap; }
  p { font-size: 21px; line-height: 1.9; margin: 0 0 14px; text-indent: 2em; }
  </style></head><body><div class="shot">
<h1>弱电智能化工程施工合同</h1>
<h2>合同编号：HT-2026-088</h2>
<div class="meta">
  <div>合同名称：市第一人民医院新院区智能化弱电工程施工合同</div>
  <div>项目名称：市第一人民医院新院区智能化弱电工程</div>
  <div>甲方：市第一人民医院</div>
  <div>乙方：上海鼎信智能科技有限公司</div>
  <div>签订日期：2026 年 03 月 05 日</div>
  <div>开工日期：2026 年 03 月 20 日</div>
  <div>竣工日期：2026 年 12 月 31 日</div>
  <div>合同金额：5,860,000.00 元</div>
  <div>付款条款：预付款 30%，进度款按月计量经监理确认后支付 60%，验收合格后支付 7%，余款 3% 作为质保金于质保期满后无息付清。</div>
</div>
<p>根据《中华人民共和国民法典》及有关法律法规，甲乙双方本着平等自愿、诚实信用的原则，
就市第一人民医院新院区智能化弱电工程的施工事宜协商一致，订立本合同。</p>
<p>一、工程范围：综合布线系统、安防监控系统、门禁一卡通系统、机房工程的设备供货、安装、调试及验收。</p>
<p>二、工期：自 2026 年 03 月 20 日开工，至 2026 年 12 月 31 日竣工，总工期 287 日历天。</p>
<p>三、质量标准：符合国家现行施工验收规范，一次性验收合格。</p>
<p>四、本合同一式肆份，甲乙双方各执贰份，自双方盖章之日起生效。</p>
</div></body></html>`;
}

function makeDocs () {
  console.log('文档素材：');
  const browser = findBrowser();
  if (!browser) {
    console.log('  ! 找不到 Edge/Chrome，跳过 pdf/png 生成（可用 PMS_BROWSER 指定路径）');
    return;
  }
  console.log('  浏览器：' + browser);

  const jobs = [
    ['contract.html', contractHtml(), 'contract.pdf', (f) => printPdf(browser, f, path.join(HERE, 'contract.pdf'))],
    ['contract-new.html', contractNewHtml(), 'contract-new.pdf', (f) => printPdf(browser, f, path.join(HERE, 'contract-new.pdf'))],
    ['invoice.html', invoiceHtml(), 'invoice.pdf', (f) => printPdf(browser, f, path.join(HERE, 'invoice.pdf'))],
    ['contract-scan.html', scanHtml(), 'contract-scan.png', (f) => printPng(browser, f, path.join(HERE, 'contract-scan.png'), 1680)],
  ];
  for (const [htmlName, html, outName, fn] of jobs) {
    const htmlFile = path.join(TMP, htmlName);
    fs.writeFileSync(htmlFile, html, 'utf8');
    try {
      const size = fn(htmlFile);
      console.log(`  ✓ ${outName}  ${(size / 1024).toFixed(0)} KB`);
    } catch (e) {
      console.log(`  ✗ ${outName}  ${e.message.split('\n')[0]}`);
    }
  }
}

// ============================================================
function main () {
  fs.mkdirSync(TMP, { recursive: true });
  makeTables();
  makeDocs();
  console.log('\n完成。这些文件要提交进仓库（都是合成数据，不含真实客户信息）。');
}
main();
