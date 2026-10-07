'use strict';
/**
 * 重置管理员密码（忘了密码时用，直接改本地数据库，不需要登录）
 *   node tools/reset-admin.js [新密码]
 * 不传新密码则重置为 admin123，并要求下次登录后修改。
 */
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));

const auth = require('../auth.js');

const pw = process.argv[2] || auth.DEFAULT_ADMIN.password;
const mustChange = process.argv[2] ? 0 : 1;

auth.createTable();
const created = auth.ensureAdmin();
let u = auth.getUserByName('admin');
if (!u) {
  // 管理员账号被删了：重新建一个
  auth.saveUser({ username: 'admin', name: '系统管理员', role: 'admin', password: pw, status: '启用' }, null);
  u = auth.getUserByName('admin');
  console.log('  已重新创建管理员账号 admin');
} else {
  const r = auth.resetPassword(u.id, pw, mustChange);
  if (r.error) { console.error('  重置失败：' + r.error); process.exit(1); }
  // 重置成初始密码时，把登录次数清零，登录页就会提示初始密码
  if (mustChange) {
    const { db } = require('../db.js');
    db.prepare('UPDATE users SET login_count = 0, last_login_at = NULL WHERE id = ?').run(u.id);
  }
  console.log('  已重置管理员密码');
}
console.log('');
console.log('  登录账号： admin');
console.log('  登录密码： ' + pw + (mustChange ? '（登录后请立即修改）' : ''));
console.log('');
