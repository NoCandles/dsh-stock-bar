/**
 * 证明客户端半真的被 DSH 装配并对外提供了。
 *
 * DSH 的 dsh-client-modules 用「构件元数据 hash」当缓存版本号：
 *   rev = sha1("plugin-artifact" + "\0" + 逐段带长度前缀拼接).slice(0, 12)
 *   段 = [String(mtimeMs), String(ctimeMs), String(size)]   (lib/index.js:187-197, 795-803)
 * 路由只认精确 URL：/plugins/??<id>/client.js&rev=<rev>      (lib/index.js:200-218, 958-972)
 * 所以只要我能自己算出 rev 并拿到 200 + 我们自己的 bundle 内容，
 * 就说明注册表里确实有 dsh-stock-ticker 这一行。
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CLIENT_PATH = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:19387';
const ID = 'dsh-stock-ticker';

function framedHash(domain, parts, len) {
  const h = createHash('sha1').update(domain).update('\0');
  for (const p of parts) h.update(`${String(Buffer.byteLength(p))}:`).update(p);
  return h.digest('hex').slice(0, len);
}

const st = statSync(CLIENT_PATH);
const parts = [String(st.mtimeMs), String(st.ctimeMs), String(st.size)];
console.log(`client.js: ${CLIENT_PATH}`);
console.log(`  size=${st.size} mtimeMs=${st.mtimeMs} ctimeMs=${st.ctimeMs}`);

let ok = false;
for (const len of [12, 8, 16, 10, 7]) {
  const rev = framedHash('plugin-artifact', parts, len);
  const url = `${BASE}/plugins/??${ID}/client.js&rev=${rev}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.log(`  len=${len} rev=${rev} -> 网络错误 ${e.message}`);
    continue;
  }
  const body = res.ok ? await res.text() : '';
  const marker = body.includes('__ModuleLoader__') && body.includes(ID);
  console.log(`  len=${len} rev=${rev} -> HTTP ${res.status}  ${body.length} bytes  含本插件标记=${marker}`);
  if (res.ok && marker) {
    ok = true;
    console.log(`\n  命中 URL: ${url}`);
    console.log(`  content-type: ${res.headers.get('content-type')}`);
    console.log(`  cache-control: ${res.headers.get('cache-control')}`);
    const head = body.slice(0, 220).replace(/\n/g, ' ');
    console.log(`  body 开头: ${head}`);
  }
}

console.log(ok ? '\nOK 客户端 bundle 已对外提供（说明注册表里有这个条目）' : '\nFAIL 没有拿到客户端 bundle');
process.exit(ok ? 0 : 1);
