#!/usr/bin/env node
'use strict';
/**
 * 授权码生成工具（**只给卖软件的人用，不要给客户**）
 *
 * 用法：
 *   node tools/gen-license.js 公司名 到期日期                  → 不限账号数
 *   node tools/gen-license.js 公司名 到期日期 --seats=20       → 最多 20 个启用账号
 *   node tools/gen-license.js 公司名 到期日期 --seats=0        → 明确不限
 *   node tools/gen-license.js --check ELV3.xxx.yyy            → 校验一个已有的码
 *
 * 不带参数会进入问答模式。
 *
 * ── 授权模型（2026-10 改）──
 *   按**公司**授权，不再一机一码。理由：云服务器网卡是弹性网卡，
 *   MAC 随重装/迁移就变，一机一码会把客户锁在门外。历史 ELV2 码继续有效。
 *   一份码可被复制到多台机器（离线校验的固有上限），靠账号数上限挡
 *   「一家买、全家用」，整包转卖属商业信誉问题，靠合同解决。
 *
 * ── 关于安全 ──
 *   这是离线签名，不是加密。密钥内置在软件里，理论上能被逆向出来自己造码。
 *   它拦的是「到期后继续用」和「一家买全家用」，不是防破解。
 *   想换密钥：设环境变量 PMS_LICENSE_SECRET（生成端和**所有部署端**要一致，
 *   ⚠️ 别写进客户的 .env —— 客户读到就能自己造码）。
 */
const readline = require('node:readline');
const {
  makeLicense, parseLicense, normalizeSeats,
  WARN_DAYS, USING_DEFAULT_SECRET,
} = require('./license.js');

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

function usage () {
  console.log('');
  console.log(C.bold('  授权码生成工具'));
  console.log('');
  console.log('  用法：');
  console.log('    node tools/gen-license.js <公司名> <到期日期> [--seats=N]');
  console.log('    node tools/gen-license.js "万祥机电设备有限公司" 2027-12-31');
  console.log('    node tools/gen-license.js "万祥机电设备有限公司" 2027-12-31 --seats=20');
  console.log('    node tools/gen-license.js --check ELV3.xxx.yyy');
  console.log('');
  console.log('  日期支持这些写法：2027-12-31 / 2027/12/31 / 2027年12月31日');
  console.log('');
  console.log('  ' + C.cyan('账号数上限（--seats）：') + '客户能同时启用的账号个数。');
  console.log('  达到上限后不能新建账号，已有账号照常登录使用。留空 = 不限。');
  console.log('');
  if (USING_DEFAULT_SECRET) {
    console.log('  ' + C.yellow('当前用的是软件内置密钥。'));
    console.log('  ' + C.dim('想换自己的密钥：设环境变量 PMS_LICENSE_SECRET，签发端和所有部署端要一致。'));
    console.log('  ' + C.dim('⚠️ 别把它写进客户的 .env —— 客户能读到就等于能自己造码。'));
  } else {
    console.log('  ' + C.dim('当前用的是环境变量 PMS_LICENSE_SECRET（自定义密钥）'));
  }
  console.log('');
}

/** 问答模式：让不会敲命令的人也能用 */
async function interactive () {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  console.log('');
  console.log(C.bold('  授权码生成（直接回车用括号里的默认值）'));
  console.log('');

  const company = (await ask('  公司名： ')).trim();
  if (!company) { console.log(C.red('  公司名不能为空')); rl.close(); process.exit(1) }

  const def = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const expiry = (await ask(`  到期日期 (${def})： `)).trim() || def;

  console.log('');
  console.log('  ' + C.dim('账号数上限：客户能同时启用的账号个数。留空 = 不限。'));
  const seats = (await ask('  账号数上限 (不限)： ')).trim();

  rl.close();
  return { company, expiry, seats };
}

function emit (company, expiry, seats) {
  const r = makeLicense(company, expiry, seats);
  if (r.error) { console.log('  ' + C.red('✗ ' + r.error)); process.exit(1) }

  const st = parseLicense(r.code);
  const days = st.daysLeft;

  console.log('');
  console.log('  ' + '═'.repeat(64));
  console.log('   ' + C.bold('授权码（按公司授权）'));
  console.log('  ' + '═'.repeat(64));
  console.log('');
  console.log('   ' + C.cyan(r.code));
  console.log('');
  console.log('  ' + '─'.repeat(64));
  console.log(`   公司名：  ${C.bold(r.company)}`);
  console.log(`   到期日：  ${C.bold(r.expiry)}   ${C.dim(`（还有 ${days} 天）`)}`);
  console.log(`   账号数：  ${r.seats ? C.bold(String(r.seats) + ' 个') : C.dim('不限')}`);
  if (days !== null && days <= WARN_DAYS) {
    console.log('   ' + C.yellow(`   注意：只剩 ${days} 天，客户登录时会看到到期提醒`));
  }
  console.log('  ' + '─'.repeat(64));
  console.log('');
  console.log('  ' + C.dim('把上面那行授权码发给客户，让他在「系统设置 → 授权」里粘贴保存。'));
  console.log('  ' + C.dim('（客户要在「系统设置 → 界面自定义」里把公司名填成和上面一致，否则会提示不匹配）'));
  console.log('');
  console.log('  ' + C.dim('校验一遍：'));
  console.log('  ' + C.dim(`  node tools/gen-license.js --check ${r.code}`));
  console.log('');
}

function check (code) {
  const r = parseLicense(code);
  const label = {
    ok: C.green('有效'),
    warn: C.yellow('即将到期'),
    expired: C.red('已过期（软件进入只读）'),
    invalid: C.red('无效'),
    none: C.dim('未填写'),
  }[r.status] || r.status;
  console.log('');
  console.log(`  状态：  ${label}`);
  if (r.company) console.log(`  公司名：${r.company}`);
  if (r.expiry) console.log(`  到期日：${r.expiry}  剩余 ${r.daysLeft} 天`);
  console.log(`  账号数：${r.seats ? r.seats + ' 个' : '不限'}`);
  if (r.error) console.log('  ' + C.red('  原因：  ' + r.error));
  console.log('');
  process.exit(r.status === 'invalid' ? 1 : 0);
}

(async () => {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) { usage(); process.exit(0) }

  if (args[0] === '--check') { check(args[1] || ''); return }

  let company = '', expiry = '', seats = '';
  const positional = args.filter(a => !a.startsWith('--'));
  const seatsArg = args.find(a => a.startsWith('--seats'));
  if (seatsArg) {
    const n = normalizeSeats(seatsArg.split('=')[1] !== undefined ? seatsArg.split('=')[1] : '1');
    if (n.error) { console.log('  ' + C.red('✗ ' + n.error)); process.exit(1) }
    seats = String(n.value);
  }
  if (positional.length >= 2) { company = positional[0]; expiry = positional[1] }
  else if (positional.length === 1) { company = positional[0] }

  if (!company) {
    const ans = await interactive();
    company = ans.company; expiry = ans.expiry; seats = seats || ans.seats || '';
  } else if (!expiry) {
    console.log('  ' + C.red('✗ 还要给一个到期日期，例如 2027-12-31'));
    usage();
    process.exit(1);
  }

  emit(company, expiry, seats);
})();
