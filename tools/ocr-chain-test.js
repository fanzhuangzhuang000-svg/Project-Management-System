'use strict';
/**
 * 附件识别链路测试：上传扫描件 → OCR → 用识别结果新建记录 → 扫描件自动归位
 * 用法： node tools/ocr-chain-test.js [http://127.0.0.1:8787]
 */
const fs = require('node:fs');
const path = require('node:path');
const T = require('./test-auth.js');
const BASE = process.argv[2] || T.BASE || 'http://127.0.0.1:8787';

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

T.forceAdminPassword();

(async () => {
  const tk = await T.login();
  const H = { Cookie: 'pms_session=' + tk, 'Content-Type': 'application/json' };
  const get = u => fetch(BASE + u, { headers: H }).then(r => r.json());
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b || {}) }).then(r => r.json());

  const madeContracts = [];
  let attId = null;

  try {
    // ---------- 1. 上传扫描件 ----------
    console.log('[1] 上传扫描件');
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'contract.pdf'));
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/pdf' }), 'OCRTEST-合同扫描件.pdf');
    const up = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: H.Cookie }, body: fd }).then(r => r.json());
    check('扫描件上传成功', up.ok === true, up.error || `id=${up.attachment?.id}`);
    if (!up.ok) throw new Error(up.error || '上传失败');
    attId = up.attachment.id;
    check('上传后自动进入识别队列', ['pending', 'running', 'done'].includes(up.attachment.ocr_status),
      '状态=' + up.attachment.ocr_status);
    check('未指定表名时是暂存附件（不挂记录）', up.attachment.record_id === null, 'record_id=' + up.attachment.record_id);

    // ---------- 2. 等 OCR ----------
    console.log('[2] OCR 识别');
    let att = null;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const list = await get('/api/attachments?q=OCRTEST-');
      att = (list.rows || []).find(a => a.id === attId);
      if (att && (att.ocr_status === 'done' || att.ocr_status === 'failed')) break;
    }
    check('识别完成', att?.ocr_status === 'done', '状态=' + att?.ocr_status);
    check('判断出文件类型是合同', att?.ocr_kind === 'contract', '类型=' + att?.ocr_kind);

    const f = att?.ocr?.fields || {};
    check('抽到结构化字段', Object.keys(f).length >= 5, Object.keys(f).length + ' 个：' + Object.keys(f).join(','));
    check('合同编号识别正确', f.code === 'HT-2026-088', 'code=' + f.code);
    check('合同金额识别正确', Number(f.amount) === 5860000, 'amount=' + f.amount);
    check('签订日期识别正确', String(f.sign_date) === '2026-03-05', 'sign_date=' + f.sign_date);
    check('付款条款识别到', /预付款\s*30%/.test(String(f.payment_terms || '')), String(f.payment_terms || '').slice(0, 30) + '…');

    const parties = att?.ocr?.parties || [];
    check('识别出甲乙方', parties.length >= 2, parties.map(p => `${p.label}:${p.name}`).join(' / '));
    check('已存在的单位被自动匹配', parties.some(p => p.match), parties.filter(p => p.match).map(p => p.name).join('、') || '无');

    // 匹配逻辑：识别出的甲方要能对上「市第一人民医院」
    // 注意 party.match 是一个对象 { id, name, type, score }，不是 id
    const matched = parties.find(p => p.match);
    const partnerRow = matched?.match?.id ? await get(`/api/get/partners/${matched.match.id}`) : null
    check('匹配到的单位确实是同一家', !!partnerRow && partnerRow.name.includes('第一人民医院'),
      partnerRow ? `→ #${partnerRow.id} ${partnerRow.name}（相似度 ${matched.match.score ?? '—'}）` : '未匹配')

    // ---------- 3. 用识别结果新建记录 ----------
    console.log('[3] 用识别结果新建记录');
    const suggest = att?.ocr?.suggest || {};
    check('给出了可直接采用的建议（方向/甲方/项目）',
      !!(suggest.direction && suggest.partner_id && suggest.project_id),
      `direction=${suggest.direction} partner=${suggest.partner_id} project=${suggest.project_id}`);

    // 模拟前端「新建合同并填入」：preset = 识别字段 + 建议
    const preset = { ...f };
    for (const k of Object.keys(preset)) if (k.endsWith('_value')) delete preset[k];
    Object.assign(preset, {
      direction: suggest.direction,
      partner_id: suggest.partner_id,
      project_id: suggest.project_id,
      name: 'OCRTEST-识别带入的合同',
    });
    const saved = await post('/api/save/contracts', { ...preset, __attach_ids: [attId] });
    check('按识别结果保存成功', !saved.error && !!saved.id, saved.error || `id=${saved.id}`);
    if (saved.error) throw new Error(saved.error);
    madeContracts.push(saved.id);

    check('编号正确写入', saved.row.code === 'HT-2026-088', 'code=' + saved.row.code);
    check('金额正确写入', Number(saved.row.amount) === 5860000, 'amount=' + saved.row.amount);
    check('付款条款正确写入', /预付款/.test(String(saved.row.payment_terms || '')), '已写入');
    check('所属项目按建议写入', String(saved.row.project_id) === String(suggest.project_id),
      `project_id=${saved.row.project_id}`);
    check('对方单位按建议写入', String(saved.row.partner_id) === String(suggest.partner_id),
      `partner_id=${saved.row.partner_id}`);

    // ---------- 4. 扫描件自动归位 ----------
    console.log('[4] 扫描件自动归位');
    const linked = await get(`/api/record-attachments/contracts/${saved.id}`);
    check('扫描件已挂到新合同上', (linked.rows || []).some(a => a.id === attId),
      (linked.rows || []).map(a => a.original_name).join('、') || '（无）');
    const after = await get(`/api/get/attachments/${attId}`).catch(() => null);
    const attRow = (await get('/api/attachments?q=OCRTEST-')).rows?.[0];
    check('附件上记录了归属', attRow && attRow.table_name === 'contracts' && attRow.record_id === saved.id,
      `table=${attRow?.table_name} record=${attRow?.record_id}`);
    check('附件不再是暂存状态', attRow && attRow.detached !== 1, 'detached=' + attRow?.detached);

    // ---------- 5. 项目名自动关联 ----------
    console.log('[5] 项目线索');
    const hint = att?.ocr?.hints?.project_name;
    check('识别到项目名线索', !!hint, hint || '无');
    const proj = await get('/api/list/projects?q=' + encodeURIComponent(hint || ''));
    const first = (proj.rows || [])[0];
    check('线索能在项目库里找到对应项目', !!first,
      first ? `#${first.id} ${first.name}` : '没找到');
        // ---- 数字生成的 PDF 走文字层，扫描件才走 OCR ----
        {
          const { recognize } = require("./ocr.js");
          const nodePath = require("node:path");
          const fx = (n) => nodePath.join(__dirname, "fixtures", n);

          const digital = await recognize(fx("invoice.pdf"), { docKind: "auto" });
          check("数字生成的 PDF 走文字层（不 OCR）", digital.engine === "pdf-text", "引擎=" + digital.engine);
          check("文字层直接读到发票种类（不靠税率反推）",
            digital.fields.invoice_type === "增值税专用发票", String(digital.fields.invoice_type));
          check("文字层金额精确", Math.abs(digital.fields.total_amount - 327000) < 0.01,
            String(digital.fields.total_amount));
          check("文字层路径明显更快", digital.elapsedMs < 900, digital.elapsedMs + "ms（OCR 约 2000ms）");

          const scan = await recognize(fx("contract-scan.jpg"), { docKind: "auto" });
          check("扫描图片照旧走 OCR（没被文字层抢走）", scan.engine !== "pdf-text", "引擎=" + scan.engine);
          check("扫描件仍能识别出合同金额", scan.ok && Number(scan.fields.amount) === 5860000,
            "金额=" + scan.fields.amount);
        }

  } catch (e) {
    check('链路测试', false, e.message.slice(0, 70));
  } finally {
    // 清理
    for (const id of madeContracts) await post('/api/delete/contracts/' + id, { cascade: true }).catch(() => {});
    if (attId) await post('/api/attachments/' + attId + '/delete', {}).catch(() => {});
    await post('/api/trash/purge-all', {}).catch(() => {});
  }

  const pass = results.filter(r => r.ok).length;
  console.log(`\n识别链路测试结果：${pass} / ${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('[测试异常]', e.message); process.exit(1); });
