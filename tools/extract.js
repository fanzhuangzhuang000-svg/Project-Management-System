'use strict';
/**
 * 识别结果后处理：文本规范化 + 合同/发票关键字段抽取
 *
 * Windows OCR 对中文的原始输出有三类系统性噪声，必须先清洗：
 *   1. 汉字之间被插入空格："发 票 号 码" → "发票号码"
 *   2. 标点被识成形近字/全角符号："HT一2026一088" / "300000 · 00" / "9 ％"
 *   3. 数字被识成字母："MA2XXXXXOK"(0→O)、"MBIA2B3C4D"(1→I)
 * 清洗后再用"标签+数值"的方式抽字段，并对金额做双口径交叉校验。
 */

// ---------------- 字符表 ----------------
const CN_DIGIT = {
  // 键名一律加引号：〇/○ 等字符不是合法的 JS 标识符字符
  '零': 0, '〇': 0, '○': 0, '一': 1, '壹': 1, '二': 2, '贰': 2, '两': 2,
  '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6,
  '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9,
};
const CN_UNIT = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_SECTION = { 万: 1e4, 亿: 1e8 };

/**
 * 解析中文大写/小写金额，例如 伍佰捌拾陆万元整 → 5860000
 * 无法完整解析时返回 null（绝不猜测）
 */
function parseChineseAmount (input) {
  let s = String(input || '').replace(/[人民币RMB\s]/gi, '').replace(/[整正]$/, '');
  if (!s) return null;
  let total = 0, section = 0, number = 0, sawAny = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) { number = CN_DIGIT[ch]; sawAny = true; }
    else if (ch in CN_UNIT) { section += (number || 1) * CN_UNIT[ch]; number = 0; sawAny = true; }
    else if (ch in CN_SECTION) { total += (section + number) * CN_SECTION[ch]; section = 0; number = 0; sawAny = true; }
    else if (ch === '元' || ch === '圆') { total += section + number; section = 0; number = 0; }
    else if (ch === '角') { total += (section + number) * 0.1; section = 0; number = 0; }
    else if (ch === '分') { total += (section + number) * 0.01; section = 0; number = 0; }
    else if (ch === '零' || ch === '〇') { /* 占位，忽略 */ }
    else return null;                       // 出现无法识别的字，判定失败
  }
  if (!sawAny) return null;
  const v = total + section + number;
  return v > 0 ? Math.round(v * 100) / 100 : null;
}

/**
 * 解析金额字符串。兼容 OCR 常见的分隔符混淆：
 *   "5,860,000.00" / "5，860000．00" / "5.860.000" / "300000.00"
 * 规则：最后一段长度为 1~2 位 → 小数点；否则所有分隔符都当千分位。
 */
function parseMoney (input) {
  let s = String(input == null ? '' : input).replace(/[^\d.,]/g, '');
  if (!s) return null;
  // 一个数里最多只能有「一个分隔符」或「规范的千分位」。
  // OCR 常把两个数字粘在一起（如单价 1.007262 和下一段 805309734514 连成
  // 「1.007262.805309734514」），以前会把非数字全删掉拼成一个十九位整数，
  // 结果 88194.34 的发票被算成 1e18。这里直接判为无效。
  const seps = s.match(/[.,]/g) || [];
  if (seps.length > 1) {
    const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    const head = s.slice(0, lastSep);
    const tail = s.slice(lastSep + 1);
    const groups = head.split(/[.,]/);
    // 情况一：规范的千分位 —— 1,234,567.89
    const okThousands = groups[0].length >= 1 && groups[0].length <= 3
      && groups.slice(1).every(g => g.length === 3);
    if (okThousands && tail.length <= 2) return sane(Number(groups.join('') + '.' + tail));
    // 情况二：千分位不规范，但「小数部分」明确（末段 1~2 位）。
    // OCR 常把 5,860,000.00 读成 5,860000.00（少一个逗号），这种要救回来：
    // 末段就是分位，前面那些分隔符当噪声去掉。
    // 注意不能反过来把 1.007262.805309734514 这种当成金额 ——
    // 它的末段有 12 位，不是分位，会在下面被拒掉。
    if (tail.length >= 1 && tail.length <= 2 && groups.every(g => g.length > 0)) {
      return sane(Number(groups.join('') + '.' + tail));
    }
    // 末段超过 2 位：是 OCR 把两个数字粘在了一起，拒绝
    return null;
  }
  if (!/[.,]/.test(s)) return sane(Number(s));
  const parts = s.split(/[.,]/).filter(p => p !== '');
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  let v;
  if (last.length <= 2 && parts.length > 1) {
    v = Number(parts.slice(0, -1).join('') + '.' + last);
  } else {
    v = Number(parts.join(''));
  }
  return sane(v);
}

/** 金额上限兜底：一张发票/一份合同不可能到万亿。
 *  超过就说明是 OCR 粘连或识别错误，宁可返回空让用户手填。 */
const MONEY_CAP = 1e12;
function sane (v) {
  if (!Number.isFinite(v) || v < 0) return null;
  if (v > MONEY_CAP) return null;
  return v;
}

// ---------------- 文本规范化 ----------------
const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff';
const reCJK = new RegExp(`[${CJK}]`);

/** 数字 token 内的字母→数字纠正（仅在疑似数字串上做，避免误伤正文） */
function fixDigits (token) {
  return token
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8')
    .replace(/[Zz]/g, '2')
    .replace(/[gq]/g, '9');
}

function normalizeLine (raw) {
  let s = String(raw);
  // 1) 全角数字/字母 → 半角
  s = s.replace(/[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g,
    c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 2) 全角标点与形近符号
  s = s.replace(/[％﹪]/g, '%')
    .replace(/[．。｡]/g, '.')
    .replace(/[（〔【]/g, '(').replace(/[）〕】]/g, ')')
    .replace(/[：﹕]/g, ':').replace(/[；;]/g, ';')
    .replace(/[，､]/g, ',')
    .replace(/[·・•∙･˙]/g, '.')
    .replace(/[－—–―]/g, '-')
      // OCR 常把连字符识别成汉字「一」（形近）：SJ 一 CL 一 202603 → SJ-CL-202603
      // 只在「数字/字母 一 数字/字母」之间替换，避免误伤「一站式」「一卡通」这类正常词
      .replace(/(?<=[A-Za-z0-9])\s*一\s*(?=[A-Za-z0-9])/g, '-')
      .replace(/(?<=[A-Za-z0-9])\s*[一二三]\s*(?=[A-Za-z0-9])/g, '-')
    .replace(/￥/g, '¥');
  // 3) 去掉汉字之间的空格（Windows OCR 的典型噪声）
  s = s.replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1');
  // 4) 汉字与数字之间的空格
  s = s.replace(new RegExp(`([${CJK}])[ \\t]+(?=[0-9])`, 'g'), '$1');
  s = s.replace(new RegExp(`([0-9])[ \\t]+(?=[${CJK}])`, 'g'), '$1');
  // 5) 数字内部被拆开的空格："1 5" → "15"，"5 , 860" → "5,860"
  s = s.replace(/([0-9])[ \t]+(?=[0-9])/g, '$1');
  s = s.replace(/([0-9])[ \t]*([.,])[ \t]*(?=[0-9])/g, '$1$2');
  // 6) 数字 token 内的字母纠正
  s = s.replace(/[0-9OoIlSsBbZz|][0-9OoIlSsBbZz|.]{3,}/g, m => (/[0-9]/.test(m) ? fixDigits(m) : m));
  return s.replace(/[ \t]+/g, ' ').trim();
}

function normalize (rawText) {
  const lines = String(rawText || '').split(/\r?\n/).map(normalizeLine).filter(l => l !== '');
  return lines.join('\n');
}

/** 压掉所有空白，用于标签匹配（中文标签常被空格切开） */
function compactOf (normalized) {
  return normalized.split('\n').map(l => l.replace(/\s+/g, '')).join('\n');
}

// ---------------- 通用取值 ----------------
const toFixed2 = v => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function pickDate (text, label) {
  // 电子发票的 OCR 是按列读的，标签和值可能隔好几行：
  //   开票日期 ：
  //   26312000006153870301
  //   2026 年 09 月 28 日     ← 值在这里
  // 所以先定位标签，再在它后面一小段窗口里找第一个日期。
  const idx = text.indexOf(label);
  const win = idx >= 0 ? text.slice(idx, idx + 90) : text;
  const a = win.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  const b = win.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const m = a || b;
  if (m) return { value: iso(m[1], m[2], m[3]), hit: label + m[0] };
  return null;
}

/** 归一化编号：把 OCR 常见的 "HT.2026.088" / "HT一2026一088" / "HT -2026-088" 统一成 "HT-2026-088" */
function cleanCode (s) {
  return String(s)
    .replace(/[一—–―－ー]/g, '-')          // 汉字"一"与各类破折号常被识成连字符
    .replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase();
}

// ---------------- 发票抽取 ----------------
const INVOICE_TYPES = [
  [/增值税电子专用发票|电子专用发票|全电.*专用/, '增值税专用发票'],
  [/增值税专用发票/, '增值税专用发票'],
  [/增值税电子普通发票|电子普通发票/, '电子普票'],
  [/增值税普通发票/, '增值税普通发票'],
];

/** 按税率反推发票种类：OCR 经常把「专用/普通」认不出来，但税率一般认得出 */
const TAX_TO_INVOICE_TYPE = {
  13: '增值税专用发票',
  9: '工程类增值税专用发票',
  6: '劳务发票',
  3: '普票',
};

function detectKind (compact) {
  const inv = /发票号码|价税合计|开票日期|销售方|购买方|税率|税额/.test(compact);
  const con = /合同编号|合同名称|甲方|乙方|发包方|承包方|签订日期|合同金额/.test(compact);
  if (inv && !con) return 'invoice';
  if (con && !inv) return 'contract';
  if (inv && con) {
    // 发票里出现"购买方/销售方"更可信；合同里出现"甲方/乙方"更可信
    const invScore = (/价税合计|发票号码|开票日期/.test(compact) ? 3 : 0) + (/销售方|购买方/.test(compact) ? 1 : 0);
    const conScore = (/合同编号|合同名称/.test(compact) ? 3 : 0) + (/甲方|乙方|发包方|承包方/.test(compact) ? 1 : 0);
    return invScore >= conScore ? 'invoice' : 'contract';
  }
  return 'unknown';
}

function extractInvoice (compact, normalized) {
  const fields = {};
  const hits = {};
  const checks = [];
  const parties = [];
  const hints = {};

  // 发票号码（数电票 20 位，老电子票 8 位，纸质票 8 位）
  //
  // 电子发票的 OCR 是按"列"读的，标签和值经常隔好几行：
  //   发票号码 ：
  //   开票日期 ：
  //   26312000006153870301      ← 值在这里
  // 所以不能要求数字紧跟标签，允许中间夹一小段非数字。
  let m = compact.match(/发票号码[^0-9]{0,24}([0-9]{8,25})/)
    || compact.match(/发票号码[:：]?([0-9]{8,25})/)
    || compact.match(/发票代码[^0-9]{0,12}([0-9]{10,12})/);
  if (m) { fields.invoice_no = m[1]; hits.invoice_no = m[0]; }

  // 开票日期：同样允许标签和日期之间隔着别的字段
  const d = pickDate(compact, '开票日期') || pickDate(compact, '开具日期');
  if (d) { fields.issue_date = d.value; hits.issue_date = d.hit; }

  // 发票种类
  for (const [re, name] of INVOICE_TYPES) { if (re.test(compact)) { fields.invoice_type = name; break; } }

  // 税率
  const rate = compact.match(/(\d{1,2}(?:\.\d{1,2})?)\s*%/);
  if (rate) {
    const r = Number(rate[1]);
    if (r > 0 && r <= 30) { fields.tax_rate = r; hits.tax_rate = rate[0]; }
  }

  // OCR 认不出专/普时，按税率反推。
  // OCR 常把「（增值税专用发票）」拆成「电 子 发 票 / 用 发 票 ）」，
  // 开头的「专/普」两个字会丢，但税率一般认得出。
  // 13% = 专票，9% = 工程类专票，6% = 劳务发票，3% = 普票。
  if (!fields.invoice_type && fields.tax_rate !== undefined) {
    const inferred = TAX_TO_INVOICE_TYPE[fields.tax_rate];
    if (inferred) {
      fields.invoice_type = inferred;
      hits.invoice_type = `按税率 ${fields.tax_rate}% 反推`;
    }
  }

  // 还是没认出来就留空，让用户选
  if (!fields.invoice_type) {
    checks.push({
      level: 'warn',
      text: '这张票的「专票」还是「普票」OCR 认不出来（开头的字经常被吃掉了），请手工选。',
    });
  }

  // 价税合计（小写）
  //
  // 以前是「价税合计 + 40 个任意字符 + 第一个数字」，但电子发票的版式是
  //   价税合计(大写) … 单价 1.007262… 金额列 … 税额列 … ¥ 88194.34
  // 于是它抓到了「单价」那一列，把发票金额算成了 1e18。
  //
  // 现在换个可靠的判据：价税合计 = 金额合计 + 税额合计，一定是票面上最大的那个 ¥ 金额。
  let total = null;
  {
    const all = [];
    const re = /[¥￥]\s*([0-9][0-9.,]*)/g;
    let mm;
    while ((mm = re.exec(compact)) !== null) {
      const v = parseMoney(mm[1]);
      if (v !== null && v > 0) all.push({ v, raw: mm[0], at: mm.index });
    }
    if (all.length) {
      all.sort((x, y) => y.v - x.v);
      total = all[0].v;
      hits.total_amount = all[0].raw;
      // 金额合计（不含税）＝比价税合计小的里面最大的那个
      const less = all.filter(x => x.v < total - 0.005);
      if (less.length) hits.table_sum = less[0].raw;
      // 税额合计＝比金额合计还小的里面最大的那个
      if (less.length) {
        const tail = all.filter(x => x.v < less[0].v - 0.005);
        if (tail.length) hits.table_tax = tail[0].raw;
      }
    }
  }
  // 兜底：整张票一个 ¥ 都没有时，退回按关键词找
  if (total === null) {
    m = compact.match(/价税合计[^0-9]{0,12}?\(?小写\)?[）)]?[¥￥]?([0-9][0-9.,]{2,})/)
      || compact.match(/\(小写\)[）)]?[¥￥]?([0-9][0-9.,]{2,})/);
    if (m) { total = parseMoney(m[1]); if (total) hits.total_amount = m[0]; }
  }

  // 价税合计大写 → 交叉校验
  let totalUpper = null;
  m = compact.match(/价税合计\(?大写\)?[:：]?([\u4e00-\u9fff]{2,30}?整)/)
    || compact.match(/\(大写\)[:：]?([\u4e00-\u9fff]{2,30}?整)/);
  if (m) { totalUpper = parseChineseAmount(m[1]); if (totalUpper) hits.amount_in_words = m[0]; }

  if (total && totalUpper && Math.abs(total - totalUpper) > 0.5) {
    checks.push({ level: 'warn', text: `价税合计小写 ¥${total} 与大写「${m[1]}」折算的 ¥${totalUpper} 不一致，请人工核对` });
  }

  // 合计行：金额 + 税额（取第一个"合计"，排除"价税合计"）
  let tableAmount = null, tableTax = null;
  m = compact.match(/(?<!价税)合计[¥￥]?([0-9][0-9.,]*)[^0-9¥￥]{0,12}[¥￥]?([0-9][0-9.,]*)/);
  if (m) {
    const a = parseMoney(m[1]), b = parseMoney(m[2]);
    if (a !== null && b !== null && a >= b) { tableAmount = a; tableTax = b; hits.table_sum = m[0]; }
  }
  // 单列税额
  const taxOnly = compact.match(/税额[:：]?[¥￥]?([0-9][0-9.,]*)/);
  if (taxOnly) { const v = parseMoney(taxOnly[1]); if (v && v > 0) tableTax = tableTax || v; }

  if (total) {
    const ratePct = fields.tax_rate === undefined ? 9 : fields.tax_rate;
    const amount = toFixed2(total / (1 + ratePct / 100));
    fields.total_amount = toFixed2(total);
    fields.amount = amount;
    fields.tax_amount = toFixed2(total - amount);
    if (tableAmount !== null && Math.abs(tableAmount - amount) > 1) {
      checks.push({ level: 'info', text: `票面合计金额 ¥${tableAmount} 与按价税合计反推的不含税金额 ¥${amount} 有差异，可能是多行明细，请核对` });
    }
    if (tableTax !== null && Math.abs(tableTax - fields.tax_amount) > 1) {
      checks.push({ level: 'info', text: `票面税额 ¥${tableTax} 与反推税额 ¥${fields.tax_amount} 有差异` });
    }
    if (fields.tax_rate === undefined) {
      checks.push({ level: 'warn', text: '未识别到税率，已按 9% 估算不含税金额，请务必核对' });
    }
  } else if (tableAmount !== null) {
    fields.amount = toFixed2(tableAmount);
    fields.tax_amount = toFixed2(tableTax || 0);
    fields.total_amount = toFixed2(tableAmount + (tableTax || 0));
    checks.push({ level: 'warn', text: '未识别到价税合计，金额取自票面「合计」行，请务必核对' });
  }

  if (totalUpper) fields.amount_in_words_value = totalUpper;

  // 购销双方。
  // OCR 常把「购买方名称」截成「购名称」、「销售方名称」截成「销名称」，
  // 只认完整标签会一个都抽不到，所以补齐缺字形式。
  //
  // 还有个更隐蔽的坑（线上真实票据复现）：发票抬头是**左右两栏并排**的，
  // PDF 文字层和 OCR 都会把同一行的两栏拼成一条：
  //   购 名称：上海索杰电子信息系统有限公司 销 名称：上海颤维电子科技有限公司
  // 而归一化会删掉汉字之间的空格（那是为了修「发 票 号 码」的噪声），
  // 两栏就彻底连成一片。于是「购买方名称」把销售方的标签和名字整段吞进来，
  // 得到一个 31 字的假公司名 —— 靠长度截断救不了，必须在**下一个字段标签**处截断。
  //
  // 分强弱两档：强档不可能是公司名的一部分，直接截；弱档（地址/电话/开户行…）
  // 可能真的出现在公司名里（「上海电话设备厂」），只有后面跟着冒号才算标签。
  const NAME_STOP_STRONG = /(?:购|销)(?:买|售)?\s*方?\s*名\s*称|统\s*一\s*社\s*会|纳\s*税\s*人\s*识\s*别\s*号|(?:购|销)(?:买|售)\s*方\s*信\s*息|价\s*税\s*合\s*计|开\s*票\s*人/;
  const NAME_STOP_WEAK = /(?:地\s*址|电\s*话|开\s*户\s*行|银\s*行\s*账\s*号|账\s*号|项\s*目\s*名\s*称|货\s*物\s*或\s*应\s*税|规\s*格\s*型\s*号|备\s*注)[:：]/;
  const cutName = (raw) => {
    let s = String(raw);
    let cut = s.length;
    for (const re of [/[（(]/, NAME_STOP_STRONG, NAME_STOP_WEAK]) {
      const mm = s.match(re);
      if (mm && mm.index < cut) cut = mm.index;
    }
    return s.slice(0, cut).replace(/[\s:：,，、;；-]+$/, '').trim();
  };
  const grab = (...res) => {
    for (const re of res) {
      const mm = compact.match(re);
      if (!mm) continue;
      // 标签找到了就认这个标签，值被截空也**只**返回空 ——
      // 不能退到更松的规则去再抓一次：那会从「购买方名称：销名称：上海B公司」
      // 里抓出「名称」这种垃圾当公司名。宁可空手让用户自己填。
      const s = cutName(mm[1]);
      return s.length >= 2 ? s : null;
    }
    return null;
  };
  const buyer = grab(/购买方[^名]{0,4}名称[:：]?([^\n]{2,40})/,
    /(?:购买方|购)\s*名\s*称[:：]?([^\n]{2,40})/,
    /购\s*买\s*方[:：]?([^\n]{2,40})/);
  const seller = grab(/销售方[^名]{0,4}名称[:：]?([^\n]{2,40})/,
    /(?:销售方|销)\s*名\s*称[:：]?([^\n]{2,40})/,
    /销\s*售\s*方[:：]?([^\n]{2,40})/);
  if (buyer) parties.push({ role: 'buyer', label: '购买方', name: buyer });
  if (seller) parties.push({ role: 'seller', label: '销售方', name: seller });

  // 纳税人识别号（仅作展示核对）
  const taxNos = [...compact.matchAll(/(?:纳税人识别号|统一社会信用代码)[:：]?([0-9A-Z]{15,20})/g)].map(x => x[1]);
  if (taxNos.length) hits.tax_nos = taxNos.join(' / ');

  // 备注常写着工程名称，可作为匹配已有项目的线索
  m = compact.match(/备注[:：]?([^\n]{4,80})/);
  if (m) { hints.remark = m[1].trim(); hints.project_text = m[1].trim(); }

  return { fields, hits, checks, parties, hints };
}

// ---------------- 合同抽取 ----------------
function extractContract (compact, normalized) {
  const fields = {};
  const hits = {};
  const checks = [];
  const parties = [];
  const hints = {};

  // 合同编号（允许 OCR 把连字符识成"一"或空格）
  let m = compact.match(/(?:合同编号|合同号|协议编号|合同编码|编号)[:：]?\s*([0-9A-Za-z][0-9A-Za-z\-_.\/一\s]{2,40})/);
  if (m) {
    const code = cleanCode(m[1]);
    // 排除误抓的纯日期
    if (code.length >= 4 && !/^\d{8}$/.test(code) && !/^\d{4}-\d{2}-\d{2}$/.test(code)) {
      fields.code = code; hits.code = m[0].trim();
    }
  }

  // 文档标题（首行含"合同/协议"）
  const docTitle = normalized.split('\n').map(s => s.trim())
    .find(l => l.length >= 6 && l.length <= 40 && /合同|协议/.test(l) && !/编号|甲方|乙方|盖章/.test(l)) || null;
  if (docTitle) hints.doc_title = docTitle;

  // 合同名称优先级：合同名称标签 > 项目名称标签 > 文档标题
  let nm = compact.match(/合同名称[:：]?([^\n]{4,60})/);
  if (nm) { fields.name = nm[1].replace(/[（(].*$/, '').trim(); hits.name = nm[0].slice(0, 60); }
  let pm = compact.match(/(?:项目名称|工程名称)[:：]?([^\n]{4,60})/);
  if (pm) { hints.project_name = pm[1].replace(/[（(].*$/, '').trim(); }
  if (!fields.name) {
    fields.name = hints.project_name || docTitle || null;
    if (fields.name) hits.name = fields.name;
  }

  // 合同自己的名字：标题区里那行短短的「XX 合同」（材料采购合同 / 安装合同 / 施工合同…）。
  // 没有这条时上面会退化成「项目名称」—— 抽出来的是项目名不是合同名；
  // docTitle 又常取到「11. 合同变更」这种章节标题，两者都要靠这条纠正。
  {
    const head = String(normalized || '').split('\n').slice(0, 24);
    const cand = head
      .map(l => l.trim())
      .find(s => /^[\u4e00-\u9fffA-Za-z0-9（）()·、]{2,26}合同$/.test(s)
        && !/^\d+\s*[.、]/.test(s)                 // 排除「11. 合同变更」这类章节
        && !/变更|解除|违约|争议|补充协议/.test(s));
    const looksWrong = !fields.name
      || /^\d+\s*[.、]/.test(fields.name)
      || fields.name === hints.project_name
      || fields.name.length > 24;
    if (cand && looksWrong) { fields.name = cand; hits.name = cand; }
  }

  // 甲乙方
  const grabParty = (re) => {
    const mm = compact.match(re);
    if (!mm) return null;
    let v = mm[1];
    v = v.replace(/^[（(][^)）]*[)）]/, '').replace(/[:：]/g, '').trim();
    v = v.replace(/[（(].*$/, '').replace(/[，,。;；].*$/, '').trim();
    return v.length >= 2 && v.length <= 40 ? v : null;
  };
  const a = grabParty(/(?:甲方|发包方|采购方|需方|买方)[（(]?[^)）]{0,8}[)）]?[:：]?([^\n]{2,40})/);
  const b = grabParty(/(?:乙方|承包方|分包方|供货方|供方|卖方)[（(]?[^)）]{0,8}[)）]?[:：]?([^\n]{2,40})/);
  if (a) parties.push({ role: 'party_a', label: '甲方', name: a });
  if (b) parties.push({ role: 'party_b', label: '乙方', name: b });

  // 金额：数值口径
  //
  // 以前是「关键词 + 24 个任意字符 + 数字」，结果把章节序号当成了金额：
  //   「合同价、范围与服务说明:1.合同价款」→ 抽出 1 元。
  // 现在改成「必须像钱」：要求数字够长/带小数，或者后面跟着「元 / 元整 / 万元」，
  // 并且排除「数字 + . + 汉字」这种列表编号。
  let amount = null;
  const AMT_RE = /(?:合同总金额|合同金额|合同总价|合同价款|总金额|价款|合同价)[^0-9¥￥]{0,16}[¥￥]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(万元|万|元整|元)?/g;
  {
    let best = null;
    let mm;
    while ((mm = AMT_RE.exec(compact)) !== null) {
      const raw = mm[1];
      const unit = mm[2] || '';
      // 数字紧跟着「.汉字」的是列表编号，不是金额
      const after = compact.slice(mm.index + mm[0].length, mm.index + mm[0].length + 1);
      if (!unit && /^[.．]/.test(after)) continue;
      const val = parseMoney(raw);
      if (!val) continue;
      const hasUnit = !!unit;
      const strongKw = /合同总金额|合同金额|合同总价|总金额/.test(mm[0]);
      const looksLikeMoney = hasUnit || /[,]/.test(raw) || /\./.test(raw) || raw.replace(/[^0-9]/g, '').length >= 4;
      if (!looksLikeMoney) continue;
      // 金额下限：只有「合同总金额 / 合同金额 / 总金额」这类强关键词才认，且要 1 万以上。
      // 光出现「价款」后面跟个 8000，基本都是条款编号而不是钱，宁可留空让用户手填。
      const inWan = unit === '万元' || unit === '万';
      const floor = strongKw ? 10000 : 100000;
      if (!inWan && val < floor) continue;
      const score = (hasUnit ? 10 : 0) + (strongKw ? 5 : 0) + Math.min(4, raw.length);
      if (!best || score > best.score) best = { val: inWan ? val * 10000 : val, raw: mm[0], score };
    }
    if (best) { amount = best.val; hits.amount = best.raw.trim(); }
  }

  // 金额：大写口径。OCR 常把大写金额糊成「县百另丨口力」这类乱码，
  // 解析不出或者明显不合理就不要，免得带一堆垃圾进表单。
  let amountUpper = null;
  let upperRaw = '';
  m = compact.match(/(?:大写|金额大写|人民币大写)[^0-9\u4e00-\u9fff]{0,12}((?:人民币)?[\u4e00-\u9fff]{3,30}?整)/)
    || compact.match(/(人民币[\u4e00-\u9fff]{3,30}?整)/);
  if (m) {
    upperRaw = m[1];
    const parsed = parseChineseAmount(m[1]);
    // 大写金额里必须出现「元」和常见的位值词，且折算出五位数以上才认
    if (parsed && /元/.test(m[1]) && parsed >= 1000) amountUpper = parsed;
    if (amountUpper) hits.amount_in_words = m[0];
  }

  if (amount && amountUpper && Math.abs(amount - amountUpper) > 1) {
    checks.push({ level: 'warn', text: `票面金额 ¥${amount} 与大写「${upperRaw}」折算的 ¥${amountUpper} 不一致，请人工核对` });
  }
  const finalAmount = amountUpper || amount;
  if (finalAmount) fields.amount = toFixed2(finalAmount);
  if (amountUpper) fields.amount_in_words_value = amountUpper;
  // 识别不到钱是很常见的（金额被公章盖住、手写、或小字太糊）——
  // 明确说一声，别让用户以为系统算错了或者漏填了。
  if (!finalAmount) {
    checks.push({
      level: 'warn',
      text: '没能识别出合同金额。合同金额常被公章盖住或是手写的，OCR 认不出来属于正常情况，请照着原件手工填写。',
    });
  }

  // 日期
  const sign = pickDate(compact, '签订日期') || pickDate(compact, '签署日期') || pickDate(compact, '签约日期');
  if (sign) { fields.sign_date = sign.value; hits.sign_date = sign.hit; }
  const start = pickDate(compact, '开工日期') || pickDate(compact, '开始日期') || pickDate(compact, '合同工期自');
  if (start) { fields.start_date = start.value; hits.start_date = start.hit; }
  const end = pickDate(compact, '竣工日期') || pickDate(compact, '结束日期') || pickDate(compact, '完工日期');
  if (end) { fields.end_date = end.value; hits.end_date = end.hit; }

  // 付款条款
  m = compact.match(/(?:付款条款|付款方式|支付方式|结算方式)[:：]?([^\n]{4,120})/);
  if (m) { fields.payment_terms = m[1].trim(); hits.payment_terms = m[0].slice(0, 80); }

  // 工程地点 → 备注参考
  m = compact.match(/(?:工程地点|项目地点|施工地点|工程地址)[:：]?([^\n]{2,60})/);
  if (m) { fields.location = m[1].trim(); hits.location = m[0].slice(0, 50); }

  if (!fields.amount) checks.push({ level: 'warn', text: '未识别到合同金额，请手动填写' });
  if (!fields.code) checks.push({ level: 'info', text: '未识别到合同编号' });

  return { fields, hits, checks, parties, hints };
}

// ---------------- 付款条款解析（用于自动生成收付款计划） ----------------
const PHASE_RULES = [
  // 顺序即优先级。原则：
  //  1) 进度款排在验收款之前 —— "按月结算80%"这类写法里也含"结算"，不先判就会被误判成验收款；
  //     同时"完工"不放进进度款词表，否则"完工验收后付"会误判。
  //  2) 验收款排在到货款之前 —— "货到验收付60%"两个条件都满足，取后置节点（验收）更符合实际付款时点。
  [/质保|保修|保证金|尾保|质量保证/, '质保金'],
  [/预付|首付|定金|签约|签订|合同生效|下单/, '预付款'],
  [/进度|月度|按月|完成量|中期|节点/, '进度款'],
  [/验收|竣工|终验|交付/, '验收款'],
  [/到货|货到|进场|发货|到场|材料|送货/, '到货款'],
  [/尾款|结清|余款|最终|结算/, '尾款'],
];

function guessPhase (text) {
  const s = String(text || '');
  for (const [re, phase] of PHASE_RULES) if (re.test(s)) return phase;
  return null;
}

/**
 * 从合同的付款条款里抽出各节点比例/金额
 *   预付款30%，进度款按月度完成量40%，竣工验收25%，质保金5%
 *   → { nodes:[{phase:'预付款',ratio:30,basis:'预付款30%'}, ...], sum:100 }
 * 也支持写成金额的条款：预付款176万，验收款410万
 */
function parsePaymentTerms (text) {
  const out = { nodes: [], sum: 0, amountWan: 0, raw: String(text || '') };
  if (!text) return out;
  const t = String(text).replace(/[％﹪]/g, '%').replace(/[（〔]/g, '(').replace(/[）〕]/g, ')');
  const segs = t.split(/[，,；;。\n\r、]+/).map(s => s.trim()).filter(Boolean);

  for (const seg of segs) {
    const pm = seg.match(/(\d{1,3}(?:\.\d{1,2})?)\s*%/);
    if (pm) {
      const ratio = Number(pm[1]);
      if (!(ratio > 0 && ratio <= 100)) continue;
      const phase = guessPhase(seg.slice(0, pm.index)) || guessPhase(seg) || '其他';
      out.nodes.push({ phase, ratio, basis: seg });
      continue;
    }
    const am = seg.match(/(\d+(?:\.\d{1,4})?)\s*万/);
    if (am) {
      const wan = Number(am[1]);
      if (!(wan > 0)) continue;
      const phase = guessPhase(seg.slice(0, am.index)) || guessPhase(seg) || '其他';
      out.nodes.push({ phase, ratio: null, amountWan: wan, basis: seg });
      continue;
    }
  }

  // 同一节点名重复出现时合并（如"进度款30%，进度款20%"）
  const merged = new Map();
  for (const n of out.nodes) {
    const key = n.phase;
    if (merged.has(key)) {
      const e = merged.get(key);
      if (n.ratio && e.ratio) e.ratio = Math.round((e.ratio + n.ratio) * 100) / 100;
      if (n.amountWan) e.amountWan = Math.round(((e.amountWan || 0) + n.amountWan) * 100) / 100;
      if (!e.basis.includes(n.basis)) e.basis = e.basis + '；' + n.basis;
    } else merged.set(key, { ...n });
  }
  out.nodes = [...merged.values()];
  out.sum = Math.round(out.nodes.reduce((s, n) => s + (n.ratio || 0), 0) * 100) / 100;
  out.amountWan = Math.round(out.nodes.reduce((s, n) => s + (n.amountWan || 0), 0) * 100) / 100;
  return out;
}

// ---------------- 对外入口 ----------------
function extract (rawText, opts = {}) {
  const normalized = normalize(rawText);
  const compact = compactOf(normalized);
  let kind = opts.kind && opts.kind !== 'auto' ? opts.kind : detectKind(compact);

  let out;
  if (kind === 'invoice') out = extractInvoice(compact, normalized);
  else if (kind === 'contract') out = extractContract(compact, normalized);
  else out = {
    fields: {}, hits: {}, hints: {}, parties: [],
    checks: [{ level: 'warn', text: '未能判断文件类型（既不像发票也不像合同），请手动填写' }],
  };

  const expected = kind === 'invoice'
    ? ['invoice_no', 'issue_date', 'amount', 'tax_rate', 'tax_amount', 'total_amount', 'invoice_type']
    : ['code', 'name', 'amount', 'sign_date', 'start_date', 'end_date', 'payment_terms'];
  const got = expected.filter(k => out.fields[k] !== undefined && out.fields[k] !== null && out.fields[k] !== '');
  const confidence = expected.length ? Math.round(got.length / expected.length * 100) : 0;

  return {
    kind,
    normalized,
    fields: out.fields,
    hits: out.hits,
    hints: out.hints || {},
    checks: out.checks || [],
    parties: out.parties || [],
    fieldCount: got.length,
    expectedCount: expected.length,
    confidence,
  };
}

module.exports = {
  extract, normalize, normalizeLine, parseMoney, parseChineseAmount, cleanCode, detectKind, fixDigits,
  parsePaymentTerms, guessPhase,
};
