'use strict';
/**
 * 用纯 Node 写 tar.gz —— 不调用外部的 tar。
 *
 * ⚠️ 为什么要自己写：
 *    交付包里的 tar 一直靠 spawnSync('tar'…)，而 Windows 上存在**两个** tar：
 *      · C:\Program Files\Git\usr\bin\tar.exe —— GNU tar，认 --mode / --owner
 *      · C:\Windows\System32\tar.exe        —— bsdtar，不认 --mode，也不认 --transform
 *    PATH 里谁在前面完全看机器。本机（Git Bash）是 GNU，CI 的 windows-latest 是
 *    bsdtar，于是同一个脚本本地绿、CI 红，而 CI 只留下一句
 *    「✗ 打包失败：tar 失败：」—— stderr 是空的，连退出码都没有，只能靠猜。
 *    改成自己写以后：同一份代码在任何机器上产出同样的包，执行位也能精确控制
 *    （Windows 上 fs.chmod 是空操作，外部 tar 的 --mode 只有 GNU 认）。
 *
 * 格式：POSIX uStar（ustar\0 + "00"），路径超长时用 prefix 字段拆。
 * 这是 tar 最基础的格式，Linux 的 GNU tar / bsdtar / busybox tar 都能读。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BLOCK = 512;

/** 八进制数值字段：宽度 w，以 NUL 结尾（uStar 的约定） */
function octal (n, w) {
  const s = Math.max(0, Math.floor(n)).toString(8);
  if (s.length > w - 1) throw new Error(`字段溢出：${n} 放不进 ${w} 字节`);
  return s.padStart(w - 1, '0') + '\0';
}

/**
 * 写一个 header。
 * @param {string} nameIn 归档内路径（用 / 分隔，不含前导 /）
 * @param {number} size 文件字节数（目录/链接为 0）
 * @param {'0'|'5'} type '0' 普通文件、'5' 目录
 * @param {number} mode 权限位（八进制语义，如 0o755）
 * @param {number} mtime 秒级时间戳
 */
function header (nameIn, size, type, mode, mtime) {
  let name = nameIn;
  let prefix = '';
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > 100) {
    // uStar 的拆法：末尾一级以上放进 prefix（≤155 字节），剩下的放 name（≤100）
    const parts = nameIn.split('/');
    while (parts.length > 1) {
      const rest = parts.slice(1).join('/');
      const head = parts[0];
      if (Buffer.byteLength(rest, 'utf8') <= 100 && Buffer.byteLength(prefix ? prefix + '/' + head : head, 'utf8') <= 155) {
        prefix = prefix ? prefix + '/' + head : head;
        name = rest;
        break;
      }
      prefix = prefix ? prefix + '/' + parts[0] : parts[0];
      parts.shift();
    }
    if (Buffer.byteLength(name, 'utf8') > 100) throw new Error(`路径太长，uStar 装不下：${nameIn}`);
    if (Buffer.byteLength(prefix, 'utf8') > 155) throw new Error(`路径前缀太长：${nameIn}`);
  }

  const b = Buffer.alloc(BLOCK, 0);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode, 8), 100, 'ascii');       // mode
  b.write(octal(0, 8), 108, 'ascii');          // uid
  b.write(octal(0, 8), 116, 'ascii');          // gid
  b.write(octal(size, 12), 124, 'ascii');      // size
  b.write(octal(mtime, 12), 136, 'ascii');     // mtime
  b.write('        ', 148, 'ascii');           // chksum 先填 8 个空格
  b.write(type, 156, 'ascii');                 // typeflag
  // linkname(157,100) 留空
  b.write('ustar\0', 257, 'ascii');            // magic
  b.write('00', 263, 'ascii');                 // version
  b.write(prefix, 345, 155, 'utf8');           // prefix

  // chksum = header 所有字节的无符号和（含那 8 个空格）
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return b;
}

/** 目录补齐到 512 的整数倍 */
function pad (len) {
  const r = len % BLOCK;
  return r === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - r, 0);
}

/** 可执行位：deploy/ 下的 .sh 要能 ./deploy.sh 直接跑 */
function modeFor (rel) {
  if (/\.sh$/.test(rel) || /(^|\/)deploy\.sh$/.test(rel)) return 0o755;
  return 0o644;
}

function walk (root, cur, out) {
  for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(cur, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      out.push({ abs, type: '5', mode: 0o755 });
      walk(root, abs, out);
    } else if (e.isFile()) {
      out.push({ abs, type: '0', mode: modeFor(path.relative(root, abs).split(path.sep).join('/')) });
    }
    // 符号链接不跟进：Windows 上通常也造不出来
  }
}

/**
 * 把 cwd/entry 打成 cwd/outRel 这个 .tar.gz。
 * @param {string} cwd 归档内容所在的父目录
 * @param {string} entry cwd 下的目录名（会成为包内的顶层目录）
 * @param {string} out 输出文件的绝对路径
 * @returns {{ files: number, bytes: number }}
 */
function writeTarGz (cwd, entry, out) {
  const root = path.join(cwd, entry);
  const items = [{ abs: root, type: '5', mode: 0o755 }];
  walk(root, root, items);

  const chunks = [];
  let files = 0;
  // 固定 mtime：同一个源码打两次包，内容完全一致（便于比对产物是否过期）
  const MTIME = 1700000000;
  for (const it of items) {
    const rel = path.relative(cwd, it.abs).split(path.sep).join('/');
    const st = fs.statSync(it.abs);
    if (it.type === '5') {
      chunks.push(header(rel.replace(/\/?$/, '/'), 0, '5', it.mode, MTIME));
      continue;
    }
    const data = fs.readFileSync(it.abs);
    chunks.push(header(rel, data.length, '0', it.mode, MTIME));
    chunks.push(data);
    chunks.push(pad(data.length));
    files++;
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));      // 归档结束：两个全零块

  const tarBuf = Buffer.concat(chunks);
  const gz = zlib.gzipSync(tarBuf, { level: 9 });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, gz);
  return { files, bytes: gz.length };
}

module.exports = { writeTarGz };
