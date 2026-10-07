'use strict';
/**
 * Docker 部署配置静态校验
 *
 * 为什么需要它：Docker Desktop 要 WSL2，装完还得重启电脑才能起引擎。
 * 在没法真跑容器的时候，至少把这些**静态就能查出来的错**先排掉：
 *   · compose / Dockerfile 语法
 *   · 服务之间的依赖是否成环、depends_on 引用的服务是否存在
 *   · 健康检查门控用的 condition 是不是合法值
 *   · .env.example 里有没有漏掉 compose 引用的变量（漏了会导致 `:?` 直接拒绝启动）
 *   · Dockerfile 要 COPY 的文件/目录在仓库里是否真的存在
 *   · 挂载路径、端口是否自相矛盾
 *
 * 这些是私有化部署最容易翻车的点，且**不需要 Docker 就能验**。
 *
 * 用法： node tools/verify-compose.js
 */
const fs = require('node:fs');
const path = require('node:path');

let yaml;
try { yaml = require('js-yaml') } catch {
  console.error('  需要 js-yaml：npm install js-yaml');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

console.log('  Docker 部署配置静态校验');
console.log('  ' + '='.repeat(58));

// ── 1. compose 语法与结构 ──
console.log('\n[1] docker-compose.yml');
let compose = null;
try {
  compose = yaml.load(read('docker-compose.yml'));
  check('YAML 语法正确', true);
} catch (e) {
  check('YAML 语法正确', false, e.message.split('\n')[0]);
}

if (compose) {
  const svc = compose.services || {};
  const names = Object.keys(svc);
  check('声明了 3 个服务', names.length === 3, names.join(', '));
  check('有 app 服务', !!svc.app);
  check('有 postgres 服务', !!svc.postgres);
  check('有 minio 服务', !!svc.minio);

  // 依赖必须指向真实存在的服务，且不能成环
  let depOk = true; let depMsg = [];
  for (const [n, s] of Object.entries(svc)) {
    for (const d of Object.keys(s.depends_on || {})) {
      if (!svc[d]) { depOk = false; depMsg.push(`${n} → ${d}（不存在）`) }
    }
  }
  check('depends_on 都指向存在的服务', depOk, depMsg.join('; ') || '没问题');

  // 健康检查门控：condition 只能是 service_started / service_healthy / service_completed_successfully
  const VALID = new Set(['service_started', 'service_healthy', 'service_completed_successfully']);
  let condOk = true; let condMsg = [];
  for (const [n, s] of Object.entries(svc)) {
    for (const [d, cfg] of Object.entries(s.depends_on || {})) {
      const c = typeof cfg === 'object' ? cfg.condition : null;
      if (c && !VALID.has(c)) { condOk = false; condMsg.push(`${n}→${d}: ${c}`) }
      // 用了 service_healthy，被依赖的服务就必须真的定义了 healthcheck
      if (c === 'service_healthy' && !(svc[d] && svc[d].healthcheck)) {
        condOk = false; condMsg.push(`${n} 等 ${d} healthy，但 ${d} 没有 healthcheck`);
      }
    }
  }
  check('depends_on 的 condition 合法，且被依赖方确实有健康检查', condOk, condMsg.join('; ') || '没问题');

  // ★ 健康检查里用的命令，必须是被依赖镜像**确实带**的工具。
  //
  // 踩过：minio 的 healthcheck 写的是 `mc ready local` —— 但 `mc` 是 MinIO 的
  // 客户端工具，精简镜像（如 chainguard 的构建）里不一定有。一旦没有，
  // 健康检查永远失败，而 app 又等它 healthy → **整个栈永远起不来**，
  // 报错还完全看不出是这个原因。
  //
  // 所以这里列一个「哪些命令是危险的」清单，加上「等 healthy 就必须有真健康检查」。
  {
    const RISKY = [/\bmc\b/, /\bcurl\b/, /\bwget\b/];   // 精简镜像里常见的缺席者
    const badHc = [];
    for (const [n, s] of Object.entries(svc)) {
      const t = (s.healthcheck && s.healthcheck.test) || [];
      const line = Array.isArray(t) ? t.join(' ') : String(t);
      if (line === 'NONE' || line.trim() === '') continue;   // 明确禁用，跳过
      if (RISKY.some(re => re.test(line))) badHc.push(`${n}: ${line}`);
    }
    check('★ 健康检查没用「精简镜像里可能没有」的命令', badHc.length === 0,
      badHc.length ? badHc.join(' | ') + '  （建议改用镜像自带命令，或把依赖降为 service_started）' : '没问题');

    // 反向：用了 service_healthy，被依赖方的健康检查就不能是禁用状态
    const disabledButWaited = [];
    for (const [n, s] of Object.entries(svc)) {
      for (const [d, cfg2] of Object.entries(s.depends_on || {})) {
        if ((typeof cfg2 === 'object' ? cfg2.condition : null) !== 'service_healthy') continue;
        const t = (svc[d].healthcheck && svc[d].healthcheck.test) || [];
        const line = Array.isArray(t) ? t.join(' ') : String(t);
        if (line === 'NONE') disabledButWaited.push(`${n} 等 ${d} healthy，但 ${d} 的健康检查是禁用的`);
      }
    }
    check('★ 等 healthy 的服务，其健康检查确实是启用的', disabledButWaited.length === 0,
      disabledButWaited.join('; ') || '没问题');
  }

  // 数据必须落在宿主机目录，否则删容器就丢数据
  const app = svc.app || {};
  const appVols = (app.volumes || []).join(' ');
  check('★ app 的数据目录挂到了宿主机', /\.\/data/.test(appVols), appVols || '（没挂）');
  check('★ app 的备份目录挂到了宿主机', /\.\/backup/.test((app.volumes || []).join(' ')));
  check('★ postgres 数据挂到了 ./data/pgdata',
    (svc.postgres.volumes || []).some(v => v.includes('./data/pgdata')),
    (svc.postgres.volumes || []).join(' '));
  check('★ minio 数据挂到了 ./data/minio',
    (svc.minio.volumes || []).some(v => v.includes('./data/minio')),
    (svc.minio.volumes || []).join(' '));

  // restart 策略：客户电脑重启后服务要能自己回来
  const noRestart = Object.entries(svc).filter(([, s]) => !s.restart).map(([n]) => n);
  check('每个服务都设了 restart 策略', noRestart.length === 0, noRestart.join(', ') || '都有');

  // app 必须配对了 DB_URL 和 STORAGE_DRIVER，否则会退回单机模式
  const appEnv = app.environment || {};
  check('★ app 配了 DB_URL（否则会退回 SQLite）', !!appEnv.DB_URL);
  check('★ app 配了 STORAGE_DRIVER=minio', appEnv.STORAGE_DRIVER === 'minio', String(appEnv.STORAGE_DRIVER));
  check('app 里的 postgres 主机名用的是服务名（不是 localhost）',
    /@postgres:5432/.test(String(appEnv.DB_URL)), String(appEnv.DB_URL).slice(0, 60));
  check('app 里的 minio 端点用的是服务名（不是 localhost）',
    appEnv.MINIO_ENDPOINT === 'minio', String(appEnv.MINIO_ENDPOINT));
}

// ── 2. .env.example 变量覆盖 ──
console.log('\n[2] .env.example 变量覆盖');
const envExample = exists('.env.example') ? read('.env.example') : '';
check('.env.example 存在', !!envExample);

if (compose) {
  // 收集 compose 里用到的 ${VAR} / ${VAR:-默认} / ${VAR:?必填}
  const used = new Set();
  const raw = read('docker-compose.yml');
  for (const m of raw.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)) used.add(m[1]);
  const declared = new Set();
  // 注释掉的也算「有说明」：可选变量（比如 AI 那些）通常就是这么给的，
  // 客户不填也没关系，只要模板里写清楚了就行。
  for (const m of envExample.matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)) declared.add(m[1]);

  const missing = [...used].filter(v => !declared.has(v));
  check('compose 引用的变量都在 .env.example 里', missing.length === 0,
    missing.length ? '缺：' + missing.join(', ') : `${used.size} 个变量都有`);

  // 必填（用了 :?）的变量一定要在模板里出现，否则客户漏填就起不来
  const required = [...raw.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)].map(m => m[1]);
  const missingReq = [...new Set(required)].filter(v => !declared.has(v));
  check('标了「必填」的变量也有说明', missingReq.length === 0,
    missingReq.length ? '缺：' + missingReq.join(', ') : required.length + ' 个必填项都有');

  // ★ 标了「必填」的变量在 .env.example 里必须是**空值**。
  // 踩过：以前写的是 `PG_PASSWORD=请改成你自己的强密码` —— 那是个字面值，
  // compose 的 :? 认为「已填」，于是**用这个中文占位符当数据库密码把容器起起来了**。
  // 客户复制完不编辑也能跑，密码却是占位符。改成空值后，未编辑就直接拒绝启动
  // 并告诉你缺哪一项 —— 大声失败好过悄悄用一个假密码。
  // 只对**密码类**变量要求留空 —— 用户名（比如 MINIO_ACCESS_KEY）给个默认值
  // 反而方便，没必要逼客户改。真正的风险是「拿占位符当密码跑起来」。
  const secretLike = [...new Set(required)].filter(v => /PASSWORD|SECRET/i.test(v));
  const requiredEmpty = secretLike.filter(v => {
    const m = envExample.match(new RegExp('^' + v + '=(.*)$', 'm'));
    return m && m[1].trim() !== '';
  });
  check('★ 密码类必填项在 .env.example 里是空值（不会拿占位符当密码跑）', requiredEmpty.length === 0,
    requiredEmpty.length ? '仍是字面值：' + requiredEmpty.join(', ') : secretLike.join(', ') + ' 都是空的');
}

// ── 3. Dockerfile ──
console.log('\n[3] Dockerfile');
const df = exists('Dockerfile') ? read('Dockerfile') : '';
check('Dockerfile 存在', !!df);
if (df) {
  check('从 node:22 起（node:sqlite 需要 22+）', /FROM\s+node:2[2-9]/.test(df), (df.match(/FROM\s+\S+/) || [''])[0]);
  check('设了时区（否则日志和「今天」差 8 小时）', /TZ=Asia\/Shanghai/.test(df));
  check('有健康检查（compose 靠它判断可用性）', /HEALTHCHECK/.test(df));
  check('暴露 8787', /EXPOSE\s+8787/.test(df));

  // COPY 的源必须在仓库里真实存在 —— 这是最容易犯的错（写错路径在 build 时才报）
  const copies = [...df.matchAll(/^COPY\s+(.+)$/gm)].map(m => m[1].trim());
  let copyOk = true; const copyMsg = [];
  for (const c of copies) {
    // 形如 "a.js b.js ./" 或 "tools ./tools"
    const parts = c.split(/\s+/).filter(Boolean);
    const srcs = parts.slice(0, -1);
    for (const s of srcs) {
      // 支持通配符：COPY *.js ./ 这种很常见，直接用 exists 查「*.js」当然找不到
      if (s.includes('*')) {
        const re = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        const hit = fs.readdirSync(ROOT).some(f2 => re.test(f2));
        if (!hit) { copyOk = false; copyMsg.push(s + '（通配符没匹配到任何文件）') }
      } else if (!exists(s)) {
        copyOk = false; copyMsg.push(s);
      }
    }
  }
  check('★ COPY 的源在仓库里都存在', copyOk, copyMsg.length ? '缺：' + copyMsg.join(', ') : `${copies.length} 条 COPY 都对`);
  check('先装依赖再拷代码（利用构建缓存）',
    df.indexOf('COPY package.json') < df.indexOf('COPY *.js'), '顺序正确');
  check('生产镜像不装 devDependencies', /--omit=dev|--production/.test(df));
}

// ── 4. 辅助脚本 ──
console.log('\n[4] 客户会用到的脚本');
for (const f of ['start.bat', 'stop.bat', 'tools/install-docker.bat']) {
  check(`${f} 存在`, exists(f));
}
// bat 必须是 GBK，否则 cmd 里中文全乱码
// 粗判：含非 ASCII 字节时，检查能否按 GBK 双字节序列走完
function looksLikeGbk (buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 127) {
      if (buf[i] >= 0x81 && buf[i] <= 0xFE && buf[i + 1] >= 0x40 && buf[i + 1] <= 0xFE) { i++; continue }
      return false;
    }
  }
  return true;
}
for (const f of ['start.bat', 'stop.bat', 'tools/install-docker.bat']) {
  if (!exists(f)) continue;
  const buf = fs.readFileSync(path.join(ROOT, f));
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  check(`${f} 不是 UTF-8 BOM（cmd 才不会乱码）`, !hasBom, hasBom ? '有 BOM' : '无 BOM');
  check(`${f} 中文按 GBK 编码`, looksLikeGbk(buf));
}

// ── 5. app 端是否真的支持这些环境变量 ──
console.log('\n[5] 程序端真的认这些变量吗');
const serverJs = read('server.js');
check('★ server.js 认 PMS_COMPANY_NAME', serverJs.includes('PMS_COMPANY_NAME'));
check('★ server.js 认 PMS_ADMIN_PASSWORD', serverJs.includes('PMS_ADMIN_PASSWORD'));
check('★ db-driver.js 认 DB_URL', read('db-driver.js').includes('DB_URL'));
check('★ storage.js 认 STORAGE_DRIVER', read('storage.js').includes('STORAGE_DRIVER'));
check('★ 升级机制会在启动时跑迁移', serverJs.includes('migrations.js') || read('db.js').includes('migrations.js'));
check('★ 升级前会自动备份', read('migrations.js').includes('升级前备份失败'));

// ── 6. 有 Docker CLI 就用**官方工具**再验一遍 ──
//
// 上面那些是我手写的静态检查，只能查我能想到的问题。
// `docker compose config` 是官方解析器 —— 它能验 schema、变量插值、
// healthcheck 格式等，比手写的权威得多，而且**不需要引擎在跑**（纯解析）。
// 装完 Docker Desktop 但还没重启的情况下也能用（CLI 已可用、引擎不可用）。
console.log('\n[6] 官方工具校验（docker compose config，不需要引擎）');
const dockerCands = [
  'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  'docker',
];
let dockerExe = null;
for (const c of dockerCands) {
  try {
    const r = require('node:child_process').spawnSync(c, ['compose', 'version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (r.status === 0) { dockerExe = c; break }
  } catch { /* 试下一个 */ }
}

if (!dockerExe) {
  console.log('  · 没找到 Docker CLI，跳过（这不影响前面的静态检查结论）');
} else {
  const env = {
    ...process.env,
    // compose 里有些变量是「必填」（:?），按客户的真实做法提供
    PG_PASSWORD: process.env.PG_PASSWORD || 'verify-only-pass',
    MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || 'verifyonly',
    MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || 'verify-only-pass',
  };
  const r = require('node:child_process').spawnSync(dockerExe, ['compose', 'config'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000, env,
  });
  check('★ 官方解析器判定 docker-compose.yml 合法', r.status === 0,
    r.status === 0 ? `Docker CLI` : String(r.stderr || '').split('\n').slice(0, 2).join(' '));

  if (r.status === 0) {
    const svc = require('node:child_process').spawnSync(dockerExe, ['compose', 'config', '--services'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000, env,
    }).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
    check('★ 官方解析出 3 个服务', svc.length === 3, svc.join(', '));

    // 挂载路径必须落在仓库的 ./data 和 ./backup 下 —— 否则删容器就丢数据
    const cfg = r.stdout;
    const okVols = ['data\\app', 'data\\minio', 'data\\pgdata', 'backup']
      .every(p => cfg.includes(p));
    check('★ 官方解析出的挂载路径都在 ./data 与 ./backup 下', okVols);

    // ★ 镜像必须真的拉得到 —— 这是唯一「不校验就一定会炸」的项。
    // 踩过：compose 里写死 minio/minio:latest，而 MinIO 已经把它从 Docker Hub 撤了
    // （denied / 404）。前面的静态检查全都通过，因为**它们从来不碰镜像仓库**；
    // 客户执行 docker compose up 时才会拉到失败，整个专业版起不来。
    const imgs = [...new Set([...cfg.matchAll(/^\s*image:\s*(\S+)/gm)].map(m => m[1]))]
      .filter(i => !i.includes('${'));   // 没解析出具体值的跳过
    // 本地构建的镜像（service 里同时有 build:）本来就不需要拉，跳过。
    // 注意必须用**解析后**的配置来判断：原始 YAML 里写的是 ${IMAGE_REPO:-elv-pms}，
    // 而解析后才是 elv-pms:1.0.0，两者对不上。
    const resolvedCfg = yaml.load(cfg);
    const builtImages = new Set(Object.values((resolvedCfg && resolvedCfg.services) || {})
      .filter(s => s && s.build).map(s => s.image).filter(Boolean));
    const pullable = imgs.filter(i => !builtImages.has(i));
    // ★ 必须把「镜像真的不存在」和「限流/网络问题」分开。
    //
    // 踩过：这条检查第一版把任何非零退出都当失败，结果我自己反复调用
    // 把 Docker Hub 的匿名配额用光了（toomanyrequests），三个镜像全"拉不到"。
    // **会误报的测试比没有测试更糟** —— 它会训练人忽略告警，
    // 等到真出问题（比如 minio/minio 撤库）时没人当回事。
    //
    // 所以：只有明确的「不存在/无权限」才算失败；限流和网络错误算「本次跳过」。
    const MISSING_RE = /(manifest unknown|not found|no such manifest|denied|unauthorized|repository does not exist|name unknown)/i;
    const INFRA_RE = /(toomanyrequests|rate limit|timeout|timed out|deadline|connection|network|TLS|EOF|503|502)/i;
    const badImgs = [];
    const skipped = [];
    for (const img of pullable) {
      const r2 = require("node:child_process").spawnSync(dockerExe, ["manifest", "inspect", img],
        { encoding: "utf8", windowsHide: true, timeout: 60000, env });
      if (r2.status === 0) continue;
      const err = String(r2.stderr || '') + String(r2.stdout || '') + String(r2.error || '');
      if (MISSING_RE.test(err)) badImgs.push(img);        // 真没有 → 失败
      else if (INFRA_RE.test(err)) skipped.push(img);     // 限流/网络 → 跳过
      else badImgs.push(img + '(原因不明)');               // 不确定就当失败，但标出来
    }
    check(`★ 声明的 ${pullable.length} 个远程镜像都能拉取到`, badImgs.length === 0,
      badImgs.length ? '拉不到：' + badImgs.join(', ')
        : (skipped.length ? `跳过 ${skipped.length} 个（限流/网络）：` + skipped.join(', ') + '；其余正常'
          : pullable.join(', ')));
  }
}

const pass = results.filter(r => r.ok).length;
console.log('\n' + '='.repeat(58));
console.log(`  Docker 配置校验：${pass} / ${results.length} 项通过`);
if (pass !== results.length) {
  console.log('  失败：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.n).join('\n'));
}
console.log('='.repeat(58));
process.exit(pass === results.length ? 0 : 1);