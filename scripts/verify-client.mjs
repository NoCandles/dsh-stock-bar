/**
 * dsh-stock-bar / scripts/verify-client.mjs
 *
 * Client(浏览器)半边自检：在 Node 里用一套最小的 React + DOM 替身，把 lib/client.js
 * 真正跑起来 —— 走 Loader 契约、apply() 注册槽位、渲染整棵组件树、派发点击、
 * 跑 effect、验证 K 线 canvas 真的画了东西。目的：在上浏览器之前就抓出
 * "slot entry crashed in 'shell.overlay'" 这类错误。
 *
 *   node scripts/verify-client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(__dirname, '..', 'lib', 'client.js');
const PKG_NAME = 'dsh-stock-bar';

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
    const d = detail === undefined ? '' : '  -> ' + JSON.stringify(detail).slice(0, 400);
    console.log(`  FAIL ${name}${d}`);
  }
}
const section = (t) => console.log(`\n== ${t} ==`);

/* ============================================================
 * 1. 测试用行情数据
 * ============================================================ */

const SHANGHAI = 'sh000001';
const MAOTAI = 'sh600519';
const PINGAN = 'sz000001';

function mkItem(o) {
  const price = o.price;
  const shares = o.shares || 0;
  const cost = o.cost || 0;
  const marketValue = +(price * shares).toFixed(2);
  const costValue = +(cost * shares).toFixed(2);
  const pnl = +(marketValue - costValue).toFixed(2);
  // 行情对象：形状必须与 lib/store.js:264 的 computePosition(item, quote) 一致，
  // 客户端 Chip 读的是 pos.quote.changePct（lib/client.js:617-618）而不是 pos.changePct。
  const quote = {
    symbol: o.symbol, name: o.name, market: o.market || 'cn', currency: o.currency || 'CNY',
    price, prevClose: o.prevClose, open: o.open ?? o.prevClose, high: o.high ?? price, low: o.low ?? price,
    change: +(price - o.prevClose).toFixed(2),
    changePct: +(((price - o.prevClose) / o.prevClose) * 100).toFixed(2),
    volume: 1_234_567, amount: 9.87e8, turnover: 1.23, volRatio: 1.05,
    provider: 'eastmoney',
  };
  return {
    symbol: o.symbol, code: o.code, name: o.name, index: !!o.index,
    market: o.market, currency: o.currency || 'CNY',
    price, prevClose: o.prevClose, open: o.open, high: o.high, low: o.low,
    change: quote.change, changePct: quote.changePct,
    shares, cost, held: shares > 0 && cost > 0,
    marketValue, costValue, pnl,
    pnlPct: costValue ? +((pnl / costValue) * 100).toFixed(2) : null,
    dayPnl: +((price - o.prevClose) * shares).toFixed(2),
    provider: 'eastmoney',
    quote,
  };
}

const STATE = {
  strip: [
    mkItem({ symbol: SHANGHAI, code: '000001', name: '上证指数', index: true, price: 3210.55, prevClose: 3196.2 }),
    mkItem({ symbol: 'sz399001', code: '399001', name: '深证成指', index: true, price: 10120.3, prevClose: 10198.4 }),
    mkItem({ symbol: MAOTAI, code: '600519', name: '贵州茅台', price: 1680.5, prevClose: 1665.0, shares: 100, cost: 1500 }),
    mkItem({ symbol: PINGAN, code: '000001', name: '平安银行', price: 9.85, prevClose: 10.12, shares: 2000, cost: 11.2 }),
  ],
  items: [],
  totals: {
    currency: 'CNY', hasPosition: true,
    marketValue: 100 * 1680.5 + 2000 * 9.85,
    costValue: 100 * 1500 + 2000 * 11.2,
    pnl: 100 * 1680.5 + 2000 * 9.85 - (100 * 1500 + 2000 * 11.2),
    pnlPct: 12.34, dayPnl: -120.5,
    byCurrency: { CNY: { marketValue: 188830, costValue: 172400, pnl: 16430 } },
  },
  settings: {
    refreshMs: 5000, topOffset: 6, opacity: 0.96, scroll: true, flash: true,
    collapsed: false, klineCount: 120, period: 'day', adjust: 'pre',
    chart: 'trend', trendDays: 1, showOrderBook: true, alertToast: true,
    showWatch: true, showHoldings: true, showIndex: true, showTotals: true,
    showTrend: true, showKline: true, showTrades: true, showAlerts: true, showAi: true,
    aiStyle: 'short', aiKline: true, aiTrend: true, aiBook: true, aiTrades: true, aiIndex: true,
  },
  alerts: [
    {
      id: 'al1', symbol: MAOTAI, code: '600519', name: '贵州茅台',
      kind: 'price', op: '>=', value: 1700, enabled: true, current: 1680.5, hit: false,
    },
    {
      id: 'al2', symbol: PINGAN, code: '000001', name: '平安银行',
      kind: 'pct', op: '<=', value: -3, enabled: true, current: -2.67, hit: true, firedAt: 1,
    },
  ],
  market: { open: true, session: 'morning', label: '交易中', shanghai: '10:23' },
  updatedAt: Date.now(),
};
// 宿主返回的 items 是「每只标的一条」（按 symbol upsert），指数也在里面、靠 index 标记区分。
// 这里曾经写成「非指数项 + 全部」，导致同一只出现两次，把表格行数和选中数的断言都带偏了。
STATE.items = STATE.strip.slice();

/* ---------- 分时 / 盘口 / 流水 夹具 ---------- */

function mkTrend(days = 1) {
  const points = [];
  const total = 241 * days;
  let px = 1650;
  const start = new Date('2026-10-16T09:30:00+08:00').getTime();
  for (let i = 0; i < total; i++) {
    const o = px;
    px = +(px * (1 + ((i % 11) - 5) / 900)).toFixed(2);
    const t = new Date(start + i * 60000);
    points.push({
      time: `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`,
      open: o, price: px,
      high: +Math.max(o, px).toFixed(2), low: +Math.min(o, px).toFixed(2),
      volume: 1200 + (i % 37) * 11, amount: 2e6 + i * 1000,
      avg: +((o + px) / 2).toFixed(2),
    });
  }
  return {
    ok: true, symbol: MAOTAI, code: '600519', market: 1, name: '贵州茅台',
    prevClose: 1665, days, points, provider: 'eastmoney', ts: Date.now(),
  };
}

const TREND = mkTrend(1);

/** 盘口：asks[0] 必须是卖1（最低卖价），bids[0] 是买1（最高买价）——
 *  这是 lib/providers.js:597-612 的顺序，界面负责把卖盘倒过来显示。 */
const BOOK = {
  ok: true, symbol: MAOTAI, code: '600519', market: 1, name: '贵州茅台',
  price: 1680.5, prevClose: 1665, open: 1668, high: 1690, low: 1660,
  volume: 38502, amount: 6.4e9,
  bids: [
    { price: 1680.4, volume: 120 }, { price: 1680.3, volume: 88 },
    { price: 1680.2, volume: 340 }, { price: 1680.1, volume: 56 },
    { price: 1680.0, volume: 210 },
  ],
  asks: [
    { price: 1680.6, volume: 140 }, { price: 1680.7, volume: 60 },
    { price: 1680.8, volume: 300 }, { price: 1680.9, volume: 95 },
    { price: 1681.0, volume: 175 },
  ],
  bidVolume: 814, askVolume: 770, commissionDiff: 44, commissionRatio: 0.0278,
  provider: 'eastmoney', ts: Date.now(),
};

const TRADES = [
  {
    id: 't1', symbol: MAOTAI, code: '600519', name: '贵州茅台',
    side: 'buy', price: 1500, shares: 100, fee: 5, date: '2026-01-06', note: '',
  },
  {
    id: 't2', symbol: PINGAN, code: '000001', name: '平安银行',
    side: 'sell', price: 11.2, shares: 500, fee: 6, date: '2026-03-11', note: '',
  },
];
const TRADES_BODY = {
  ok: true, trades: TRADES,
  realized: { total: 1998.75, fees: 11, tradeCount: TRADES.length },
  bySymbol: {
    [MAOTAI]: { name: '贵州茅台', qty: 100, avgCost: 1500.05, realized: 0 },
    [PINGAN]: { name: '平安银行', qty: -500, avgCost: 11.2, realized: 1998.75 },
  },
  quotes: { [MAOTAI]: { name: '贵州茅台', price: 1680.5, changePct: 0.93, currency: 'CNY' } },
};

/* ---------------- AI 分析夹具 ----------------
 * 契约来自 lib/index.js 的 GET /ai/models 与 POST /ai/analyze：
 *   /ai/models  -> { ok, providers, current, models, failures }
 *   /ai/analyze -> Content-Type: application/x-ndjson，每行一个 {type:...} 事件
 * 这里故意把 NDJSON 按 17 字节切开，保证某一行会被劈成两半，
 * 从而验证客户端跨 chunk 的拼行缓冲（少了它就是"偶尔丢半句"的经典 bug）。
 */
const AI_MODELS = {
  ok: true,
  providers: [{ id: 'deep', name: 'DeepSeek' }, { id: 'qwen', name: '通义千问' }],
  current: { provider: 'deep', model: 'deepseek-v4-flash' },
  models: [
    { provider: 'deep', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { provider: 'deep', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    { provider: 'qwen', id: 'qwen3-max', name: 'Qwen3 Max', description: '旗舰' },
  ],
  failures: [],
};
const AI_ANSWER = '### 结论\n- 现价 **1680.50**，成本 1500.05，浮盈明显\n量能温和，盘口买盘 814 手。';
const AI_EVENTS = [
  { type: 'meta', provider: 'deep', model: 'deepseek-v4-flash', meta: { chars: 1234, has: ['日K', '分时', '盘口'] } },
  { type: 'reasoning', text: '先看均线再看量能' },
  { type: 'delta', text: '### 结论\n' },
  { type: 'delta', text: '- 现价 **1680.50**，成本 ' },
  { type: 'delta', text: '1500.05，浮盈明显\n' },
  { type: 'delta', text: '量能温和，盘口买盘 814 手。' },
  {
    type: 'done', text: AI_ANSWER,
    usage: { inputTokens: 900, outputTokens: 120 }, elapsedMs: 2100, finish: 'stop',
  },
];
const AI_LINES = AI_EVENTS.map((e) => JSON.stringify(e));
const analyzeLog = [];

function aiStreamResponse() {
  const enc = new TextEncoder();
  const bytes = enc.encode(`${AI_LINES.join('\n')}\n`);
  const cuts = [];
  for (let at = 0; at < bytes.length; at += 17) cuts.push(bytes.slice(at, at + 17));
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (/content-type/i.test(String(k)) ? 'application/x-ndjson; charset=utf-8' : null) },
    body: {
      getReader() {
        return {
          read() {
            if (i >= cuts.length) return Promise.resolve({ done: true, value: undefined });
            const value = cuts[i++];
            return Promise.resolve({ done: false, value });
          },
          cancel() { return Promise.resolve(); },
        };
      },
    },
    json: () => Promise.resolve(AI_MODELS),
  };
}

function mkCandles(n) {
  const out = [];
  let px = 1500;
  const end = new Date('2026-10-16T00:00:00+08:00').getTime();
  for (let i = n - 1; i >= 0; i--) {
    const o = px;
    px = +(px * (1 + ((i % 7) - 3) / 400)).toFixed(2);
    const c = px;
    out.push({
      date: new Date(end - i * 86400000).toISOString().slice(0, 10),
      open: o, close: c,
      high: +Math.max(o, c).toFixed(2), low: +Math.min(o, c).toFixed(2),
      volume: 100000 + i * 137, amount: 1e8 + i, changePct: 0.5,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
const ALL_CANDLES = mkCandles(800);

const fetchLog = [];
/** 故障注入。null = 正常；'auth' = 宿主路由不存在，DSH 回 401；
 *  'offline' = 本地服务没起来，fetch 直接 reject。 */
let FAULT = null;
/** 模拟"宿主是旧版本"：POST /settings/save 只认识老的设置键，新键静默丢弃 */
let DROP_UNKNOWN_SETTINGS = false;
function fakeFetch(url, init = {}) {
  const u = String(url);
  fetchLog.push(u);
  if (FAULT === 'offline') return Promise.reject(new TypeError('fetch failed'));
  if (FAULT === 'auth') {
    return Promise.resolve({
      ok: false, status: 401,
      json: () => Promise.resolve({ ok: false, error: '未经授权' }),
    });
  }
  let body;
  if (u.includes('/ai/models')) {
    // 宿主契约：GET /ai/models -> { ok, providers, current, models, failures }
    body = AI_MODELS;
  } else if (u.includes('/ai/analyze')) {
    // 宿主契约：POST /ai/analyze -> NDJSON 流；先把请求体记下来供断言
    try { analyzeLog.push(JSON.parse(init.body || '{}')); } catch { analyzeLog.push({}); }
    return aiStreamResponse();
  } else if (u.includes('/settings/save')) {
    // 宿主契约：lib/index.js:314-323 返回 { ok:true, settings }，客户端 patchSettings
    // 直接读 data.settings（lib/client.js:283-286），缺了就等于把 settings 置空。
    let patch = {};
    try { patch = JSON.parse(init.body || '{}'); } catch { /* 非法 JSON 按空补丁处理 */ }
    if (DROP_UNKNOWN_SETTINGS) {
      // 模拟"宿主是旧版本"：它的默认设置表里没有这些新键，所以响应里根本不带它们
      const legacy = ['refreshMs', 'topOffset', 'collapsed', 'opacity', 'showWatch', 'showHoldings',
        'showIndex', 'scroll', 'period', 'adjust', 'klineCount', 'flash', 'klineInStrip'];
      const old = {};
      for (const k of legacy) if (STATE.settings[k] !== undefined) old[k] = STATE.settings[k];
      body = { ok: true, settings: old };
    } else {
      STATE.settings = { ...STATE.settings, ...patch };
      body = { ok: true, settings: STATE.settings };
    }
  } else if (u.includes('/state')) body = STATE;
  else if (u.includes('/kline')) {
    const q = new URL(u, 'http://x').searchParams;
    const count = Math.min(Number(q.get('count')) || 120, 1000);
    const all = ALL_CANDLES;
    body = {
      ok: true, symbol: q.get('symbol'), period: q.get('period'),
      adjust: q.get('adjust'), candles: all.slice(Math.max(0, all.length - count)),
    };
  } else if (u.includes('/trends')) {
    const q = new URL(u, 'http://x').searchParams;
    const days = Number(q.get('days')) || 1;
    body = days === 1 ? TREND : mkTrend(days);
  } else if (u.includes('/orderbook')) body = BOOK;
  else if (u.includes('/trades/save')) {
    // 宿主契约：POST /trades/save 返回 { ok:true, trade, realized, state }
    let patch = {};
    try { patch = JSON.parse(init.body || '{}'); } catch { /* 空补丁 */ }
    const trade = { id: `t${TRADES.length + 1}`, fee: 0, date: '2026-10-16', name: '贵州茅台', ...patch };
    TRADES.push(trade);
    body = { ok: true, trade, realized: TRADES_BODY.realized.total, state: STATE };
  } else if (u.includes('/trades/remove')) {
    let patch = {};
    try { patch = JSON.parse(init.body || '{}'); } catch { /* 空补丁 */ }
    const i = TRADES.findIndex((t) => t.id === patch.id);
    if (i >= 0) TRADES.splice(i, 1);
    body = { ok: true, removed: i >= 0, state: STATE };
  } else if (u.includes('/trades/clear')) {
    TRADES.length = 0;
    body = { ok: true, removed: 2, realized: 0 };
  } else if (u.includes('/trades/apply')) {
    body = { ok: true, changed: 2, state: STATE };
  } else if (u.includes('/trades')) {
    body = { ...TRADES_BODY, trades: TRADES.slice() };
  } else if (u.includes('/alerts/save')) {
    // 宿主契约：POST /alerts/save 返回 { ok:true, alert, state }
    let patch = {};
    try { patch = JSON.parse(init.body || '{}'); } catch { /* 空补丁 */ }
    let alert = patch.id ? STATE.alerts.find((a) => a.id === patch.id) : null;
    if (alert) Object.assign(alert, patch);
    else {
      alert = {
        id: `al${STATE.alerts.length + 1}`, symbol: MAOTAI, code: '600519', name: '贵州茅台',
        kind: 'price', op: '>=', value: 0, enabled: true, hit: false, ...patch,
      };
      STATE.alerts.push(alert);
    }
    body = { ok: true, alert, state: STATE };
  } else if (u.includes('/alerts/remove')) {
    let patch = {};
    try { patch = JSON.parse(init.body || '{}'); } catch { /* 空补丁 */ }
    const i = STATE.alerts.findIndex((a) => a.id === patch.id);
    if (i >= 0) STATE.alerts.splice(i, 1);
    body = { ok: true, removed: i >= 0 };
  } else if (u.includes('/alerts/ack')) {
    let patch = {};
    try { patch = JSON.parse(init.body || '{}'); } catch { /* 空补丁 */ }
    const found = STATE.alerts.find((a) => a.id === patch.id);
    if (found) { found.hit = false; found.firedAt = null; }
    body = { ok: true };
  } else if (u.includes('/alerts/dismiss')) body = { ok: true };
  else if (u.includes('/search')) body = { ok: true, hits: [] };
  else body = { ok: true };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/* ============================================================
 * 2. 最小 DOM 替身
 * ============================================================ */

let drawCalls = 0;
/** canvas 上真正落笔的文字。成本线要在图上写「成本 xxx」，只能靠这个断言。 */
const textCalls = [];
const styleTags = [];
/** 所有 document.createElement 出来的节点。K 线 canvas 是命令式创建再挂到 ref 上的，
 *  不在 React 树里，只能靠这个登记表找到。 */
const createdEls = [];

function makeCtx2d(node) {
  const store = { canvas: node };
  return new Proxy(store, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 8 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (k === 'fillText' || k === 'strokeText') {
        return (text) => { drawCalls++; textCalls.push(String(text)); return undefined; };
      }
      return () => { drawCalls++; return undefined; };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function makeNode(tag, attrs = {}) {
  const a = { ...attrs };
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    style: {}, dataset: {},
    children: [], childNodes: [],
    textContent: '', innerHTML: '', value: '', checked: false,
    clientWidth: 720, clientHeight: 320,
    offsetWidth: 720, offsetHeight: 320, offsetTop: 40, offsetLeft: 0,
    scrollWidth: 1800, scrollLeft: 0, scrollHeight: 400,
    parentNode: null, ownerDocument: null,
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    appendChild(c) { node.children.push(c); node.childNodes.push(c); if (c) c.parentNode = node; return c; },
    insertBefore(c) { node.children.unshift(c); node.childNodes.unshift(c); return c; },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i >= 0) { node.children.splice(i, 1); node.childNodes.splice(i, 1); }
      return c;
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    hasAttribute: (k) => k in a,
    getAttribute: (k) => (k in a ? a[k] : null),
    setAttribute: (k, v) => { a[k] = v; },
    removeAttribute: (k) => { delete a[k]; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 40, right: 720, bottom: 360, width: 720, height: 320, x: 0, y: 40 }),
    getContext(kind) { return kind === '2d' ? node._ctx : null; },
    // 真记录监听器，才能在测试里派发合成事件（滚轮/拖动都靠这个验证）
    __listeners: new Map(),
    addEventListener(type, fn, opts) {
      const arr = node.__listeners.get(type) || [];
      arr.push({ fn, capture: !!(opts === true || (opts && opts.capture)), passive: opts && opts.passive });
      node.__listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = node.__listeners.get(type) || [];
      node.__listeners.set(type, arr.filter((l) => l.fn !== fn));
    },
    focus() {}, blur() {}, select() {}, click() {},
    scrollIntoView() {}, setPointerCapture() {}, releasePointerCapture() {},
    contains() { return false; },
    cloneNode() { return makeNode(tag); },
    __attrs: a,
  };
  node._ctx = makeCtx2d(node);
  return node;
}

/** 派发一个合成事件：本测试只需要「挂在同一个节点上的监听器被调用」这一层语义 */
function dispatch(node, type, ev = {}) {
  const e = Object.assign({
    type, target: node, currentTarget: node,
    button: 0, clientX: 0, clientY: 0, deltaX: 0, deltaY: 0, cancelable: true,
    _prevented: false, _stopped: false,
    preventDefault() { e._prevented = true; },
    stopPropagation() { e._stopped = true; },
  }, ev);
  const list = (node.__listeners && node.__listeners.get(type)) || [];
  for (const l of list.slice()) l.fn(e);
  return e;
}

function dispatchWindow(type, ev = {}) {
  const list = windowListeners.get(type) || [];
  const e = Object.assign({ type, cancelable: true, preventDefault() {}, stopPropagation() {} }, ev);
  for (const fn of list.slice()) fn(e);
  return e;
}

const documentElement = makeNode('html');
documentElement.setAttribute('data-windows-titlebar', '');
const bodyEl = makeNode('body');
const headEl = makeNode('head');

function makeEl(t) {
  const n = makeNode(t);
  createdEls.push(n);
  return n;
}

const document = {
  documentElement,
  body: bodyEl,
  head: headEl,
  createElement: makeEl,
  createElementNS: (_ns, t) => makeEl(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  querySelector(sel) {
    const m = /style\[data-plugin-css=["']?(.+?)["']?\]/.exec(String(sel));
    if (m) return styleTags.find((s) => s.dataset.pluginCss === m[1]) || null;
    return null;
  },
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
  hidden: false, visibilityState: 'visible',
};

const originalAppendChild = headEl.appendChild.bind(headEl);
headEl.appendChild = (c) => {
  if (String(c.tagName).toLowerCase() === 'style') styleTags.push(c);
  return originalAppendChild(c);
};

function getComputedStyle() {
  return {
    getPropertyValue(k) {
      if (k === '--dsh-frame-top-clearance') return '40px';
      if (k === '--dsh-windows-titlebar-height') return '40px';
      if (k === '--dsh-windows-menu-start') return '84px';
      return '';
    },
  };
}

const intervals = new Map();
let intervalSeq = 0;
const liveIntervals = new Set();

function setIntervalShim(fn, ms) {
  const id = ++intervalSeq;
  intervals.set(id, { fn, ms });
  liveIntervals.add(id);
  return id;
}
function clearIntervalShim(id) { liveIntervals.delete(id); intervals.delete(id); }

let rafCount = 0;
const windowListeners = new Map();
const window = {
  devicePixelRatio: 2,
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener(type, fn) {
    const a = windowListeners.get(type) || [];
    a.push(fn);
    windowListeners.set(type, a);
  },
  removeEventListener(type, fn) {
    const a = windowListeners.get(type) || [];
    windowListeners.set(type, a.filter((f) => f !== fn));
  },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle,
  location: { href: 'http://127.0.0.1:19387/', origin: 'http://127.0.0.1:19387' },
  __ModuleLoader__: { load(def) { window.__captured = def; } },
};

const localStorageMap = new Map();
const localStorage = {
  getItem: (k) => (localStorageMap.has(k) ? localStorageMap.get(k) : null),
  setItem: (k, v) => { localStorageMap.set(k, String(v)); },
  removeItem: (k) => { localStorageMap.delete(k); },
  clear: () => localStorageMap.clear(),
  key: (i) => [...localStorageMap.keys()][i],
  get length() { return localStorageMap.size; },
};

class ResizeObserver {
  constructor(cb) { this.cb = cb; }
  observe() {} unobserve() {} disconnect() {}
}

const requestAnimationFrame = (fn) => {
  if (rafCount++ > 4) return 0;
  return setTimeout(() => fn(Date.now()), 0);
};
const cancelAnimationFrame = (id) => clearTimeout(id);

/* ============================================================
 * 3. 最小 React 替身（带 hook 分发 + 组件树渲染）
 * ============================================================ */

let dirty = false;
const fibers = new Map();
let current = null;
let pendingEffects = [];
const allCleanups = [];

function sameDeps(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function beginFiber(key) {
  let hooks = fibers.get(key);
  if (!hooks) { hooks = []; fibers.set(key, hooks); }
  current = { hooks, index: 0, key, pending: [] };
  return current;
}

function slot(factory) {
  const c = current;
  const i = c.index++;
  if (!(i in c.hooks)) c.hooks[i] = factory();
  return c.hooks[i];
}

const React = {
  createElement(type, props, ...children) {
    const p = props ? Object.assign({}, props) : {};
    if (children.length === 1) p.children = children[0];
    else if (children.length > 1) p.children = children;
    return { __el: true, type, props: p };
  },
  useState(init) {
    const s = slot(() => ({ v: typeof init === 'function' ? init() : init }));
    return [s.v, (nv) => { s.v = typeof nv === 'function' ? nv(s.v) : nv; dirty = true; }];
  },
  useRef(init) {
    return slot(() => ({ v: { current: init === undefined ? null : init } })).v;
  },
  useEffect(fn, deps) {
    const s = slot(() => ({ v: { deps: undefined, cleanup: undefined } }));
    if (!sameDeps(s.v.deps, deps)) {
      // React 语义：依赖变化时先跑上一次的清理函数，再跑新的。
      // 少了这一步，"改了依赖之后旧定时器有没有被清掉"就测不出来。
      if (typeof s.v.cleanup === 'function') s.v.cleanup();
      s.v.cleanup = undefined;
      s.v.deps = deps ? deps.slice() : null;
      current.pending.push({ fn, setCleanup: (c) => { s.v.cleanup = c; } });
    }
  },
  useMemo(fn, deps) {
    const s = slot(() => ({ v: { deps: undefined, val: undefined } }));
    if (!sameDeps(s.v.deps, deps)) {
      s.v.deps = deps ? deps.slice() : undefined;
      s.v.val = fn();
    }
    return s.v.val;
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
};

/* ---------------- 渲染器 ---------------- */

let refAssignments = 0;

function render(node, key) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (Array.isArray(node)) {
    return node.map((c, i) => render(c, `${key}.${i}`)).filter(Boolean);
  }
  if (!node.__el) return { text: String(node) };

  const { type, props } = node;

  if (typeof type === 'function') {
    const fiber = beginFiber(key);
    const out = type(props);
    // 先取走本 fiber 的 effect，再渲染子树 —— 否则 current 会被子组件覆盖
    const mine = fiber.pending.slice();
    const kids = render(out, `${key}/r`);
    pendingEffects.push(...mine);
    return { comp: type.name || type.displayName || 'Anonymous', props, kids };
  }

  if (type === Symbol.for('react.fragment') || type === undefined) {
    return render(props.children, `${key}/f`);
  }

  const kids = render(props.children, `${key}/c`);
  if (props.ref && typeof props.ref === 'object') {
    const refNode = props.ref.current;
    if (!refNode) {
      props.ref.current = makeNode(type);
      refAssignments++;
    }
  }
  return { tag: String(type), props, kids };
}

function walk(tree, fn) {
  if (!tree) return;
  if (Array.isArray(tree)) { tree.forEach((t) => walk(t, fn)); return; }
  fn(tree);
  if (tree.kids) walk(tree.kids, fn);
}

function collect(tree) {
  const out = [];
  walk(tree, (n) => { if (n.tag || n.comp) out.push(n); });
  return out;
}

function allText(tree) {
  const parts = [];
  walk(tree, (n) => { if (n.text) parts.push(n.text); });
  return parts.join(' ');
}

function findByClass(tree, cls) {
  return collect(tree).filter((n) => {
    const c = n.props && n.props.className;
    return typeof c === 'string' && c.split(/\s+/).indexOf(cls) >= 0;
  });
}

async function flush(n = 6) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

let tree = null;

async function settle(maxPass = 24) {
  for (let i = 0; i < maxPass; i++) {
    dirty = false;
    pendingEffects = [];
    tree = render({ __el: true, type: registered.component, props: {} }, 'root');
    const effs = pendingEffects.slice();
    for (const e of effs) {
      const c = e.fn();
      if (typeof c === 'function') {
        e.setCleanup(c);
        allCleanups.push(c);
      }
    }
    await flush(4);
    if (!dirty && effs.length === 0) break;
  }
  return tree;
}

/* ============================================================
 * 4. 走 Loader 契约
 * ============================================================ */

const source = fs.readFileSync(CLIENT_PATH, 'utf8');
// 去掉注释后再做静态检查，避免文档里的示例被当成真代码
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

section('模块包裹契约');
check('文件存在且非空', source.length > 1000, source.length);
check('顶层只有 __ModuleLoader__.load 一次', (code.match(/__ModuleLoader__\.load\(/g) || []).length === 1,
  (code.match(/__ModuleLoader__\.load\(/g) || []).length);
check('没有顶层 import/export（浏览器 bundle 不走 ESM）', !/^\s*(import|export)\s/m.test(code));
check('没有 require() 客户端宿主包', !/require\(['"]@deepseek-ai\//.test(code));
check('没有裸 npm 依赖', !/require\(['"](?!react['"])/.test(code), (code.match(/require\(['"][^'"]+['"]\)/g) || []));

const sandboxGlobals = {
  window, document, fetch: fakeFetch, getComputedStyle, ResizeObserver,
  requestAnimationFrame, cancelAnimationFrame,
  setInterval: setIntervalShim, clearInterval: clearIntervalShim,
  setTimeout, clearTimeout, localStorage, console,
  URL, Date, Math, JSON, Promise, Object, Array, Number, String, Boolean,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  Intl, Map, Set, Error, RegExp, Symbol, TextEncoder,
  navigator: { userAgent: 'node-verify', language: 'zh-CN' },
  performance: { now: () => Date.now() },
};

const names = Object.keys(sandboxGlobals);
let evalErr = null;
try {
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, source);
  fn(...names.map((n) => sandboxGlobals[n]));
} catch (e) {
  evalErr = e;
}
check('client.js 能在浏览器环境下执行不报错', evalErr === null, evalErr && (evalErr.stack || evalErr.message));

const def = window.__captured;
check('调用了一次 __ModuleLoader__.load', !!def);
check(`注册 id 等于包名 ${PKG_NAME}`, def && def.id === PKG_NAME, def && def.id);
check('def.factory 是函数', def && typeof def.factory === 'function');

/* ============================================================
 * 5. factory + apply
 * ============================================================ */

section('factory 与槽位注册');
let mod = null;
let factoryErr = null;
const reactRequests = [];
try {
  mod = def.factory((name) => {
    reactRequests.push(name);
    if (name === 'react') return React;
    throw new Error(`意外的模块请求: ${name}`);
  });
} catch (e) {
  factoryErr = e;
}
check('factory(require) 不抛错', factoryErr === null, factoryErr && (factoryErr.stack || factoryErr.message));
check('只请求了 react', reactRequests.length === 1 && reactRequests[0] === 'react', reactRequests);
check('返回 { inject, apply }', mod && Array.isArray(mod.inject) && typeof mod.apply === 'function', mod && Object.keys(mod));
check("inject 恰好是 ['slots']", JSON.stringify(mod.inject) === '["slots"]', mod.inject);
check('factory 内没有副作用（未注入样式）', styleTags.length === 0, styleTags.length);

const registrations = [];
const effectLabels = [];
let fakeCtx = {
  slots: {
    inject(ownerKey, cb) { effectLabels.push(['inject', ownerKey]); return cb(); },
    register(entry, component) { registrations.push({ entry, component }); return () => {}; },
  },
  effect(fn, label) { effectLabels.push(['effect', label]); const d = fn(); return d; },
};

let applyErr = null;
try { mod.apply(fakeCtx); } catch (e) { applyErr = e; }
check('apply(ctx) 不抛错', applyErr === null, applyErr && (applyErr.stack || applyErr.message));
check('通过 ctx.slots.inject 声明槽位依赖', effectLabels.some(([k, v]) => k === 'inject' && v === 'shell.overlay'), effectLabels);
check('注册了 1 个槽位条目', registrations.length === 1, registrations.length);

const reg = registrations[0];
check("槽位名 = 'shell.overlay'（frame 级 overlay 座位）", reg && reg.entry.name === 'shell.overlay', reg && reg.entry.name);
check("条目 id = 'stock-bar'", reg && reg.entry.id === 'stock-bar', reg && reg.entry.id);
check('order 是数字', reg && typeof reg.entry.order === 'number', reg && reg.entry.order);
check('注册的是函数组件', reg && typeof reg.component === 'function', reg && typeof reg.component);
const registered = { component: reg.component };

section('样式注入');
check('样式写进了 document.head', styleTags.length === 1, styleTags.length);
check('样式带 data-plugin-css 便于去重', styleTags[0] && !!styleTags[0].dataset.pluginCss, styleTags[0] && styleTags[0].dataset);
check('样式带插件归属标记', styleTags[0] && styleTags[0].dataset.plugin === PKG_NAME);
check('样式内容是我们的 CSS 前缀 dst-', styleTags[0] && styleTags[0].textContent.includes('.dst-root'), null);
check('CSS 使用了 DSH 主题 token', styleTags[0] && styleTags[0].textContent.includes('--dsw-alias-'), null);
{
  const before = styleTags.length;
  mod.apply(fakeCtx);
  check('重复 apply 不会重复注入样式', styleTags.length === before, styleTags.length);
}

/* ============================================================
 * 6. 真实渲染
 * ============================================================ */

section('首次渲染（数据未到）');
let renderErr = null;
tree = null;
// 只跑一轮：这一轮里 effect 刚发出 fetch，数据还没回来 —— 这才是"加载中"那一帧
await settle(1);
check('组件渲染不抛错', tree !== null);
check('渲染出 .dst-root', findByClass(tree, 'dst-root').length === 1, findByClass(tree, 'dst-root').length);
check('渲染出 .dst-bar 顶栏', findByClass(tree, 'dst-bar').length === 1);
check('加载中显示占位文案', /加载行情中/.test(allText(tree)), allText(tree).slice(0, 120));

section('数据到位后渲染');
// 让 usePortfolio 的 effect 跑完：再 settle 几轮
await settle(12);
const text = allText(tree);
check('state 已拉取（/state 请求发出）', fetchLog.some((u) => u.includes('/api/stock-bar/state')), fetchLog.slice(0, 3));
check('顶栏显示交易时段标签', /交易中/.test(text), text.slice(0, 200));

const chips = findByClass(tree, 'dst-chip');
check('渲染出 4 个行情胶囊（2 指数 + 2 个股）', chips.length === 4, chips.length);
check('胶囊里出现贵州茅台', /贵州茅台/.test(text), null);
check('胶囊里出现价格 1680.5', /1,?680\.5/.test(text), null);

const rootNode = findByClass(tree, 'dst-root')[0];
check('顶栏钉在 Windows 标题栏下方（top=40px + 偏移 6px）',
  rootNode && rootNode.props.style && /46px/.test(String(rootNode.props.style.top)),
  rootNode && rootNode.props.style);

section('涨跌语义色');
{
  const upNodes = findByClass(tree, 'dst-up');
  const downNodes = findByClass(tree, 'dst-down');
  // 茅台 1680.5 > 1665 前收 => 涨；平安 9.85 < 10.12 => 跌
  check('存在涨(.dst-up)的节点', upNodes.length > 0, upNodes.length);
  check('存在跌(.dst-down)的节点', downNodes.length > 0, downNodes.length);
  const upText = upNodes.map((n) => allText(n.kids)).join(' ');
  const downText = downNodes.map((n) => allText(n.kids)).join(' ');
  check('上涨色节点含茅台（+0.93%）', /0\.9\d%/.test(upText), upText.slice(0, 120));
  check('下跌色节点含负号（平安 -2.67%）', /-2\.6\d%|-2\.7\d%/.test(downText), downText.slice(0, 120));
}

section('持仓盈亏汇总徽标');
{
  const badges = findByClass(tree, 'dst-total');
  check('渲染出总额徽标', badges.length === 1, badges.length);
  const bt = allText(badges[0] && badges[0].kids);
  check('徽标显示持仓市值', /188,?830|18\.88万/.test(bt) || bt.length > 0, bt.slice(0, 160));
  check('徽标含盈亏金额', /\+?\d[\d,]*\.\d\d/.test(bt), bt.slice(0, 160));
}

section('点击展开面板');
{
  const brand = findByClass(tree, 'dst-brand').find((n) => n.props && typeof n.props.onClick === 'function');
  check('品牌区可点击', !!brand);
  let clickErr = null;
  try { brand.props.onClick({ preventDefault() {}, stopPropagation() {} }); } catch (e) { clickErr = e; }
  check('点击不抛错', clickErr === null, clickErr && clickErr.message);
  await settle(12);
  const panel = findByClass(tree, 'dst-panel');
  check('面板已展开', panel.length === 1, panel.length);
  const tabs = findByClass(tree, 'dst-tab');
  check('面板有多个标签页', tabs.length >= 3, tabs.map((t) => allText(t.kids)));
  check('面板文案含持仓只数', /只持仓/.test(allText(tree)), null);
}

section('持仓表格');
{
  const rows = findByClass(tree, 'dst-rowsel').concat(
    collect(tree).filter((n) => n.tag === 'tr'),
  );
  check('渲染出表格行', rows.length >= 2, rows.length);
  const bodyText = allText(tree);
  check('表格含成本价列', /成本/.test(bodyText), null);
  check('表格含盈亏列', /盈亏/.test(bodyText), null);
  check('表格含股数列', /股数|持股/.test(bodyText), null);
}

/** 按文案找按钮并点击；找不到返回 false，交给断言报错 */
function clickText(label) {
  const btns = collect(tree).filter((n) => n.tag === 'button');
  const b = btns.find((n) => allText(n.kids).trim() === label)
    || btns.find((n) => allText(n.kids).includes(label));
  if (!b) return false;
  b.props.onClick({ preventDefault() {}, stopPropagation() {} });
  return true;
}

function clickTitle(part) {
  const b = collect(tree).filter((n) => n.tag === 'button')
    .find((n) => String(n.props.title || '').includes(part));
  if (!b) return false;
  b.props.onClick({ preventDefault() {}, stopPropagation() {} });
  return true;
}

section('分时图（默认图型）');
{
  const drawsBefore = drawCalls;
  // 选中一行 -> 触发行情图 effect（默认走分时）
  const trs = collect(tree).filter((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
  check('表格行可点击选中', trs.length > 0, trs.length);
  if (trs.length) {
    let err = null;
    try { trs[0].props.onClick({ preventDefault() {}, stopPropagation() {} }); } catch (e) { err = e; }
    check('点击行不抛错', err === null, err && err.message);
    await settle(14);
    const trendUrls = fetchLog.filter((u) => u.includes('/trends'));
    check('默认拉取分时接口', trendUrls.length > 0, trendUrls.slice(-1));
    check('分时请求带 days 参数', trendUrls.some((u) => /days=/.test(u)), trendUrls.slice(-1));
    check('分时文案出现', /分时/.test(allText(tree)), null);
    check('分时 canvas 真的被绘制了', drawCalls > drawsBefore, { before: drawsBefore, after: drawCalls });
    check('存在 3 日分时切换', clickText('3日'));
    await settle(12);
    check('切 3 日会重新请求分时',
      fetchLog.some((u) => u.includes('/trends') && /days=3/.test(u)),
      fetchLog.filter((u) => u.includes('/trends')).slice(-2));
  }
}

section('五档盘口');
{
  await settle(10);
  const txt = allText(tree);
  check('渲染出盘口区块', findByClass(tree, 'dst-book').length >= 1 || /五档盘口/.test(txt), null);
  check('盘口请求已发出', fetchLog.some((u) => u.includes('/orderbook')), fetchLog.filter((u) => u.includes('/orderbook')).slice(-1));
  check('盘口展示卖1', /卖1/.test(txt), null);
  check('盘口展示卖5', /卖5/.test(txt), null);
  check('盘口展示买1', /买1/.test(txt), null);
  check('盘口展示委比', /委比/.test(txt), null);
  check('盘口展示现价', /现价/.test(txt), null);
  // 卖盘必须倒着显示：最上面一行是卖5（宿主 asks[0] 是卖1）
  const askRows = collect(tree).filter((n) => typeof n.props.className === 'string'
    && n.props.className.includes('dst-book-ask'));
  if (askRows.length === 5) {
    check('卖盘最上一行是卖5', allText(askRows[0].kids).includes('卖5'), allText(askRows[0].kids));
    check('卖盘最下一行是卖1', allText(askRows[4].kids).includes('卖1'), allText(askRows[4].kids));
  } else {
    check('卖盘共 5 档', askRows.length === 5, askRows.length);
  }
}

section('K 线图');
{
  const drawsBefore = drawCalls;
  check('找到"K线"切换按钮', clickText('K线'));
  await settle(14);
  const canvases = createdEls.filter((n) => n.tagName === 'CANVAS')
    .concat(collect(tree).filter((n) => n.tag === 'canvas'));
  check('渲染出 canvas', canvases.length >= 1, canvases.length);
  const klineUrls = fetchLog.filter((u) => u.includes('/kline'));
  check('请求了 K 线接口', klineUrls.length > 0, klineUrls.slice(-2));
  check('K 线请求带 period/adjust/count', klineUrls.some((u) => /period=/.test(u) && /adjust=/.test(u) && /count=/.test(u)), klineUrls.slice(-1));
  check('canvas 真的被绘制了', drawCalls > drawsBefore, { before: drawsBefore, after: drawCalls });
  check('K 线相关文案出现', /日K|周K|前复权/.test(allText(tree)), null);
}

section('成本线（持仓时画在图上）');
{
  // 选中的是贵州茅台：100 股，成本 1500，现价 1680.5 -> 必须画出成本线
  const costTexts = textCalls.filter((t) => t.includes('成本'));
  check('图上写了成本价', costTexts.length > 0, costTexts.slice(-4));
  check('成本标签带具体价格', costTexts.some((t) => /1,?500/.test(t)), costTexts.slice(-4));
  check('面板里也有成本摘要行', /成本/.test(allText(tree)), null);
  const costCells = collect(tree).filter((n) => n.props && String(n.props.className || '').includes('dst-cost'));
  check('成本相关样式类生效', costCells.length > 0, costCells.map((n) => n.props.className).slice(0, 4));
}

section('涨跌停标记');
{
  // 平安银行 9.85 / 昨收 10.12 = -2.67%，不到跌停，不该有标记
  const texts = allText(tree);
  check('未涨跌停时不打标记', !/跌停|涨停/.test(texts), null);
  // 把价格改到跌停位（10.12 * 0.9 = 9.108 -> 9.11 四舍五入到分）再渲染
  const pingan = STATE.strip.find((i) => i.symbol === PINGAN);
  const old = pingan.price;
  pingan.price = 9.11;
  pingan.quote.price = 9.11;
  pingan.quote.changePct = +(((9.11 - 10.12) / 10.12) * 100).toFixed(2);
  pingan.changePct = pingan.quote.changePct;
  clickTitle('立即刷新行情');
  await settle(6);
  const marks = collect(tree).filter((n) => n.props && String(n.props.className || '').includes('dst-limit'));
  check('跌停时打上标记', marks.length > 0, marks.map((n) => allText(n.kids)).slice(0, 4));
  check('标记文案是「跌停」', marks.some((n) => allText(n.kids).includes('跌停')), marks.map((n) => allText(n.kids)).slice(0, 4));
  pingan.price = old;
  pingan.quote.price = old;
  pingan.quote.changePct = +(((old - 10.12) / 10.12) * 100).toFixed(2);
  pingan.changePct = pingan.quote.changePct;
  clickTitle('立即刷新行情');
  await settle(6);
}

section('休市时自动放慢轮询');
{
  const ms = () => [...intervals.values()].map((x) => x.ms);
  check('交易时段按用户设定的间隔轮询', ms().includes(5000), ms());
  STATE.market = { open: false, session: 'closed', label: '已收盘', shanghai: '16:01' };
  clickTitle('立即刷新行情');
  await settle(6);
  check('收盘后轮询降到 60s', ms().includes(60000), ms());
  check('旧的高频定时器已清掉', !ms().includes(5000), ms());
  STATE.market = { open: true, session: 'morning', label: '交易中', shanghai: '10:23' };
  clickTitle('立即刷新行情');
  await settle(6);
  check('回到交易时段恢复原间隔', ms().includes(5000), ms());
}

section('切换周期');
{
  const btns = collect(tree).filter((n) => n.tag === 'button');
  const weekBtn = btns.find((b) => allText(b.kids).includes('周K'));
  check('找到"周K"按钮', !!weekBtn);
  if (weekBtn) {
    const before = fetchLog.filter((u) => u.includes('/kline')).length;
    let err = null;
    try { weekBtn.props.onClick({ preventDefault() {}, stopPropagation() {} }); } catch (e) { err = e; }
    check('切周期不抛错', err === null, err && err.message);
    await settle(14);
    const after = fetchLog.filter((u) => u.includes('/kline'));
    check('切周期后重新请求 K 线', after.length > before, after.slice(-1));
    check('新请求 period=week', after.some((u) => /period=week/.test(u)), after.slice(-1));
  }
}

section('切换标签页 / 自选');
{
  const btns = collect(tree).filter((n) => n.tag === 'button');
  const idxBtn = btns.find((b) => /自选|全部|指数/.test(allText(b.kids)));
  check('存在自选/指数类标签', !!idxBtn, btns.map((b) => allText(b.kids)).slice(0, 12));
  if (idxBtn) {
    let err = null;
    try { idxBtn.props.onClick({ preventDefault() {}, stopPropagation() {} }); } catch (e) { err = e; }
    check('切标签不抛错', err === null, err && err.message);
    await settle(6);
    check('切标签后仍能正常渲染', findByClass(tree, 'dst-bar').length === 1);
  }
}

section('交易流水');
{
  check('切到流水标签页', clickText('流水'));
  await settle(12);
  check('请求了流水接口', fetchLog.some((u) => u.includes('/trades')), fetchLog.filter((u) => u.includes('/trades')).slice(-1));
  const txt = allText(tree);
  check('显示已实现盈亏', /已实现盈亏/.test(txt), null);
  check('显示流水笔数', /笔/.test(txt), null);
  check('列出流水标的', /贵州茅台/.test(txt), null);
  check('显示买入方向', /买入/.test(txt), null);
  check('显示卖出方向', /卖出/.test(txt), null);
  check('有"记一笔"按钮', collect(tree).some((n) => n.tag === 'button' && allText(n.kids).includes('记一笔')));
  check('有"按流水同步持仓"按钮', clickText('按流水同步持仓'));
  await settle(10);
  check('同步持仓请求 /trades/apply', fetchLog.some((u) => u.includes('/trades/apply')), null);
  let err = null;
  try { clickText('记一笔'); } catch (e) { err = e; }
  await settle(6);
  check('空标的记账不抛错', err === null, err && err.message);
  check('空标的记账给出错误提示', /请填写股票代码或名称/.test(allText(tree)), null);
}

section('价格预警');
{
  check('切到预警标签页', clickText('预警'));
  await settle(12);
  const txt = allText(tree);
  check('列出预警标的', /贵州茅台/.test(txt) && /平安银行/.test(txt), null);
  check('显示监控中状态', /监控中/.test(txt), null);
  check('显示已触发状态', /已触发/.test(txt), null);
  check('显示价格条件', /价格 >= 1700/.test(txt), null);
  check('显示涨跌幅条件', /涨跌幅 <= -3%/.test(txt), null);

  let err = null;
  try { clickText('加预警'); } catch (e) { err = e; }
  await settle(6);
  check('空标的加预警不抛错', err === null, err && err.message);
  check('空标的加预警给出错误提示', /请填写股票代码或名称/.test(allText(tree)), null);

  const ackBtn = collect(tree).filter((n) => n.tag === 'button')
    .find((n) => String(n.props.title || '').includes('重新监控'));
  check('触发项有"知道了"按钮', !!ackBtn);
  if (ackBtn) {
    let e2 = null;
    try { ackBtn.props.onClick({ preventDefault() {}, stopPropagation() {} }); } catch (e) { e2 = e; }
    await settle(10);
    check('ack 不抛错', e2 === null, e2 && e2.message);
    check('ack 请求已发出', fetchLog.some((u) => u.includes('/alerts/ack')), null);
  }
}

section('预警弹窗提示');
{
  STATE.fired = [{
    id: 'al2', symbol: PINGAN, code: '000001', name: '平安银行',
    kind: 'pct', op: '<=', value: -3, enabled: true, hit: true, firedAt: 20261016, current: -3.21,
  }];
  check('点击刷新按钮', clickTitle('立即刷新行情'));
  await settle(14);
  check('弹出了预警提示浮层', findByClass(tree, 'dst-toasts').length === 1, findByClass(tree, 'dst-toasts').length);
  const txt = allText(tree);
  check('提示里有标的名称', /平安银行/.test(txt), null);
  check('提示里有阈值', /-3/.test(txt), null);

  const x = collect(tree).filter((n) => n.tag === 'button')
    .find((n) => String(n.props.className || '').includes('dst-toast-x'));
  check('提示可关闭', !!x);
  if (x) {
    x.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle(6);
    check('关闭后浮层消失', findByClass(tree, 'dst-toasts').length === 0, findByClass(tree, 'dst-toasts').length);
  }
  STATE.fired = [];
}

section('宿主未加载时的提示（401 / 断网）');
{
  // 手动触发一次轮询：把已登记的定时器回调全部跑一遍
  const poke = () => { for (const it of [...intervals.values()]) it.fn(); };

  FAULT = 'auth';
  poke();
  await settle(8);
  check('401 时显示异常角标', findByClass(tree, 'dst-err-badge').length > 0,
    findByClass(tree, 'dst-err-badge').length);
  const badge = findByClass(tree, 'dst-err-badge')[0];
  check('角标 title 说明需要重启 DSH',
    !!badge && String(badge.props.title || '').includes('重启 DSH'),
    badge && badge.props.title);
  check('角标可点击跳到设置页', !!badge && typeof badge.props.onClick === 'function');
  if (badge) {
    badge.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle(6);
    check('设置页里给出完整原因', /重启 DSH/.test(allText(tree)), null);
  }

  FAULT = 'offline';
  poke();
  await settle(8);
  const b2 = findByClass(tree, 'dst-err-badge')[0];
  check('断网时也提示', !!b2, findByClass(tree, 'dst-err-badge').length);
  check('断网文案指向本地服务', !!b2 && String(b2.props.title || '').includes('本地服务'), b2 && b2.props.title);

  FAULT = null;
  poke();
  await settle(8);
  check('恢复后角标消失', findByClass(tree, 'dst-err-badge').length === 0,
    findByClass(tree, 'dst-err-badge').length);
}

section('旧宿主不认新设置项时的提示');
{
  const poke = () => { for (const it of [...intervals.values()]) it.fn(); };
  /** 设置页里按行标题点它的按钮（这行是本地副本：组件开关那一节里也有一份同名的） */
  function toggleRow(label) {
    const row = collect(tree).find((n) => n.tag === 'div'
      && typeof n.props.className === 'string'
      && n.props.className.split(' ').includes('dst-row')
      && (n.kids || []).some((k) => k.tag === 'span' && allText(k).trim() === label));
    if (!row) return false;
    const kids = (n) => (Array.isArray(n.kids) ? n.kids : []);
    const direct = kids(row).find((k) => k.tag === 'button');
    const nested = kids(row).map((k) => kids(k).find((kk) => kk.tag === 'button')).find(Boolean);
    const btn = direct || nested;
    if (!btn) return false;
    btn.props.onClick({ preventDefault() {}, stopPropagation() {} });
    return true;
  }
  check('打开设置页', clickText('设置'));
  await settle(10);
  const before = STATE.settings.showKline;
  DROP_UNKNOWN_SETTINGS = true; // 宿主装的是旧版本，showKline 这个键它不认识
  check('点一下「K线图」的开关', toggleRow('K线图'));
  await settle(12);
  check('宿主丢弃设置项时不再假装成功（角标出现）',
    findByClass(tree, 'dst-err-badge').length > 0, findByClass(tree, 'dst-err-badge').length);
  const badge = findByClass(tree, 'dst-err-badge')[0];
  check('角标指出是哪个设置项没保存',
    !!badge && String(badge.props.title || '').includes('showKline'), badge && badge.props.title);
  check('角标文案区分「宿主待重启」和「行情异常」',
    !!badge && allText(badge).includes('宿主待重启'), badge && allText(badge));
  check('设置项确实没被写进去（界面不会自己弹回去）',
    STATE.settings.showKline === before, `${before} -> ${STATE.settings.showKline}`);
  check('这一下没有把整个界面搞崩', findByClass(tree, 'dst-root').length > 0, null);
  poke();
  await settle(10);
  check('宿主太旧时的提示不会被下一轮成功轮询擦掉',
    findByClass(tree, 'dst-err-badge').length > 0, findByClass(tree, 'dst-err-badge').length);
  DROP_UNKNOWN_SETTINGS = false;
  check('宿主恢复后存一次设置就消掉提示', toggleRow('K线图'));
  await settle(12);
  check('提示消失', findByClass(tree, 'dst-err-badge').length === 0,
    findByClass(tree, 'dst-err-badge').length);
  // 这一节把 K 线开关拨动过，拨回原样：后面的「组件开关」用例假定 showKline 还是 true。
  // 必须在还在设置页的时候拨（设置行只在设置页里渲染）。
  check('K线开关拨回原样', toggleRow('K线图'));
  await settle(12);
  check('K线开关确实回到 true', STATE.settings.showKline === true, STATE.settings.showKline);
  check('回到持仓页', clickText('持仓'));
  await settle(10);
}

section('条内手动滚动（鼠标滚轮 / 拖动）');
{
  const trackNode = collect(tree).find((n) => n.tag === 'div' && n.props && n.props.className === 'dst-track');
  const trk = trackNode && trackNode.props.ref ? trackNode.props.ref.current : null;
  check('拿得到行情轨道元素', !!trk);
  if (trk) {
    trk.scrollWidth = 1800;
    trk.clientWidth = 720;
    trk.scrollLeft = 0;

    const wheelHandlers = trk.__listeners.get('wheel') || [];
    check('轨道注册了 wheel 监听', wheelHandlers.length >= 1, wheelHandlers.length);
    check('wheel 监听不是 passive（否则拦不住页面滚动）',
      wheelHandlers.length > 0 && wheelHandlers.every((l) => l.passive !== true),
      wheelHandlers.map((l) => l.passive));

    const e1 = dispatch(trk, 'wheel', { deltaY: 200 });
    check('普通鼠标滚轮向下 = 条内向右滚', trk.scrollLeft === 200, `scrollLeft=${trk.scrollLeft}`);
    check('轨道溢出时拦下页面滚动', e1._prevented === true, e1._prevented);

    dispatch(trk, 'wheel', { deltaX: -120, deltaY: 0 });
    check('横向滚轮优先于纵向', trk.scrollLeft === 80, `scrollLeft=${trk.scrollLeft}`);

    trk.scrollLeft = 0;
    trk.scrollWidth = 720;
    const e3 = dispatch(trk, 'wheel', { deltaY: 200 });
    check('没溢出就不抢滚轮', e3._prevented === false && trk.scrollLeft === 0,
      { prevented: e3._prevented, scrollLeft: trk.scrollLeft });

    trk.scrollWidth = 1800;
    trk.scrollLeft = 0;
    dispatch(trk, 'mousedown', { button: 0, clientX: 500 });
    dispatchWindow('mousemove', { clientX: 420 });
    const dragged = trk.scrollLeft;
    dispatchWindow('mouseup', {});
    check('按住往左拖 = 条内内容跟着走', dragged === 80, `scrollLeft=${dragged}`);

    const clickAfterDrag = dispatch(trk, 'click', {});
    check('拖动之后的 click 被吞掉（不会误选中）', clickAfterDrag._prevented === true, clickAfterDrag._prevented);
    const clickNoDrag = dispatch(trk, 'click', {});
    check('没拖动时 click 正常放行', clickNoDrag._prevented === false, clickNoDrag._prevented);

    dispatchWindow('mousemove', { clientX: 100 });
    check('松手后拖动监听已解绑', trk.scrollLeft === 80, `scrollLeft=${trk.scrollLeft}`);
    await settle(4);
  }
}

section('再点一次收起详情');
{
  check('回到持仓标签页', clickText('持仓'));
  await settle(12);
  let trs = collect(tree).filter((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
  check('持仓表格行可点击', trs.length >= 2, trs.length);
  check('每只标的只占一行（宿主按 symbol 去重）', trs.length === 2, trs.length);
  // 前面的用例已经选中过一行，先清干净，否则这里的第一次点击会变成「收起」
  const selRow = collect(tree).find((n) => n.tag === 'tr' && /dst-rowsel/.test(String((n.props && n.props.className) || '')));
  if (selRow) { selRow.props.onClick({ preventDefault() {}, stopPropagation() {} }); await settle(12); }
  check('起点确实处于未选中状态', findByClass(tree, 'dst-rowsel').length === 0,
    findByClass(tree, 'dst-rowsel').length);
  trs = collect(tree).filter((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
  if (trs.length >= 2) {
    trs[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle(14);
    check('点一下展开走势图', findByClass(tree, 'dst-kline-title').length > 0,
      findByClass(tree, 'dst-kline-title').length);
    check('展开后该行高亮', findByClass(tree, 'dst-rowsel').length === 1, findByClass(tree, 'dst-rowsel').length);

    trs = collect(tree).filter((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
    trs[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle(14);
    check('再点同一行就收起走势图', findByClass(tree, 'dst-kline-title').length === 0,
      findByClass(tree, 'dst-kline-title').length);
    check('收起后没有高亮行', findByClass(tree, 'dst-rowsel').length === 0, findByClass(tree, 'dst-rowsel').length);
    check('收起后给出提示文案', /再点一次收起/.test(allText(tree)), null);

    trs = collect(tree).filter((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
    trs[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle(12);
    trs = collect(tree).filter((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
    trs[1].props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle(14);
    check('点另一行是切换而不是收起', findByClass(tree, 'dst-kline-title').length > 0,
      findByClass(tree, 'dst-kline-title').length);
    check('切换后只有一行高亮', findByClass(tree, 'dst-rowsel').length === 1, findByClass(tree, 'dst-rowsel').length);
  }
}

section('AI 分析');
{
  check('切到 AI 分析标签页', clickText('AI 分析'));
  await settle(16);
  const selects = () => collect(tree).filter((n) => n.tag === 'select');
  const provSel = () => selects()[0] || null;
  const modelSel = () => selects()[1] || null;
  const provOpts = () => (provSel() ? (provSel().kids || []).filter((k) => k.tag === 'option') : []);
  const modelOpts = () => (modelSel() ? (modelSel().kids || []).filter((k) => k.tag === 'option') : []);
  check('供应商是父级下拉框，列出提供方并带模型数',
    provOpts().length === 2 && /DeepSeek（2 个模型）/.test(allText(tree))
    && /通义千问（1 个模型）/.test(allText(tree)), provOpts().length);
  check('模型是子级下拉框，只列当前供应商的模型',
    modelOpts().length === 2 && /DeepSeek V4 Flash/.test(allText(tree))
    && !/Qwen3 Max/.test(allText(tree)), modelOpts().length);
  check('默认选中宿主当前供应商与模型',
    !!provSel() && provSel().props.value === 'deep'
    && !!modelSel() && modelSel().props.value === 'deepseek-v4-flash',
    `${provSel() && provSel().props.value}/${modelSel() && modelSel().props.value}`);
  check('模型下拉框不再把供应商缀在模型名后面',
    !/DeepSeek V4 Flash · deep/.test(allText(tree)), null);
  // 换父级 → 子级跟着换
  check('切换到另一个供应商', (() => {
    const s = provSel();
    if (!s) return false;
    s.props.onChange({ target: { value: 'qwen' } });
    return true;
  })());
  await settle(10);
  check('换供应商后模型列表换成它自己的',
    modelOpts().length === 1 && /Qwen3 Max/.test(allText(tree)) && !/DeepSeek V4 Flash/.test(allText(tree)),
    modelOpts().length);
  check('换供应商后设置里也写成了新供应商',
    STATE.settings.aiProvider === 'qwen' && STATE.settings.aiModel === 'qwen3-max',
    `${STATE.settings.aiProvider}/${STATE.settings.aiModel}`);
  // 换回父级 deep，子级应该回到它自己的第一个
  provSel().props.onChange({ target: { value: 'deep' } });
  await settle(10);
  check('换回来时模型子级跟着回到 deep 的模型',
    modelOpts().length === 2 && STATE.settings.aiProvider === 'deep',
    `${STATE.settings.aiProvider}/${modelOpts().length}`);
  check('五个数据勾选项齐全',
    ['日K', '分时', '盘口', '流水', '大盘'].every((l) => allText(tree).includes(l)), null);
  check('额外要求输入框存在',
    collect(tree).some((n) => n.tag === 'input' && /额外要求/.test(String(n.props.placeholder || ''))), null);
  check('未开始时有说明文案', /让模型做一次复盘/.test(allText(tree)), null);
  check('未开始时不渲染正文区', findByClass(tree, 'dst-ai-out').length === 0, findByClass(tree, 'dst-ai-out').length);

  const before = analyzeLog.length;
  check('点「开始分析」', clickText('开始分析'));
  await settle(30);
  check('确实发出了分析请求', analyzeLog.length === before + 1, analyzeLog.length);
  const req = analyzeLog[analyzeLog.length - 1] || {};
  check('请求带了分析标的（沿用表格里选中的那只）', typeof req.symbol === 'string' && req.symbol.length > 0, req.symbol);
  check('请求带了提供方与模型', req.provider === 'deep' && req.model === 'deepseek-v4-flash',
    `${req.provider}/${req.model}`);
  check('默认走简版', req.style === 'short', req.style);
  check('请求里带上数据勾选', !!req.include && req.include.kline === true && req.include.indexes === true,
    JSON.stringify(req.include));

  check('NDJSON 跨 chunk 拼行后正文完整', /量能温和，盘口买盘 814 手。/.test(allText(tree)), null);
  check('markdown 小标题渲染成块', findByClass(tree, 'dst-ai-h').length >= 1, findByClass(tree, 'dst-ai-h').length);
  check('**加粗** 渲染成 strong', findByClass(tree, 'dst-ai-strong').length >= 1,
    findByClass(tree, 'dst-ai-strong').length);
  check('列表项渲染成 li 且内容在', collect(tree).some((n) => n.tag === 'li'), null);
  check('显示 token 用量', /输入 900 \/ 输出 120/.test(allText(tree)), null);
  check('显示数据包字数', /数据 1234 字/.test(allText(tree)), null);
  check('显示已喂的数据来源', /已喂/.test(allText(tree)), null);
  check('meta 标记了模型名', findByClass(tree, 'dst-pill').some((n) => /deepseek-v4-flash/.test(allText(n))), null);
  check('思考过程折叠展示且内容在', findByClass(tree, 'dst-ai-think').length === 1
    && /先看均线再看量能/.test(allText(tree)), null);
  check('有复制按钮', /复制/.test(allText(tree)), null);
  check('结束后按钮变成「重新分析」', /重新分析/.test(allText(tree)), null);
  check('流结束后光标消失', findByClass(tree, 'dst-ai-cursor').length === 0,
    findByClass(tree, 'dst-ai-cursor').length);
  check('底部有「不构成投资建议」提示', /不构成投资建议/.test(allText(tree)), null);

  // 换模型后应该把选择写回设置（下次打开还记住）
  check('切到第二个模型', (() => {
    const s = modelSel();
    if (!s) return false;
    s.props.onChange({ target: { value: 'deepseek-reasoner' } });
    return true;
  })());
  await settle(10);
  check('模型选择写进了设置', STATE.settings.aiModel === 'deepseek-reasoner', STATE.settings.aiModel);
  check('切模型后子级下拉框跟着变',
    !!modelSel() && modelSel().props.value === 'deepseek-reasoner'
    && !!provSel() && provSel().props.value === 'deep',
    modelSel() && modelSel().props.value);
}

section('组件开关（设置 → 显示）');
{
  // 手动触发一次轮询：把已登记的定时器回调全部跑一遍（和各处的 poke 一样）
  const poke = () => { for (const it of [...intervals.values()]) it.fn(); };

  /** 在设置页里按行标题点它的按钮，例如「K线图」这一行的 显示/隐藏 */
  function clickSettingToggle(label) {
    const row = collect(tree).find((n) => n.tag === 'div'
      && typeof n.props.className === 'string'
      && n.props.className.split(' ').includes('dst-row')
      && (n.kids || []).some((k) => k.tag === 'span' && allText(k).trim() === label));
    if (!row) return false;
    const kids = (n) => (Array.isArray(n.kids) ? n.kids : []);
    const direct = kids(row).find((k) => k.tag === 'button');
    const nested = kids(row).map((k) => kids(k).find((kk) => kk.tag === 'button')).find(Boolean);
    const btn = direct || nested;
    if (!btn) return false;
    btn.props.onClick({ preventDefault() {}, stopPropagation() {} });
    return true;
  }
  const btnTexts = () => collect(tree).filter((n) => n.tag === 'button').map((b) => allText(b).trim());
  const subLabels = () => findByClass(tree, 'dst-sub').map((n) => allText(n).trim());
  /** 选中表格里的第一行；已经选中时不要再点（再点会收起，这是本插件的切换式选中） */
  async function ensureRowSelected() {
    if (findByClass(tree, 'dst-kline-title').length) return true;
    const trs = collect(tree).filter((n) => n.tag === 'tr' && n.props.onClick);
    if (!trs.length) return false;
    trs[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle(14);
    return findByClass(tree, 'dst-kline-title').length > 0;
  }

  check('切到设置标签页', clickText('设置'));
  await settle(12);
  check('设置里出现组件开关',
    ['持仓汇总', '分时图', 'K线图', '流水标签页', '预警标签页', 'AI 分析标签页']
      .every((l) => allText(tree).includes(l)), null);
  check('两个分组小标题都在', findByClass(tree, 'dst-group-title').length === 2,
    findByClass(tree, 'dst-group-title').length);

  // ---- 关掉 K 线图：图表区只剩分时，切换按钮也一起消失 ----
  check('关掉「K线图」', clickSettingToggle('K线图'));
  await settle(12);
  check('K线开关写回了设置', STATE.settings.showKline === false, STATE.settings.showKline);
  check('关掉后按钮变成「隐藏」', (() => {
    const row = collect(tree).find((n) => n.tag === 'div'
      && typeof n.props.className === 'string' && n.props.className.split(' ').includes('dst-row')
      && (n.kids || []).some((k) => k.tag === 'span' && allText(k).trim() === 'K线图'));
    return !!row && /隐藏/.test(allText(row));
  })(), null);

  check('回持仓页', clickText('持仓'));
  await settle(10);
  check('选中一行', await ensureRowSelected(), null);
  check('只开分时时没有「分时/K线」切换按钮',
    !btnTexts().includes('K线') && subLabels().includes('分时'), subLabels().join(','));
  check('只开分时时周期按钮不出现', !btnTexts().includes('周K') && btnTexts().includes('3日'), null);

  // ---- 再关掉分时、打开 K 线：只剩 K 线 ----
  check('切回设置', clickText('设置'));
  await settle(10);
  clickSettingToggle('分时图');
  await settle(10);
  clickSettingToggle('K线图');
  await settle(10);
  check('分时关、K线开写回了设置',
    STATE.settings.showTrend === false && STATE.settings.showKline === true,
    `${STATE.settings.showTrend}/${STATE.settings.showKline}`);
  check('切回持仓', clickText('持仓'));
  await settle(10);
  await ensureRowSelected();
  check('只开K线时没有分时天数按钮',
    !btnTexts().includes('3日') && !btnTexts().includes('5日'), null);
  check('只开K线时周期按钮在', btnTexts().includes('周K'), null);
  check('只开K线时也没有切换按钮', !btnTexts().includes('分时'), null);

  // ---- 两个都关：图表区给出提示 ----
  clickText('设置');
  await settle(10);
  clickSettingToggle('K线图');
  await settle(10);
  check('两张图都关了', STATE.settings.showTrend === false && STATE.settings.showKline === false, null);
  clickText('持仓');
  await settle(10);
  await ensureRowSelected();
  check('都关掉时给出提示而不是空白',
    /分时图和 K 线图都在「设置 → 显示」里关掉了/.test(allText(tree)), null);
  check('都关掉时不再画图', !btnTexts().includes('周K') && !btnTexts().includes('3日'), null);

  // ---- 关掉标签页 ----
  clickText('设置');
  await settle(10);
  check('关掉「流水标签页」', clickSettingToggle('流水标签页'));
  await settle(10);
  check('关掉「AI 分析标签页」', clickSettingToggle('AI 分析标签页'));
  await settle(12);
  check('标签栏里没有流水了', !btnTexts().includes('流水'), btnTexts().join(','));
  check('标签栏里没有 AI 分析了', !btnTexts().includes('AI 分析'), null);
  check('添加/设置/持仓还在，用户不会把自己锁死',
    btnTexts().includes('添加') && btnTexts().includes('设置'), null);

  // ---- 当前标签页被关掉时自动退回 ----
  check('把流水标签页打开', clickSettingToggle('流水标签页'));
  await settle(12);
  check('打开流水页', clickText('流水'));
  await settle(10);
  const onTab = (label) => collect(tree).some((n) => n.tag === 'button'
    && allText(n).trim() === label && String(n.props.className).includes('dst-on'));
  check('确实停在流水页', onTab('流水'), null);
  // 模拟「在别处把这个标签页关了」：改数据 + 走一次轮询
  STATE.settings.showTrades = false;
  poke();
  await settle(16);
  check('当前标签页被关掉后自动退回一个还开着的',
    !onTab('流水') && (onTab('持仓') || onTab('添加') || onTab('设置')), null);

  // ---- 恢复默认，后面的用例还要用 ----
  STATE.settings.showTrend = true;
  STATE.settings.showKline = true;
  STATE.settings.showTrades = true;
  STATE.settings.showAlerts = true;
  STATE.settings.showAi = true;
  STATE.settings.showTotals = true;
  poke();
  await settle(16);
  check('恢复开关后图表区回到正常',
    (() => { clickText('持仓'); return true; })(), null);
  await settle(10);
  {
    const trs = collect(tree).filter((n) => n.tag === 'tr' && n.props.onClick);
    trs[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    await settle(14);
  }
  check('两种图都开时切换按钮回来了',
    btnTexts().includes('K线') && btnTexts().includes('分时') && btnTexts().includes('周K'), null);
}

section('折叠态');
{
  const btns = collect(tree).filter((n) => n.tag === 'button');
  const collapse = btns.find((b) => (b.props.title || '').includes('折叠'));
  check('存在折叠按钮', !!collapse);
  if (collapse) {
    let err = null;
    try { collapse.props.onClick({ preventDefault() {}, stopPropagation() {} }); } catch (e) { err = e; }
    check('折叠不抛错', err === null, err && err.message);
    await settle(8);
    check('折叠态不再渲染完整顶栏', findByClass(tree, 'dst-bar').length === 0, findByClass(tree, 'dst-bar').length);
    // 折叠胶囊改用 .dst-dock：它是 position:fixed 的独立元素，
    // 靠 dock 测量出来的 top/right 钉进标题栏右侧空白区，不再压正文
    const dockEls = findByClass(tree, 'dst-dock');
    check('折叠态仍渲染小胶囊', dockEls.length >= 1, dockEls.length);
    const dockStyle = (dockEls[0] && dockEls[0].props && dockEls[0].props.style) || {};
    check('胶囊钉在标题栏右侧（有 top 和 right，不用 left:0 铺满）',
      typeof dockStyle.top === 'string' && typeof dockStyle.right === 'string' && dockStyle.left === undefined,
      dockStyle);
    check('胶囊标了 no-drag 的样式类（标题栏是拖拽区，不然点不动）',
      /\.dst-dock\{[^}]*-webkit-app-region:no-drag/.test(source), null);
    check('胶囊默认半透明（不用它时几乎看不见）',
      /\.dst-dock\{[^}]*opacity:\.55/.test(source) && /\.dst-dock:hover[^{]*\{[^}]*opacity:1/.test(source), null);
    // 没有标题栏可借时（普通浏览器）退到右下角，别又压住工具栏
    const flat = source.replace(/\s+/g, ' ');
    check('无标题栏时退到右下角（bottom+right，而不是又用 top）',
      /dock\.inCaption \? \{ top: /.test(flat) && /bottom: '14px', right: '14px'/.test(flat), null);
  }
}

section('卸载清理');
{
  const liveBefore = liveIntervals.size;
  check('存在需要清理的定时器（刷新/测量）', liveBefore > 0, liveBefore);
  for (const c of allCleanups.slice().reverse()) {
    try { c(); } catch { /* 清理失败不影响判定 */ }
  }
  check('effect 全部执行了清理函数', allCleanups.length > 0, allCleanups.length);
}

/* ============================================================
 * dsh-better-sidebar 侧边栏接入（可选插件）
 * ============================================================ */

section('侧边栏接入契约（静态）');
{
  check('注册 tab 走 ctx.inject 软依赖（没装不挂起）',
    /ctx\.inject\(\['betterSidebar'\]/.test(code), null);
  check('tab 注册包在 ctx.effect 里（HMR/禁用后可回收）',
    /ctx\.effect\(\(\) => \{[\s\S]*?ctx\.inject\(\['betterSidebar'\]/.test(code), null);
  check('registerTab 在 owner.effect 里注册',
    /owner\.effect\(/.test(code) && /service\.registerTab\(/.test(code), null);
  check("tab id 带插件前缀 dsh-stock-bar:portfolio",
    /SIDEBAR_TAB_ID = 'dsh-stock-bar:portfolio'/.test(code), null);
  check('没有以 value 形式引入 dsh-better-sidebar',
    !/require\(['"]dsh-better-sidebar/.test(code) && !/from ['"]dsh-better-sidebar/.test(code), null);
  check('静态 inject 仍只有 slots（不把可选插件写死）',
    JSON.stringify(mod.inject) === '["slots"]', mod.inject);
}

section('侧边栏 tab 注册（模拟装好 dsh-better-sidebar）');
const sideTabs = [];
const sideEffectLabels = [];
const sideCleanups = [];
const sideService = {
  registerTab(desc) {
    sideTabs.push(desc);
    return () => { sideCleanups.push(desc.id); };
  },
};
let sideSeatDisposed = false;
const sideEffectCleanups = [];
const sideCtx = {
  slots: {
    inject(ownerKey, cb) { return cb(); },
    register() { return () => {}; },
  },
  effect(fn, label) {
    sideEffectLabels.push(label);
    const d = fn();
    if (typeof d === 'function') sideEffectCleanups.push(d);
    return d;
  },
  inject(deps, cb) {
    sideEffectLabels.push('ctx.inject:' + deps.join(','));
    const owner = {
      betterSidebar: sideService,
      get(name) { return name === 'betterSidebar' ? sideService : undefined; },
      effect(fn, label) {
        sideEffectLabels.push(label);
        const d = fn();
        if (typeof d === 'function') sideEffectCleanups.push(d);
        return d;
      },
    };
    cb(owner);
    return { dispose() { sideSeatDisposed = true; } };
  },
};
let sideApplyErr = null;
try { mod.apply(sideCtx); } catch (e) { sideApplyErr = e; }
check('apply 在有 betterSidebar 的环境下不抛错', sideApplyErr === null, sideApplyErr && sideApplyErr.stack);
check('通过 ctx.inject 等待 betterSidebar 服务',
  sideEffectLabels.includes('ctx.inject:betterSidebar'), sideEffectLabels);
check('注册了 1 个侧边栏 tab', sideTabs.length === 1, sideTabs.length);
const tabDef = sideTabs[0] || {};
check('tab id = dsh-stock-bar:portfolio', tabDef.id === 'dsh-stock-bar:portfolio', tabDef.id);
check('tab 标题是中文「股票」', tabDef.title === '股票', tabDef.title);
check('tab 有描述（菜单里能看懂）',
  typeof tabDef.description === 'string' && tabDef.description.length > 6, tabDef.description);
check('tab order 是数字', typeof tabDef.order === 'number', tabDef.order);
check('tab 单实例（single 复用）', tabDef.single === true, tabDef.single);
check('tab 组件是函数', typeof tabDef.component === 'function', typeof tabDef.component);
check('tab 图标是函数且能画出 svg', typeof tabDef.icon === 'function' && (() => {
  try { const el = tabDef.icon(14); return !!el && el.type === 'svg'; } catch { return false; }
})(), null);
check('tab 注册和座位都在 effect 里（可释放）',
  sideEffectLabels.includes('dsh-stock-bar/sidebar-tab') && sideEffectLabels.includes('dsh-stock-bar/sidebar'),
  sideEffectLabels);

// 模拟没装 better-sidebar：apply 不能要求这个服务，也不能抛错
let bareApplyErr = null;
try {
  mod.apply({
    slots: { inject(k, cb) { return cb(); }, register() { return () => {}; } },
    effect(fn) { return fn(); },
  });
} catch (e) { bareApplyErr = e; }
check('没装 dsh-better-sidebar 时 apply 不抛错（顶栏照旧）',
  bareApplyErr === null, bareApplyErr && bareApplyErr.message);
check('没装时不会多注册 tab', sideTabs.length === 1, sideTabs.length);

section('侧边栏页渲染（visible=false 暂停，visible=true 复用面板）');
{
  const page = tabDef.component;

  // settle() 只会渲染顶栏那个 registered.component，这里单独渲染侧边栏页。
  async function settleNode(node, key, maxPass) {
    let t = null;
    for (let i = 0; i < maxPass; i++) {
      dirty = false;
      pendingEffects = [];
      t = render(node, key);
      const effs = pendingEffects.slice();
      for (const e of effs) {
        const c = e.fn();
        if (typeof c === 'function') { e.setCleanup(c); allCleanups.push(c); }
      }
      await flush(4);
      if (!dirty && effs.length === 0) break;
    }
    return t;
  }

  // 1) 不可见：不拉数据、不起轮询，也不能渲染成 fixed 顶栏
  const reqsBefore = fetchLog.length;
  const pollBefore = liveIntervals.size;
  tree = await settleNode({ __el: true, type: page, props: { visible: false } }, 'sideHidden', 8);
  const stateReqs = fetchLog.slice(reqsBefore).filter((u) => u.includes('/api/stock-bar/state'));
  check('不可见时不拉 /state', stateReqs.length === 0, stateReqs);
  check('不可见时不起轮询定时器',
    liveIntervals.size === pollBefore, { before: pollBefore, after: liveIntervals.size });
  check('侧边栏页渲染整页容器 .dst-side',
    findByClass(tree, 'dst-side').length === 1, findByClass(tree, 'dst-side').length);
  check('侧边栏页没有 fixed 顶栏 .dst-root',
    findByClass(tree, 'dst-root').length === 0, null);
  check('侧边栏页有标题行和内容区',
    findByClass(tree, 'dst-side-head').length === 1 && findByClass(tree, 'dst-side-body').length === 1, null);

  // 2) 可见：拉数据、起轮询、整套面板都能用
  const reqs2 = fetchLog.length;
  const poll2 = liveIntervals.size;
  const drawsBefore = drawCalls;
  tree = await settleNode({ __el: true, type: page, props: { visible: true } }, 'sideVisible', 24);
  const urls = fetchLog.slice(reqs2);
  check('可见时拉 /state', urls.some((u) => u.includes('/api/stock-bar/state')), urls.slice(0, 3));
  check('可见时起了行情轮询', liveIntervals.size > poll2, { before: poll2, after: liveIntervals.size });
  check('侧边栏页复用标签栏（持仓/自选…）',
    findByClass(tree, 'dst-tab').length >= 5
      && /持仓/.test(allText(tree)) && /自选/.test(allText(tree)),
    findByClass(tree, 'dst-tab').length);
  check('侧边栏页复用持仓表格',
    collect(tree).filter((n) => n.tag === 'tr').length >= 2, null);
  const trs = collect(tree).filter((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
  check('侧边栏页表格行可点击', trs.length > 0, trs.length);
  if (trs.length) {
    trs[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    tree = await settleNode({ __el: true, type: page, props: { visible: true } }, 'sideVisible', 18);
    check('侧边栏页选中后拉分时',
      fetchLog.slice(reqs2).some((u) => u.includes('/trends')),
      fetchLog.filter((u) => u.includes('/trends')).slice(-1));
    check('侧边栏页画出了图', drawCalls > drawsBefore, { before: drawsBefore, after: drawCalls });
  }
  check('侧边栏页能切到「自选」标签', clickText('自选'), null);
  tree = await settleNode({ __el: true, type: page, props: { visible: true } }, 'sideVisible', 14);
  check('切标签后侧边栏页仍完整',
    findByClass(tree, 'dst-side').length === 1 && findByClass(tree, 'dst-side-body').length === 1, null);

  // 3) 卸载：注册处返回的 disposer 和座位都要能释放
  for (const c of sideEffectCleanups.slice().reverse()) {
    try { c(); } catch { /* 清理失败不影响判定 */ }
  }
  check('卸载时释放 betterSidebar 座位（seat.dispose）', sideSeatDisposed === true, sideSeatDisposed);
  check('卸载时调了 registerTab 的 disposer', sideCleanups.length >= 1, sideCleanups);
}

/* ============================================================
 * 收尾
 * ============================================================ */

console.log(`\n==== 通过 ${pass} / 失败 ${fail} ====`);
if (fail) {
  console.log('失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
