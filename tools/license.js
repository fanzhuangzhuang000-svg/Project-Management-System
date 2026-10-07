'use strict';
/**
 * 授权码：绑定公司名 + 到期日期 + 账号数上限，离线校验（不联网）
 *
 * ── 格式 ──
 *   ELV1.<payload>.<签名>   老格式：公司名 + 到期日（继续有效）
 *   ELV2.<payload>.<签名>   曾经的一机一码：公司名 + 到期日 + 机器码
 *   ELV3.<payload>.<签名>   现格式：公司名 + 到期日 + 账号数上限
 *   payload = base64url(公司名|YYYY-MM-DD[|N])
 *
 * ── 为什么不再绑机器（2026-10 决定）──
 *   原 ELV2 用网卡 MAC 当机器码，配 pin 文件容忍网卡漂移。在**云服务器**上这套
 *   是错的：云主机的网卡是弹性网卡，重装系统/换可用区/跨云迁移 MAC 就会变，
 *   客户一续费就被锁在门外；pin 文件又只存在于数据盘，云盘重建就丢。
 *   所以放弃一机一码，改成**按公司授权**（SaaS 常规做法）。
 *   ⚠️ ELV2 的码继续照旧认（机器码字段直接忽略），别让已经发出去的码作废。
 *
 * ── 诚实的边界：这套拦不住什么 ──
 *   这是**离线签名校验**，不是加密：算法和密钥都在客户端里，有心人逆向就能造码。
 *   放弃机器绑定后，一份码可以被复制到任意多台机器。真正能约束部署数的只有
 *   **联网激活**（要维护服务器，且客户内网不通外网就不能用）。
 *   这里能离线做到的是：到期转只读（年费收得回）+ 账号数上限（一家买不了全家用）。
 *   「整包复制给别家公司」属于商业信誉问题，靠合同和售后，不指望技术解决。
 *
 * ── 账号数上限（seats）怎么执行 ──
 *   纯离线、零依赖：签发时你定一个数，激活后系统数「启用」的账号，
 *   达到上限就**禁止新建账号**（已有账号照常登录、照常改，不把人锁在门外）。
 *   seats 留空或 0 = 不限（兼容没有 seats 的 ELV1/ELV2 码）。
 *
 * ── 想让密钥更安全 ──
 *   密钥内置在软件里（离线校验必须这样，客户拿到的包自带）。想换：
 *   设环境变量 PMS_LICENSE_SECRET，**签发端和所有部署端要一致**。
 *   ⚠️ 别把密钥写进给客户的 .env —— 客户能读到就等于能自己造码。
 */
const crypto = require('node:crypto');

/**
 * 内置密钥（离线校验的固有代价：客户包里有密钥）。
 * 已从可猜测的默认值换成随机值 —— 授权粒度变粗（可为任意公司签发码）之后，
 * 密钥泄露的后果严重了一个量级。
 */
const DEFAULT_SECRET = 'elv-evEslMhNn6xMdXA6GTC5fYJuANvNL_2O67trKLIRPkSa4exTPt4E7g';
const SECRET = process.env.PMS_LICENSE_SECRET || DEFAULT_SECRET;
/** 现在用的是不是内置默认密钥（启动时据此警告） */
const USING_DEFAULT_SECRET = !process.env.PMS_LICENSE_SECRET;

const PREFIX = 'ELV1';       // 老格式：公司名 + 到期日
const PREFIX_V2 = 'ELV2';    // 历史格式：公司名 + 到期日 + 机器码（机器码已忽略）
const PREFIX_V3 = 'ELV3';    // 现格式：公司名 + 到期日 + 账号数上限
const PREFIXES = [PREFIX, PREFIX_V2, PREFIX_V3];

/** 到期前多少天开始提醒 */
const WARN_DAYS = 30;

/** 机器码的样子：MC-XXXXXXXX-XXXXXXXX（只用于识别历史 ELV2 码，已不再做比对） */
const MACHINE_RE = /^MC-[0-9A-F]{8}-[0-9A-F]{8}$/;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign (payload) {
  return b64u(crypto.createHmac('sha256', SECRET).update(payload).digest().subarray(0, 16));
}

// ---------------- 授权码 ----------------

/**
 * 生成授权码。
 * @param {string} company 公司名
 * @param {string} expiry  到期日（各种写法都认）
 * @param {number|string} [seats] 账号数上限；空/0 = 不限
 */
function makeLicense (company, expiry, seats) {
  const name = String(company || '').trim();
  const exp = normalizeDate(expiry);
  if (!name) return { error: '公司名不能为空' };
  if (!exp) return { error: '到期日期格式不对，应该是 2027-12-31 这样' };

  const n = normalizeSeats(seats);
  if (n.error) return { error: n.error };

  // 公司名里可能有 '|'，统一换成空格，免得把分隔符污染掉
  const payload = b64u(`${name.replace(/\|/g, ' ')}|${exp}|${n.value}`);
  return {
    code: PREFIX_V3 + '.' + payload + '.' + sign(payload),
    company: name, expiry: exp, seats: n.value,
  };
}

/** 账号数上限归一：空/0/不限 = 0（不限），否则是正整数 */
function normalizeSeats (v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s || s === '0' || s === 'off' || s === 'no' || s === '不限' || s === '不限制') return { value: 0 };
  if (!/^\d{1,4}$/.test(s)) return { error: '账号数上限只能填 1~9999 的整数，留空表示不限' };
  return { value: parseInt(s, 10) };
}

/** 把各种写法归一成 YYYY-MM-DD */
function normalizeDate (v) {
  const s = String(v || '').trim();
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 两个日期之间差多少天（按自然日算，忽略时分秒） */
function daysBetween (fromISO, toISO) {
  const a = Date.parse(fromISO + 'T00:00:00');
  const b = Date.parse(toISO + 'T00:00:00');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * 校验授权码。
 * @param {string} code 授权码
 * @param {Date|null} today 固定「今天」用（测试）
 * @returns {{status:'none'|'invalid'|'expired'|'warn'|'ok', company?:string, expiry?:string, seats?:number, daysLeft?:number, error?:string}}
 */
function parseLicense (code, today = null) {
  const raw = String(code || '').trim();
  if (!raw) return { status: 'none' };

  // 用 '.' 分隔：base64url 的字母表里有 '-' 和 '_'，用 '-' 当分隔符会把 payload 切碎
  const parts = raw.split('.');
  const prefix = parts[0];
  if (parts.length !== 3 || !PREFIXES.includes(prefix)) {
    return { status: 'invalid', error: '授权码格式不对' };
  }
  const [, payload, sig] = parts;
  if (sign(payload) !== sig) return { status: 'invalid', error: '授权码无效（签名对不上）' };

  let text;
  try { text = unb64u(payload).toString('utf8') } catch { return { status: 'invalid', error: '授权码损坏' } }
  const fields = text.split('|');
  if (fields.length < 2 || fields.length > 3) return { status: 'invalid', error: '授权码内容不完整' };
  const [company, expiry, third] = fields.map(f => f.trim());
  if (!company || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return { status: 'invalid', error: '授权码内容不完整' };

  // 第三个字段的含义**取决于前缀**：
  //   ELV3 = 账号数上限；ELV2 = 机器码（已废弃，认格式但不比对，直接忽略）
  let seats = 0;
  if (fields.length === 3) {
    if (prefix === PREFIX_V3) {
      if (!/^\d{1,4}$/.test(third)) return { status: 'invalid', error: '授权码内容不完整' };
      seats = parseInt(third, 10);
    } else if (!MACHINE_RE.test(third.toUpperCase())) {
      return { status: 'invalid', error: '授权码内容不完整' };
    }
  }

  const d = today || new Date();
  const todayISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daysLeft = daysBetween(todayISO, expiry);
  if (daysLeft === null) return { status: 'invalid', error: '日期无法解析' };

  const base = { company, expiry, seats, daysLeft };

  if (daysLeft < 0) return { ...base, status: 'expired' };
  if (daysLeft <= WARN_DAYS) return { ...base, status: 'warn' };
  return { ...base, status: 'ok' };
}

/** 给前端用的摘要（不含授权码本身，避免到处传） */
function licenseStatus (code, today = null) {
  const r = parseLicense(code, today);
  return {
    status: r.status,
    company: r.company || null,
    expiry: r.expiry || null,
    daysLeft: r.daysLeft === undefined ? null : r.daysLeft,
    warnDays: WARN_DAYS,
    error: r.error || null,
    /** 账号数上限；0 = 不限（老码没有 seats） */
    seats: r.seats || 0,
    /** 已启用的账号数（由 server.js 填，纯校验层不知道） */
    usedSeats: r.usedSeats === undefined ? null : r.usedSeats,
    /** 已超出账号数上限（由 server.js 填） */
    seatsExceeded: !!r.seatsExceeded,
    /** 过期后只读：能看、能导，不能改 */
    readOnly: r.status === 'expired',
  };
}

module.exports = {
  makeLicense, parseLicense, licenseStatus, normalizeDate, normalizeSeats, daysBetween,
  WARN_DAYS, PREFIX, PREFIX_V2, PREFIX_V3, MACHINE_RE, SECRET, USING_DEFAULT_SECRET,
  // 导出 sign 只为测试能造出「历史格式」的码来验证向后兼容，生产代码不要用
  _sign: sign, _b64u: b64u,
};
