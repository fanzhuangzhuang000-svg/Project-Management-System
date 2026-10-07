'use strict';
/**
 * 备份异地存放
 *
 * 本地备份只防「手滑删库」，防不了「这台电脑坏了/被偷了」。
 * 所以再加一份放到别处：
 *   off    只留本地（默认）
 *   share  复制到局域网共享目录（单机版常用，比如 NAS 或另一台电脑的共享文件夹）
 *   minio  上传到 MinIO（网络版，跟着 docker 一起备份）
 *
 * ── 设计原则 ──
 * 异地失败**绝不回滚本地备份**：本地那份才是主备份，
 * 异地是加分项。传失败只记一条警告，让用户知道，但不影响正常备份流程。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} filePath 本地备份文件的绝对路径
 * @param {string} fileName 文件名
 * @param {object} cfg { mode, share }
 * @returns {{ok:boolean, mode:string, target?:string, error?:string}}
 */
function upload (filePath, fileName, cfg = {}) {
  const mode = String(cfg.mode || 'off').toLowerCase();
  if (mode === 'off' || !mode) return { ok: true, mode: 'off', target: '（未开启异地备份）' };

  if (mode === 'share') {
    const dir = String(cfg.share || '').trim();
    if (!dir) return { ok: false, mode, error: '没有填共享目录路径' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, fileName);
      fs.copyFileSync(filePath, dest);
      // 顺手校验一下大小，共享目录掉线时 copyFileSync 有时会「成功」但文件是 0 字节
      const a = fs.statSync(filePath).size;
      const b = fs.statSync(dest).size;
      if (a !== b) return { ok: false, mode, error: `复制后大小不一致（${a} vs ${b}）` };
      return { ok: true, mode, target: dest };
    } catch (e) {
      return { ok: false, mode, error: '复制到共享目录失败：' + e.message };
    }
  }

  if (mode === 'minio') {
    try {
      // 复用附件那套存储驱动，省得再写一份 S3 逻辑
      const { storage } = require('./storage.js');
      if (storage.driver !== 'minio') {
        return { ok: false, mode, error: '当前存储驱动不是 minio（把 STORAGE_DRIVER 设成 minio 才能用这个）' };
      }
      const key = 'backups/' + fileName;
      storage.save(key, fs.readFileSync(filePath));
      return { ok: true, mode, target: `minio://${key}` };
    } catch (e) {
      return { ok: false, mode, error: '上传到 MinIO 失败：' + e.message };
    }
  }

  return { ok: false, mode, error: '不认识的异地备份方式：' + mode };
}

/** 从系统设置里读配置 */
function configFromSettings () {
  try {
    const dbf = require('./db.js');
    const s = dbf.getSettings();
    return {
      mode: String(s.backup_remote || 'off'),
      share: String(s.backup_share || ''),
    };
  } catch {
    return { mode: 'off', share: '' };
  }
}

module.exports = { upload, configFromSettings };
