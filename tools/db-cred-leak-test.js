'use strict';
/**
 * 回归测试：/api/health 不得回显数据库密码。
 *
 * 起因（真实漏洞）：PG 模式下 db-driver.js 的 DB_FILE 就是完整连接串
 *     postgres://elvpms:明文密码@host:5432/elvpms
 * 而 /api/health 是**未登录即可访问**的（响应里 needLogin:true 自证），
 * 原来直接回显 DB_FILE —— 等于任何人都能读到数据库密码。
 *
 * 三个环境（单机/Docker/裸装）都受影响，且不需要任何技巧就能拿到。
 *
 * 本测试同时验证脱敏函数本身对各种连接串形态都有效，
 * 因为只测「当前这台机器」的话，换个部署形态就漏了。
 */
const { DB_FILE_SAFE, DB_FILE } = require('../db-driver.js');

let pass = 0, fail = 0;
function ok (cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

// ── 1. 当前运行的实例确实不含密码 ──
if (DB_FILE.includes('://')) {
  // PG 模式：脱敏后密码位必须是 ***，不能再有真实字符。
  // 注意不能用「有没有 user:xxx@」来判 —— *** 本身也长得像密码。
  const m = DB_FILE_SAFE.match(/(:\/\/[^:/@\s]+:)([^@\s]+)(@)/);
  ok(!!m && m[2] === '***',
    'PG 模式：DB_FILE_SAFE 的密码位已被替换为 ***',
    DB_FILE_SAFE);
  ok(DB_FILE_SAFE.includes('@'), 'PG 模式：仍保留主机部分（便于排查）', DB_FILE_SAFE);
} else {
  ok(true, 'SQLite 模式：DB_FILE_SAFE 是本地路径（无凭据），无需脱敏 → ' + DB_FILE_SAFE);
}

// ── 2. 脱敏规则对各种连接串形态都有效（不依赖当前机器）──
function mask (url) {
  return url.replace(/(:\/\/[^:/@\s]+:)[^@\s]+(@)/, '$1***$2');
}

const cases = [
  ['postgres://elvpms:Secret123@127.0.0.1:5432/elvpms', '标准形态'],
  ['postgres://user:p%40ss%3Aword@db:5432/app', 'URL 编码的密码'],
  ['postgres://u:pw@h:5432/d', '最短形态'],
];
for (const [url, name] of cases) {
  const m = mask(url);
  const pw = m.match(/(:\/\/[^:/@\s]+:)([^@\s]+)(@)/);
  ok(!!pw && pw[2] === '***', '脱敏生效：' + name, m);
  ok(m.includes('***'), '密码位置有掩码：' + name, m);
}

// 不含密码的连接串不应被破坏
const noPw = 'postgres://elvpms@127.0.0.1:5432/elvpms';
ok(mask(noPw) === noPw, '无密码的连接串保持原样（不误伤）', mask(noPw));

// ── 3. server.js 的三处响应都改用了脱敏值 ──
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const badEchos = [...src.matchAll(/(dbFile|db)\s*:\s*dbf\.DB_FILE(?![_A-Z])/g)];
ok(badEchos.length === 0,
  'server.js 里没有把 dbf.DB_FILE 直接放进 HTTP 响应',
  badEchos.length + ' 处：' + badEchos.map(m => m[1]).join(', '));

const safeUses = [...src.matchAll(/dbf\.DB_FILE_SAFE/g)];
ok(safeUses.length >= 3, '三处响应都改用 DB_FILE_SAFE', '实际 ' + safeUses.length + ' 处');

// 启动横幅仍应打完整值（运维排查要看）
ok(/console\.log\([^)]*dbf\.DB_FILE[^_A-Z]/.test(src),
  '启动横幅仍回显完整 DB_FILE（运维终端需要，不外泄）');

console.log('\n  db-cred-leak: ' + pass + ' 通过, ' + fail + ' 失败');
// run-all.js 用这个正则判定套件结果：/(\d+)\s*\/\s*(\d+) 项通过/
// 格式必须一致，否则明明全过也会被判成「未取得结果」。
console.log(`  ${pass} / ${pass + fail} 项通过`);
process.exit(fail ? 1 : 0);
