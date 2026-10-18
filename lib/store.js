/**
 * dsh-stock-ticker / lib/store.js
 *
 * 持仓 / 自选 / 设置 / 交易流水 / 预警 的持久化。纯 Node，无依赖，可单独测试。
 * 默认文件：<DSH_HOME>/dsh-stock-ticker/portfolio.json
 *
 * 数据结构：
 * {
 *   version: 1,
 *   settings: { refreshMs, topOffset, collapsed, opacity, showWatch, showHoldings,
 *               showIndex, showTotals, scroll, period, adjust, klineCount, flash,
 *               klineInStrip, chart, trendDays, showTrend, showKline, showOrderBook,
 *               showTrades, showAlerts, showAi, alertToast },
 *   items:  [ { symbol, code, market, name, shares, cost, watch, note, sort, addedAt } ],
 *   trades: [ { id, symbol, code, market, name, side:'buy'|'sell', price, shares,
 *               fee, date:'YYYY-MM-DD', note, createdAt } ],
 *   alerts: [ { id, symbol, code, name, kind:'price'|'pct', op:'>='|'<=',
 *               value, enabled, note, firedAt, createdAt } ]
 * }
 *
 * 设计取舍：流水（trades）和持仓（items）是**两本账**。流水是流水，持仓是持仓，
 * 不会互相偷偷改写；界面提供"按流水同步持仓"按钮，由用户显式触发。这样用户手动
 * 填的持仓不会被流水覆盖，也不会因为流水记漏了一笔就把持仓算错。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  refreshMs: 5000,      // 行情轮询间隔
  topOffset: 0,         // 状态栏额外下移像素（用于避开窗口标题栏）
  collapsed: false,     // 折叠成小胶囊
  opacity: 0.96,
  showWatch: true,      // 行情条里显示自选
  showHoldings: true,   // 行情条里显示持仓
  showIndex: true,      // 显示大盘指数
  showTotals: true,     // 行情条右侧的持仓汇总徽标
  scroll: true,         // 跑马灯滚动
  period: 'day',        // K线周期
  adjust: 'pre',        // 复权
  klineCount: 120,
  flash: true,          // 价格变动闪烁
  klineInStrip: false,  // 行情条内嵌迷你K线
  chart: 'trend',       // 打开图表时默认看什么：trend=分时 kline=K线
  trendDays: 1,         // 分时天数 1..5
  showTrend: true,      // 组件：分时图
  showKline: true,      // 组件：K线图
  showOrderBook: true,  // 组件：五档盘口
  showTrades: true,     // 标签页：交易流水
  showAlerts: true,     // 标签页：价格预警
  showAi: true,         // 标签页：AI 分析
  alertToast: true,     // 预警触发时弹提示
  aiProvider: '',       // AI 分析上次用的模型提供方
  aiModel: '',          // AI 分析上次用的模型 id
  aiStyle: 'short',     // AI 输出风格：short 简版 / detail 详细
  aiKline: true,        // AI 数据包：带日K指标与明细
  aiTrend: true,        // AI 数据包：带分时
  aiBook: true,         // AI 数据包：带五档盘口
  aiTrades: true,       // AI 数据包：带自己的交易流水
  aiIndex: true,        // AI 数据包：带大盘指数
};

/** 大盘指数（默认开启，作为市场温度计） */
export const DEFAULT_INDEXES = [
  { symbol: 'sh000001', code: '000001', market: 1, name: '上证指数', shares: 0, cost: 0, watch: true, index: true },
  { symbol: 'sz399001', code: '399001', market: 0, name: '深证成指', shares: 0, cost: 0, watch: true, index: true },
  { symbol: 'sz399006', code: '399006', market: 0, name: '创业板指', shares: 0, cost: 0, watch: true, index: true },
];

export function defaultStorePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-stock-ticker', 'portfolio.json');
}

export class PortfolioStore {
  /** @param {string} [file] */
  constructor(file) {
    this.file = file && String(file).trim() ? String(file).trim() : defaultStorePath();
    this.data = emptyData();
    this._loaded = false;
    this._writing = null;
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(stripBom(raw));
      this.data = normalizeData(parsed);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // 文件损坏时不要静默丢弃：改名留档，再从空库开始
        try {
          await fsp.rename(this.file, `${this.file}.broken-${Date.now()}`);
        } catch { /* 留档失败也不阻塞启动 */ }
      }
      this.data = emptyData();
    }
    this._loaded = true;
    await this.save().catch(() => {});
    return this.data;
  }

  async ensureLoaded() {
    if (!this._loaded) await this.load();
    return this.data;
  }

  get settings() {
    return this.data.settings;
  }

  get items() {
    return this.data.items;
  }

  /** 原子写盘：先写临时文件再 rename，避免半截 JSON */
  async save() {
    if (this._writing) await this._writing.catch(() => {});
    this._writing = (async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await fsp.rename(tmp, this.file);
    })();
    try {
      await this._writing;
    } finally {
      this._writing = null;
    }
    return this.file;
  }

  /**
   * 新增或更新一只股票。
   * @param {{symbol:string, code?:string, market?:number, name?:string,
   *          shares?:number, cost?:number, watch?:boolean, note?:string}} patch
   */
  async upsert(patch) {
    await this.ensureLoaded();
    const symbol = String(patch.symbol || '').trim();
    if (!symbol) throw new Error('缺少 symbol');

    const idx = this.data.items.findIndex((it) => it.symbol === symbol);
    const base = idx >= 0 ? this.data.items[idx] : {
      symbol,
      code: patch.code || symbol.replace(/^[a-z]+/, ''),
      market: patch.market ?? null,
      name: patch.name || symbol,
      shares: 0,
      cost: 0,
      watch: true,
      note: '',
      addedAt: Date.now(),
    };

    const next = { ...base };
    if (patch.code !== undefined) next.code = String(patch.code);
    if (patch.market !== undefined && patch.market !== null) next.market = Number(patch.market);
    if (patch.name !== undefined && patch.name) next.name = String(patch.name);
    if (patch.shares !== undefined) next.shares = nonNeg(patch.shares);
    if (patch.cost !== undefined) next.cost = nonNeg(patch.cost);
    if (patch.watch !== undefined) next.watch = !!patch.watch;
    if (patch.note !== undefined) next.note = String(patch.note);
    if (patch.sort !== undefined) next.sort = Number(patch.sort);

    if (idx >= 0) this.data.items[idx] = next;
    else this.data.items.push(next);

    await this.save();
    return next;
  }

  async remove(symbol) {
    await this.ensureLoaded();
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((it) => it.symbol !== symbol);
    await this.save();
    return before !== this.data.items.length;
  }

  async patchSettings(patch) {
    await this.ensureLoaded();
    const next = { ...this.data.settings };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined) continue;
      if (!(k in DEFAULT_SETTINGS)) continue;
      next[k] = coerceSetting(k, v);
    }
    this.data.settings = next;
    await this.save();
    return next;
  }

  /** 首次使用时把大盘指数写进自选，保证打开插件就有内容 */
  async seedIndexes() {
    await this.ensureLoaded();
    if (this.data.items.some((it) => it.index)) return false;
    for (const ix of DEFAULT_INDEXES) {
      if (!this.data.items.some((it) => it.symbol === ix.symbol)) {
        this.data.items.push({ ...ix, note: '', addedAt: Date.now() });
      }
    }
    await this.save();
    return true;
  }

  /* ---------------- 交易流水 ---------------- */

  get trades() {
    return this.data.trades;
  }

  /**
   * 记一笔买入/卖出。
   * @param {{symbol:string, code?:string, market?:number, name?:string,
   *          side:'buy'|'sell', price:number, shares:number, fee?:number,
   *          date?:string, note?:string}} patch
   */
  async addTrade(patch = {}) {
    await this.ensureLoaded();
    const symbol = String(patch.symbol || '').trim();
    if (!symbol) throw new Error('缺少 symbol');
    if (patch.side !== 'buy' && patch.side !== 'sell') {
      throw new Error("买卖方向只能是 buy 或 sell");
    }
    const side = patch.side;
    const price = nonNeg(patch.price);
    const shares = nonNeg(patch.shares);
    if (!(price > 0)) throw new Error('成交价必须大于 0');
    if (!(shares > 0)) throw new Error('股数必须大于 0');

    // 不允许卖空：卖出股数不能超过流水里已经攒下的持仓
    if (side === 'sell') {
      const held = computeRealized(this.data.trades).bySymbol.get(symbol);
      const qty = held ? held.qty : 0;
      if (shares > qty + 1e-9) {
        throw new Error(`卖出 ${shares} 股超过 ${symbol} 的流水持仓 ${qty} 股（是不是漏记了买入？）`);
      }
    }

    const trade = {
      id: patch.id ? String(patch.id) : newId('t'),
      symbol,
      code: String(patch.code || symbol.replace(/^[a-z]+/, '')),
      market: patch.market === undefined || patch.market === null ? null : Number(patch.market),
      name: patch.name ? String(patch.name) : symbol,
      side,
      price,
      shares,
      fee: nonNeg(patch.fee),
      date: normDate(patch.date),
      note: patch.note ? String(patch.note) : '',
      createdAt: Date.now(),
    };
    this.data.trades.push(trade);
    sortTrades(this.data.trades);
    await this.save();
    return trade;
  }

  async removeTrade(id) {
    await this.ensureLoaded();
    const before = this.data.trades.length;
    this.data.trades = this.data.trades.filter((t) => t.id !== String(id));
    await this.save();
    return before !== this.data.trades.length;
  }

  async clearTrades(symbol) {
    await this.ensureLoaded();
    const before = this.data.trades.length;
    this.data.trades = symbol
      ? this.data.trades.filter((t) => t.symbol !== symbol)
      : [];
    await this.save();
    return before - this.data.trades.length;
  }

  /* ---------------- 预警 ---------------- */

  get alerts() {
    return this.data.alerts;
  }

  /**
   * 新建/修改一条预警。
   * @param {{id?:string, symbol:string, code?:string, name?:string,
   *          kind?:'price'|'pct', op?:'>='|'<=', value:number,
   *          enabled?:boolean, note?:string}} patch
   */
  async upsertAlert(patch = {}) {
    await this.ensureLoaded();
    const id = patch.id ? String(patch.id) : '';
    const idx = id ? this.data.alerts.findIndex((a) => a.id === id) : -1;

    if (idx < 0) {
      const symbol = String(patch.symbol || '').trim();
      if (!symbol) throw new Error('缺少 symbol');
      const value = Number(patch.value);
      if (!Number.isFinite(value)) throw new Error('预警阈值必须是数字');
      const alert = {
        id: newId('a'),
        symbol,
        code: String(patch.code || symbol.replace(/^[a-z]+/, '')),
        name: patch.name ? String(patch.name) : symbol,
        kind: patch.kind === 'pct' ? 'pct' : 'price',
        op: patch.op === '<=' ? '<=' : '>=',
        value,
        enabled: patch.enabled !== false,
        note: patch.note ? String(patch.note) : '',
        firedAt: null,
        createdAt: Date.now(),
      };
      this.data.alerts.push(alert);
      await this.save();
      return alert;
    }

    const next = { ...this.data.alerts[idx] };
    if (patch.kind !== undefined) next.kind = patch.kind === 'pct' ? 'pct' : 'price';
    if (patch.op !== undefined) next.op = patch.op === '<=' ? '<=' : '>=';
    if (patch.value !== undefined) {
      const v = Number(patch.value);
      if (!Number.isFinite(v)) throw new Error('预警阈值必须是数字');
      next.value = v;
    }
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.note !== undefined) next.note = String(patch.note);
    if (patch.name !== undefined && patch.name) next.name = String(patch.name);
    // 改了条件就把"已触发"清掉，重新武装
    next.firedAt = null;
    this.data.alerts[idx] = next;
    await this.save();
    return next;
  }

  async removeAlert(id) {
    await this.ensureLoaded();
    const before = this.data.alerts.length;
    this.data.alerts = this.data.alerts.filter((a) => a.id !== String(id));
    await this.save();
    return before !== this.data.alerts.length;
  }

  async ackAlert(id) {
    await this.ensureLoaded();
    const a = this.data.alerts.find((x) => x.id === String(id));
    if (!a) return false;
    a.firedAt = null;
    await this.save();
    return true;
  }

  /**
   * 拿最新行情跑一遍所有预警：条件成立的标记 firedAt（每穿越一次只报一次），
   * 条件不成立的就解除标记（下次再穿越会重新报）。
   *
   * 新触发的会同时压进 pendingFired 队列。这样即使中间有别的接口（比如 /alerts/save）
   * 顺带跑了一次 syncAlerts，客户端下一轮轮询 /state 依然能收到这条通知。
   *
   * @param {Map<string, object>|Record<string, object>} quotes symbol -> 行情
   * @returns {Promise<{alerts:Array, fired:Array}>} fired 是本次**新**触发的
   */
  async syncAlerts(quotes) {
    await this.ensureLoaded();
    const lookup = (symbol) =>
      quotes instanceof Map ? quotes.get(symbol) : quotes ? quotes[symbol] : undefined;

    this.pendingFired ||= [];
    const out = [];
    const fired = [];
    let dirty = false;

    for (const a of this.data.alerts) {
      // 判定逻辑只有一处：evalAlert（停用的预警永远 hit=false）
      const { hit, current } = evalAlert(a, lookup(a.symbol));

      if (hit && !a.firedAt) {
        a.firedAt = Date.now();
        dirty = true;
        const event = { ...a, current, hit: true };
        fired.push(event);
        this.pendingFired.push(event);
      } else if (!hit && a.firedAt) {
        a.firedAt = null;
        dirty = true;
      }
      out.push({ ...a, current, hit });
    }

    if (dirty) await this.save();
    return { alerts: out, fired };
  }

  /** 取走"尚未送达客户端"的触发事件（清空队列） */
  drainFired() {
    const list = this.pendingFired || [];
    this.pendingFired = [];
    return list;
  }

  /** 用当前流水推导出的持仓覆盖 items 里的股数与成本（用户显式触发） */
  async applyDerivedPositions() {
    await this.ensureLoaded();
    const derived = computeRealized(this.data.trades);
    let changed = 0;
    for (const [symbol, d] of derived.bySymbol) {
      const shares = round2(d.qty);
      const cost = d.qty > 0 ? round4(d.avgCost) : 0;
      let item = this.data.items.find((it) => it.symbol === symbol);
      if (!item) {
        // 只记了流水、没加过自选的标的，同步时补进持仓列表
        const created = {
          symbol,
          code: d.code || symbol.replace(/^[a-z]+/, ''),
          market: d.market ?? null,
          name: d.name || symbol,
          shares: 0,
          cost: 0,
          watch: true,
          index: false,
          note: '',
          addedAt: Date.now(),
        };
        this.data.items.push(created);
        item = created;
      }
      if (item.shares !== shares || item.cost !== cost) {
        item.shares = shares;
        item.cost = cost;
        changed++;
      }
    }
    if (changed) await this.save();
    return { changed, derived };
  }
}

/* ------------------------------------------------------------------ */

function emptyData() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, items: [], trades: [], alerts: [] };
}

let idSeq = 0;
function newId(prefix) {
  idSeq = (idSeq + 1) % 100000;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`;
}

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function round4(v) {
  return Math.round((Number(v) || 0) * 10000) / 10000;
}

/** 归一化成交日期到 YYYY-MM-DD；给不出合法日期就用今天 */
function normDate(input) {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return input.trim();
  const d = input ? new Date(input) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** 流水按日期升序、同日按录入顺序排 —— 已实现盈亏必须按时间顺序算 */
function sortTrades(list) {
  list.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  return list;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function nonNeg(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function coerceSetting(key, value) {
  switch (key) {
    case 'refreshMs': return Math.min(120000, Math.max(1000, Number(value) || DEFAULT_SETTINGS.refreshMs));
    case 'topOffset': return Math.min(400, Math.max(-40, Number(value) || 0));
    case 'opacity': return Math.min(1, Math.max(0.3, Number(value) || DEFAULT_SETTINGS.opacity));
    case 'klineCount': return Math.min(800, Math.max(30, Number(value) || DEFAULT_SETTINGS.klineCount));
    case 'trendDays': return Math.min(5, Math.max(1, Math.round(Number(value) || DEFAULT_SETTINGS.trendDays)));
    case 'chart': return ['trend', 'kline'].includes(value) ? value : 'trend';
    case 'period': return ['1m', '5m', '15m', '30m', '60m', 'day', 'week', 'month'].includes(value) ? value : 'day';
    case 'adjust': return ['none', 'pre', 'post'].includes(value) ? value : 'pre';
    case 'aiStyle': return value === 'detail' ? 'detail' : 'short';
    case 'aiProvider': return String(value == null ? '' : value).slice(0, 80);
    case 'aiModel': return String(value == null ? '' : value).slice(0, 120);
    default: return typeof DEFAULT_SETTINGS[key] === 'boolean' ? !!value : value;
  }
}

function normalizeData(parsed) {
  const out = emptyData();
  if (!parsed || typeof parsed !== 'object') return out;

  if (parsed.settings && typeof parsed.settings === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (parsed.settings[k] !== undefined) out.settings[k] = coerceSetting(k, parsed.settings[k]);
    }
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const seen = new Set();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || !raw.symbol) continue;
    const symbol = String(raw.symbol);
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.items.push({
      symbol,
      code: String(raw.code || symbol.replace(/^[a-z]+/, '')),
      market: raw.market === undefined || raw.market === null ? null : Number(raw.market),
      name: raw.name ? String(raw.name) : symbol,
      shares: nonNeg(raw.shares),
      cost: nonNeg(raw.cost),
      watch: raw.watch !== false,
      index: !!raw.index,
      note: raw.note ? String(raw.note) : '',
      sort: raw.sort === undefined ? undefined : Number(raw.sort),
      addedAt: raw.addedAt ? Number(raw.addedAt) : Date.now(),
    });
  }

  const trades = Array.isArray(parsed.trades) ? parsed.trades : [];
  const seenTrade = new Set();
  for (const raw of trades) {
    if (!raw || typeof raw !== 'object' || !raw.symbol) continue;
    const id = raw.id ? String(raw.id) : newId('t');
    if (seenTrade.has(id)) continue;
    seenTrade.add(id);
    const price = nonNeg(raw.price);
    const shares = nonNeg(raw.shares);
    if (!(price > 0) || !(shares > 0)) continue; // 残缺流水直接丢掉，不要让盈亏算错
    const symbol = String(raw.symbol);
    out.trades.push({
      id,
      symbol,
      code: String(raw.code || symbol.replace(/^[a-z]+/, '')),
      market: raw.market === undefined || raw.market === null ? null : Number(raw.market),
      name: raw.name ? String(raw.name) : symbol,
      side: raw.side === 'sell' ? 'sell' : 'buy',
      price,
      shares,
      fee: nonNeg(raw.fee),
      date: normDate(raw.date),
      note: raw.note ? String(raw.note) : '',
      createdAt: raw.createdAt ? Number(raw.createdAt) : Date.now(),
    });
  }
  sortTrades(out.trades);

  const alerts = Array.isArray(parsed.alerts) ? parsed.alerts : [];
  const seenAlert = new Set();
  for (const raw of alerts) {
    if (!raw || typeof raw !== 'object' || !raw.symbol) continue;
    const value = Number(raw.value);
    if (!Number.isFinite(value)) continue;
    const id = raw.id ? String(raw.id) : newId('a');
    if (seenAlert.has(id)) continue;
    seenAlert.add(id);
    const symbol = String(raw.symbol);
    out.alerts.push({
      id,
      symbol,
      code: String(raw.code || symbol.replace(/^[a-z]+/, '')),
      name: raw.name ? String(raw.name) : symbol,
      kind: raw.kind === 'pct' ? 'pct' : 'price',
      op: raw.op === '<=' ? '<=' : '>=',
      value,
      enabled: raw.enabled !== false,
      note: raw.note ? String(raw.note) : '',
      firedAt: raw.firedAt ? Number(raw.firedAt) : null,
      createdAt: raw.createdAt ? Number(raw.createdAt) : Date.now(),
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * 盈亏计算
 * ------------------------------------------------------------------ */

/**
 * 用行情填充一条持仓记录，算出盈亏。
 * @param {object} item 持仓记录
 * @param {object|undefined} quote 实时行情
 */
export function computePosition(item, quote) {
  const price = quote && quote.price != null ? quote.price : null;
  const shares = nonNeg(item.shares);
  const cost = nonNeg(item.cost);
  const held = shares > 0 && cost > 0;

  const marketValue = price != null && shares ? price * shares : null;
  const costValue = held ? cost * shares : shares ? 0 : 0;
  const pnl = marketValue != null && held ? marketValue - costValue : null;
  const pnlPct = pnl != null && costValue > 0 ? (pnl / costValue) * 100 : null;
  // 当日盈亏：按昨收算持仓浮动
  const dayPnl =
    quote && price != null && quote.prevClose != null && shares
      ? (price - quote.prevClose) * shares
      : null;

  return {
    ...item,
    name: (quote && quote.name) || item.name,
    quote: quote || null,
    price,
    change: quote ? quote.change : null,
    changePct: quote ? quote.changePct : null,
    marketValue,
    costValue: held ? costValue : null,
    pnl,
    pnlPct,
    dayPnl,
    held,
    currency: (quote && quote.currency) || 'CNY',
    // 数据源标记：主源挂了会退回腾讯，界面上要能看出这一条是谁给的
    provider: (quote && quote.provider) || null,
  };
}

/**
 * 汇总总资产 / 总盈亏，按币种分开统计（不要把港币和人民币加在一起）。
 * @param {Array<object>} positions computePosition 的结果
 */
export function computeTotals(positions) {
  const byCurrency = {};
  const totals = {
    marketValue: 0,
    costValue: 0,
    pnl: 0,
    pnlPct: null,
    dayPnl: 0,
    upCount: 0,
    downCount: 0,
    flatCount: 0,
    byCurrency,
  };
  let hasPosition = false;

  for (const p of positions) {
    if (p.changePct != null) {
      if (p.changePct > 0) totals.upCount++;
      else if (p.changePct < 0) totals.downCount++;
      else totals.flatCount++;
    }
    if (!p.held || p.marketValue == null) continue;
    hasPosition = true;
    const cur = p.currency || 'CNY';
    const b = (byCurrency[cur] ||= { marketValue: 0, costValue: 0, pnl: 0, pnlPct: null, dayPnl: 0 });
    b.marketValue += p.marketValue;
    b.costValue += p.costValue || 0;
    b.pnl += p.pnl || 0;
    b.dayPnl += p.dayPnl || 0;
  }

  for (const b of Object.values(byCurrency)) {
    b.pnlPct = b.costValue > 0 ? (b.pnl / b.costValue) * 100 : null;
  }

  const primary = byCurrency.CNY || Object.values(byCurrency)[0];
  if (primary) {
    totals.marketValue = primary.marketValue;
    totals.costValue = primary.costValue;
    totals.pnl = primary.pnl;
    totals.pnlPct = primary.pnlPct;
    totals.dayPnl = primary.dayPnl;
  }
  totals.hasPosition = hasPosition;
  totals.currency = byCurrency.CNY ? 'CNY' : Object.keys(byCurrency)[0] || 'CNY';
  return totals;
}

/* ------------------------------------------------------------------ *
 * 交易流水 -> 已实现盈亏（加权平均成本法）
 * ------------------------------------------------------------------ */

/**
 * 按时间顺序跑一遍流水，用**加权平均成本法**算已实现盈亏。
 *
 * 买入：成本并入费用 —— avgCost = (avgCost*qty + price*shares + fee) / (qty + shares)
 * 卖出：已实现 = (price - avgCost) * shares - fee，qty 相应减少
 *
 * 卖空了（qty 被卖成负数）说明流水记漏了买入，这时候把 qty 夹回 0 并把该笔的
 * 已实现盈亏标为"不可信"，而不是算出一个凭空的数字。
 *
 * @param {Array<object>} trades
 * @returns {{bySymbol: Map<string, {symbol,name,code,market,qty,avgCost,realized,
 *           buyShares,sellShares,buyAmount,sellAmount,fees,tradeCount,incomplete}>,
 *           realized:number, fees:number, tradeCount:number, symbols:string[]}}
 */
export function computeRealized(trades) {
  const bySymbol = new Map();
  const list = Array.isArray(trades) ? [...trades] : [];
  sortTrades(list);

  for (const t of list) {
    const symbol = String(t.symbol || '');
    if (!symbol) continue;
    let s = bySymbol.get(symbol);
    if (!s) {
      s = {
        symbol,
        name: t.name || symbol,
        code: t.code || symbol.replace(/^[a-z]+/, ''),
        market: t.market ?? null,
        qty: 0,
        avgCost: 0,
        realized: 0,
        buyShares: 0,
        sellShares: 0,
        buyAmount: 0,
        sellAmount: 0,
        fees: 0,
        tradeCount: 0,
        incomplete: false,
      };
      bySymbol.set(symbol, s);
    }

    const price = nonNeg(t.price);
    const shares = nonNeg(t.shares);
    const fee = nonNeg(t.fee);
    if (!(price > 0) || !(shares > 0)) continue;

    s.tradeCount++;
    s.fees += fee;
    if (t.name && s.name === symbol) s.name = t.name;

    if (t.side === 'sell') {
      s.sellShares += shares;
      s.sellAmount += price * shares;
      if (shares > s.qty) s.incomplete = true; // 卖得比手上还多 = 流水缺买入
      s.realized += (price - s.avgCost) * shares - fee;
      s.qty = Math.max(0, s.qty - shares);
      if (s.qty === 0) s.avgCost = 0;
    } else {
      s.buyShares += shares;
      s.buyAmount += price * shares;
      const totalCost = s.avgCost * s.qty + price * shares + fee;
      s.qty += shares;
      s.avgCost = s.qty > 0 ? totalCost / s.qty : 0;
    }
  }

  let realized = 0;
  let fees = 0;
  let tradeCount = 0;
  for (const s of bySymbol.values()) {
    realized += s.realized;
    fees += s.fees;
    tradeCount += s.tradeCount;
  }

  return { bySymbol, realized, fees, tradeCount, symbols: [...bySymbol.keys()] };
}

/* ------------------------------------------------------------------ *
 * 预警判定
 * ------------------------------------------------------------------ */

/**
 * 判断一条预警是否成立。纯函数，Host / Client 都能用。
 * @param {object} alert
 * @param {object|undefined|null} quote
 * @returns {{hit:boolean, current:number|null}}
 */
export function evalAlert(alert, quote) {
  if (!alert || !quote) return { hit: false, current: null };
  const current =
    alert.kind === 'pct'
      ? quote.changePct != null ? Number(quote.changePct) : null
      : quote.price != null ? Number(quote.price) : null;
  if (current === null || !Number.isFinite(current)) return { hit: false, current: null };
  const value = Number(alert.value);
  if (!Number.isFinite(value)) return { hit: false, current };
  // 停用的预警照样把当前价带回去（界面要显示），但永不判命中
  if (alert.enabled === false) return { hit: false, current };
  const hit = alert.op === '<=' ? current <= value : current >= value;
  return { hit, current };
}

/** 把预警渲染成一句人话，Client 和日志共用 */
export function describeAlert(alert) {
  const what = alert.kind === 'pct' ? '涨跌幅' : '价格';
  const unit = alert.kind === 'pct' ? '%' : '';
  return `${alert.name || alert.symbol} ${what} ${alert.op} ${alert.value}${unit}`;
}
