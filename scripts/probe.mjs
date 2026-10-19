/**
 * dsh-stock-bar / scripts/probe.mjs
 * 快速连通性探针：验证数据源在本机可用、字段解析正确。
 * 运行：node scripts/probe.mjs
 */
import { fetchQuotes, fetchKline, fetchTrends, fetchOrderBook, searchStock, normalizeSymbol, resolveSymbol } from '../lib/providers.js';

const line = (s) => console.log(s);
const ok = (s) => console.log('  [OK]   ' + s);
const bad = (s) => console.log('  [FAIL] ' + s);

let failures = 0;
async function step(name, fn) {
  line('\n== ' + name + ' ==');
  try {
    const r = await fn();
    ok(JSON.stringify(r, null, 2).split('\n').slice(0, 40).join('\n'));
    return r;
  } catch (e) {
    failures++;
    bad(e && e.message ? e.message : String(e));
    return null;
  }
}

line('symbol normalization');
for (const s of ['600519', 'sh600519', '600519.SH', '000001', '1.600519', '00700', 'hk00700', 'AAPL']) {
  line(`  ${s.padEnd(12)} -> ${JSON.stringify(normalizeSymbol(s))}`);
}
line(`  resolveSymbol(AAPL) -> ${JSON.stringify(await resolveSymbol('AAPL').catch((e) => 'ERR ' + e.message))}`);

const q = await step('fetchQuotes sh600519,sz000001,sh000001,hk00700', () =>
  fetchQuotes(['sh600519', 'sz000001', 'sh000001', 'hk00700']).then((m) => Object.fromEntries(m)),
);

await step('fetchKline sh600519 day x5', async () => {
  const k = await fetchKline('sh600519', { period: 'day', count: 5, adjust: 'pre' });
  return { symbol: k.symbol, name: k.name, n: k.candles.length, last: k.candles[k.candles.length - 1] };
});

await step('searchStock 贵州 / gzmt / 000001', async () => {
  const a = await searchStock('贵州茅台', 3);
  const b = await searchStock('gzmt', 3);
  const c = await searchStock('000001', 3);
  return { byName: a.slice(0, 2), byPinyin: b.slice(0, 2), byCode: c.slice(0, 3) };
});

await step('fetchTrends sh600519 1d', async () => {
  const t = await fetchTrends('sh600519', { days: 1 });
  const first = t.points[0];
  const last = t.points[t.points.length - 1];
  return {
    symbol: t.symbol, name: t.name, prevClose: t.prevClose, n: t.points.length,
    first, last,
    hasAvgLine: t.points.every((p) => Number.isFinite(p.avg)),
    // 均价线必须落在当日最高最低之间
    avgInRange: t.points.every((p) => p.avg >= (t.low ?? 0) && p.avg <= (t.high ?? Infinity)) || 'see last',
  };
});

await step('fetchTrends sz000001 5d', async () => {
  const t = await fetchTrends('sz000001', { days: 5 });
  return { symbol: t.symbol, days: t.days, n: t.points.length, firstTime: t.points[0]?.time, lastTime: t.points[t.points.length - 1]?.time };
});

await step('fetchOrderBook sh600519', async () => {
  const b = await fetchOrderBook('sh600519');
  return {
    symbol: b.symbol, name: b.name, price: b.price, prevClose: b.prevClose,
    asks: b.asks, bids: b.bids,
    bidVolume: b.bidVolume, askVolume: b.askVolume,
    commissionDiff: b.commissionDiff, commissionRatio: b.commissionRatio,
    // 卖一 >= 现价 >= 买一，且卖1..卖5 递增、买1..买5 递减
    priceBetween: b.price >= b.bids[0].price && b.price <= b.asks[0].price,
    asksAscending: b.asks.every((r, i) => i === 0 || r.price >= b.asks[i - 1].price),
    bidsDescending: b.bids.every((r, i) => i === 0 || r.price <= b.bids[i - 1].price),
  };
});

await step('fetchOrderBook 指数应报错（无盘口）', async () => {
  try {
    await fetchOrderBook('sh000001');
    return 'UNEXPECTED-SUCCESS';
  } catch (e) {
    return { expected: 'throw', message: e.message };
  }
});

// 腾讯备源单独验证（走 GBK 解码）
await step('tencent fallback (direct)', async () => {
  const res = await fetch('https://qt.gtimg.cn/q=sh600519', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const buf = await res.arrayBuffer();
  let txt;
  try {
    txt = new TextDecoder('gbk').decode(buf);
  } catch (e) {
    txt = 'GBK-DECODER-UNAVAILABLE: ' + e.message;
  }
  return { status: res.status, head: txt.slice(0, 160) };
});

// 新浪作为第三备源候选
await step('sina probe', async () => {
  const res = await fetch('https://hq.sinajs.cn/list=sh600519', {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' },
  });
  const buf = await res.arrayBuffer();
  return { status: res.status, head: new TextDecoder('gbk').decode(buf).slice(0, 160) };
});

line('\n==== failures: ' + failures + ' ====');
process.exit(failures ? 1 : 0);
