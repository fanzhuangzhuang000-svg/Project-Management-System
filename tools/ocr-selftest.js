'use strict';
/**
 * 识别流水线自检： node tools/ocr-selftest.js <文件1> [文件2] ...
 * 打印识别耗时、抽取到的字段、命中原文片段和校验提示，便于人工核对识别质量。
 */
const path = require('node:path');
const { recognize, isSupported } = require('./ocr.js');

const money = v => (v === null || v === undefined) ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LABELS = {
  invoice_no: '发票号码', issue_date: '开票日期', amount: '金额(不含税)', tax_rate: '税率(%)',
  tax_amount: '税额', total_amount: '价税合计', invoice_type: '发票种类',
  code: '合同编号', name: '名称', sign_date: '签订日期', start_date: '开始日期',
  end_date: '结束日期', payment_terms: '付款条款', location: '地点',
};
const MONEY_FIELDS = new Set(['amount', 'tax_amount', 'total_amount']);

(async function main () {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('用法: node tools/ocr-selftest.js <文件> [...]');
    process.exit(1);
  }
  let bad = 0;
  for (const f of files) {
    const abs = path.resolve(f);
    console.log('\n' + '='.repeat(72));
    console.log('文件: ' + abs);
    if (!isSupported(abs)) { console.log('  不支持的文件类型'); bad++; continue; }
    const t0 = Date.now();
    let r;
    try { r = await recognize(abs); } catch (e) { console.log('  异常: ' + e.message); bad++; continue; }
    const total = Date.now() - t0;
    if (!r.ok) { console.log('  识别失败: ' + r.error); bad++; continue; }

    console.log(`  类型: ${r.kind}   置信度: ${r.confidence}% (${r.fieldCount}/${r.expectedCount} 个字段)   引擎: ${r.engine}`);
    console.log(`  耗时: OCR ${r.elapsedMs}ms / 合计 ${total}ms   页数: ${r.pages.length}`);
    console.log('\n  ── 抽取到的字段 ──');
    for (const [k, v] of Object.entries(r.fields)) {
      if (k.endsWith('_value')) continue;
      const label = (k === 'amount')
        ? (r.kind === 'invoice' ? '金额(不含税)' : '合同金额(含税)')
        : (LABELS[k] || k);
      const val = MONEY_FIELDS.has(k) ? money(v) : v;
      const hit = r.hits[k] ? `   ← 「${String(r.hits[k]).replace(/\n/g, ' ').slice(0, 46)}」` : '';
      console.log(`    ${label.padEnd(12, '　')} ${String(val).slice(0, 60)}${hit}`);
    }
    if (r.hints && Object.keys(r.hints).length) {
      console.log('\n  ── 关联线索 ──');
      for (const [k, v] of Object.entries(r.hints)) console.log(`    ${k}: ${String(v).slice(0, 70)}`);
    }
    if (r.parties.length) {
      console.log('\n  ── 甲乙方/购销方 ──');
      r.parties.forEach(p => console.log(`    ${p.label}: ${p.name}`));
    }
    if (r.checks.length) {
      console.log('\n  ── 校验提示 ──');
      r.checks.forEach(c => console.log(`    [${c.level === 'warn' ? '注意' : '提示'}] ${c.text}`));
    }
    console.log('\n  ── 规范化后文本 ──');
    r.normalized.split('\n').slice(0, 24).forEach(l => console.log('    | ' + l));
  }
  console.log('\n' + '='.repeat(72));
  process.exit(bad ? 1 : 0);
})();
