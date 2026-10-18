/**
 * dsh-stock-ticker / lib/providers.js
 *
 * 行情数据源适配层。纯 Node，无第三方依赖，不依赖 DSH 运行时，可单独测试。
 *
 *   fetchQuotes(symbols)        -> Map<symbol, Quote>    批量实时行情
 *   fetchKline(symbol, opts)    -> Candle[]              K线
 *   fetchTrends(symbol, opts)   -> 分时点[]               当日/多日分时走势
 *   fetchOrderBook(symbol)      -> 五档盘口               买一到买五、卖一到卖五
 *   searchStock(keyword)        -> SearchHit[]           代码/名称/拼音搜索
 *   normalizeSymbol(input)      -> { symbol, code, market, secid } | null
 *   resolveSymbol(input)        -> 同上，必要时走搜索接口（支持美股/港股）
 *
 * 主源：东方财富 push2 / push2his / searchapi（JSON，UTF-8，无需鉴权，无 CORS 限制——
 *       由 Host 侧调用，不受浏览器同源策略约束）
 * 备源：腾讯 qt.gtimg.cn（GBK）
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TIMEOUT_MS = 8000;

/** 市场代码（东方财富 secid 前缀） */
const MARKET = {
  SZ: 0,
  SH: 1,
  BJ: 0, // 北交所与深市同前缀 0
  HK: 116,
  US_NASDAQ: 105,
  US_NYSE: 106,
  US_AMEX: 107,
};

/** K线周期 -> 东方财富 klt */
const KLT = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '60m': 60,
  day: 101,
  week: 102,
  month: 103,
};

/** 复权 -> 东方财富 fqt */
const FQT = { none: 0, pre: 1, post: 2 };

/** ulist.np 请求的字段（含义见 parseUlistDiff） */
const QUOTE_FIELDS = [
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11',
  'f12', 'f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f20', 'f21', 'f22',
  'f23', 'f24', 'f25', 'f26', 'f33', 'f62', 'f115', 'f124', 'f152',
].join(',');

const KLINE_FIELDS1 = 'f1,f2,f3,f4,f5,f6';
const KLINE_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function withTimeout(ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

async function getText(url, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      signal: t.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    t.done();
  }
}

async function getJson(url, opts) {
  const text = await getText(url, opts);
  return JSON.parse(text);
}

function decodeGbk(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    // 无完整 ICU 时退回 latin1（腾讯源将不可用，但不影响东财主源）
    return new TextDecoder('latin1').decode(buffer);
  }
}

async function getGbkText(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      signal: t.signal,
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return decodeGbk(buf);
  } finally {
    t.done();
  }
}

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ *
 * 代码规范化
 * ------------------------------------------------------------------ */

/**
 * 把用户输入的各种写法统一成 { symbol, code, market, secid }。
 * 无法靠规则判定（如美股）时返回 null，交给 resolveSymbol() 走搜索接口。
 *
 * 支持：600519 / sh600519 / 600519.SH / 1.600519 / 000001 / 00700 / hk00700 / AAPL / us.AAPL
 */
export function normalizeSymbol(input) {
  if (!input) return null;
  let raw = String(input).trim();
  if (!raw) return null;

  // 已经带了 secid（1.600519）
  const secidLike = /^(\d{1,3})\.([A-Za-z0-9.\-]+)$/.exec(raw);
  if (secidLike) {
    const market = Number(secidLike[1]);
    const code = secidLike[2].toUpperCase();
    return { symbol: makeSymbol(code, market), code, market, secid: `${market}.${code}` };
  }

  // 前缀式 sh600519 / sz000001 / hk00700 / usAAPL
  const prefixed = /^(sh|sz|bj|hk|us|nasdaq|nyse|amex)[.:]?(.+)$/i.exec(raw);
  if (prefixed) {
    const tag = prefixed[1].toLowerCase();
    const code = prefixed[2].toUpperCase();
    const market = marketFromTag(tag);
    if (market !== null) {
      return { symbol: makeSymbol(code, market), code, market, secid: `${market}.${code}` };
    }
  }

  // 后缀式 600519.SH
  const suffixed = /^([A-Za-z0-9.\-]+)[.](SH|SZ|BJ|HK|US)$/i.exec(raw);
  if (suffixed) {
    const tag = suffixed[2].toLowerCase();
    const code = suffixed[1].toUpperCase();
    const market = marketFromTag(tag);
    if (market !== null) {
      return { symbol: makeSymbol(code, market), code, market, secid: `${market}.${code}` };
    }
  }

  // 纯数字
  if (/^\d+$/.test(raw)) {
    // 5 位 -> 港股
    if (raw.length <= 5) {
      const code = raw.padStart(5, '0');
      return { symbol: makeSymbol(code, MARKET.HK), code, market: MARKET.HK, secid: `${MARKET.HK}.${code}` };
    }
    if (raw.length === 6) {
      const market = marketFromAShareCode(raw);
      return { symbol: makeSymbol(raw, market), code: raw, market, secid: `${market}.${raw}` };
    }
    return null;
  }

  // 纯字母 -> 美股，但需要交易所，交给搜索
  if (/^[A-Za-z][A-Za-z.\-]{0,9}$/.test(raw)) return null;

  return null;
}

/** 由搜索接口返回的 QuoteID / MktNum 构造规范符号 */
export function fromSecid(secid, code, name) {
  const [m, c] = String(secid).split('.');
  const market = Number(m);
  const upper = String(code || c).toUpperCase();
  return { symbol: makeSymbol(upper, market), code: upper, market, secid: `${market}.${upper}`, name };
}

function marketFromTag(tag) {
  switch (tag) {
    case 'sh': return MARKET.SH;
    case 'sz': return MARKET.SZ;
    case 'bj': return MARKET.BJ;
    case 'hk': return MARKET.HK;
    case 'us': return MARKET.US_NASDAQ;
    case 'nasdaq': return MARKET.US_NASDAQ;
    case 'nyse': return MARKET.US_NYSE;
    case 'amex': return MARKET.US_AMEX;
    default: return null;
  }
}

/** 6 位 A 股代码 -> 市场前缀 */
export function marketFromAShareCode(code) {
  const c = String(code);
  if (/^(60|68|90|50|51|52|56|58|11|13|20|5)/.test(c)) {
    // 6xx 沪A / 688 科创 / 9xx 沪B / 5xx 沪基金 / 11x 沪转债 / 2xx 沪B
    if (c.startsWith('2')) return MARKET.SZ; // 200xxx 是深B
    if (c.startsWith('13')) return MARKET.SZ;
    if (c.startsWith('12')) return MARKET.SZ;
    if (c.startsWith('11')) return MARKET.SH;
    if (c.startsWith('5')) return c.startsWith('50') || c.startsWith('51') || c.startsWith('52') || c.startsWith('56') || c.startsWith('58') ? MARKET.SH : MARKET.SH;
    return MARKET.SH;
  }
  if (/^(00|30|15|16|18|12|13|20|08)/.test(c)) return MARKET.SZ;
  if (/^(4|8)/.test(c)) return MARKET.BJ;
  return MARKET.SH;
}

/** 规范符号串：sh600519 / sz000001 / hk00700 / us105.AAPL */
function makeSymbol(code, market) {
  switch (market) {
    case MARKET.SH: return `sh${code}`;
    case MARKET.SZ: return `sz${code}`;
    case MARKET.BJ: return `bj${code}`;
    case MARKET.HK: return `hk${code}`;
    case MARKET.US_NASDAQ:
    case MARKET.US_NYSE:
    case MARKET.US_AMEX: return `us${market}.${code}`;
    default: return `${market}.${code}`;
  }
}

/* ------------------------------------------------------------------ *
 * 实时行情
 * ------------------------------------------------------------------ */

/**
 * 批量拉取实时行情。
 * @param {Array<string|{symbol:string}>} symbols 规范符号或用户输入
 * @returns {Promise<Map<string, object>>} key 为规范符号
 */
export async function fetchQuotes(symbols) {
  const list = dedupe(symbols.map((s) => (typeof s === 'string' ? s : s && s.symbol)).filter(Boolean));
  const out = new Map();
  if (!list.length) return out;

  const resolved = [];
  for (const sym of list) {
    const norm = normalizeSymbol(sym);
    if (norm) resolved.push({ symbol: sym, ...norm });
    else {
      // 非规则内代码（美股等）逐个解析
      const hit = await resolveSymbol(sym).catch(() => null);
      if (hit) resolved.push({ symbol: sym, ...hit });
    }
  }
  if (!resolved.length) return out;

  try {
    const secids = resolved.map((r) => r.secid).join(',');
    const url =
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&np=1&dect=1` +
      `&fields=${QUOTE_FIELDS}&secids=${encodeURIComponent(secids)}`;
    const json = await getJson(url);
    const diff = json && json.data && json.data.diff;
    const rows = Array.isArray(diff) ? diff : diff ? Object.values(diff) : [];
    const bySecid = new Map();
    for (const row of rows) {
      const key = `${row.f13}.${row.f12}`;
      bySecid.set(key, uniqueQuote(row));
    }
    for (const r of resolved) {
      const q = bySecid.get(r.secid);
      if (q) out.set(r.symbol, q);
    }
  } catch {
    /* 落到腾讯备源 */
  }

  const missing = resolved.filter((r) => !out.has(r.symbol));
  if (missing.length) {
    const fb = await fetchQuotesTencent(missing).catch(() => new Map());
    for (const [k, v] of fb) out.set(k, v);
  }

  for (const [k] of out) out.get(k).provider = out.get(k).provider || 'eastmoney';
  return out;
}

/** ulist.np 单行 -> 统一 Quote */
function uniqueQuote(row) {
  const price = num(row.f2);
  const prevClose = num(row.f18);
  const change = num(row.f4);
  const changePct = num(row.f3);
  return {
    code: row.f12,
    name: row.f14,
    market: row.f13,
    symbol: makeSymbol(row.f12, row.f13),
    price,
    prevClose,
    open: num(row.f17),
    high: num(row.f15),
    low: num(row.f16),
    change,
    changePct,
    volume: num(row.f5),      // 手
    amount: num(row.f6),      // 元
    amplitude: num(row.f7),   // 振幅 %
    turnover: num(row.f8),    // 换手率 %
    pe: num(row.f9),          // 市盈率(动)
    volRatio: num(row.f10),   // 量比
    speed: num(row.f22),      // 涨速 %
    pb: num(row.f23),         // 市净率
    change60d: num(row.f24),
    changeYtd: num(row.f25),
    marketCap: num(row.f20),  // 总市值
    floatCap: num(row.f21),   // 流通市值
    mainInflow: num(row.f62), // 主力净流入
    limitUp: num(row.f26) === 1,
    limitDown: num(row.f26) === 2,
    suspended: price === null || price === 0,
    currency: currencyOf(row.f13),
    provider: 'eastmoney',
    ts: Date.now(),
  };
}

function currencyOf(market) {
  switch (Number(market)) {
    case MARKET.HK: return 'HKD';
    case MARKET.US_NASDAQ:
    case MARKET.US_NYSE:
    case MARKET.US_AMEX: return 'USD';
    default: return 'CNY';
  }
}

/** 备源：腾讯行情（GBK）。symbol 需带上市场前缀 */
async function fetchQuotesTencent(items) {
  const out = new Map();
  if (!items.length) return out;

  const codeOf = (r) => {
    switch (r.market) {
      case MARKET.SH: return `sh${r.code}`;
      case MARKET.SZ: return `sz${r.code}`;
      case MARKET.BJ: return `bj${r.code}`;
      case MARKET.HK: return `hk${r.code}`;
      case MARKET.US_NASDAQ: return `us${r.code}`;
      case MARKET.US_NYSE: return `us${r.code}`;
      case MARKET.US_AMEX: return `us${r.code}`;
      default: return `sh${r.code}`;
    }
  };

  const codes = items.map(codeOf);
  const text = await getGbkText(`https://qt.gtimg.cn/q=${codes.join(',')}`);
  for (const line of text.split(';')) {
    const m = /v_([a-z]{2}\d*|us[A-Z.]+)="([^"]*)"/i.exec(line.trim());
    if (!m) continue;
    const f = m[2].split('~');
    if (f.length < 40) continue;
    const tencCode = m[1];
    const found = items.find((it) => codeOf(it).toLowerCase() === tencCode.toLowerCase());
    if (!found) continue;
    out.set(found.symbol, {
      code: found.code,
      name: f[1],
      market: found.market,
      symbol: found.symbol,
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      high: num(f[33]),
      low: num(f[34]),
      change: num(f[31]),
      changePct: num(f[32]),
      volume: num(f[6]),
      amount: num(f[37]) === null ? null : num(f[37]) * 10000,
      amplitude: null,
      turnover: num(f[38]),
      pe: num(f[39]),
      volRatio: num(f[49]),
      pb: num(f[46]),
      speed: null,
      marketCap: num(f[45]) === null ? null : num(f[45]) * 100000000,
      floatCap: num(f[44]) === null ? null : num(f[44]) * 100000000,
      mainInflow: null,
      change60d: null,
      changeYtd: null,
      limitUp: false,
      limitDown: false,
      suspended: !num(f[3]),
      currency: currencyOf(found.market),
      provider: 'tencent',
      ts: Date.now(),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * K 线
 * ------------------------------------------------------------------ */

/**
 * 拉取 K 线。
 * @param {string} symbol 规范符号或用户输入
 * @param {{period?:string, count?:number, adjust?:'none'|'pre'|'post'}} opts
 * @returns {Promise<{symbol:string, name:string|null, period:string, adjust:string, candles:Candle[]}>}
 */
export async function fetchKline(symbol, opts = {}) {
  const period = KLT[opts.period] ? opts.period : 'day';
  const adjust = FQT[opts.adjust] !== undefined ? opts.adjust : 'pre';
  const count = clamp(Number(opts.count) || 120, 20, 800);

  let norm = normalizeSymbol(symbol);
  if (!norm) norm = await resolveSymbol(symbol);
  if (!norm) throw new Error(`无法识别的证券代码: ${symbol}`);

  const klt = KLT[period];
  const fqt = FQT[adjust];

  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(norm.secid)}` +
    `&klt=${klt}&fqt=${fqt}&beg=0&end=20500101&lmt=${count}` +
    `&fields1=${KLINE_FIELDS1}&fields2=${KLINE_FIELDS2}`;

  const json = await getJson(url);
  const data = json && json.data;
  if (!data) throw new Error(`未获取到 K 线数据: ${norm.symbol}`);

  const raw = Array.isArray(data.klines) ? data.klines : [];
  // 注意：push2his 在 beg=0&end=20500101 时会忽略 lmt，返回全部历史，必须自行截断
  const candles = raw.map(parseKlineRow).filter(Boolean).slice(-count);

  return {
    symbol: norm.symbol,
    code: norm.code,
    market: norm.market,
    name: data.name || null,
    period,
    adjust,
    candles,
    provider: 'eastmoney',
    ts: Date.now(),
  };
}

function parseKlineRow(row) {
  if (typeof row !== 'string') return null;
  const f = row.split(',');
  if (f.length < 6) return null;
  const c = {
    date: f[0],
    open: num(f[1]),
    close: num(f[2]),
    high: num(f[3]),
    low: num(f[4]),
    volume: num(f[5]),
    amount: num(f[6]),
    amplitude: num(f[7]),
    changePct: num(f[8]),
    change: num(f[9]),
    turnover: num(f[10]),
  };
  if (c.open === null || c.close === null) return null;
  return c;
}

/* ------------------------------------------------------------------ *
 * 分时（当日走势）
 * ------------------------------------------------------------------ */

const TREND_FIELDS1 = 'f1,f2,f3,f4,f5,f6,f7,f8';
const TREND_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58';

/**
 * 拉取分时数据。
 *
 * 东方财富 trends2 每个交易日返回 241 个点（09:30 集合竞价 + 09:31..11:30 + 13:01..15:00），
 * 每行格式：`时间,开,收,高,低,成交量(手),成交额,均价`。
 * 均价线是交易所口径的累计成交额/累计成交量，直接取第 8 列，不要自己算。
 *
 * @param {string} symbol 规范符号或用户输入
 * @param {{days?:number}} opts days: 1=当日（默认）, 2..5=最近 N 个交易日连续显示
 * @returns {Promise<{symbol:string, code:string, market:number, name:string|null,
 *                    prevClose:number|null, days:number,
 *                    points:Array<{time:string, price:number|null, avg:number|null,
 *                                  open:number|null, high:number|null, low:number|null,
 *                                  volume:number|null, amount:number|null}>,
 *                    provider:string, ts:number}>}
 */
export async function fetchTrends(symbol, opts = {}) {
  const days = clamp(Number(opts.days) || 1, 1, 5);

  let norm = normalizeSymbol(symbol);
  if (!norm) norm = await resolveSymbol(symbol);
  if (!norm) throw new Error(`无法识别的证券代码: ${symbol}`);

  const url =
    `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${encodeURIComponent(norm.secid)}` +
    `&fields1=${TREND_FIELDS1}&fields2=${TREND_FIELDS2}&iscr=0&ndays=${days}`;

  const json = await getJson(url);
  const data = json && json.data;
  if (!data) throw new Error(`未获取到分时数据: ${norm.symbol}`);

  const raw = Array.isArray(data.trends) ? data.trends : [];
  const points = raw.map(parseTrendRow).filter(Boolean);
  if (!points.length) throw new Error(`分时数据为空: ${norm.symbol}`);

  return {
    symbol: norm.symbol,
    code: norm.code,
    market: norm.market,
    name: data.name || null,
    prevClose: num(data.preClose) ?? num(data.prePrice) ?? null,
    days,
    points,
    provider: 'eastmoney',
    ts: Date.now(),
  };
}

function parseTrendRow(row) {
  if (typeof row !== 'string') return null;
  const f = row.split(',');
  if (f.length < 3) return null;
  const price = num(f[2]);
  if (price === null) return null;
  return {
    time: f[0],
    open: num(f[1]),
    price, // 第 3 列是"收"，分时图上画的就是它
    high: num(f[3]),
    low: num(f[4]),
    volume: num(f[5]),
    amount: num(f[6]),
    avg: num(f[7]), // 交易所口径均价（均价线）
  };
}

/* ------------------------------------------------------------------ *
 * 五档盘口
 * ------------------------------------------------------------------ */

/**
 * 买卖五档。价格字段用 fltt=2 直接给到小数，量单位是"手"。
 *
 * ⚠️ 这个接口必须**不带 `fields` 参数**：显式列字段时东方财富会把 f11..f20 / f31..f40
 * 这一整段买卖盘字段丢掉，只回 f43..f58。不带 fields 时返回全部 58 个字段，五档齐全。
 *
 * 字段映射（已实测核对）：
 *   卖5=f31/f32  卖4=f33/f34  卖3=f35/f36  卖2=f37/f38  卖1=f39/f40
 *   买1=f19/f20  买2=f17/f18  买3=f15/f16  买4=f13/f14  买5=f11/f12
 *
 * @param {string} symbol
 * @returns {Promise<{symbol:string, code:string, market:number, name:string|null,
 *                    price:number|null, prevClose:number|null, open:number|null,
 *                    high:number|null, low:number|null, volume:number|null, amount:number|null,
 *                    bids:Array<{price:number|null, volume:number|null}>,
 *                    asks:Array<{price:number|null, volume:number|null}>,
 *                    bidVolume:number, askVolume:number,
 *                    commissionDiff:number, commissionRatio:number|null,
 *                    provider:string, ts:number}>}
 */
export async function fetchOrderBook(symbol) {
  let norm = normalizeSymbol(symbol);
  if (!norm) norm = await resolveSymbol(symbol);
  if (!norm) throw new Error(`无法识别的证券代码: ${symbol}`);

  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(norm.secid)}` +
    `&invt=2&fltt=2`;

  const json = await getJson(url);
  const d = json && json.data;
  if (!d) throw new Error(`未获取到盘口数据: ${norm.symbol}`);

  // 买盘：买1 在最前（f19/f20），依次到买5（f11/f12）
  const bids = [
    { price: num(d.f19), volume: num(d.f20) },
    { price: num(d.f17), volume: num(d.f18) },
    { price: num(d.f15), volume: num(d.f16) },
    { price: num(d.f13), volume: num(d.f14) },
    { price: num(d.f11), volume: num(d.f12) },
  ];
  // 卖盘：卖1 在最前（f39/f40），依次到卖5（f31/f32）
  const asks = [
    { price: num(d.f39), volume: num(d.f40) },
    { price: num(d.f37), volume: num(d.f38) },
    { price: num(d.f35), volume: num(d.f36) },
    { price: num(d.f33), volume: num(d.f34) },
    { price: num(d.f31), volume: num(d.f32) },
  ];

  // 指数、部分基金没有盘口
  const hasBook = [...bids, ...asks].some((r) => r.price !== null && r.price !== 0);
  if (!hasBook) throw new Error(`该品种没有五档盘口数据: ${norm.symbol}`);

  const sum = (rows) =>
    rows.reduce((acc, r) => acc + (Number.isFinite(r.volume) ? r.volume : 0), 0);
  const bidVolume = sum(bids);
  const askVolume = sum(asks);
  const total = bidVolume + askVolume;

  return {
    symbol: norm.symbol,
    code: norm.code,
    market: norm.market,
    name: d.f58 || null,
    price: num(d.f43),
    prevClose: num(d.f60),
    open: num(d.f46),
    high: num(d.f44),
    low: num(d.f45),
    volume: num(d.f47),
    amount: num(d.f48),
    bids,
    asks,
    bidVolume,
    askVolume,
    // 委差 = 买盘总量 - 卖盘总量；委比 = 委差 / 总量 * 100。自己算，不依赖 f191/f192
    // （那两个字段在 fltt=2 下经常是空的）。
    commissionDiff: bidVolume - askVolume,
    commissionRatio: total > 0 ? ((bidVolume - askVolume) / total) * 100 : null,
    provider: 'eastmoney',
    ts: Date.now(),
  };
}

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

const SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

/**
 * 按代码 / 名称 / 拼音搜索证券。
 * @returns {Promise<Array<{code,name,symbol,secid,market,marketName,type}>>}
 */
export async function searchStock(keyword, limit = 12) {
  const q = String(keyword || '').trim();
  if (!q) return [];

  const url =
    `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}` +
    `&type=14&token=${SEARCH_TOKEN}&count=${clamp(limit, 1, 30)}`;
  const json = await getJson(url, { headers: { Referer: 'https://www.eastmoney.com/' } });
  const rows =
    (json && json.QuotationCodeTable && json.QuotationCodeTable.Data) || [];

  const hits = [];
  for (const r of rows) {
    const quoteId = r.QuoteID || (r.MktNum !== undefined ? `${r.MktNum}.${r.Code}` : null);
    if (!quoteId) continue;
    const market = Number(String(quoteId).split('.')[0]);
    const code = String(r.Code || '').toUpperCase();
    hits.push({
      code,
      name: r.Name,
      pinyin: r.PinYin || '',
      symbol: makeSymbol(code, market),
      secid: quoteId,
      market,
      marketName: r.SecurityTypeName || r.Classify || '',
      type: r.SecurityType || '',
      marketType: r.MarketType || '',
    });
  }

  // 把完全匹配排前面
  const upper = q.toUpperCase();
  hits.sort((a, b) => score(b) - score(a));
  function score(h) {
    let s = 0;
    if (h.code === upper) s += 100;
    if (h.name === q) s += 90;
    if (h.code.startsWith(upper)) s += 30;
    if (h.pinyin && h.pinyin.startsWith(upper)) s += 20;
    if (/^(AStock|Index|Fund)$/.test(h.marketType)) s += 5;
    if (/^(1|0)$/.test(String(h.market))) s += 3;
    return s;
  }
  return hits;
}

/** 解析任意输入为规范符号，必要时走搜索（美股、指数等） */
export async function resolveSymbol(input) {
  const direct = normalizeSymbol(input);
  if (direct) return direct;
  const hits = await searchStock(input, 5).catch(() => []);
  if (!hits.length) return null;
  const best = hits[0];
  return { symbol: best.symbol, code: best.code, market: best.market, secid: best.secid, name: best.name };
}

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

export function dedupe(arr) {
  return Array.from(new Set(arr));
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export const PROVIDER_META = {
  periods: Object.keys(KLT),
  adjusts: Object.keys(FQT),
  markets: MARKET,
};
