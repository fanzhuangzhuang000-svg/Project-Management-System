'use strict';
/**
 * MinIO 对象存储（专业版 / 网络版）
 *
 * 附件不再放本地磁盘，而是放进 MinIO（S3 兼容协议）。
 * 好处：多个 app 实例可以共享同一份附件、备份直接备份 MinIO 数据卷、
 *      客户机磁盘满了也不影响。
 *
 * ── 为什么本地还要有一份缓存 ──
 * OCR 引擎要读**本地文件**（Windows OCR / pdfjs 都只认文件路径）。
 * 所以 localPath() 会把对象下载到 data/attach-cache/ 下，用完由 release() 清掉。
 *
 * ── 同步/异步 ──
 * minio 客户端是异步的，业务层是同步的。用 sync-bridge 包装成同步调用，
 * 和 PostgreSQL 那边同一套办法。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createBridge } = require('./sync-bridge.js');

const DRIVER = 'minio';

// worker 里干活的代码。单独写成字符串，避免 eval 里引用外部作用域。
const WORKER_SRC = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { workerData, parentPort } = require('node:worker_threads');
const port = workerData.port;

let client = null;
let bucket = null;

async function ensure () {
  if (client) return;
  const Minio = require(workerData.minioPath);
  const Ctor = Minio.Client || (Minio.default && Minio.default.Client) || Minio;
  client = new Ctor({
    endPoint: workerData.endPoint,
    port: workerData.port_,
    useSSL: !!workerData.useSSL,
    accessKey: workerData.accessKey,
    secretKey: workerData.secretKey,
    // path-style：bucket 出现在 URL 路径里。MinIO 两种都支持，
    // 走网关/反向代理时通常需要它，测试用的模拟服务也只实现这一种
    pathStyle: workerData.pathStyle !== false,
  });
  bucket = workerData.bucket;
  const exists = await client.bucketExists(bucket).catch(() => false);
  if (!exists) {
    await client.makeBucket(bucket).catch((e) => {
      // 并发启动时另一个实例可能刚好建好了，这种情况不算错
      if (!/already exists|BucketAlreadyOwnedByYou/i.test(e.message)) throw e;
    });
  }
}

async function handle (m) {
  if (m.kind === '__close__') return null;
  await ensure();

  switch (m.kind) {
    case 'save': {
      const buf = Buffer.from(m.data || '', 'base64');
      await client.putObject(bucket, m.key, buf, buf.length);
      return m.key;
    }
    case 'remove':
      await client.removeObject(bucket, m.key);
      return true;
    case 'exists':
      try { await client.statObject(bucket, m.key); return true } catch { return false }
    case 'size': {
      try { const s = await client.statObject(bucket, m.key); return s.size || 0 } catch { return 0 }
    }
    case 'download': {
      // 下到本地缓存，OCR / 下载接口都需要一个真实文件路径
      fs.mkdirSync(path.dirname(m.dest), { recursive: true });
      let stream;
      try { stream = await client.getObject(bucket, m.key) } catch { return null }
      await new Promise((res, rej) => {
        const ws = fs.createWriteStream(m.dest);
        stream.pipe(ws);
        ws.on('finish', res);
        ws.on('error', rej);
        stream.on('error', rej);
      });
      return m.dest;
    }
    case 'list': {
      const out = [];
      await new Promise((res, rej) => {
        const s = client.listObjectsV2(bucket, m.prefix || '', true);
        s.on('data', (o) => { if (o.name) out.push({ key: o.name, size: o.size || 0 }) });
        s.on('end', res);
        s.on('error', rej);
      });
      return out;
    }
    default:
      throw new Error('未知操作：' + m.kind);
  }
}

port.on('message', (m) => {
  const i32 = new Int32Array(m.sab);
  handle(m).then(
    (result) => { port.postMessage({ id: m.id, ok: true, result }); },
    (err) => { port.postMessage({ id: m.id, ok: false, error: err.message || String(err) }); }
  ).finally(() => { Atomics.store(i32, 0, 1); Atomics.notify(i32, 0); });
});
`;

function create (opts = {}) {
  const endPoint = opts.endPoint || process.env.MINIO_ENDPOINT || '127.0.0.1';
  const portNum = Number(opts.port || process.env.MINIO_PORT || 9000);
  const useSSL = String(opts.useSSL ?? process.env.MINIO_USE_SSL ?? 'false') === 'true';
  const accessKey = opts.accessKey || process.env.MINIO_ACCESS_KEY || 'minioadmin';
  const secretKey = opts.secretKey || process.env.MINIO_SECRET_KEY || 'minioadmin';
  const bucket = opts.bucket || process.env.MINIO_BUCKET || 'elv-pms';
  const pathStyle = String(opts.pathStyle ?? process.env.MINIO_PATH_STYLE ?? 'true') !== 'false';
  const cacheDir = opts.cacheDir || path.join(opts.dataDir || path.join(__dirname, 'data'), 'attach-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  let minioPath;
  try {
    minioPath = require.resolve('minio');
  } catch {
    throw new Error(
      'STORAGE_DRIVER=minio 需要 minio 客户端，但当前环境里没装。\n' +
      '  · 网络版/专业版：在项目目录执行  npm install  后再启动\n' +
      '  · 单机版：不需要 MinIO，用默认的本地存储即可（不要设 STORAGE_DRIVER）'
    );
  }

  const bridge = createBridge(WORKER_SRC, {
    minioPath, endPoint, port_: portNum, useSSL, accessKey, secretKey, bucket, pathStyle,
  }, { name: 'MinIO', timeoutMs: 120000 });

  const call = (msg) => bridge.call(msg);

  /** 缓存文件名用存储键的哈希，避免键里的目录分隔符搞出层级 */
  const cachePathOf = (key) =>
    path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex') + path.extname(key));

  return {
    driver: DRIVER,
    baseDir: `minio://${endPoint}:${portNum}/${bucket}`,
    describe: () => `MinIO  ${endPoint}:${portNum}/${bucket}`,
    cacheDir,

    save (key, buffer) {
      call({ kind: 'save', key, data: Buffer.from(buffer).toString('base64') });
      return key;
    },

    remove (key) {
      try { call({ kind: 'remove', key }); return true } catch { return false }
    },

    exists (key) {
      try { return !!call({ kind: 'exists', key }) } catch { return false }
    },

    size (key) {
      try { return call({ kind: 'size', key }) || 0 } catch { return 0 }
    },

    /**
     * 拿到本地可读路径。
     * 已经在缓存里就直接用，没有再下载 —— OCR 一次可能被调好几次，
     * 每次都下会白白浪费带宽。
     */
    localPath (key) {
      const dest = cachePathOf(key);
      if (fs.existsSync(dest)) return dest;
      const got = call({ kind: 'download', key, dest });
      if (!got) throw new Error('对象存储里找不到这个附件：' + key);
      return got;
    },

    /** 用完清掉缓存文件（本地存的是副本，删了不影响 MinIO 里的正本） */
    release (key) {
      if (!key) return;
      try { fs.unlinkSync(cachePathOf(key)) } catch { /* 不存在就算了 */ }
    },

    list (prefix = '') {
      return call({ kind: 'list', prefix }) || [];
    },

    close () { bridge.close() },
  };
}

module.exports = { create, DRIVER };
