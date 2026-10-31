'use strict';

/** 子进程摘要只说明断言结果；退出码、超时和信号也必须参与判定。 */
function suiteResult ({ code, out = '', error, signal }) {
  const summaries = [...out.matchAll(/(\d+)\s*\/\s*(\d+) 项通过/g)];
  const summary = summaries[summaries.length - 1];
  const passed = summary ? Number(summary[1]) : null;
  const total = summary ? Number(summary[2]) : null;
  let reason = '';

  if (error) reason = `子进程错误：${error.code || error.message || String(error)}`;
  else if (signal) reason = `子进程被信号终止：${signal}`;
  else if (code !== 0) reason = code === null ? '子进程未正常退出' : `子进程退出码 ${code}`;
  else if (summary) {
    if (total === 0) reason = '没有执行任何断言';
    else if (passed !== total) reason = '断言未全部通过';
  } else {
    const skip = /^[ \t]*SKIP[:：][ \t]*(.+)$/m.exec(out);
    if (skip) return { status: 'skipped', passed, total, reason: skip[1].trim() };
    reason = '未取得结果';
  }

  return { status: reason ? 'failed' : 'passed', passed, total, reason };
}

module.exports = { suiteResult };
