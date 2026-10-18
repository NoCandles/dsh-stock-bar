/**
 * dsh-stock-ticker / lib/index.js  —— Host 半边
 *
 * 职责：把行情数据源与本地持仓存储包装成同源 HTTP 路由，供 Client 半边（顶部状态栏）
 * 通过 fetch('/api/stock-ticker/...') 读取。浏览器直连 webServer；Electron 下
 * 该 fetch 由桌面宿主经 IPC 桥接，两种形态都走相对路径，无需配置端口。
 *
 * 路由表（kind: 'exact'）：
 *   GET  /api/stock-ticker/state          行情条所需的全部数据（行情+持仓+盈亏+设置+预警）
 *   GET  /api/stock-ticker/kline          K 线数据
 *   GET  /api/stock-ticker/trends         分时数据（当日/多日）
 *   GET  /api/stock-ticker/orderbook      五档盘口
 *   GET  /api/stock-ticker/search         代码/名称/拼音搜索
 *   GET  /api/stock-ticker/trades         交易流水 + 已实现盈亏（加权平均成本法）
 *   GET  /api/stock-ticker/health         自检（数据源连通性、存储路径）
 *   POST /api/stock-ticker/items/save     新增/修改持仓
 *   POST /api/stock-ticker/items/remove   删除
 *   POST /api/stock-ticker/settings/save  保存设置
 *   POST /api/stock-ticker/trades/save    记一笔买入/卖出
 *   POST /api/stock-ticker/trades/remove  删除一笔流水
 *   POST /api/stock-ticker/trades/clear   清空流水（可按 symbol）
 *   POST /api/stock-ticker/trades/apply   按流水反推持仓，写回 items
 *   POST /api/stock-ticker/alerts/save    新建/修改预警
 *   POST /api/stock-ticker/alerts/remove  删除预警
 *   POST /api/stock-ticker/alerts/ack     确认（解除已触发标记，重新武装）
 *   GET  /api/stock-ticker/ai/models      可用模型目录（转发宿主已挂的 dsh-llm 服务）
 *   POST /api/stock-ticker/ai/analyze     AI 分析：取数→组装数据包→调模型，NDJSON 流式回传
 */
import { PortfolioStore, computePosition, computeTotals, computeRealized } from './store.js';
import { fetchQuotes, fetchKline, fetchTrends, fetchOrderBook, searchStock, resolveSymbol, normalizeSymbol } from './providers.js';
import {
  summarizeCandles, condenseCandles, summarizeTrends, summarizeBook,
  summarizeTrades, buildDataPack, buildMessages,
} from './analysis.js';

export const name = 'dsh-stock-ticker';
/** 依赖 webServer 服务注册 HTTP 路由。 */
export const inject = ['webServer'];
export const ROUTE_PREFIX = '/api/stock-ticker';

/** 行情缓存存活时间：避免多个窗口各自轮询时把上游打爆 */
const QUOTE_TTL_MS = 2000;
const SEARCH_TTL_MS = 60_000;
const KLINE_TTL_MS = 15_000;
/** 分时/盘口只在交易时段频繁变，缓存短一点 */
const TREND_TTL_MS = 20_000;
const BOOK_TTL_MS = 3_000;

/** K 线周期 -> 喂给模型的人话标签 */
const PERIOD_LABEL = {
  '1m': '1分钟K', '5m': '5分钟K', '15m': '15分钟K', '30m': '30分钟K', '60m': '60分钟K',
  day: '日K', week: '周K', month: '月K',
};

/**
 * 注册全部路由。每个 handler 自己兜住异常，返回 JSON 错误而不是让请求 400。
 * @param {object} ctx Cordis 上下文
 * @param {object} config 插件配置
 */
export function apply(ctx, config = {}) {
  const store = new PortfolioStore(config.storePath);
  const log = (level, msg) => {
    try {
      ctx.logger?.[level]?.(msg instanceof Error ? msg : new Error(String(msg)));
    } catch { /* 日志失败不影响业务 */ }
  };

  // 行情缓存
  const quoteCache = { map: new Map(), at: 0 };
  const searchCache = new Map();
  const klineCache = new Map();
  const trendCache = new Map();
  const bookCache = new Map();

  /**
   * 缓存条目上限。这些缓存按 symbol/周期/搜索词做键，键空间是无界的：
   * 用户翻几轮周期、改几次 K 线根数、搜几十次股票，条目就只增不减。
   * 卡一个上限 + LRU 淘汰，最坏情况也只是多打一次接口。
   */
  const CACHE_MAX = 200;

  /** 读缓存；过期即删，命中则刷新 LRU 位置 */
  function cacheGet(map, key, ttl) {
    const hit = map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > ttl) {
      map.delete(key);
      return null;
    }
    map.delete(key);
    map.set(key, hit);
    return hit.value;
  }

  /** 写缓存 + LRU 淘汰（Map 保持插入序，第一个就是最久没用的） */
  function cacheSet(map, key, value) {
    map.delete(key);
    map.set(key, { at: Date.now(), value });
    while (map.size > CACHE_MAX) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /** 只给 /health 看：确认缓存没有无限膨胀 */
  function cacheSizes() {
    return {
      quote: quoteCache.map.size,
      search: searchCache.size,
      kline: klineCache.size,
      trend: trendCache.size,
      book: bookCache.size,
      max: CACHE_MAX,
    };
  }

  let ready = null;
  const init = () => (ready ||= (async () => {
    await store.load();
    const seeded = await store.seedIndexes();
    log('info', `[stock-ticker] 存储文件: ${store.file}${seeded ? '（已写入默认大盘指数）' : ''}`);
    return store;
  })());

  /** 拉取（带缓存的）全部关注标的行情 */
  async function quotesFor(items, { force = false } = {}) {
    const symbols = items.map((it) => it.symbol).filter(Boolean);
    const fresh = Date.now() - quoteCache.at < QUOTE_TTL_MS && !force;
    const missing = symbols.filter((s) => !quoteCache.map.has(s));
    if (fresh && !missing.length) return pick(quoteCache.map, symbols);

    try {
      const got = await fetchQuotes(symbols);
      for (const [k, v] of got) quoteCache.map.set(k, v);
      quoteCache.at = Date.now();
    } catch (err) {
      log('warn', `[stock-ticker] 行情拉取失败: ${err && err.message ? err.message : err}`);
      // 失败时保留旧值（客户端能看到 stale 标记）
    }
    return pick(quoteCache.map, symbols);
  }

  function pick(map, keys) {
    const out = new Map();
    for (const k of keys) if (map.has(k)) out.set(k, map.get(k));
    return out;
  }

  /**
   * 把用户输入（代码/名称/拼音）解析成规范符号，并尽量带一份行情回来。
   * 记流水和设预警都需要"名称+市场"，但都不应该在行情失败时中断操作。
   * @returns {Promise<{symbol:string, code:string, market:number, name:string, quote:object|null}|null>}
   */
  async function resolveWithQuote(input) {
    const text = String(input == null ? '' : input).trim();
    if (!text) return null;
    const resolved = await resolveSymbol(text).catch(() => null);
    if (!resolved) return null;

    let quote = null;
    try {
      const m = await fetchQuotes([resolved.symbol]);
      quote = m.get(resolved.symbol) || null;
    } catch { /* 行情失败不阻塞落库 */ }

    return {
      symbol: resolved.symbol,
      code: resolved.code,
      market: resolved.market,
      name: (quote && quote.name) || resolved.name || text,
      quote,
    };
  }

  /**
   * 组装 /state 响应。
   * @param {{force?:boolean, consumeFired?:boolean}} opts
   *   consumeFired 只有轮询用的 GET /state 才该传 true —— 写接口内部也会调 buildState，
   *   如果它们把"新触发"的预警队列取走，客户端的通知就永远不会弹出来。
   */
  async function buildState({ force = false, consumeFired = false } = {}) {
    const s = await init();
    const items = s.items;
    // 预警可能盯着一只没加进自选的股票，行情要按 items ∪ alerts 的并集去拉
    const alertSymbols = s.alerts.map((a) => a.symbol).filter(Boolean);
    const quotes = await quotesFor(
      [...items, ...alertSymbols.map((symbol) => ({ symbol }))],
      { force },
    );

    const positions = items.map((it) => {
      const q = quotes.get(it.symbol);
      const pos = computePosition(it, q);
      if (q && q.name && q.name !== it.name) {
        // 名称以行情为准（首次添加时可能只填了代码）
        it.name = q.name;
        if (it.market == null) it.market = q.market;
        s.save().catch(() => {});
      }
      return pos;
    });

    const strip = positions.filter(
      (p) => (p.watch && (p.index ? s.settings.showIndex : s.settings.showHoldings || !p.held ? s.settings.showWatch || s.settings.showHoldings : true)),
    );

    // 跑一遍预警：新触发的进队列，只有轮询接口会取走
    const { alerts } = await s.syncAlerts(quotes);
    const fired = consumeFired ? s.drainFired() : [];

    return {
      ok: true,
      serverTime: Date.now(),
      market: marketStatus(),
      settings: s.settings,
      storePath: s.file,
      items: positions,
      strip,
      totals: computeTotals(positions.filter((p) => !p.index)),
      alerts,
      fired,
      quotesStale: Date.now() - quoteCache.at > 30_000,
      provider: firstProvider(quotes),
    };
  }

  function firstProvider(quotes) {
    for (const [, q] of quotes) return q.provider || 'eastmoney';
    return null;
  }

  /* ---------------- 路由 ---------------- */

  const route = (path, handler) => {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PREFIX + path, handler }),
      `stock-ticker: ${ROUTE_PREFIX}${path}`,
    );
  };

  /** 统一的 JSON 回复 */
  const json = (res, status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  };

  /** 包一层：任何异常都变成 200 + {ok:false,error}，绝不 400/500 掉线 */
  const safe = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      log('warn', `[stock-ticker] 路由异常: ${err && err.stack ? err.stack : err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, 200, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  };

  const url = (req) => new URL(req.url || '/', 'http://127.0.0.1');

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 512 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  }

  /* GET /state */
  route('/state', safe(async (req, res) => {
    const u = url(req);
    json(res, 200, await buildState({
      force: u.searchParams.get('fresh') === '1',
      consumeFired: true,
    }));
  }));

  /* GET /kline */
  route('/kline', safe(async (req, res) => {
    const u = url(req);
    const symbol = u.searchParams.get('symbol') || '';
    if (!symbol) {
      json(res, 200, { ok: false, error: '缺少 symbol 参数' });
      return;
    }
    const s = await init();
    const period = u.searchParams.get('period') || s.settings.period;
    const adjust = u.searchParams.get('adjust') || s.settings.adjust;
    const count = Number(u.searchParams.get('count') || s.settings.klineCount);
    const key = `${symbol}|${period}|${adjust}|${count}`;

    const hit = cacheGet(klineCache, key, KLINE_TTL_MS);
    if (hit) {
      json(res, 200, hit);
      return;
    }
    const value = { ok: true, ...(await fetchKline(symbol, { period, adjust, count })) };
    cacheSet(klineCache, key, value);
    json(res, 200, value);
  }));

  /* GET /search */
  route('/search', safe(async (req, res) => {
    const u = url(req);
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) {
      json(res, 200, { ok: true, hits: [] });
      return;
    }
    const hit = cacheGet(searchCache, q, SEARCH_TTL_MS);
    if (hit) {
      json(res, 200, { ok: true, hits: hit, cached: true });
      return;
    }
    const hits = await searchStock(q, 12);
    cacheSet(searchCache, q, hits);
    json(res, 200, { ok: true, hits });
  }));

  /* GET /health */
  route('/health', safe(async (_req, res) => {
    const s = await init();
    const probeSymbol = s.items[0]?.symbol || 'sh000001';
    // 盘口只有个股有，指数没有。拿第一只非指数来探，否则 bookOk 永远是 false，
    // 看起来像"盘口坏了"，其实只是探针选错了标的。
    const bookSymbol = (s.items.find((i) => !i.index) || s.items[0])?.symbol || 'sh000001';
    let quoteOk = false;
    let quoteErr = null;
    let sample = null;
    try {
      const m = await fetchQuotes([probeSymbol]);
      const q = m.get(probeSymbol);
      quoteOk = !!q;
      sample = q ? { symbol: q.symbol, name: q.name, price: q.price, changePct: q.changePct, provider: q.provider } : null;
    } catch (err) {
      quoteErr = err && err.message ? err.message : String(err);
    }
    let klineOk = false;
    try {
      const k = await fetchKline(probeSymbol, { period: 'day', count: 5 });
      klineOk = k.candles.length > 0;
    } catch { /* 记在 klineOk */ }

    let trendOk = false;
    let trendPoints = 0;
    try {
      const t = await fetchTrends(probeSymbol, { days: 1 });
      trendOk = t.points.length > 0;
      trendPoints = t.points.length;
    } catch { /* 记在 trendOk */ }

    let bookOk = false;
    let bookLevels = 0;
    try {
      const b = await fetchOrderBook(bookSymbol);
      bookOk = b.bids.length === 5 && b.asks.length === 5;
      bookLevels = b.bids.length + b.asks.length;
    } catch { /* 指数没有盘口，记在 bookOk */ }

    const realized = computeRealized(s.trades);

    json(res, 200, {
      ok: true,
      plugin: `${name}@1.0.0`,
      node: process.version,
      storePath: s.file,
      itemCount: s.items.length,
      tradeCount: s.trades.length,
      alertCount: s.alerts.length,
      realizedPnl: realized.realized,
      probeSymbol,
      bookSymbol,
      quoteOk,
      quoteErr,
      sample,
      klineOk,
      trendOk,
      trendPoints,
      bookOk,
      bookLevels,
      caches: cacheSizes(),
      market: marketStatus(),
    });
  }));

  /* POST /items/save */
  route('/items/save', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const input = String(body.symbol || body.code || body.input || '').trim();
    if (!input) {
      json(res, 200, { ok: false, error: '请输入股票代码或名称' });
      return;
    }

    const s = await init();
    // 解析成规范符号；必要时走搜索（美股/指数/基金）
    let norm = body.secid ? null : null;
    let resolved = await resolveSymbol(input).catch(() => null);
    let quote = null;
    if (!resolved) {
      json(res, 200, { ok: false, error: `没找到「${input}」，请检查代码或名称` });
      return;
    }

    // 取一次行情，把名字/市场补齐
    try {
      const m = await fetchQuotes([resolved.symbol]);
      quote = m.get(resolved.symbol) || null;
    } catch { /* 行情失败也能先把持仓存下来 */ }

    const saved = await s.upsert({
      symbol: resolved.symbol,
      code: resolved.code,
      market: resolved.market,
      name: (quote && quote.name) || resolved.name || input,
      shares: body.shares,
      cost: body.cost,
      watch: body.watch,
      note: body.note,
    });

    json(res, 200, {
      ok: true,
      item: computePosition(saved, quote),
      state: await buildState({ force: true }),
    });
  }));

  /* POST /items/remove */
  route('/items/remove', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const s = await init();
    const removed = await s.remove(String(body.symbol || ''));
    json(res, 200, { ok: true, removed, state: await buildState() });
  }));

  /* POST /settings/save */
  route('/settings/save', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const s = await init();
    const settings = await s.patchSettings(body || {});
    json(res, 200, { ok: true, settings });
  }));

  /* GET /trends */
  route('/trends', safe(async (req, res) => {
    const u = url(req);
    const symbol = u.searchParams.get('symbol') || '';
    if (!symbol) {
      json(res, 200, { ok: false, error: '缺少 symbol 参数' });
      return;
    }
    const s = await init();
    const days = Number(u.searchParams.get('days') || s.settings.trendDays || 1);
    const key = `${symbol}|${days}`;

    const hit = cacheGet(trendCache, key, TREND_TTL_MS);
    if (hit) {
      json(res, 200, hit);
      return;
    }
    const value = { ok: true, ...(await fetchTrends(symbol, { days })) };
    cacheSet(trendCache, key, value);
    json(res, 200, value);
  }));

  /* GET /orderbook */
  route('/orderbook', safe(async (req, res) => {
    const u = url(req);
    const symbol = u.searchParams.get('symbol') || '';
    if (!symbol) {
      json(res, 200, { ok: false, error: '缺少 symbol 参数' });
      return;
    }
    const hit = cacheGet(bookCache, symbol, BOOK_TTL_MS);
    if (hit) {
      json(res, 200, hit);
      return;
    }
    const value = { ok: true, ...(await fetchOrderBook(symbol)) };
    cacheSet(bookCache, symbol, value);
    json(res, 200, value);
  }));

  /* GET /trades */
  route('/trades', safe(async (_req, res) => {
    const s = await init();
    const summary = computeRealized(s.trades);
    const bySymbol = {};
    for (const [sym, v] of summary.bySymbol) bySymbol[sym] = v;

    // 顺带带上最新价，界面上好对照"这笔买卖现在值多少"
    let quotes = {};
    try {
      const syms = summary.symbols;
      if (syms.length) {
        const m = await quotesFor(syms.map((symbol) => ({ symbol })));
        quotes = Object.fromEntries(
          [...m.entries()].map(([k, q]) => [k, { name: q.name, price: q.price, changePct: q.changePct, currency: q.currency }]),
        );
      }
    } catch { /* 行情失败不影响流水本身 */ }

    json(res, 200, {
      ok: true,
      trades: s.trades,
      realized: { total: summary.realized, fees: summary.fees, tradeCount: summary.tradeCount },
      bySymbol,
      quotes,
    });
  }));

  /* POST /trades/save */
  route('/trades/save', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const s = await init();

    // 允许只填 code / name，先解析成规范符号
    let resolved = null;
    if (body.symbol) resolved = await resolveWithQuote(body.symbol).catch(() => null);
    if (!resolved) {
      const input = String(body.code || body.input || body.name || '').trim();
      if (input) resolved = await resolveWithQuote(input);
    }
    if (!resolved) {
      json(res, 200, { ok: false, error: `没找到「${body.symbol || body.code || ''}」` });
      return;
    }
    if (!resolved.quote) {
      json(res, 200, { ok: false, error: `未能确认「${resolved.symbol}」的行情，无法记账` });
      return;
    }

    const trade = await s.addTrade({
      id: body.id,
      symbol: resolved.symbol,
      code: resolved.code,
      market: resolved.market,
      name: resolved.name,
      side: body.side,
      price: body.price,
      shares: body.shares,
      fee: body.fee,
      date: body.date,
      note: body.note,
    });
    const summary = computeRealized(s.trades);
    json(res, 200, { ok: true, trade, realized: summary.realized, state: await buildState({ force: true }) });
  }));

  /* POST /trades/remove */
  route('/trades/remove', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const s = await init();
    const removed = await s.removeTrade(body.id);
    json(res, 200, { ok: true, removed, realized: computeRealized(s.trades).realized });
  }));

  /* POST /trades/clear */
  route('/trades/clear', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const s = await init();
    const removed = await s.clearTrades(body.symbol ? String(body.symbol) : null);
    json(res, 200, { ok: true, removed, realized: 0 });
  }));

  /* POST /trades/apply —— 按流水反推的股数/均价写回持仓 */
  route('/trades/apply', safe(async (_req, res) => {
    const s = await init();
    const { changed } = await s.applyDerivedPositions();
    json(res, 200, { ok: true, changed, state: await buildState({ force: true }) });
  }));

  /* POST /alerts/save */
  route('/alerts/save', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const s = await init();

    let patch = { ...body };
    if (!body.id) {
      if (!body.symbol) {
        json(res, 200, { ok: false, error: '请选择要预警的股票' });
        return;
      }
      const resolved = await resolveWithQuote(body.symbol).catch(() => null);
      if (!resolved) {
        json(res, 200, { ok: false, error: `没找到「${body.symbol}」` });
        return;
      }
      patch = { ...patch, symbol: resolved.symbol, code: resolved.code, market: resolved.market, name: resolved.name };
    }

    // upsertAlert 返回的是落盘对象，此刻还没有 hit/current——那两个字段是
    // buildState 里 syncAlerts 才按最新行情算出来的。所以先跑一遍 state，
    // 再从 state.alerts 里取回同一条，前端才能立刻把"已命中/当前价"画出来。
    const saved = await s.upsertAlert(patch);
    const state = await buildState({ force: true });
    const alert = (state.alerts || []).find((a) => a.id === saved.id) || { ...saved };
    // 注意：fired 队列归轮询接口（GET /state）独占消费，这里不取，
    // 否则"新建预警立刻触发"的提示会被这里吃掉、顶栏再也弹不出来。
    json(res, 200, { ok: true, alert, state });
  }));

  /* POST /alerts/remove */
  route('/alerts/remove', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const s = await init();
    const removed = await s.removeAlert(body.id);
    json(res, 200, { ok: true, removed });
  }));

  /* POST /alerts/ack */
  route('/alerts/ack', safe(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 200, { ok: false, error: '请使用 POST' });
      return;
    }
    const body = await readBody(req);
    const s = await init();
    const ok = await s.ackAlert(body.id);
    json(res, 200, { ok });
  }));

  /* ---------------- AI 分析 ---------------- *
   * 走宿主已经挂好的模型服务（@deepseek-ai/dsh-llm），不自己发 HTTP、不需要 API Key：
   * 适配器会按各提供方的凭据缝自己解析密钥。服务用 ctx.get('llm') 惰性读取——
   * 不写进 inject，是为了让「没挂模型服务」的配置仍然能正常用行情条，
   * 只让 AI 标签页显示一句人话错误，而不是整个插件加载失败。
   * ------------------------------------------------------------------ */

  const llmOf = () => {
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm;
      return svc && typeof svc.stream === 'function' ? svc : null;
    } catch {
      return null;
    }
  };

  const NO_LLM = '这个 DSH 配置里没有挂载模型服务（@deepseek-ai/dsh-llm），AI 分析用不了';

  /* GET /ai/models —— 模型目录，供界面下拉框 */
  route('/ai/models', safe(async (_req, res) => {
    const llm = llmOf();
    if (!llm) {
      json(res, 200, { ok: false, error: NO_LLM });
      return;
    }
    let providers = [];
    try {
      providers = llm.listProviders() || [];
    } catch (err) {
      json(res, 200, { ok: false, error: `读取模型提供方失败：${err && err.message ? err.message : err}` });
      return;
    }
    const models = [];
    const failures = [];
    for (const p of providers) {
      try {
        const list = await llm.listModels(p.id);
        for (const m of list || []) {
          models.push({
            provider: m.provider || p.id,
            id: m.id,
            name: m.name || m.id,
            description: m.description || '',
          });
        }
      } catch (err) {
        // 单个提供方不可用（没配密钥等）不该让整张目录失败
        failures.push({ provider: p.id, error: err && err.message ? err.message : String(err) });
      }
    }

    let current = null;
    try {
      const dm = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null;
      const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : null;
      if (sel && sel.provider && sel.model) {
        current = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || null };
      }
    } catch { /* 读不到默认值就退回第一个模型 */ }
    if (!current && models.length) current = { provider: models[0].provider, model: models[0].id, reasoningEffort: null };

    json(res, 200, {
      ok: true,
      providers: providers.map((p) => ({ id: p.id, name: p.name || p.id })),
      models,
      failures,
      current,
    });
  }));

  /* POST /ai/analyze —— 取数 → 组装数据包 → 调模型，用 NDJSON 边生成边回传 */
  route('/ai/analyze', async (req, res) => {
    // 故意不套 safe()：safe 在 headersSent 之后会 destroy socket，
    // 那样前端只能看到"连接中断"，拿不到真正的错误原因。这里自己兜底。
    let streaming = false;
    const send = (obj) => {
      try { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); } catch { /* 客户端断开 */ }
    };

    try {
      if (req.method !== 'POST') {
        json(res, 200, { ok: false, error: '请使用 POST' });
        return;
      }
      const body = await readBody(req);
      const raw = String(body.symbol || '').trim();
      if (!raw) {
        json(res, 200, { ok: false, error: '缺少标的：请求里要带上股票代码（symbol），例如 sh600519' });
        return;
      }
      // 直接传 6 位代码/拼音也认：先归一化，归一化不了再走一次搜索
      let symbol = raw;
      const direct = normalizeSymbol(raw);
      if (direct && direct.symbol) symbol = direct.symbol;
      else {
        const hit = await resolveSymbol(raw).catch(() => null);
        if (hit && hit.symbol) symbol = hit.symbol;
      }
      const llm = llmOf();
      if (!llm) {
        json(res, 200, { ok: false, error: NO_LLM });
        return;
      }

      const s = await init();
      const state = await buildState({});
      let pos = (state.items || []).find((p) => p.symbol === symbol) || null;
      if (!pos) {
        // 不在自选里也能分析：单独取一次行情
        const one = await fetchQuotes([symbol]).catch(() => new Map());
        const q = one.get(symbol) || null;
        if (!q) {
          json(res, 200, { ok: false, error: `取不到「${symbol}」的行情，检查一下代码` });
          return;
        }
        pos = { symbol, code: q.code, market: q.market, name: q.name, quote: q, shares: 0, cost: 0, index: false };
      }

      const include = body.include && typeof body.include === 'object' ? body.include : {};
      const wantKline = include.kline !== false;
      const wantTrend = include.trend !== false;
      const wantBook = include.book !== false;
      const wantTrades = include.trades !== false;
      const wantIndexes = include.indexes !== false;

      const period = body.period || s.settings.period || 'day';
      const adjust = body.adjust || s.settings.adjust || 'pre';
      const count = Math.min(240, Math.max(30, Number(body.count) || 120));

      const [kline, trend, book] = await Promise.all([
        wantKline ? fetchKline(symbol, { period, adjust, count }).catch(() => null) : null,
        wantTrend ? fetchTrends(symbol, { days: 1 }).catch(() => null) : null,
        wantBook ? fetchOrderBook(symbol).catch(() => null) : null,
      ]);

      const candles = kline && Array.isArray(kline.candles) ? kline.candles : [];
      const pack = buildDataPack({
        symbol,
        name: pos.name,
        code: pos.code,
        quote: pos.quote,
        candleSummary: summarizeCandles(candles),
        candleText: condenseCandles(candles, 60),
        periodLabel: PERIOD_LABEL[period] || '日K',
        trendSummary: trend ? summarizeTrends(trend) : null,
        bookSummary: book ? summarizeBook(book) : null,
        tradeSummary: wantTrades ? summarizeTrades(s.trades, symbol) : null,
        market: state.market,
        position: pos.cost > 0 || pos.shares > 0 ? pos : null,
        alerts: (state.alerts || []).filter((a) => a.symbol === symbol),
        indexes: wantIndexes ? (state.items || []).filter((p) => p.index) : [],
        asOf: new Date(),
      });

      const style = body.style === 'detail' ? 'detail' : 'short';
      const messages = buildMessages(pack, { style, extra: typeof body.extra === 'string' ? body.extra : '' })
        .map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] }));

      let provider = body.provider ? String(body.provider) : '';
      let model = body.model ? String(body.model) : '';
      if (!provider || !model) {
        try {
          const dm = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null;
          const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : null;
          if (sel && sel.provider && sel.model) { provider = provider || sel.provider; model = model || sel.model; }
        } catch { /* 忽略 */ }
      }
      if (!provider || !model) {
        json(res, 200, { ok: false, error: '没指定模型，也没读到 DSH 的默认模型；请在上方下拉框里选一个' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      streaming = true;

      const asOf = Date.now();
      send({ type: 'meta', meta: pack.meta, provider, model, style, asOf, symbol, name: pos.name });
      log('info', `[stock-ticker] AI 分析 ${symbol} via ${provider}/${model}，数据 ${pack.meta.chars} 字`);

      const controller = new AbortController();
      req.on('close', () => controller.abort());

      let text = '';
      let reasoning = '';
      let usage = null;
      let finish = null;
      for await (const chunk of llm.stream({ provider, model, messages, signal: controller.signal })) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') {
          text += chunk.text || '';
          send({ type: 'delta', text: chunk.text || '' });
        } else if (chunk.type === 'reasoning-delta') {
          reasoning += chunk.text || '';
          send({ type: 'reasoning', text: chunk.text || '' });
        } else if (chunk.type === 'usage') {
          usage = chunk.usage || null;
        } else if (chunk.type === 'finish') {
          finish = chunk.reason || null;
        }
      }

      const failure = finish && finish.failure ? finish.failure : null;
      send({
        type: 'done',
        text,
        reasoning,
        usage,
        finish: finish ? finish.kind : 'stop',
        code: failure ? failure.code || 'ERROR' : null,
        error: failure ? failure.message || failure.code || '模型调用失败' : null,
        elapsedMs: Date.now() - asOf,
      });
      res.end();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      log('warn', `[stock-ticker] AI 分析失败: ${err && err.stack ? err.stack : msg}`);
      if (streaming) {
        send({ type: 'error', error: msg });
        try { res.end(); } catch { /* 已断开 */ }
      } else if (!res.headersSent) {
        json(res, 200, { ok: false, error: msg });
      } else {
        res.destroy();
      }
    }
  });

  log('info', `[stock-ticker] 已注册 ${ROUTE_PREFIX}/* 路由`);
}

/* ------------------------------------------------------------------ *
 * 交易时段判断（Asia/Shanghai）
 * ------------------------------------------------------------------ */

/** @returns {{open:boolean, session:string, label:string, shanghai:string}} */
export function marketStatus(now = new Date()) {
  const parts = shanghaiParts(now);
  const { weekday, hour, minute } = parts;
  const mins = hour * 60 + minute;
  const isWeekday = weekday >= 1 && weekday <= 5;

  let session = 'closed';
  if (isWeekday) {
    if (mins >= 9 * 60 + 15 && mins < 9 * 60 + 25) session = 'auction';
    else if (mins >= 9 * 60 + 30 && mins <= 11 * 60 + 30) session = 'morning';
    else if (mins >= 13 * 60 && mins <= 15 * 60) session = 'afternoon';
    else if (mins > 11 * 60 + 30 && mins < 13 * 60) session = 'lunch';
    else if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 30) session = 'preopen';
  }

  const labels = {
    auction: '集合竞价',
    preopen: '即将开盘',
    morning: '交易中',
    lunch: '午间休市',
    afternoon: '交易中',
    closed: isWeekday ? '已收盘' : '周末休市',
  };

  return {
    open: session === 'morning' || session === 'afternoon' || session === 'auction',
    session,
    label: labels[session] || '休市',
    shanghai: `${pad(hour)}:${pad(minute)}`,
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function shanghaiParts(date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    let weekday = 0;
    let hour = 0;
    let minute = 0;
    for (const p of fmt.formatToParts(date)) {
      if (p.type === 'weekday') weekday = map[p.value] ?? 0;
      else if (p.type === 'hour') hour = Number(p.value) % 24;
      else if (p.type === 'minute') minute = Number(p.value);
    }
    return { weekday, hour, minute };
  } catch {
    // 极端情况下退回本地时间
    return { weekday: date.getDay(), hour: date.getHours(), minute: date.getMinutes() };
  }
}
