'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { suiteResult } = require('./suite-result.js');

let total = 0, bad = 0;
function test (name, fn) {
  total++;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { bad++; console.log(`  ✗ ${name} — ${e.message}`); }
}
const success = { code: 0, out: '3 / 3 项通过\n' };

test('正常退出且断言全部通过才算通过', () => {
  assert.deepEqual(suiteResult(success), { status: 'passed', passed: 3, total: 3, reason: '' });
});
test('真实子进程打印成功摘要后报错，仍然失败', () => {
  const r = spawnSync(process.execPath, ['-e', "console.log('3 / 3 项通过'); process.exit(1)"],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 1);
  const result = suiteResult({ code: r.status, out: r.stdout, error: r.error, signal: r.signal });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /退出码 1/);
});
test('打印成功摘要后超时仍然失败', () => {
  const result = suiteResult({ ...success, code: null, error: { code: 'ETIMEDOUT' } });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /ETIMEDOUT/);
});
test('打印成功摘要后被信号终止仍然失败', () => {
  assert.equal(suiteResult({ ...success, code: null, signal: 'SIGTERM' }).status, 'failed');
});
test('无法启动的子进程给出原始错误码', () => {
  assert.match(suiteResult({ code: null, error: { code: 'ENOENT' } }).reason, /ENOENT/);
});
test('退出状态为空不能当作成功', () => {
  assert.equal(suiteResult({ ...success, code: null }).status, 'failed');
});
test('断言失败即使退出码为零也失败', () => {
  assert.equal(suiteResult({ code: 0, out: '2 / 3 项通过' }).status, 'failed');
});
test('零条断言不能冒充全部通过', () => {
  assert.equal(suiteResult({ code: 0, out: '0 / 0 项通过' }).status, 'failed');
});
test('正常退出但没有摘要也失败', () => {
  assert.equal(suiteResult({ code: 0 }).status, 'failed');
});
test('明确跳过且正常退出时保留原因', () => {
  assert.deepEqual(suiteResult({ code: 0, out: '  SKIP: 缺少测试服务\n' }),
    { status: 'skipped', passed: null, total: null, reason: '缺少测试服务' });
});
test('跳过标记兼容全角冒号', () => {
  assert.equal(suiteResult({ code: 0, out: 'SKIP：没有浏览器' }).status, 'skipped');
});
test('打印跳过但退出失败仍然失败', () => {
  assert.equal(suiteResult({ code: 1, out: 'SKIP: 没有浏览器' }).status, 'failed');
});
test('打印跳过后超时仍然失败', () => {
  assert.equal(suiteResult({ code: null, out: 'SKIP: 等待服务', error: { code: 'ETIMEDOUT' } }).status, 'failed');
});
test('部分用例跳过不能盖住失败摘要', () => {
  assert.equal(suiteResult({ code: 0, out: 'SKIP: 某项不可用\n2 / 3 项通过' }).status, 'failed');
});
test('部分用例跳过但其余断言通过仍有有效摘要', () => {
  assert.equal(suiteResult({ code: 0, out: 'SKIP: 某项不可用\n3 / 3 项通过' }).status, 'passed');
});
test('嵌套脚本有多个摘要时取最终摘要', () => {
  const result = suiteResult({ code: 0, out: '3 / 3 项通过\n4 / 5 项通过' });
  assert.equal(result.status, 'failed');
  assert.equal(result.passed, 4);
  assert.equal(result.total, 5);
});

console.log(`\n${total - bad} / ${total} 项通过`);
process.exitCode = bad ? 1 : 0;
