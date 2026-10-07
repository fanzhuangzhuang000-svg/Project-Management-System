'use strict';
/**
 * 同步桥：把异步操作包装成同步调用
 *
 * ── 为什么需要它 ──
 * 业务层是全同步的（SQLite 时代留下的，1700 行），而 PostgreSQL / MinIO 的
 * 官方客户端都是异步的。把业务层改成 async 会牵动所有调用方，风险极高。
 *
 * 做法：异步客户端跑在 worker 线程里；主线程发完消息后用 Atomics.wait 阻塞，
 * worker 干完活写共享内存并唤醒主线程。业务层看到的就是个普通的同步调用。
 *
 * 代价：调用期间主线程阻塞。但这本来就和同步 SQLite 的行为一致，
 * 对「2-5 人的局域网工具」完全够用。
 *
 * 实现要点（踩过的坑）：
 *   - receiveMessageOnPort 必须用 MessageChannel 的端口，不能用 worker 自带端口
 *   - Atomics.wait 必须带超时，否则 worker 挂了主线程会永远挂住
 *   - 唤醒后消息可能还没排到端口队列，要自旋取一下
 */
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');

/**
 * 起一个同步桥
 * @param {string} workerSrc  worker 的源码（字符串，用 eval 方式跑）
 * @param {object} workerData 传给 worker 的数据
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=60000] 单次调用超时
 * @param {string} [opts.name='sync'] 出错信息里的名字
 */
function createBridge (workerSrc, workerData = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  const name = opts.name || 'sync';

  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(workerSrc, {
    eval: true,
    workerData: { ...workerData, port: port2 },
    transferList: [port2],
  });
  // 不因为 worker 还活着就拖着主进程不退出
  worker.unref?.();

  let seq = 0;
  let closed = false;
  let workerError = null;
  worker.on('error', (e) => { workerError = e; });

  /**
   * 发一条消息并**阻塞**等结果
   * @param {object} msg 要发给 worker 的消息
   * @returns {any} worker 返回的 result 字段
   */
  function call (msg, customTimeout) {
    if (workerError) throw new Error(`${name} worker 已挂：` + workerError.message);
    if (closed) throw new Error(`${name} 连接已关闭`);

    const id = ++seq;
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    port1.postMessage({ ...msg, id, sab });

    const limit = customTimeout || timeoutMs;
    const r = Atomics.wait(i32, 0, 0, limit);
    if (r === 'timed-out') throw new Error(`${name} 调用超时（${limit}ms）`);

    let m;
    while ((m = receiveMessageOnPort(port1)) === undefined) { /* 等消息排到队列 */ }
    const out = m.message;
    if (!out.ok) throw new Error(out.error);
    return out.result;
  }

  function close () {
    if (closed) return;
    try { closed = true; call({ kind: '__close__' }, 5000) } catch { /* 忽略 */ }
    try { worker.terminate() } catch { /* 忽略 */ }
  }

  return { call, close, get closed () { return closed }, worker };
}

module.exports = { createBridge };
