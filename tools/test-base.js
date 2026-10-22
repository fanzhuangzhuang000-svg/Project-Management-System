'use strict';
/**
 * 测试基址 —— 全项目唯一的默认值来源。
 *
 * ⚠️ 为什么不再默认 8787（真实事故，别改回去）：
 *    8787 是系统安装后的**默认端口**，用户机器上通常正跑着正式实例。
 *    测试套件默认连它，等于把用户的真实库当测试库用：
 *      · 批量删除 / 批量导入用例直接写真实数据
 *      · test-auth 会往真实库里插 testadmin、清 login_fails
 *      · 某个用例故意输错密码 → 真实账号被锁在门外
 *
 *    2026-10 出过一次：run-all 连上了用户正在用的 8787，而测试进程改密码改的是
 *    **另一个库**（测试进程 cwd 不同，PMS_DATA_DIR 指向别处）。于是凭据永远对不上，
 *    testadmin 连续失败 12 次被锁，全量套件 15 个集体红 —— 还在用户库里留了 15 条
 *    失败记录。教训有两条，这里各配一道闸：
 *      1) 默认端口改成 8899（测试专用），不再指向用户实例 → 本文件
 *      2) 动手前先确认"服务读的库 == 测试改的库" → test-auth.js 的 assertSameDb
 *
 * PMS_BASE 仍然可以覆盖（CI 就是这么显式指定的，它连自己刚起的临时服务）。
 */
const path = require('node:path');
const TEST_PORT = process.env.PMS_TEST_PORT || '8899';
const BASE = process.env.PMS_BASE || `http://127.0.0.1:${TEST_PORT}`;

/** 测试要操作的数据目录。run-all 起服务时把它显式传给服务端，两边必须一致。 */
const DATA_DIR = process.env.PMS_DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = { BASE, TEST_PORT, DATA_DIR };
