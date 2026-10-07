'use strict';
/**
 * 本地文件存储（单机版 / 开发用）
 *
 * 就是现在这套：附件放在 data/attachments/ 下，按月份分子目录。
 * exe 安装包的客户走这条，零依赖、不用起任何服务。
 */
const fs = require('node:fs');
const path = require('node:path');

const DRIVER = 'local';

function create (opts = {}) {
  const baseDir = opts.dir || path.join(opts.dataDir || path.join(__dirname, 'data'), 'attachments');
  fs.mkdirSync(baseDir, { recursive: true });

  /**
   * 把存储键（形如 202610/ab12cd.pdf）解析成绝对路径。
   * 必须防目录穿越：stored_name 是从库里读的，万一被人写进 ../.. 就出事了。
   */
  function localPath (key) {
    const p = path.join(baseDir, key);
    const root = path.resolve(baseDir);
    if (!path.resolve(p).startsWith(root + path.sep) && path.resolve(p) !== root) {
      throw new Error('非法的存储路径：' + key);
    }
    return p;
  }

  return {
    driver: DRIVER,
    baseDir,
    describe: () => '本地目录  ' + baseDir,

    /** 存一份文件（buffer）。key 形如 202610/ab12cd.pdf，父目录会自动建 */
    async_init: null,

    save (key, buffer) {
      const p = localPath(key);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buffer);
      return key;
    },

    remove (key) {
      try { fs.unlinkSync(localPath(key)); return true } catch { return false }
    },

    exists (key) {
      try { return fs.existsSync(localPath(key)) } catch { return false }
    },

    /** 拿到本地可读路径（OCR 要读本地文件，MinIO 那边会先下载到缓存） */
    localPath,

    /** 用完释放（本地存储没什么可释放的，MinIO 会删掉临时文件） */
    release () { /* 无需处理 */ },

    size (key) {
      try { return fs.statSync(localPath(key)).size } catch { return 0 }
    },

    /** 列出现有全部文件（迁移到 MinIO 时用） */
    list () {
      const out = [];
      (function walk (dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) walk(path.join(dir, e.name), r);
          else out.push({ key: r, size: fs.statSync(path.join(dir, e.name)).size });
        }
      })(baseDir, '');
      return out;
    },
  };
}

module.exports = { create, DRIVER };
