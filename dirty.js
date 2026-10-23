'use strict';
/**
 * 「这次请求到底改了哪张表」—— 看板缓存失效的判据。
 *
 * 为什么需要
 *   以前是 `if (method !== 'GET') res.on('finish', dashClear)`：
 *   只要不是 GET，就把全员看板缓存清空。后果两头都不对：
 *     · 清多了：登录、退出、改设置、改密码、上传、备份、清日志、
 *       甚至 400/403/404 全都清 —— 每次登录都把全公司的看板重算一遍
 *     · 清少了：客户端中途断开时 finish 不触发，写已提交但缓存没清；
 *       维护任务在定时器里写库（快照/回收站清理）根本不经过 HTTP
 *
 * 做法
 *   在写原语（db.js 的增删改、附件的裸 SQL、用户、快照、回收站还原）
 *   真的改变了行数之后，把表名记到「当前请求」名下。
 *   请求结束时只看这一份清单：与看板依赖的表有交集才失效。
 *
 * ⚠️ 判定依据是「真的改了行」，不是「请求方法不是 GET」。
 *    所以 400 校验失败、403 权限不足、404 未知接口、update 命中 0 行、
 *    只写 sessions/logs 的登录 —— 都不会再清空看板缓存。
 *
 * ⚠️ 请求结束后才发生的写（例如 OCR 队列在响应之后回填）会落到 pending，
 *    由维护任务周期性取走。这类写不经过请求生命周期，靠 ALS 是抓不住的。
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

/** 没有请求上下文时（维护任务 / 启动 seed / 脚本）落到这里 */
const pending = new Set();

/** 在一个新的「请求作用域」里执行 */
function run (fn) {
  return als.run({ tables: new Set(), done: false }, fn);
}

/** 记一笔脏表。table 用 '*' 表示"说不清改了哪些，全都算脏" */
function mark (table) {
  if (!table) return;
  const store = als.getStore();
  // store.done = 请求已经结束（响应发完了），此时的写属于后台任务，
  // 不能再记到一个已经结算过的请求上 —— 记进 pending 由维护任务兜底。
  if (store && !store.done) store.tables.add(table);
  else pending.add(table);
}

/** 结束请求作用域：返回本次请求的脏表清单，并让此后的写落到 pending */
function end () {
  const store = als.getStore();
  if (!store) return [];
  store.done = true;
  const list = [...store.tables];
  store.tables.clear();     // 重复调用不会把同一批脏表算两次
  return list;
}

/** 取走并清空 pending（维护任务用） */
function takePending () {
  const list = [...pending];
  pending.clear();
  return list;
}

module.exports = { run, mark, end, takePending };
