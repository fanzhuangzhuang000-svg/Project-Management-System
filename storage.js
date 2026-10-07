'use strict';
/**
 * 文件存储驱动选择器
 *
 *   STORAGE_DRIVER 没配 / local  → 本地目录（单机版、开发）
 *   STORAGE_DRIVER=minio        → MinIO / S3 兼容对象存储（专业版、网络版）
 *
 * 业务代码只认「存/取/删/本地路径」这几个方法，不关心文件到底在哪。
 * 单机版装机包里没有 minio 依赖，也永远不会走到那条路。
 */
const path = require('node:path');

const DATA_DIR = process.env.PMS_DATA_DIR || path.join(__dirname, 'data');
const DRIVER = String(process.env.STORAGE_DRIVER || 'local').trim().toLowerCase();

let storage;
if (DRIVER === 'minio' || DRIVER === 's3') {
  storage = require('./storage-minio.js').create({ dataDir: DATA_DIR });
} else {
  storage = require('./storage-local.js').create({ dataDir: DATA_DIR });
}

module.exports = {
  storage,
  driver: storage.driver,
  describe: () => storage.describe(),
  /** 附件的本地可读路径（OCR 用） */
  localPath: (key) => storage.localPath(key),
  /** 用完释放本地副本（MinIO 模式下会删缓存） */
  release: (key) => storage.release(key),
};
