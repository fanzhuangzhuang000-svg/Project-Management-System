'use strict';
/**
 * 最小 S3 兼容服务（只给测试用，别拿去当生产存储）
 *
 * 为什么需要它：MinIO 官方下载地址已改成 410/404，机器上拿不到服务端。
 * 但我要验证的是**我这边的集成**（同步桥 → minio 客户端 → 真实 HTTP → 对象存储），
 * 不是 MinIO 本身。所以起一个只实现必要动作的本地服务就够了，走真实网络路径。
 *
 * ⚠️ 必须跑在**独立进程**：业务侧 storage.save() 用 Atomics.wait 阻塞主线程，
 *    服务若跑在主线程就永远没机会响应 → 死锁。生产环境 MinIO 是独立容器，无此问题。
 *
 * ⚠️ S3 客户端对响应格式很挑：
 *    - 错误必须是 XML 体（只回 404 空体，客户端会当成 S3Error 而不是「不存在」）
 *    - PUT 必须回 ETag，否则客户端判定写入失败
 *
 * 用法：node tools/minio-mock-server.js 9100
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] || 9100);
const objects = new Map();   // "bucket/key" -> Buffer
const buckets = new Set();

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** S3 的错误响应必须是 XML */
function errBody (code, msg) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Error><Code>' + code + '</Code><Message>' + xmlEscape(msg) + '</Message>'
    + '<RequestId>mock</RequestId><HostId>mock</HostId></Error>';
}

function sendErr (res, status, code, msg) {
  const body = errBody(code, msg);
  res.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  // path-style：/bucket 或 /bucket/key
  const parts = url.pathname.replace(/^\//, '').split('/');
  const bucket = parts.shift();
  const key = decodeURIComponent(parts.join('/'));

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const full = bucket + '/' + key;

    // 桶是否存在（HEAD 不能有响应体，但要给出正确的类型和长度）
    if (req.method === 'HEAD' && !key) {
      if (buckets.has(bucket)) { res.writeHead(200); return res.end() }
      const b = errBody('NoSuchBucket', 'bucket not found');
      res.writeHead(404, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(b) });
      return res.end();
    }
    // 建桶
    if (req.method === 'PUT' && !key) {
      buckets.add(bucket);
      res.writeHead(200, { 'Content-Length': 0 });
      return res.end();
    }
    // 列对象（ListObjectsV2）
    if (req.method === 'GET' && !key && url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') || '';
      const matched = [...objects.entries()].filter(([k]) => k.startsWith(full + prefix));
      const items = matched.map(([k, v]) =>
        '<Contents><Key>' + xmlEscape(k.slice(full.length)) + '</Key><Size>' + v.length + '</Size>'
        + '<LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"x"</ETag>'
        + '<StorageClass>STANDARD</StorageClass></Contents>').join('');
      const xml = '<?xml version="1.0" encoding="UTF-8"?>'
        + '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        + '<Name>' + xmlEscape(bucket) + '</Name><Prefix>' + xmlEscape(prefix) + '</Prefix>'
        + '<KeyCount>' + matched.length + '</KeyCount><MaxKeys>1000</MaxKeys>'
        + '<IsTruncated>false</IsTruncated>' + items + '</ListBucketResult>';
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(xml);
    }
    // 取对象 / 看元信息
    if ((req.method === 'GET' || req.method === 'HEAD') && key) {
      const v = objects.get(full);
      if (!v) return sendErr(res, 404, 'NoSuchKey', 'object not found');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': v.length });
      return req.method === 'HEAD' ? res.end() : res.end(v);
    }
    // 存对象：必须回 ETag
    if (req.method === 'PUT' && key) {
      objects.set(full, body);
      const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
      res.writeHead(200, { ETag: etag, 'Content-Length': 0 });
      return res.end();
    }
    // 删对象
    if (req.method === 'DELETE' && key) {
      objects.delete(full);
      res.writeHead(204);
      return res.end();
    }
    // 桶上的其它 GET（ListObjects V1、?location 探测等）：一律回一个空的列表结果
    if (req.method === 'GET' && !key) {
      const xml = '<?xml version="1.0" encoding="UTF-8"?>'
        + '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        + '<Name>' + xmlEscape(bucket) + '</Name><Prefix></Prefix>'
        + '<KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>'
        + '</ListBucketResult>';
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(xml);
    }
    return sendErr(res, 400, 'BadRequest', 'unsupported: ' + req.method + ' ' + url.pathname);
  });
});

srv.listen(PORT, '127.0.0.1', () => {
  console.log('mock s3 ready on ' + PORT);
});
