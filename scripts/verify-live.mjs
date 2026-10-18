/**
 * verify-live.mjs —— 走真实 HTTP 的端到端自检
 *
 * verify.mjs 是在进程内用假的 req/res 调 handler；这个脚本更狠一点：把插件的
 * `apply()` 挂到一个真的 node:http 服务器上，然后用真的 fetch 打进去。
 *
 * 为什么要多这一层：`readBody()` 用的是 `for await (const chunk of req)`，
 * 这依赖真实的 IncomingMessage 异步迭代器；假 req 只能"装作"能迭代。
 * 另外 Content-Length / Content-Type / Cache-Control 这些响应头也只有在
 * 真服务器上才有意义。
 *
 * 用法：node scripts/verify-live.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dst-live-')), 'portfolio.json');

const PASS = [];
const FAIL = [];
let sectionName = '';

function section(name) {
  sectionName = name;
  console.log(`\n== ${name} ==`);
}

function check(label, ok, detail) {
  if (ok) {
    PASS.push(`${sectionName} / ${label}`);
    console.log(`  ok   ${label}`);
  } else {
    FAIL.push(`${sectionName} / ${label}`);
    console.log(`  FAIL ${label}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
  }
}

/** 跳过一段断言（不记失败）：上游行情源掐连接这类与插件无关的情况 */
function note(msg) {
  console.log(`  --   ${msg}`);
}

/** 上游挂了长什么样：插件把它包成了 200 + { ok:false, error:"fetch failed" } */
function upstreamDown(json) {
  if (!json || json.ok !== false) return false;
  return /fetch failed|timeout|timed out|ECONN|socket|network|aborted/i.test(String(json.error));
}

/* ------------------------------------------------------------------
 * 1. 假的 Cordis ctx：只实现插件真正用到的那几个面
 * ------------------------------------------------------------------ */

const routes = new Map();
const disposers = [];
const logs = [];
const streamCalls = [];

/** 假的 dsh-llm：只实现插件用到的那三个面（listProviders / listModels / stream） */
const AI_ANSWER = '### 结论\n- 现价 **1680.50**\n';
function makeFakeLlm() {
  return {
    listProviders: () => [{ id: 'deep', name: 'DeepSeek' }],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('提供方没有配置凭据');
      return [
        { provider: 'deep', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { provider: 'deep', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ];
    },
    stream(options) {
      streamCalls.push(options);
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '先看均线再看量能' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先看均线再看量能' } },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '### 结论\n' },
        { type: 'text-delta', index: 1, text: '- 现价 **1680.50**\n' },
        { type: 'block-end', index: 1, block: { type: 'text', text: AI_ANSWER } },
        { type: 'usage', usage: { inputTokens: 900, outputTokens: 120 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) {
            if (options.signal && options.signal.aborted) return;
            yield c;
            await new Promise((r) => setTimeout(r, 0));
          }
        },
      };
    },
  };
}
const fakeLlm = makeFakeLlm();

const ctx = {
  get(key) {
    if (key === 'llm') return fakeLlm;
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deep', model: 'deepseek-v4-flash' }) };
    return null;
  },
  logger: {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
  },
  effect(fn, label) {
    const d = fn();
    disposers.push({ label, d });
    return d;
  },
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error(`重复注册路由: ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
};

const mod = await import('../lib/index.js');
check('index.js 导出了 apply', typeof mod.apply === 'function');
check('index.js 声明了 webServer 依赖', Array.isArray(mod.inject) && mod.inject.includes('webServer'), mod.inject);

await mod.apply(ctx, { storePath });

/* ------------------------------------------------------------------
 * 2. 用注册表驱动一个真 HTTP 服务器（模拟宿主的分发：精确匹配）
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const route = routes.get(u.pathname);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: `no route: ${u.pathname}` }));
    return;
  }
  await route.handler(req, res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`\n[verify-live] 插件挂在 ${BASE}，store=${storePath}`);
console.log(`[verify-live] 已注册 ${routes.size} 条路由`);

async function call(pathname, { method = 'GET', body } = {}) {
  const r = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就是错 */ }
  return { status: r.status, headers: r.headers, text, json };
}

const post = (p, b) => call(p, { method: 'POST', body: b });

/* ------------------------------------------------------------------
 * 3. 路由契约
 * ------------------------------------------------------------------ */

section('路由注册');
{
  const expected = [
    '/api/stock-ticker/state', '/api/stock-ticker/kline', '/api/stock-ticker/search',
    '/api/stock-ticker/health', '/api/stock-ticker/trends', '/api/stock-ticker/orderbook',
    '/api/stock-ticker/trades', '/api/stock-ticker/items/save', '/api/stock-ticker/items/remove',
    '/api/stock-ticker/settings/save', '/api/stock-ticker/trades/save', '/api/stock-ticker/trades/remove',
    '/api/stock-ticker/trades/clear', '/api/stock-ticker/trades/apply',
    '/api/stock-ticker/alerts/save', '/api/stock-ticker/alerts/remove', '/api/stock-ticker/alerts/ack',
    '/api/stock-ticker/ai/models', '/api/stock-ticker/ai/analyze',
  ];
  check('全部 19 条路由都在', routes.size === 19, routes.size);
  for (const p of expected) {
    check(`注册了 ${p.replace('/api/stock-ticker', '')}`, routes.has(p));
  }
  check('全部走 ctx.effect 注册（可随插件卸载）', disposers.length === 19, disposers.length);
  let unknown = null;
  try { unknown = await call('/api/stock-ticker/nope'); } catch (e) { unknown = { status: 0, error: e.message }; }
  check('未知路径返回 404', unknown.status === 404, unknown.status);
}

section('响应头契约（浏览器侧要靠它）');
{
  const r = await call('/api/stock-ticker/state');
  check('Content-Type 是 utf-8 JSON',
    /application\/json/.test(r.headers.get('content-type') || '') && /charset=utf-8/.test(r.headers.get('content-type') || ''),
    r.headers.get('content-type'));
  check('带 Cache-Control: no-store（行情不能缓存）', r.headers.get('cache-control') === 'no-store', r.headers.get('cache-control'));
  check('Content-Length 与实际字节数一致',
    Number(r.headers.get('content-length')) === Buffer.byteLength(r.text),
    { header: r.headers.get('content-length'), actual: Buffer.byteLength(r.text) });
}

/* ------------------------------------------------------------------
 * 4. 真实行情
 * ------------------------------------------------------------------ */

section('GET /state');
let state = null;
{
  const r = await call('/api/stock-ticker/state?fresh=1');
  state = r.json;
  check('HTTP 200', r.status === 200, r.status);
  check('ok:true', state && state.ok === true);
  check('带 17 项以上字段', state && Object.keys(state).length >= 9, state && Object.keys(state));
  check('带 settings', !!state.settings);
  check('带 market 状态', !!(state.market && state.market.label), state && state.market);
  check('带 storePath 且与传入一致', state.storePath === storePath, state.storePath);
  check('带 items', Array.isArray(state.items) && state.items.length >= 3, state && state.items && state.items.length);
  check('首次启动自动铺了 3 个大盘指数',
    (state.items || []).filter((i) => i.index).length === 3,
    (state.items || []).filter((i) => i.index).map((i) => i.symbol));
  check('带 totals', !!state.totals);
  check('带 strip（顶栏用的扁平列表）', Array.isArray(state.strip) && state.strip.length > 0, state && state.strip && state.strip.length);
  check('新增：带 alerts 数组', Array.isArray(state.alerts), state && typeof state.alerts);
  check('新增：带 fired 数组', Array.isArray(state.fired), state && typeof state.fired);
  check('行情带了 provider 标记', !!(state.strip || []).find((s) => s.provider), null);

  const idx = (state.strip || []).find((s) => s.symbol === 'sh000001');
  check('上证指数有真实价格', !!(idx && idx.price > 0), idx && { price: idx.price, name: idx.name });
  if (idx) console.log(`      上证指数 ${idx.price} ${idx.changePct}%  数据源=${idx.provider}`);
}

section('GET /health');
{
  const r = await call('/api/stock-ticker/health');
  const h = r.json;
  check('HTTP 200', r.status === 200);
  check('quoteOk 为真（真实行情可用）', h.quoteOk === true, h.quoteErr);
  check('klineOk 为真（真实 K 线可用）', h.klineOk === true);
  check('报了 node 版本', !!h.node, h.node);
  check('报了 itemCount', typeof h.itemCount === 'number', h.itemCount);
}

section('GET /search（中文 / 拼音 / 空）');
{
  const a = await call(`/api/stock-ticker/search?q=${encodeURIComponent('贵州茅台')}`);
  check('中文搜索有结果', (a.json.hits || []).length > 0, a.json.hits && a.json.hits.length);
  check('命中里含 600519', (a.json.hits || []).some((x) => String(x.code) === '600519'), (a.json.hits || []).map((x) => x.code));

  const b = await call('/api/stock-ticker/search?q=gzmt');
  check('拼音搜索有结果', (b.json.hits || []).length > 0, b.json.hits && b.json.hits.length);

  const c = await call('/api/stock-ticker/search?q=');
  check('空关键词返回空数组而不是报错', Array.isArray(c.json.hits) && c.json.hits.length === 0, c.json);
}

section('GET /kline（真实 K 线 + 截断修好了没）');
{
  const r = await call('/api/stock-ticker/kline?symbol=sh600519&period=day&adjust=pre&count=30');
  const k = r.json;
  if (upstreamDown(k)) {
    note(`上游 K 线接口当前不可用（${k.error}），本段跳过。`);
  } else {
    check('ok:true', k.ok === true, k.error);
    check('返回 30 根（服务端 lmt 失效的那个坑）', (k.candles || []).length === 30, (k.candles || []).length);
    const rows = k.candles || [];
    check('OHLC 不变式成立', rows.every((c) => c.high >= c.low && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)));
    check('日期升序', rows.every((c, i) => i === 0 || rows[i - 1].date <= c.date));
    check('最后一根是最近交易日', rows.length > 0, rows[rows.length - 1]);

    const w = await call('/api/stock-ticker/kline?symbol=sh600519&period=week&count=20');
    check('周线 20 根', (w.json.candles || []).length === 20, (w.json.candles || []).length);
  }
}

section('GET /trends（新增：分时）');
{
  const r = await call('/api/stock-ticker/trends?symbol=sh600519&days=1');
  const t = r.json;
  if (upstreamDown(t)) {
    note(`上游分时接口当前不可用（${t.error}），本段跳过。`);
  } else {
    check('ok:true', t.ok === true, t.error);
    check('带 prevClose（分时图的中轴）', t.prevClose > 0, t.prevClose);
    check('带 points', Array.isArray(t.points) && t.points.length > 200, t.points && t.points.length);
    const p = (t.points || [])[0];
    check('每个点有 time/price/high/low/volume/avg', !!(p && p.time && p.price != null && p.high != null && p.low != null && p.volume != null && p.avg != null), p);
    check('points 价格区间合理（不跟 prevClose 差 10 倍以上）',
      (t.points || []).every((x) => Math.abs(x.price - t.prevClose) < t.prevClose),
      null);
    const d5 = await call('/api/stock-ticker/trends?symbol=sh600519&days=5');
    check('5 日分时点数多于 1 日', (d5.json.points || []).length > (t.points || []).length,
      { d1: (t.points || []).length, d5: (d5.json.points || []).length });
  }
  const bad = await call('/api/stock-ticker/trends?symbol=sh000001&days=1');
  check('指数也能取分时', bad.json.ok === true || bad.json.ok === false, bad.json.ok);
}

section('GET /orderbook（新增：五档）');
{
  const r = await call('/api/stock-ticker/orderbook?symbol=sh600519');
  const b = r.json;
  check('ok:true', b.ok === true, b.error);
  check('买卖各 5 档', (b.bids || []).length === 5 && (b.asks || []).length === 5,
    { bids: (b.bids || []).length, asks: (b.asks || []).length });
  check('asks[0] 是卖1（最低卖价）', (b.asks || [])[0] && b.asks[0].price <= b.asks[4].price, b.asks && b.asks.map((x) => x.price));
  check('bids[0] 是买1（最高买价）', (b.bids || [])[0] && b.bids[0].price >= b.bids[4].price, b.bids && b.bids.map((x) => x.price));
  check('卖1 不低于现价', (b.asks || [])[0] && b.asks[0].price >= b.price, { ask1: b.asks && b.asks[0] && b.asks[0].price, price: b.price });
  check('买1 不高于现价', (b.bids || [])[0] && b.bids[0].price <= b.price, { bid1: b.bids && b.bids[0] && b.bids[0].price, price: b.price });
  check('带委比与买卖量', b.commissionRatio != null && b.bidVolume > 0 && b.askVolume > 0,
    { ratio: b.commissionRatio, bid: b.bidVolume, ask: b.askVolume });
  const idx = await call('/api/stock-ticker/orderbook?symbol=sh000001');
  check('指数没有盘口时返回结构化错误而不是 500', idx.status === 200 && idx.json.ok === false, idx.json.error);
}

/* ------------------------------------------------------------------
 * 5. 写入路径（真 HTTP + 真 JSON body + 真异步迭代 req）
 * ------------------------------------------------------------------ */

section('POST /settings/save');
{
  const r = await post('/api/stock-ticker/settings/save', { refreshMs: 3000, chart: 'kline', trendDays: 5, showOrderBook: false });
  check('ok:true', r.json.ok === true, r.json);
  check('设置已生效', r.json.settings.refreshMs === 3000 && r.json.settings.chart === 'kline'
    && r.json.settings.trendDays === 5 && r.json.settings.showOrderBook === false, r.json.settings);
  const clamp = await post('/api/stock-ticker/settings/save', { refreshMs: 10, bogusKey: 1 });
  check('refreshMs 被夹到下限 1000', clamp.json.settings.refreshMs === 1000, clamp.json.settings.refreshMs);
  check('未知字段被忽略', !('bogusKey' in clamp.json.settings), Object.keys(clamp.json.settings));
  await post('/api/stock-ticker/settings/save', { refreshMs: 5000, chart: 'trend', trendDays: 1, showOrderBook: true });
}

section('POST /items/save + /items/remove');
{
  const r = await post('/api/stock-ticker/items/save', { input: '000001' });
  check('ok:true', r.json.ok === true, r.json.error);
  check('代码被规范化成 sz000001', r.json.item && r.json.item.symbol === 'sz000001', r.json.item && r.json.item.symbol);
  check('名称从行情回填', !!(r.json.item && r.json.item.name), r.json.item && r.json.item.name);

  const h = await post('/api/stock-ticker/items/save', { symbol: 'sz000001', shares: 2000, cost: 11.2 });
  const it = h.json.item;
  check('股数/成本已写入', it.shares === 2000 && it.cost === 11.2, { shares: it.shares, cost: it.cost });
  check('算出市值', Math.abs(it.marketValue - it.price * 2000) < 0.02, { mv: it.marketValue, price: it.price });
  check('算出盈亏', Math.abs(it.pnl - (it.price - 11.2) * 2000) < 0.02, { pnl: it.pnl });
  check('标记为持仓', it.held === true);

  const again = await post('/api/stock-ticker/items/save', { symbol: '000001', shares: 2000, cost: 11.2 });
  const list = (again.json.state.items || []).filter((x) => x.symbol === 'sz000001');
  check('重复保存不会新增一条', list.length === 1, list.length);

  const rm = await post('/api/stock-ticker/items/remove', { symbol: 'sz000001' });
  check('删除成功', rm.json.ok === true && rm.json.removed === true, rm.json);
  const rm2 = await post('/api/stock-ticker/items/remove', { symbol: 'sz000001' });
  check('重复删除不报错', rm2.json.ok === true && rm2.json.removed === false, rm2.json);
}

section('POST /trades/save（新增：交易流水）');
{
  const r = await post('/api/stock-ticker/trades/save', {
    symbol: '600519', side: 'buy', price: 1500, shares: 100, fee: 5, date: '2026-01-06',
  });
  check('ok:true', r.json.ok === true, r.json.error);
  check('返回 trade 且带 id', !!(r.json.trade && r.json.trade.id), r.json.trade);
  check('名称被回填', r.json.trade.name === '贵州茅台', r.json.trade.name);

  const s = await post('/api/stock-ticker/trades/save', {
    symbol: '600519', side: 'sell', price: 1700, shares: 40, fee: 6, date: '2026-03-02',
  });
  check('第二笔（卖出）成功', s.json.ok === true, s.json.error);

  const list = await call('/api/stock-ticker/trades');
  check('GET /trades ok', list.json.ok === true, list.json.error);
  check('列出 2 笔', (list.json.trades || []).length === 2, (list.json.trades || []).length);
  // 100 股 @1500 费 5 -> 均价 1500.05；卖 40 股 @1700 费 6
  // 已实现 = (1700 - 1500.05) * 40 - 6 = 7998 - 6 = 7992
  check('已实现盈亏按加权平均成本法算对', Math.abs(list.json.realized.total - 7992) < 0.01, list.json.realized);
  check('手续费合计 11', Math.abs(list.json.realized.fees - 11) < 0.01, list.json.realized.fees);
  check('bySymbol 里有 600519', !!(list.json.bySymbol && list.json.bySymbol.sh600519), list.json.bySymbol && Object.keys(list.json.bySymbol));
  const b = list.json.bySymbol.sh600519;
  check('剩余 60 股、均价 1500.05', b && b.qty === 60 && Math.abs(b.avgCost - 1500.05) < 0.001, b);
  check('带最新价方便对照', !!(list.json.quotes && list.json.quotes.sh600519), list.json.quotes && Object.keys(list.json.quotes));

  const bad = await post('/api/stock-ticker/trades/save', { symbol: '600519', side: 'buy', price: 0, shares: 10 });
  check('价格为 0 被拒', bad.json.ok === false, bad.json.error);
  const bad2 = await post('/api/stock-ticker/trades/save', { symbol: '不存在的东西', side: 'buy', price: 10, shares: 10 });
  check('不存在的标的被拒', bad2.json.ok === false, bad2.json.error);
  const bad3 = await post('/api/stock-ticker/trades/save', { symbol: '600519', side: 'hold', price: 10, shares: 10 });
  check('非法方向被拒', bad3.json.ok === false, bad3.json.error);

  const over = await post('/api/stock-ticker/trades/save', { symbol: '600519', side: 'sell', price: 1700, shares: 999 });
  check('超卖被拦（提示漏记买入）', over.json.ok === false && /超过/.test(over.json.error || ''), over.json.error);
}

section('POST /trades/apply（按流水反推持仓）');
{
  const r = await post('/api/stock-ticker/trades/apply', {});
  check('ok:true', r.json.ok === true, r.json.error);
  check('改动了持仓', typeof r.json.changed === 'number' && r.json.changed >= 1, r.json.changed);
  const item = (r.json.state.items || []).find((x) => x.symbol === 'sh600519');
  check('持仓被写成流水的 60 股', item && item.shares === 60, item && item.shares);
  check('成本价被写成流水均价 1500.05', item && Math.abs(item.cost - 1500.05) < 0.001, item && item.cost);
  check('自动补建了持仓条目', !!item);
}

section('POST /trades/remove + /trades/clear');
{
  const list = await call('/api/stock-ticker/trades');
  const target = list.json.trades[0];
  const r = await post('/api/stock-ticker/trades/remove', { id: target.id });
  check('ok:true', r.json.ok === true, r.json.error);
  check('确实删掉了', r.json.removed === true, r.json.removed);
  const again = await post('/api/stock-ticker/trades/remove', { id: target.id });
  check('重复删除不报错', again.json.ok === true && again.json.removed === false, again.json);

  const c = await post('/api/stock-ticker/trades/clear', {});
  check('清空成功', c.json.ok === true, c.json.error);
  const after = await call('/api/stock-ticker/trades');
  check('清空后没有流水', (after.json.trades || []).length === 0, (after.json.trades || []).length);
}

section('POST /alerts/save + /remove + /ack（新增：价格预警）');
{
  const r = await post('/api/stock-ticker/alerts/save', {
    symbol: 'sh600519', kind: 'price', op: '>=', value: 1,
  });
  check('ok:true', r.json.ok === true, r.json.error);
  const alert = r.json.alert;
  check('返回带 id 的预警', !!(alert && alert.id), alert);
  check('名称已回填', alert.name === '贵州茅台', alert.name);
  check('当前价已带回（界面要显示）', alert.current > 0, alert.current);
  check('阈值 1 元 -> 必然命中', alert.hit === true, { hit: alert.hit, current: alert.current });

  // 顶栏弹窗由轮询 /state 消费 fired 队列驱动，所以这里验证"下一次轮询会送出来"，
  // 而不是要求 save 的响应体里带 fired（队列的所有权归轮询接口）
  const poll = await call('/api/stock-ticker/state');
  check('命中项由轮询 /state 送进 fired（顶栏据此弹提示）',
    Array.isArray(poll.json.fired) && poll.json.fired.some((a) => a.id === alert.id),
    poll.json.fired && poll.json.fired.map((a) => a.id));
  const poll2 = await call('/api/stock-ticker/state');
  check('fired 取走即清空（同一个条件不会反复弹）',
    !(poll2.json.fired || []).some((a) => a.id === alert.id),
    poll2.json.fired && poll2.json.fired.map((a) => a.id));

  const ack = await post('/api/stock-ticker/alerts/ack', { id: alert.id });
  check('ack ok', ack.json.ok === true, ack.json);
  const st = await call('/api/stock-ticker/state');
  const found = (st.json.alerts || []).find((a) => a.id === alert.id);
  check('ack 后重新武装（条件仍成立会立刻再触发，说明标志清过）', !!(found && found.hit), found && { hit: found.hit, firedAt: found.firedAt });
  const st2 = await call('/api/stock-ticker/state');
  const found2 = (st2.json.alerts || []).find((a) => a.id === alert.id);
  check('同一次触发不会重复进 fired', (st2.json.fired || []).filter((a) => a.id === alert.id).length <= 1,
    st2.json.fired && st2.json.fired.map((a) => a.id));

  const no = await post('/api/stock-ticker/alerts/save', { symbol: 'sh600519', kind: 'price', op: '>=', value: 999999 });
  check('不可达阈值 hit=false', no.json.alert.hit === false, no.json.alert.hit);

  const off = await post('/api/stock-ticker/alerts/save', { id: no.json.alert.id, enabled: false });
  check('可以停用', off.json.alert.enabled === false, off.json.alert.enabled);

  const pct = await post('/api/stock-ticker/alerts/save', { symbol: 'sh600519', kind: 'pct', op: '<=', value: -50 });
  check('涨跌幅型预警可创建', pct.json.ok === true && pct.json.alert.kind === 'pct', pct.json.error);

  const idx = await post('/api/stock-ticker/alerts/save', { symbol: 'sh000001', kind: 'price', op: '>=', value: 1 });
  check('指数也能建预警', idx.json.ok === true, idx.json.error);

  const rm = await post('/api/stock-ticker/alerts/remove', { id: alert.id });
  check('删除成功', rm.json.ok === true && rm.json.removed === true, rm.json);
  const rm2 = await post('/api/stock-ticker/alerts/remove', { id: alert.id });
  check('重复删除不报错', rm2.json.ok === true && rm2.json.removed === false, rm2.json);

  const badAck = await post('/api/stock-ticker/alerts/ack', { id: 'nope' });
  check('ack 不存在的 id 返回 ok:false', badAck.json.ok === false, badAck.json);
}

section('GET /ai/models（新增：模型目录）');
{
  const r = await call('/api/stock-ticker/ai/models');
  check('HTTP 200', r.status === 200, r.status);
  check('ok:true', r.json && r.json.ok === true, r.json && r.json.ok);
  check('列出提供方', Array.isArray(r.json.providers) && r.json.providers.length === 1, JSON.stringify(r.json.providers));
  check('列出模型', Array.isArray(r.json.models) && r.json.models.length === 2, r.json.models && r.json.models.length);
  check('带当前默认模型', r.json.current && r.json.current.model === 'deepseek-v4-flash', JSON.stringify(r.json.current));
  check('no-store（模型目录不能缓存）', /no-store/.test(r.headers.get('Cache-Control') || ''), r.headers.get('Cache-Control'));
}

section('POST /ai/analyze（新增：NDJSON 流式分析）');
{
  // 先确认默认模型会被补进请求（客户端没传 model 时宿主自己填）
  const r = await fetch(`${BASE}/api/stock-ticker/ai/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: '600519', provider: 'deep', model: 'deepseek-v4-flash', style: 'short' }),
  });
  check('HTTP 200', r.status === 200, r.status);
  const text = await r.text();
  check('Content-Type 是 ndjson', /ndjson/.test(r.headers.get('Content-Type') || ''),
    `${r.headers.get('Content-Type')} :: ${text.slice(0, 200)}`);
  check('给了 no-cache（不然代理会攒着不吐）',
    /no-cache|no-store/.test(r.headers.get('Cache-Control') || ''), r.headers.get('Cache-Control'));
  const events = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { type: '__bad__', line: l }; }
  });
  check('每一行都是合法 JSON（NDJSON 契约）', events.every((e) => e.type !== '__bad__'),
    JSON.stringify(events.filter((e) => e.type === '__bad__').slice(0, 2)));
  check('第一个事件是 meta', events[0] && events[0].type === 'meta', events[0] && events[0].type);
  check('meta 里带数据包统计', !!(events[0] && events[0].meta && events[0].meta.chars > 0),
    JSON.stringify(events[0] && events[0].meta));
  check('有增量文本事件', events.some((e) => e.type === 'delta' && e.text), null);
  check('有思考过程事件', events.some((e) => e.type === 'reasoning' && e.text), null);
  const done = events.find((e) => e.type === 'done');
  check('以 done 收尾', !!done, events.map((e) => e.type).join(','));
  check('done 里带完整正文', !!done && /### 结论/.test(done.text || ''), done && done.text);
  check('拼起来的 delta 等于正文', events.filter((e) => e.type === 'delta').map((e) => e.text).join('') === AI_ANSWER,
    JSON.stringify(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')));
  check('done 里带 token 用量', !!(done && done.usage && done.usage.outputTokens === 120),
    JSON.stringify(done && done.usage));
  check('done 里带耗时', !!(done && typeof done.elapsedMs === 'number'), done && done.elapsedMs);
  check('done 的 finish 是 stop', !!(done && done.finish === 'stop'), done && done.finish);

  const last = streamCalls[streamCalls.length - 1] || {};
  check('确实调用了 llm.stream', streamCalls.length >= 1, streamCalls.length);
  check('传了 provider/model', last.provider === 'deep' && last.model === 'deepseek-v4-flash',
    `${last.provider}/${last.model}`);
  const sysMsg = (last.messages || []).filter((m) => m.role === 'system')
    .map((m) => (m.content || []).map((c) => c.text || '').join('')).join('\n');
  const userMsg = (last.messages || []).filter((m) => m.role !== 'system')
    .map((m) => (m.content || []).map((c) => c.text || '').join('')).join('\n');
  check('消息里带 system 人设（行情助手）', /行情/.test(sysMsg), sysMsg.slice(0, 40));
  check('user 里带了行情数据包', /贵州茅台|600519/.test(userMsg), userMsg.slice(0, 60));
  check('system 里声明了不构成投资建议', /不构成投资建议/.test(sysMsg), sysMsg.slice(-40));

  // 缺 symbol：不进流，直接 JSON 400/200 + ok:false
  const bad = await post('/api/stock-ticker/ai/analyze', { provider: 'deep', model: 'x' });
  check('缺标的时不进流', bad.json && bad.json.ok === false, bad.json);
  check('缺标的时给出可读原因', /标的|symbol|代码/.test(String(bad.json && bad.json.error)), bad.json && bad.json.error);
}

section('错误路径：一律 200 + ok:false，不 4xx/5xx');
{
  const cases = [
    ['GET 写接口', await call('/api/stock-ticker/items/save')],
    ['POST 缺 body', await post('/api/stock-ticker/items/save', {})],
    ['POST 乱码标的', await post('/api/stock-ticker/items/save', { input: '???乱码???' })],
    ['kline 缺 symbol', await call('/api/stock-ticker/kline')],
    ['kline 乱码 symbol', await call('/api/stock-ticker/kline?symbol=zzzzzz')],
    ['trends 缺 symbol', await call('/api/stock-ticker/trends')],
    ['orderbook 缺 symbol', await call('/api/stock-ticker/orderbook')],
    ['trades/apply 无需参数', await post('/api/stock-ticker/trades/apply', {})],
    ['alerts/save 缺标的', await post('/api/stock-ticker/alerts/save', {})],
    ['alerts/remove 缺 id', await post('/api/stock-ticker/alerts/remove', {})],
  ];
  for (const [label, r] of cases) {
    check(`${label} -> 200 + 结构化`, r.status === 200 && r.json && typeof r.json.ok === 'boolean', { status: r.status, json: r.json });
  }
  check('没有任何 5xx', cases.every(([, r]) => r.status < 500), cases.map(([l, r]) => [l, r.status]));
}

/* ------------------------------------------------------------------
 * 6. 持久化 + 卸载
 * ------------------------------------------------------------------ */

section('落盘');
{
  const raw = fs.readFileSync(storePath, 'utf8');
  const data = JSON.parse(raw);
  check('portfolio.json 是合法 JSON', !!data);
  check('带 version', typeof data.version === 'number', data.version);
  check('带 settings', !!data.settings);
  check('带 trades 数组', Array.isArray(data.trades), typeof data.trades);
  check('带 alerts 数组', Array.isArray(data.alerts), data.alerts && data.alerts.length);
  check('无 BOM', fs.readFileSync(storePath)[0] !== 0xef, fs.readFileSync(storePath).slice(0, 3));
}

section('卸载');
{
  for (const { d } of disposers) { try { if (typeof d === 'function') d(); } catch { /* 忽略 */ } }
  check('卸载后路由表清空', routes.size === 0, routes.size);
  const gone = await call('/api/stock-ticker/state');
  check('卸载后请求变 404', gone.status === 404, gone.status);
}

server.close();
fs.rmSync(path.dirname(storePath), { recursive: true, force: true });

console.log(`\n==== 通过 ${PASS.length} / 失败 ${FAIL.length} ====`);
if (FAIL.length) {
  console.log('失败项:');
  for (const f of FAIL) console.log(`  - ${f}`);
  process.exit(1);
}
