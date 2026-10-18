/**
 * dsh-stock-ticker / scripts/verify.mjs
 *
 * Host 半边集成自检：用一个假的 Cordis ctx 真跑 apply()，把注册出来的每条路由
 * 用假的 req/res 走一遍，断言返回的 JSON。不依赖 DSH 运行时，不需要装插件。
 *
 *   node scripts/verify.mjs          常规自检（含真实网络请求）
 *   node scripts/verify.mjs --offline  只跑不联网的部分
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, marketStatus, ROUTE_PREFIX } from '../lib/index.js';

const OFFLINE = process.argv.includes('--offline');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
  }
}

function section(t) {
  console.log(`\n== ${t} ==`);
}

/** 跳过一段断言（不记失败）：用在"上游行情源挂了"这种与插件无关的情况 */
function note(msg) {
  console.log(`  --   ${msg}`);
}

/**
 * 上游挂了长什么样：插件把 fetch 失败包成了 200 + { ok:false, error:"fetch failed" }。
 * 这一类必须和"插件算错了"区分开，否则每次对方掐连接都会误报成插件有 bug。
 */
function upstreamDown(r) {
  if (!r || !r.json || r.json.ok !== false) return false;
  return /fetch failed|timeout|timed out|ECONN|socket|network|aborted/i.test(String(r.json.error));
}

/* ---------------- 假 Cordis 上下文 ---------------- */

function makeCtx() {
  const routes = new Map();
  const ctx = {
    routes,
    effects: [],
    logs: [],
    llm: null,
    defaultModel: null,
    logger: {
      info: (m) => ctx.logs.push(['info', String(m)]),
      warn: (m) => ctx.logs.push(['warn', String(m)]),
      error: (m) => ctx.logs.push(['error', String(m)]),
    },
    effect(fn, label) {
      const disposer = fn();
      ctx.effects.push({ label, disposer });
      return disposer;
    },
    /** 惰性读取可选服务：宿主挂没挂 llm 都要能跑 */
    get(name) {
      if (name === 'llm') return ctx.llm || undefined;
      if (name === 'agentDefaultModel') return ctx.defaultModel || undefined;
      return undefined;
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`重复路由: ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  return ctx;
}

/**
 * 假模型服务：只实现插件真正用到的那几个方法
 * （listProviders / listModels / stream），并记录收到的请求。
 */
function makeFakeLlm({ chunks, listModelsThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'deep', name: 'deep' }, { id: 'broken', name: 'broken' }],
    async listModels(provider) {
      if (provider === 'broken' || listModelsThrows) throw new Error(`provider ${provider} 没配密钥`);
      return [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '快' }];
    },
    stream(options) {
      calls.push(options);
      const seq = chunks || [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '看' },
        { type: 'text-delta', index: 0, text: '多' },
        { type: 'reasoning-delta', index: 1, text: '先想想' },
        { type: 'usage', usage: { inputTokens: 1234, outputTokens: 2, totalTokens: 1236 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      return (async function* gen() {
        for (const c of seq) yield c;
      })();
    },
  };
}

function makeReq(method, url, body) {
  const chunks = [];
  if (body !== undefined && body !== null) chunks.push(Buffer.from(JSON.stringify(body)));
  const listeners = {};
  return {
    method,
    url,
    on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); },
    emit(evt, ...args) { for (const fn of listeners[evt] || []) fn(...args); },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function makeRes() {
  const res = {
    status: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers || {};
      res.headersSent = true;
    },
    write(chunk) { res.body += String(chunk); return true; },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk);
      res.headersSent = true;
      res.writableEnded = true;
    },
    destroy() { res.destroyed = true; },
  };
  return res;
}

/** 把 NDJSON 响应切成对象数组 */
function ndjson(raw) {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return { type: 'unparsed', raw: l }; }
    });
}

/** 通过注册表派发一次请求 */
async function call(ctx, pathWithQuery, { method = 'GET', body } = {}) {
  const pathname = pathWithQuery.split('?')[0];
  const route = ctx.routes.get(ROUTE_PREFIX + pathname);
  if (!route) throw new Error(`路由未注册: ${ROUTE_PREFIX}${pathname}`);
  const req = makeReq(method, ROUTE_PREFIX + pathWithQuery, body);
  const res = makeRes();
  await route.handler(req, res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch { /* 流式响应解析不出来，用 lines */ }
  return { status: res.status, json, raw: res.body, headers: res.headers, lines: ndjson(res.body), req };
}

/* ---------------- 开始 ---------------- */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stock-ticker-verify-'));
const storePath = path.join(tmpDir, 'portfolio.json');
const symbol = 'sh600519';

console.log(`临时存储: ${storePath}`);
console.log(`模式: ${OFFLINE ? '离线' : '联网'}`);

const ctx = makeCtx();
apply(ctx, { storePath });

section('路由注册');
const ROUTE_LIST = [
  '/state', '/kline', '/trends', '/orderbook', '/search', '/trades', '/health',
  '/items/save', '/items/remove', '/settings/save',
  '/trades/save', '/trades/remove', '/trades/clear', '/trades/apply',
  '/alerts/save', '/alerts/remove', '/alerts/ack',
  '/ai/models', '/ai/analyze',
];
check(`注册了 ${ROUTE_LIST.length} 条路由`, ctx.routes.size === ROUTE_LIST.length, [...ctx.routes.keys()]);
for (const p of ROUTE_LIST) {
  check(`存在 ${ROUTE_PREFIX}${p}`, ctx.routes.has(ROUTE_PREFIX + p));
}
check('全部为 exact 路由', [...ctx.routes.values()].every((r) => r.kind === 'exact'));
check('每条路由都有 handler', [...ctx.routes.values()].every((r) => typeof r.handler === 'function'));
check('ctx.effect 被用于注册（可随插件 fiber 卸载）', ctx.effects.length === ROUTE_LIST.length, ctx.effects.map((e) => e.label));

section('交易时段判断');
const ms = marketStatus();
check('marketStatus 返回结构完整', ['open', 'session', 'label', 'shanghai'].every((k) => k in ms), ms);
check('shanghai 形如 HH:MM', /^\d{2}:\d{2}$/.test(ms.shanghai), ms.shanghai);
{
  // 2026-10-16 是周五；用固定时刻验证分段逻辑
  const at = (iso) => marketStatus(new Date(iso));
  check('周五 10:00 = 交易中', at('2026-10-16T10:00:00+08:00').session === 'morning');
  check('周五 12:00 = 午间休市', at('2026-10-16T12:00:00+08:00').session === 'lunch');
  check('周五 14:00 = 交易中', at('2026-10-16T14:00:00+08:00').session === 'afternoon');
  check('周五 16:00 = 已收盘', at('2026-10-16T16:00:00+08:00').session === 'closed');
  check('周六 = 周末休市', at('2026-10-17T10:00:00+08:00').label === '周末休市');
}

section('GET /health');
{
  const r = await call(ctx, '/health');
  check('HTTP 200', r.status === 200, r.status);
  check('JSON ok', r.json && r.json.ok === true);
  check(`storePath 指向临时文件`, r.json.storePath === storePath, r.json.storePath);
  check('首次启动已种入 3 条大盘指数', r.json.itemCount === 3, r.json.itemCount);
  check('新库流水数为 0', r.json.tradeCount === 0, r.json.tradeCount);
  check('新库预警数为 0', r.json.alertCount === 0, r.json.alertCount);
  check('已实现盈亏初始为 0', r.json.realizedPnl === 0, r.json.realizedPnl);
  check('上报了缓存规模（被 LRU 卡住）', !!r.json.caches && r.json.caches.max === 200, r.json.caches);
  check('盘口探针单独取样', !!r.json.bookSymbol, r.json.bookSymbol);
  if (!OFFLINE) {
    check('行情源可用', r.json.quoteOk === true, r.json.quoteErr || r.json.sample);
    check('K线源可用', r.json.klineOk === true);
    check('分时源可用', r.json.trendOk === true, r.json.trendPoints);
    check('分时返回 240+ 点（一个交易日）', r.json.trendPoints >= 240, r.json.trendPoints);
    check('盘口源可用（探测标的为指数时应为 false 但不报错）', typeof r.json.bookOk === 'boolean', r.json.bookLevels);
    check('盘口探针选的不是指数', !/^sh000001$/.test(r.json.bookSymbol) || r.json.bookOk === false, r.json.bookSymbol);
    check('行情带 provider 标记', !!r.json.sample && !!r.json.sample.provider, r.json.sample);
  }
}

section('存储落盘');
check('portfolio.json 已生成', fs.existsSync(storePath));
{
  const disk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('落盘结构含 settings/items', !!disk.settings && Array.isArray(disk.items));
  check('落盘包含指数', disk.items.some((i) => i.index === true));
}

section('POST /settings/save');
{
  const r = await call(ctx, '/settings/save', { method: 'POST', body: { refreshMs: 3000, scroll: false } });
  check('保存成功', r.json.ok === true, r.json);
  check('refreshMs 生效', r.json.settings.refreshMs === 3000, r.json.settings.refreshMs);
  check('scroll 生效', r.json.settings.scroll === false);
  const r2 = await call(ctx, '/settings/save', { method: 'POST', body: { refreshMs: 1 } });
  check('refreshMs 被钳到下限 1000', r2.json.settings.refreshMs === 1000, r2.json.settings.refreshMs);
  const r3 = await call(ctx, '/settings/save', { method: 'POST', body: { 未知字段: 1, period: 'week' } });
  check('未知字段被忽略且不报错', r3.json.ok === true && r3.json.settings.period === 'week');
  await call(ctx, '/settings/save', { method: 'POST', body: { refreshMs: 5000, scroll: true } });
}

if (!OFFLINE) {
  section('GET /search');
  {
    const r = await call(ctx, '/search?q=' + encodeURIComponent('贵州茅台'));
    check('搜索返回命中', r.json.ok === true && r.json.hits.length > 0, r.json);
    check('命中带 secid', !!(r.json.hits[0] || {}).secid, r.json.hits[0]);
    const r2 = await call(ctx, '/search?q=gzmt');
    check('拼音搜索可用', r2.json.hits.length > 0 && r2.json.hits[0].code === '600519', r2.json.hits[0]);
    const r3 = await call(ctx, '/search?q=');
    check('空查询返回空数组', r3.json.ok === true && r3.json.hits.length === 0);
    const r4 = await call(ctx, '/search?q=' + encodeURIComponent('这个股票不存在zzz'));
    check('无结果不抛错', r4.json.ok === true && Array.isArray(r4.json.hits));
  }
}

section('POST /items/save —— 只填代码');
let price = null;
{
  const r = await call(ctx, '/items/save', { method: 'POST', body: { input: '600519' } });
  check('保存成功', r.json.ok === true, r.json);
  check('代码被规范化成 sh600519', r.json.item.symbol === symbol, r.json.item && r.json.item.symbol);
  check('名称由行情补齐', !!(r.json.item.name && r.json.item.name !== '600519'), r.json.item && r.json.item.name);
  check('未填股数时为 0', r.json.item.shares === 0);
  if (!OFFLINE) {
    check('拿得到现价', r.json.item.price > 0, r.json.item.price);
    price = r.json.item.price;
  }
}

section('POST /items/save —— 股数 + 成本价');
{
  const r = await call(ctx, '/items/save', {
    method: 'POST',
    body: { input: 'sh600519', shares: 100, cost: 1000 },
  });
  check('保存成功', r.json.ok === true, r.json);
  check('股数=100', r.json.item.shares === 100);
  check('成本=1000', r.json.item.cost === 1000);
  check('持仓标记 held', r.json.item.held === true);
  if (price) {
    check('市值 = 现价 × 100', Math.abs(r.json.item.marketValue - price * 100) < 0.01,
      { marketValue: r.json.item.marketValue, expected: price * 100 });
    check('盈亏 = 市值 - 成本100000', Math.abs(r.json.item.pnl - (price * 100 - 100000)) < 0.01,
      { pnl: r.json.item.pnl });
    check('盈亏率符号一致', Math.sign(r.json.item.pnlPct) === Math.sign(r.json.item.pnl),
      { pnl: r.json.item.pnl, pnlPct: r.json.item.pnlPct });
  }
  const list = await call(ctx, '/state');
  const matching = list.json.items.filter((i) => i.symbol === symbol);
  check('同一代码不会重复插入', matching.length === 1, matching.length);
  check('state.totals.hasPosition = true', list.json.totals.hasPosition === true, list.json.totals);
  check('state.totals 计入 CNY', list.json.totals.currency === 'CNY', list.json.totals.currency);
  if (price) {
    check('总市值 = 现价 × 100', Math.abs(list.json.totals.marketValue - price * 100) < 0.01);
  }
  check('strip 非空（行情条有内容）', list.json.strip.length > 0, list.json.strip.length);
  check('strip 含大盘指数', list.json.strip.some((p) => p.index), list.json.strip.map((p) => p.symbol));
  check('settings 随 state 返回', !!list.json.settings.refreshMs);
  check('market 随 state 返回', !!list.json.market.label);
}

section('GET /state 参数');
{
  const r = await call(ctx, '/state?fresh=1');
  check('fresh=1 可用', r.json.ok === true);
  check('响应头 no-store', r.headers && r.headers['Cache-Control'] === 'no-store', r.headers);
}

if (!OFFLINE) {
  section('GET /kline');
  {
    const r = await call(ctx, `/kline?symbol=${symbol}&period=day&count=30&adjust=pre`);
    if (upstreamDown(r)) {
      // 上游（东方财富 push2his）偶尔会直接掐连接。这是行情源的问题，不是插件的问题：
      // 插件这边已经正确返回了 200 + { ok:false, error }。这种情况只记跳过，别报成插件失败。
      note(`上游 K 线接口当前不可用（${r.json.error}），本段跳过。换网络或过一会儿再跑。`);
    } else {
      check('返回 ok', r.json.ok === true, r.json);
      check('恰好 30 根（lmt 被服务端忽略，由插件截断）', r.json.candles.length === 30, r.json.candles.length);
      const c = r.json.candles[r.json.candles.length - 1];
      check('K线字段齐全', ['date', 'open', 'close', 'high', 'low', 'volume'].every((k) => c[k] !== null && c[k] !== undefined), c);
      check('high >= low', c.high >= c.low, c);
      check('high >= max(open,close)', c.high >= Math.max(c.open, c.close), c);
      check('low <= min(open,close)', c.low <= Math.min(c.open, c.close), c);
      check('日期升序', r.json.candles[0].date < r.json.candles[29].date, [r.json.candles[0].date, r.json.candles[29].date]);

      const r2 = await call(ctx, `/kline?symbol=${symbol}&period=week&count=20`);
      check('周K 可用', r2.json.ok === true && r2.json.candles.length === 20, r2.json.candles && r2.json.candles.length);

      const r3 = await call(ctx, `/kline?symbol=${symbol}&period=5m&count=48&adjust=none`);
      check('5分钟K 可用', r3.json.ok === true && r3.json.candles.length === 48, r3.json.candles && r3.json.candles.length);
    }

    const r4 = await call(ctx, '/kline?symbol=');
    check('缺 symbol 返回结构化错误而不是崩溃', r4.json.ok === false && /symbol/.test(r4.json.error), r4.json);

    const r5 = await call(ctx, '/kline?symbol=zzzzzz');
    check('乱码代码返回结构化错误', r5.json.ok === false, r5.json);
  }

  section('多市场');
  {
    const r = await call(ctx, '/items/save', { method: 'POST', body: { input: '00700', shares: 200, cost: 300 } });
    check('港股 00700 -> hk00700', r.json.ok === true && r.json.item.symbol === 'hk00700', r.json.item && r.json.item.symbol);
    check('港股币种 HKD', r.json.item.currency === 'HKD', r.json.item.currency);
    const st = await call(ctx, '/state');
    check('港股盈亏独立按 HKD 汇总', !!st.json.totals.byCurrency.HKD, Object.keys(st.json.totals.byCurrency));
  }
}

section('POST /items/remove');
{
  const r = await call(ctx, '/items/remove', { method: 'POST', body: { symbol } });
  check('删除成功', r.json.ok === true && r.json.removed === true, r.json);
  const st = await call(ctx, '/state');
  check('已从列表移除', !st.json.items.some((i) => i.symbol === symbol));
  const r2 = await call(ctx, '/items/remove', { method: 'POST', body: { symbol } });
  check('重复删除不报错', r2.json.ok === true && r2.json.removed === false);
}

section('错误与边界');
{
  const r = await call(ctx, '/items/save', { method: 'POST', body: {} });
  check('空输入返回结构化错误', r.json.ok === false && !!r.json.error, r.json);
  const r2 = await call(ctx, '/items/save', { method: 'GET' });
  check('GET 调用写接口被拒绝', r2.json.ok === false, r2.json);
  const r3 = await call(ctx, '/items/save', { method: 'POST', body: { input: '600519', shares: -5, cost: -1 } });
  check('负数股数/成本被归零', r3.json.ok === true && r3.json.item.shares === 0 && r3.json.item.cost === 0, r3.json.item);
  const r4 = await call(ctx, '/items/save', { method: 'POST', body: { input: '不存在zzz' } });
  check('找不到标的时返回 ok:false', r4.json.ok === false && !!r4.json.error, r4.json);
  await call(ctx, '/items/remove', { method: 'POST', body: { symbol: 'sh600519' } });
}

section('损坏文件恢复');
{
  fs.writeFileSync(storePath, '{ 这不是 JSON', 'utf8');
  const ctx2 = makeCtx();
  apply(ctx2, { storePath });
  const r = await call(ctx2, '/state');
  check('损坏文件不会让插件崩溃', r.json.ok === true, r.json);
  check('损坏文件被改名留档', fs.readdirSync(tmpDir).some((f) => f.includes('.broken-')), fs.readdirSync(tmpDir));
}

section('分时 /trends 与盘口 /orderbook');
if (!OFFLINE) {
  const t = await call(ctx, '/trends?symbol=sh600519&days=1');
  check('分时 HTTP 200 + ok', t.status === 200 && t.json.ok === true, t.json.error);
  check('分时返回 points 数组', Array.isArray(t.json.points) && t.json.points.length > 0, t.json.points && t.json.points.length);
  check('单日分时 240~245 点', t.json.points.length >= 240 && t.json.points.length <= 245, t.json.points.length);
  {
    const pts = t.json.points;
    check('分时点带 time/price/avg', pts.every((p) => p.time && typeof p.price === 'number'), pts[0]);
    check('分时时间为 HH:MM 升序', pts.every((p, i) => i === 0 || p.time >= pts[i - 1].time), `${pts[0].time}..${pts[pts.length - 1].time}`);
    check('分时最高价 >= 每个点价格', pts.every((p) => (t.json.high == null ? true : p.price <= t.json.high + 1e-6)), t.json.high);
    check('分时最低价 <= 每个点价格', pts.every((p) => (t.json.low == null ? true : p.price >= t.json.low - 1e-6)), t.json.low);
    check('分时带昨收（用于算涨跌幅）', typeof t.json.prevClose === 'number' && t.json.prevClose > 0, t.json.prevClose);
  }
  const t5 = await call(ctx, '/trends?symbol=sh600519&days=5');
  check('多日分时约 5 倍点数', t5.json.points.length > t.json.points.length * 3, t5.json.points.length);
  const tBad = await call(ctx, '/trends?symbol=');
  check('缺 symbol 返回结构化错误', tBad.json.ok === false && !!tBad.json.error, tBad.json);

  const ob = await call(ctx, '/orderbook?symbol=sz000001');
  check('盘口 HTTP 200 + ok', ob.status === 200 && ob.json.ok === true, ob.json.error);
  if (ob.json.ok) {
    const { bids, asks, price } = ob.json;
    check('盘口 5 档买卖', bids.length === 5 && asks.length === 5, `${bids.length}/${asks.length}`);
    check('卖价递增（卖5→卖1）', asks.every((a, i) => i === 0 || a.price >= asks[i - 1].price), asks.map((a) => a.price));
    check('买价递减（买1→买5）', bids.every((b, i) => i === 0 || b.price <= bids[i - 1].price), bids.map((b) => b.price));
    check('卖1 >= 现价 >= 买1', asks[0].price >= price - 1e-6 && bids[0].price <= price + 1e-6, `${bids[0].price} / ${price} / ${asks[0].price}`);
    check('每档带价格与手数', asks.every((a) => typeof a.price === 'number' && typeof a.volume === 'number'), asks[0]);
    check('委差 = 买量 - 卖量', Math.abs(ob.json.commissionDiff - (ob.json.bidVolume - ob.json.askVolume)) < 1e-6, ob.json.commissionDiff);
  }
  const obIdx = await call(ctx, '/orderbook?symbol=sh000001');
  check('指数无盘口时返回 ok:false 而非崩溃', obIdx.json.ok === false && !!obIdx.json.error, obIdx.json);
}

section('交易流水 /trades —— 加权平均成本法');
if (!OFFLINE) {
  const empty = await call(ctx, '/trades');
  check('初始流水为空', empty.json.ok === true && empty.json.trades.length === 0 && empty.json.realized.total === 0, empty.json);

  // 买 1000 @10，再买 1000 @12 → 均价 11
  const b1 = await call(ctx, '/trades/save', { method: 'POST', body: { symbol: 'sz000001', side: 'buy', price: 10, shares: 1000, fee: 5, date: '2026-03-02' } });
  check('记一笔买入成功', b1.json.ok === true && b1.json.trade.side === 'buy', b1.json.error || b1.json.trade);
  check('买入带规范符号与名称', b1.json.trade.symbol === 'sz000001' && !!b1.json.trade.name, b1.json.trade);
  check('买入不影响已实现盈亏', b1.json.realized === 0, b1.json.realized);

  const b2 = await call(ctx, '/trades/save', { method: 'POST', body: { symbol: 'sz000001', side: 'buy', price: 12, shares: 1000, date: '2026-03-03' } });
  check('第二笔买入成功', b2.json.ok === true, b2.json.error);

  // 卖 500 @15 → 成本价含首笔 5 元手续费：(10*1000+5)/1000=10.005，加买 1000@12 → 11.0025
  const s1 = await call(ctx, '/trades/save', { method: 'POST', body: { symbol: 'sz000001', side: 'sell', price: 15, shares: 500, date: '2026-03-04' } });
  check('记一笔卖出成功', s1.json.ok === true, s1.json.error);
  check('已实现盈亏 = (15-11.0025)*500 = 1998.75', Math.abs(s1.json.realized - 1998.75) < 1e-6, s1.json.realized);

  const list = await call(ctx, '/trades');
  check('流水 3 条', list.json.trades.length === 3, list.json.trades.length);
  check('流水按日期升序', list.json.trades.every((t, i) => i === 0 || t.date >= list.json.trades[i - 1].date), list.json.trades.map((t) => t.date));
  check('每条流水都有 id', list.json.trades.every((t) => !!t.id));
  const agg = list.json.bySymbol.sz000001;
  check('按标的聚合：净股数 1500', agg.qty === 1500, agg.qty);
  check('按标的聚合：持仓均价 11.0025（手续费计入成本）', Math.abs(agg.avgCost - 11.0025) < 1e-6, agg.avgCost);
  check('按标的聚合：已实现 1998.75', Math.abs(agg.realized - 1998.75) < 1e-6, agg.realized);
  check('费用合计 5', Math.abs(list.json.realized.fees - 5) < 1e-6, list.json.realized.fees);
  check('流水带最新价用于对照', !!list.json.quotes.sz000001 && typeof list.json.quotes.sz000001.price === 'number', list.json.quotes.sz000001);

  // 超卖：流水里只有 1500 股，卖 99999 必须被拒
  const over = await call(ctx, '/trades/save', { method: 'POST', body: { symbol: 'sz000001', side: 'sell', price: 15, shares: 99999 } });
  check('超卖被拒绝（不允许卖空）', over.json.ok === false && !!over.json.error, over.json.error);
  const overList = await call(ctx, '/trades');
  check('被拒的卖单没有落盘', overList.json.trades.length === 3, overList.json.trades.length);

  // apply：把按流水反推的持仓写回 items（sz000001 之前不在 items 里，应当被补进来）
  const applied = await call(ctx, '/trades/apply', { method: 'POST', body: {} });
  check('apply 成功', applied.json.ok === true, applied.json.error);
  check('apply 返回变更数 >= 1', applied.json.changed >= 1, applied.json.changed);
  {
    const item = applied.json.state.items.find((i) => i.symbol === 'sz000001');
    check('apply 后持仓股数 = 1500', item && item.shares === 1500, item && item.shares);
    check('apply 后成本价 = 11.0025', item && Math.abs(item.cost - 11.0025) < 1e-6, item && item.cost);
    check('apply 后标记为持仓', item && item.held === true, item && item.held);
  }

  // 删除单笔
  const delId = list.json.trades[0].id;
  const del = await call(ctx, '/trades/remove', { method: 'POST', body: { id: delId } });
  check('删除单笔流水成功', del.json.ok === true && del.json.removed === true, del.json);
  const after = await call(ctx, '/trades');
  check('删除后只剩 2 条', after.json.trades.length === 2, after.json.trades.length);
  const delAgain = await call(ctx, '/trades/remove', { method: 'POST', body: { id: delId } });
  check('重复删除不报错', delAgain.json.ok === true && delAgain.json.removed === false, delAgain.json);

  // 清空
  const cleared = await call(ctx, '/trades/clear', { method: 'POST', body: {} });
  check('清空流水成功', cleared.json.ok === true && cleared.json.removed === 2, cleared.json.removed);
  const finalList = await call(ctx, '/trades');
  check('清空后流水为空且已实现归零', finalList.json.trades.length === 0 && finalList.json.realized.total === 0, finalList.json.realized);

  // 边角
  const bad = await call(ctx, '/trades/save', { method: 'POST', body: { side: 'buy', price: 10, shares: 100 } });
  check('无标的时返回结构化错误', bad.json.ok === false && !!bad.json.error, bad.json);
  const badSide = await call(ctx, '/trades/save', { method: 'POST', body: { symbol: 'sz000001', side: 'hold', price: 10, shares: 100 } });
  check('非法方向被拒绝', badSide.json.ok === false && !!badSide.json.error, badSide.json);
  const badPrice = await call(ctx, '/trades/save', { method: 'POST', body: { symbol: 'sz000001', side: 'buy', price: 0, shares: 100 } });
  check('价格为 0 被拒绝', badPrice.json.ok === false && !!badPrice.json.error, badPrice.json);
  const badShares = await call(ctx, '/trades/save', { method: 'POST', body: { symbol: 'sz000001', side: 'buy', price: 10, shares: 0 } });
  check('股数为 0 被拒绝', badShares.json.ok === false && !!badShares.json.error, badShares.json);
  const getWrite = await call(ctx, '/trades/save', { method: 'GET' });
  check('GET 调用写接口被拒绝', getWrite.json.ok === false, getWrite.json);

  // 清掉 items 里被 apply 写进去的持仓，避免影响后续断言
  await call(ctx, '/items/remove', { method: 'POST', body: { symbol: 'sz000001' } });
}

section('价格预警 /alerts');
if (!OFFLINE) {
  const fresh = await call(ctx, '/state?fresh=1');
  const px = fresh.json.items.find((i) => i.symbol === 'sh600519') || fresh.json.items[0];
  check('拿到一个现价用于构造预警', !!px && typeof px.price === 'number' && px.price > 0, px && px.price);

  // 必然触发：现价 >= 0.01
  const a1 = await call(ctx, '/alerts/save', { method: 'POST', body: { symbol: px.symbol, kind: 'price', op: '>=', value: 0.01 } });
  check('新建预警成功', a1.json.ok === true && !!a1.json.alert.id, a1.json.error || a1.json.alert);
  check('预警带规范符号', a1.json.alert.symbol === px.symbol, a1.json.alert.symbol);
  check('预警默认启用', a1.json.alert.enabled === true, a1.json.alert.enabled);
  // save 的响应体必须已经算过行情：否则前端新建一条必然命中的预警后，
  // 界面上看不到"已命中"，得等下一次轮询才知道（这是修过的一个真实缺陷）
  check('新建响应直接带命中状态与当前价',
    a1.json.alert.hit === true && typeof a1.json.alert.current === 'number' && a1.json.alert.current > 0,
    { hit: a1.json.alert.hit, current: a1.json.alert.current });

  const st = await call(ctx, '/state');
  const live = st.json.alerts.find((a) => a.id === a1.json.alert.id);
  check('/state 返回 alerts', Array.isArray(st.json.alerts) && st.json.alerts.length === 1, st.json.alerts);
  check('预警被判定为命中', live && live.hit === true, live && { hit: live.hit, current: live.current });
  check('预警带当前价', live && typeof live.current === 'number', live && live.current);
  check('新触发进入 fired', Array.isArray(st.json.fired) && st.json.fired.some((a) => a.id === a1.json.alert.id), st.json.fired);

  // 第二次拉取不应重复触发
  const st2 = await call(ctx, '/state');
  check('已触发的预警不再重复进 fired', st2.json.fired.length === 0, st2.json.fired);

  const ack = await call(ctx, '/alerts/ack', { method: 'POST', body: { id: a1.json.alert.id } });
  check('ack 成功', ack.json.ok === true, ack.json);
  const st3 = await call(ctx, '/state');
  const rearmed = st3.json.alerts.find((a) => a.id === a1.json.alert.id);
  check('ack 后重新武装：条件仍成立所以立刻再次触发（能再次触发就证明标志被清过）',
    rearmed && rearmed.firedAt !== null && st3.json.fired.some((a) => a.id === a1.json.alert.id),
    { fired: st3.json.fired.length, firedAt: rearmed && rearmed.firedAt });

  // 不可能触发：现价 <= 0.0001
  const a2 = await call(ctx, '/alerts/save', { method: 'POST', body: { symbol: px.symbol, kind: 'price', op: '<=', value: 0.0001 } });
  const st4 = await call(ctx, '/state');
  const never = st4.json.alerts.find((a) => a.id === a2.json.alert.id);
  check('未命中的预警 hit=false', never && never.hit === false, never && never.hit);

  // 涨幅型
  const a3 = await call(ctx, '/alerts/save', { method: 'POST', body: { symbol: px.symbol, kind: 'pct', op: '>=', value: -999 } });
  check('涨幅型预警可创建', a3.json.ok === true, a3.json.error);
  const st5 = await call(ctx, '/state');
  const pctAlert = st5.json.alerts.find((a) => a.id === a3.json.alert.id);
  check('涨幅型预警能命中', pctAlert && pctAlert.hit === true, pctAlert && pctAlert.hit);

  const off = await call(ctx, '/alerts/save', { method: 'POST', body: { id: a3.json.alert.id, enabled: false } });
  check('可以修改已有预警', off.json.ok === true && off.json.alert.enabled === false, off.json.alert);
  const st6 = await call(ctx, '/state');
  const disabled = st6.json.alerts.find((a) => a.id === a3.json.alert.id);
  check('停用的预警仍列出但不算命中', disabled && disabled.hit === false, disabled && disabled.hit);
  check('停用的预警不进 fired', !st6.json.fired.some((a) => a.id === a3.json.alert.id), st6.json.fired.length);
  check('停用的预警仍回报当前价（界面要显示）', disabled && typeof disabled.current === 'number', disabled && disabled.current);

  const aBad = await call(ctx, '/alerts/save', { method: 'POST', body: { symbol: 'zzz不存在' } });
  check('无效标的返回结构化错误', aBad.json.ok === false && !!aBad.json.error, aBad.json);
  const aNoSym = await call(ctx, '/alerts/save', { method: 'POST', body: { kind: 'price' } });
  check('缺标的返回结构化错误', aNoSym.json.ok === false && !!aNoSym.json.error, aNoSym.json);

  const rm = await call(ctx, '/alerts/remove', { method: 'POST', body: { id: a1.json.alert.id } });
  check('删除预警成功', rm.json.ok === true && rm.json.removed === true, rm.json);
  const rmAgain = await call(ctx, '/alerts/remove', { method: 'POST', body: { id: a1.json.alert.id } });
  check('重复删除不报错', rmAgain.json.ok === true && rmAgain.json.removed === false, rmAgain.json);
  const ackBad = await call(ctx, '/alerts/ack', { method: 'POST', body: { id: 'no-such-id' } });
  check('ack 不存在的 id 返回 ok:false', ackBad.json.ok === false, ackBad.json);
}

section('预警盯非自选股时也能取到行情');
if (!OFFLINE) {
  // 用一只不在 items 里的股票建预警：/state 的行情拉取必须把 alerts 的 symbol 也算进去
  const a = await call(ctx, '/alerts/save', { method: 'POST', body: { symbol: 'sh601398', kind: 'price', op: '>=', value: 0.01 } });
  check('为非自选股建预警成功', a.json.ok === true, a.json.error);
  const st = await call(ctx, '/state?fresh=1');
  const live = st.json.alerts.find((x) => x.symbol === 'sh601398');
  check('非自选股预警也能取到当前价', live && typeof live.current === 'number' && live.current > 0, live && live.current);
  check('非自选股预警能判命中', live && live.hit === true, live && live.hit);
  await call(ctx, '/alerts/remove', { method: 'POST', body: { id: a.json.alert.id } });
}

section('老版本数据文件迁移（升级不能丢持仓）');
{
  // v1.0.0 的 portfolio.json 只有 { version, settings, items }，没有 trades/alerts。
  // 升级后第一次 load() 必须能读旧文件：持仓原样保留、新字段补成空数组、设置补默认值。
  // 这里用的就是线上真实文件的结构和真实条目。
  const legacy = {
    version: 1,
    settings: { refreshMs: 4000, opacity: 0.9, collapsed: false, period: 'day' },
    items: [
      { symbol: 'sh000001', code: '000001', name: '上证指数', shares: 0, cost: 0, watch: true, index: true },
      { symbol: 'sz399001', code: '399001', name: '深证成指', shares: 0, cost: 0, watch: true, index: true },
      { symbol: 'sz399006', code: '399006', name: '创业板指', shares: 0, cost: 0, watch: true, index: true },
      { symbol: 'sh515050', code: '515050', name: '通信ETF华夏', shares: 1000, cost: 0.85, watch: true, index: false },
      { symbol: 'sh600519', code: '600519', name: '贵州茅台', shares: 100, cost: 1622, watch: true, index: false },
    ],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stock-ticker-legacy-'));
  const file = path.join(dir, 'portfolio.json');
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));

  const { PortfolioStore } = await import('../lib/store.js');
  const s = new PortfolioStore(file);
  await s.load();

  check('旧文件能读进来（没被当成损坏文件改名）',
    fs.existsSync(file) && !fs.readdirSync(dir).some((f) => f.includes('.broken-')), fs.readdirSync(dir));
  check('5 条持仓一条不少', s.items.length === 5, s.items.length);
  const etf = s.items.find((i) => i.symbol === 'sh515050');
  check('ETF 的股数保住了', etf && etf.shares === 1000, etf && etf.shares);
  check('ETF 的成本价保住了', etf && Math.abs(etf.cost - 0.85) < 1e-9, etf && etf.cost);
  check('ETF 的名称中文没乱码', etf && etf.name === '通信ETF华夏', etf && etf.name);
  const mt = s.items.find((i) => i.symbol === 'sh600519');
  check('茅台 100 股 @1622 保住了', mt && mt.shares === 100 && mt.cost === 1622, mt && { shares: mt.shares, cost: mt.cost });
  check('指数标记保住了', s.items.filter((i) => i.index).length === 3, s.items.filter((i) => i.index).length);
  check('旧设置保住了', s.settings.refreshMs === 4000 && Math.abs(s.settings.opacity - 0.9) < 1e-9, s.settings);

  check('新增的 trades 补成空数组', Array.isArray(s.trades) && s.trades.length === 0, s.trades);
  check('新增的 alerts 补成空数组', Array.isArray(s.alerts) && s.alerts.length === 0, s.alerts);
  check('新增的设置补上默认值',
    s.settings.chart === 'trend' && s.settings.trendDays === 1 && s.settings.showOrderBook === true && s.settings.alertToast === true,
    { chart: s.settings.chart, trendDays: s.settings.trendDays, showOrderBook: s.settings.showOrderBook, alertToast: s.settings.alertToast });
  // 组件开关也得跟着补上默认值，否则升级后界面读不到会全部按"关"渲染
  {
    const keys = ['showTotals', 'showTrend', 'showKline', 'showTrades', 'showAlerts', 'showAi'];
    const missing = keys.filter((k) => s.settings[k] !== true);
    check('老库补齐了组件开关默认值（全部默认开）', missing.length === 0, missing.join(','));
  }

  // 新功能在老库上必须能用，不能因为 trades/alerts 曾经不存在而炸
  const { computeRealized, evalAlert } = await import('../lib/store.js');
  const r = computeRealized(s.trades);
  check('空流水也能算已实现盈亏', r && r.realized === 0 && r.tradeCount === 0, { realized: r && r.realized });
  const synced = await s.syncAlerts(new Map());
  check('syncAlerts 在空预警上不炸', synced && Array.isArray(synced.alerts) && synced.alerts.length === 0);
  await s.addTrade({ symbol: 'sh600519', side: 'buy', price: 1622, shares: 100, fee: 0, date: '2026-02-02' });
  check('老库上能记第一笔流水', s.trades.length === 1, s.trades.length);
  const derived = await s.applyDerivedPositions();
  check('按流水反推后仍是 100 股', derived && derived.changed >= 0 && s.items.find((i) => i.symbol === 'sh600519').shares === 100,
    s.items.find((i) => i.symbol === 'sh600519').shares);

  await s.save();
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('存盘后带上 trades/alerts 字段',
    Array.isArray(after.trades) && Array.isArray(after.alerts), Object.keys(after));
  check('存盘后 items 仍是 5 条', after.items.length === 5, after.items.length);
  check('存盘文件无 BOM', fs.readFileSync(file)[0] !== 0xef, fs.readFileSync(file).slice(0, 3));

  fs.rmSync(dir, { recursive: true, force: true });
}

section('缓存不会无限膨胀（LRU 上限）');
{
  const h0 = await call(ctx, '/health');
  const c0 = h0.json.caches;
  check('/health 上报缓存规模', !!c0 && c0.max === 200, c0);

  // 210 个不同关键词并发打进去：键空间是无界的，必须被 LRU 卡住
  const qs = Array.from({ length: 210 }, (_, i) => `zzq${i}`);
  const results = [];
  for (let i = 0; i < qs.length; i += 50) {
    results.push(...await Promise.all(qs.slice(i, i + 50).map((q) => call(ctx, `/search?q=${q}`))));
  }
  const okCount = results.filter((r) => r.json && r.json.ok).length;
  const c1 = (await call(ctx, '/health')).json.caches;
  check('缓存条数没超过上限', c1.search <= 200, c1.search);
  if (okCount >= 210) {
    check('恰好保留 200 条（LRU 真的在淘汰）', c1.search === 200, c1.search);
  } else {
    // 网络抖动导致部分请求失败时，只验证上界，别把环境问题算成插件 bug
    check(`部分请求未成功（${okCount}/210），只验证上界`, c1.search <= 200, c1.search);
  }
  check('K 线缓存也受同一上限约束', c1.kline <= 200, c1.kline);
}

section('AI 分析：模型目录');
{
  // 默认（宿主没挂 llm）时必须是一句人话错误，而不是崩掉
  const before = await call(ctx, '/ai/models');
  check('没挂模型服务时返回 ok:false', before.json && before.json.ok === false, before.json);
  check('错误里写清了缺什么', /dsh-llm/.test(before.json.error || ''), before.json.error);

  ctx.llm = makeFakeLlm();
  ctx.defaultModel = { currentSelection: () => ({ provider: 'deep', model: 'deepseek-v4-flash', reasoningEffort: 'max' }) };

  const r = await call(ctx, '/ai/models');
  check('HTTP 200', r.status === 200, r.status);
  check('ok:true', r.json && r.json.ok === true, r.json);
  check('列出两个提供方', (r.json.providers || []).length === 2, r.json.providers);
  check('坏提供方只记 failures，不拖垮整张目录', (r.json.failures || []).length === 1, r.json.failures);
  check('好提供方的模型进了目录', (r.json.models || []).some((m) => m.id === 'deepseek-v4-flash'), r.json.models);
  check('模型带 provider 便于回传', (r.json.models || []).every((m) => !!m.provider));
  check('默认模型来自 agentDefaultModel', r.json.current && r.json.current.model === 'deepseek-v4-flash', r.json.current);
  check('默认模型带上推理强度', r.json.current.reasoningEffort === 'max', r.json.current);

  ctx.defaultModel = null;
  const r2 = await call(ctx, '/ai/models');
  check('读不到默认值时退回目录里第一个', r2.json.current && r2.json.current.model === 'deepseek-v4-flash', r2.json.current);
  ctx.defaultModel = { currentSelection: () => ({ provider: 'deep', model: 'deepseek-v4-flash' }) };
}

section('AI 分析：数据包与流式回传');
{
  const r = await call(ctx, '/ai/analyze', {
    method: 'POST',
    body: { symbol, style: 'short', extra: '多看看量能', include: { book: false } },
  });
  check('HTTP 200', r.status === 200, r.status);
  check('内容是 NDJSON', /application\/x-ndjson/.test((r.headers || {})['Content-Type'] || ''), r.headers);
  check('禁止缓存', (r.headers || {})['Cache-Control'] === 'no-store');
  const types = r.lines.map((l) => l.type);
  check('先发 meta', types[0] === 'meta', types);
  check('以 done 收尾', types[types.length - 1] === 'done', types);
  check('每个 delta 都是独立一行', types.filter((t) => t === 'delta').length === 2, types);

  const meta = r.lines[0];
  check('meta 里带喂进去的数据清单', Array.isArray(meta.meta.has) && meta.meta.has.length > 0, meta.meta);
  check('meta 里带字符数', typeof meta.meta.chars === 'number' && meta.meta.chars > 200, meta.meta.chars);
  check('meta 里写清用了哪个模型', meta.provider === 'deep' && meta.model === 'deepseek-v4-flash', meta);

  const done = r.lines[r.lines.length - 1];
  check('拼出了完整正文', done.text === '看多', done.text);
  check('推理增量单独上报但没混进正文', done.reasoning === '先想想' && !done.text.includes('先想'), done);
  check('usage 透传', done.usage && done.usage.inputTokens === 1234, done.usage);
  check('finish 为 stop，无错误', done.finish === 'stop' && !done.error, done);
  check('耗时被记录', typeof done.elapsedMs === 'number' && done.elapsedMs >= 0, done.elapsedMs);

  const sent = ctx.llm.calls[ctx.llm.calls.length - 1];
  check('调用时带上了 provider/model', sent.provider === 'deep' && sent.model === 'deepseek-v4-flash', sent);
  check('两条消息：system + user', sent.messages.length === 2 && sent.messages[0].role === 'system' && sent.messages[1].role === 'user',
    sent.messages.map((m) => m.role));
  check('消息内容是 text 块（宿主协议要求的形状）',
    sent.messages.every((m) => Array.isArray(m.content) && m.content[0].type === 'text' && typeof m.content[0].text === 'string'));
  check('system 提示词禁止编造数据', sent.messages[0].content[0].text.includes('禁止编造'));
  const userText = sent.messages[1].content[0].text;
  check('user 消息带着真实行情', /贵州茅台/.test(userText), userText.slice(0, 80));
  check('user 消息带着日K明细', /日期,开,高,低,收,量\(手\)/.test(userText));
  check('user 消息带着用户附加要求', /多看看量能/.test(userText));
  check('调用带上了取消信号', !!sent.signal, typeof sent.signal);
  check('分时/盘口按 include 取舍（关掉盘口就没有盘口段）', !/【盘口】/.test(userText), null);
}

section('AI 分析：失败与边界');
{
  // 模型侧失败：adapter 不抛异常，而是以终止 finish 分片报告
  ctx.llm = makeFakeLlm({
    chunks: [
      { type: 'text-delta', index: 0, text: '前半段' },
      { type: 'finish', reason: { kind: 'error', failure: { message: '密钥无效', code: 'AUTH', status: 401 } } },
    ],
  });
  const r = await call(ctx, '/ai/analyze', { method: 'POST', body: { symbol } });
  const done = r.lines[r.lines.length - 1];
  check('失败也以 done 收尾（前端不用等超时）', done.type === 'done', r.lines.map((l) => l.type));
  check('finish 标记为 error', done.finish === 'error', done.finish);
  check('错误码透传', done.code === 'AUTH', done.code);
  check('错误文案透传', done.error === '密钥无效', done.error);
  check('已经生成的部分不丢', done.text === '前半段', done.text);

  // 没选股票
  const noSymbol = await call(ctx, '/ai/analyze', { method: 'POST', body: {} });
  check('没选标的时给中文提示', noSymbol.json && noSymbol.json.ok === false && /代码|标的/.test(noSymbol.json.error), noSymbol.json);

  // 拿不到代码
  const badSymbol = await call(ctx, '/ai/analyze', { method: 'POST', body: { symbol: 'zzz不存在的代码' } });
  check('无效代码返回结构化错误而不是崩', badSymbol.json && badSymbol.json.ok === false, badSymbol.json);

  // GET 打写接口
  const wrongMethod = await call(ctx, '/ai/analyze');
  check('GET 打分析接口给中文提示', wrongMethod.json && wrongMethod.json.ok === false && /POST/.test(wrongMethod.json.error), wrongMethod.json);

  // 宿主没挂 llm
  const keep = ctx.llm;
  ctx.llm = null;
  const noLlm = await call(ctx, '/ai/analyze', { method: 'POST', body: { symbol } });
  check('没挂模型服务时不炸', noLlm.json && noLlm.json.ok === false && /dsh-llm/.test(noLlm.json.error), noLlm.json);
  ctx.llm = keep;

  // 空回复（模型什么都没说）
  ctx.llm = makeFakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] });
  const empty = await call(ctx, '/ai/analyze', { method: 'POST', body: { symbol } });
  const emptyDone = empty.lines[empty.lines.length - 1];
  check('空回复也是正常的 done，text 为空串', emptyDone.type === 'done' && emptyDone.text === '', emptyDone);
}

section('卸载');
{
  for (const e of ctx.effects) if (typeof e.disposer === 'function') e.disposer();
  check('卸载后路由全部注销', ctx.routes.size === 0, [...ctx.routes.keys()]);
}

/* ---------------- 收尾 ---------------- */

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n==== 通过 ${pass} / 失败 ${fail} ====`);
if (fail) {
  console.log('失败项:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
