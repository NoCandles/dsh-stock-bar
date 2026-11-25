/**
 * dsh-stock-bar / lib/store.js
 *
 * 持仓 / 自选 / 设置 / 交易流水 / 预警 的持久化。纯 Node，无依赖，可单独测试。
 * 默认文件：<DSH_HOME>/dsh-stock-bar/portfolio.json
 *
 * 数据结构：
 * {
 *   version: 1,
 *   settings: { refreshMs, topOffset, collapsed, opacity, showWatch, showHoldings,
 *               showIndex, showTotals, scroll, period, adjust, klineCount, flash,
 *               klineInStrip, chart, trendDays, showTrend, showKline, showOrderBook,
 *               showTrades, showAlerts, showAi, alertToast },
 *   items:  [ { symbol, code, market, name, shares, cost, watch, onStrip, note, sort, addedAt } ],
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

/** AI 分析历史最多留多少条（正文通常几 KB，50 条约 200KB 以内） */
const MAX_ANALYSES = 50;
/** 一条历史里保存的数据包快照上限（字符）；多周期 K 线全开时约 1.6 万字 */
const MAX_PACK_CHARS = 20000;
const MAX_CHATS = 20;
/** 每只基金保留多少天的份额快照（约 4 个月交易日） */
const MAX_SHARE_SNAPSHOTS = 120;
/** 组合净值快照：一天一行，400 行约一年半，够画收益曲线 */
const MAX_EQUITY_SNAPSHOTS = 400;
/** 预警触发历史：每条只有几个字段，200 条约 30KB */
const MAX_ALERT_EVENTS = 200;
/** 同一条预警两次触发之间的冷却：价格在阈值附近赖着不走时，不会每轮轮询都弹一次 */
const ALERT_REFIRE_MS = 60 * 60_000;

export const DEFAULT_SETTINGS = {
  refreshMs: 5000,      // 行情轮询间隔
  topOffset: 0,         // 状态栏额外下移像素（用于避开窗口标题栏）
  leftOffset: 10,       // 行情条距左边缘的像素（拖动把手改的就是它）
  leftPct: null,        // 拖动后的水平位置（占窗口宽度百分比）；null=用 leftOffset
  topPct: null,         // 拖动后的垂直位置（占可用高度百分比）；null=用 topOffset
  collapsed: false,     // 折叠成小胶囊
  opacity: 0.96,
  showWatch: true,      // 行情条里显示自选
  showHoldings: true,   // 行情条里显示持仓
  showIndex: true,      // 显示大盘指数
  showTotals: true,     // 行情条右侧的持仓汇总徽标
  scroll: true,         // 跑马灯滚动
  period: 'day',        // K线周期
  adjust: 'pre',        // 复权
  subIndicator: 'macd', // K线副图指标：none / macd / kdj / rsi
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
  aiDay3: false,        // AI 数据包：带 3 日 K（本地聚合）
  aiDay5: false,        // AI 数据包：带 5 日 K（本地聚合）
  aiWeek: true,         // AI 数据包：带周K
  aiMonth: false,       // AI 数据包：带月K
  aiTrend: true,        // AI 数据包：带分时
  aiTrendDays: 1,       // AI 数据包：分时天数 1..5（3/5 日分时）
  aiBook: true,         // AI 数据包：带五档盘口
  aiTrades: true,       // AI 数据包：带自己的交易流水
  aiIndex: true,        // AI 数据包：带大盘指数
  aiFlow: true,         // AI 数据包：带多日资金流
  aiHoldings: true,     // AI 数据包：带 ETF/基金持仓成分股及其资金
  aiShare: true,        // AI 数据包：带一级市场份额申赎（ETF）
  aiSector: true,       // AI 数据包：带所属板块当日涨跌（ETF 取第一大重仓股的板块）
  aiFund: true,         // AI 数据包：带个股基本面快照（PE/PB/ROE/同比，仅个股）
  aiAutoAlert: true,    // AI 给的关键价位自动设成价格预警
  aiCollapsed: false,   // AI 分析正文是否收起（只影响界面，不重新分析）
  aiChatSplit: 0.5,     // 追问对话占 AI 面板的宽度比例（0.25~0.75）
  autoTrackEnabled: true,                       // 收盘/盘中自动跟踪持仓
  autoTrackTimes: '09:35,10:30,11:30,13:35,14:30,15:05', // 自动跟踪的时间点（15:05 为收盘完整复盘，其余是简报）
  autoPlanEnabled: false,                       // 盘前计划：开盘前跑一次深度分析，关键价位自动落成预警
  autoPlanTime: '09:20',                        // 盘前计划的时间点（默认开盘前 10 分钟）
  barTransparent: true,                         // 行情条空闲时透明（false = 空闲也带面板底和边框）
  barDocked: false,                             // 停靠会话视图标签行（true = 位置固定，缩放不跑位）
};

/** 大盘指数（默认开启，作为市场温度计） */
export const DEFAULT_INDEXES = [
  { symbol: 'sh000001', code: '000001', market: 1, name: '上证指数', shares: 0, cost: 0, watch: true, index: true },
  { symbol: 'sz399001', code: '399001', market: 0, name: '深证成指', shares: 0, cost: 0, watch: true, index: true },
  { symbol: 'sz399006', code: '399006', market: 0, name: '创业板指', shares: 0, cost: 0, watch: true, index: true },
];

export function defaultStorePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-stock-bar', 'portfolio.json');
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
      onStrip: true,   // 是否钉在行情条上（false 时只在列表里，条上不显示）
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
    if (patch.onStrip !== undefined) next.onStrip = !!patch.onStrip;
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

  /**
   * 按给定 symbol 顺序重排 items（行情条拖动排序）。
   * order 里没提到的股票保持原相对顺序、排在已知 symbol 之后。
   * @param {string[]} order
   */
  async reorder(order) {
    await this.ensureLoaded();
    const rank = new Map((Array.isArray(order) ? order : []).map((s, i) => [String(s), i]));
    const n = rank.size;
    // Array.prototype.sort 是稳定排序：同 rank（都没提到）保持原相对顺序
    this.data.items.sort((a, b) => {
      const ra = rank.has(a.symbol) ? rank.get(a.symbol) : n;
      const rb = rank.has(b.symbol) ? rank.get(b.symbol) : n;
      return ra - rb;
    });
    await this.save();
    return true;
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

    // 不允许卖空：卖出股数不能超过实际持仓（流水攒下的股数 与 清单里手输/跟随流水的持股数，取大者——
    // 只记了一部分流水时，清单里的持股数才是你真正持有的）
    if (side === 'sell') {
      const held = computeRealized(this.data.trades).bySymbol.get(symbol);
      const qty = held ? held.qty : 0;
      const item = this.data.items.find((i) => i.symbol === symbol);
      const manual = item && Number(item.shares) > 0 ? Number(item.shares) : 0;
      const owned = Math.max(qty, manual);
      if (shares > owned + 1e-9) {
        throw new Error(`卖出 ${shares} 股超过 ${symbol} 的持仓 ${owned} 股（是不是漏记了买入？）`);
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
    this._applyTradeToItem(trade);
    await this.save();
    return trade;
  }

  /**
   * 记一笔流水就把清单里这只票的 持股/成本价 跟着改（券商摊薄口径的增量版）：
   * 买入 → 持股加上，成本变成新旧两批的加权均价（手续费算进买入成本）；
   * 卖出 → 持股减去，卖出那笔的盈亏摊到剩下的股上（盈利摊低成本、亏损抬高成本），
   *   全部卖完就归零持股（成本保留原值，行还在清单里，用户可自行删除）。
   * 只改清单里已有的票，不新建行；删流水/清流水不反向回滚（成本已被带走，手改即可）。
   */
  _applyTradeToItem(trade) {
    const item = this.data.items.find((i) => i.symbol === trade.symbol);
    if (!item) return;
    const held = Number(item.shares) > 0 ? Number(item.shares) : 0;
    const cost = Number(item.cost) > 0 ? Number(item.cost) : 0;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    if (trade.side === 'buy') {
      const total = held + trade.shares;
      if (!(total > 0)) return;
      item.shares = Math.round(total * 1e6) / 1e6;
      item.cost = r4((cost * held + trade.price * trade.shares + trade.fee) / total);
    } else {
      const left = held - trade.shares;
      if (left < 0) return; // 流水层已有卖空校验，这里兜底：异常就不动清单
      item.shares = Math.round(left * 1e6) / 1e6;
      if (left > 0) item.cost = r4((cost * held - trade.price * trade.shares) / left);
    }
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

  /* ---------------- AI 分析历史 ---------------- */

  get analyses() {
    return this.data.analyses;
  }

  /**
   * 存一条 AI 分析记录（只留正文，不留思考过程，省磁盘）。
   * 新记录排在最前面，超出上限的老记录直接丢弃。
   * @param {{symbol:string, name?:string, provider?:string, model?:string, style?:string,
   *          periods?:Array<{period:string,label:string}>, trendDays?:number,
   *          include?:object, chars?:number, has?:string[], text:string,
   *          usage?:object|null, elapsedMs?:number, finish?:string|null,
   *          error?:string|null, promptVersion?:string, plan?:object|null,
   *          pack?:string, alerts?:string[]}} patch
   */
  async addAnalysis(patch = {}) {
    await this.ensureLoaded();
    const text = String(patch.text || '');
    if (!text.trim()) throw new Error('分析正文为空，不保存');
    const symbol = String(patch.symbol || '').trim();
    if (!symbol) throw new Error('缺少 symbol');
    const rec = {
      id: patch.id ? String(patch.id) : newId('a'),
      at: Number(patch.at) || Date.now(),
      symbol,
      name: patch.name ? String(patch.name) : symbol,
      provider: patch.provider ? String(patch.provider) : '',
      model: patch.model ? String(patch.model) : '',
      style: patch.style === 'detail' ? 'detail' : 'short',
      kind: patch.kind === 'auto' ? 'auto' : 'manual',
      trigger: patch.trigger ? String(patch.trigger).slice(0, 20) : 'manual',
      periods: Array.isArray(patch.periods)
        ? patch.periods.map((p) => ({
          period: String((p && p.period) || ''),
          label: String((p && p.label) || ''),
        })).filter((p) => p.period)
        : [],
      trendDays: Number(patch.trendDays) || 1,
      include: patch.include && typeof patch.include === 'object' ? { ...patch.include } : {},
      chars: Number(patch.chars) || text.length,
      has: Array.isArray(patch.has) ? patch.has.map((x) => String(x)) : [],
      text,
      usage: patch.usage && typeof patch.usage === 'object' ? { ...patch.usage } : null,
      elapsedMs: Number(patch.elapsedMs) || 0,
      finish: patch.finish ? String(patch.finish) : 'stop',
      error: patch.error ? String(patch.error) : null,
      promptVersion: patch.promptVersion ? String(patch.promptVersion) : '',
      plan: normalizePlan(patch.plan),
      pack: patch.pack ? String(patch.pack).slice(0, MAX_PACK_CHARS) : '',
      alerts: Array.isArray(patch.alerts) ? patch.alerts.map((x) => String(x)) : [],
      chats: normalizeChats(patch.chats),
    };
    this.data.analyses = [rec, ...(this.data.analyses || [])].slice(0, MAX_ANALYSES);
    await this.save();
    return rec;
  }

  /** 列表只回摘要，不带全文，避免 /ai/history 一次吐几百 KB */
  listAnalyses(limit = 30) {
    const n = Math.min(MAX_ANALYSES, Math.max(1, Number(limit) || 30));
    return (this.data.analyses || []).slice(0, n).map((r) => ({
      id: r.id,
      at: r.at,
      symbol: r.symbol,
      name: r.name,
      provider: r.provider,
      model: r.model,
      style: r.style,
      kind: r.kind === 'auto' ? 'auto' : 'manual',
      trigger: r.trigger || 'manual',
      periods: r.periods,
      trendDays: r.trendDays,
      chars: r.chars,
      has: r.has,
      usage: r.usage,
      elapsedMs: r.elapsedMs,
      finish: r.finish,
      error: r.error,
      promptVersion: r.promptVersion,
      stance: r.plan ? r.plan.stance : '',
      confidence: r.plan ? r.plan.confidence : null,
      action: r.plan ? r.plan.action : '',
      alertCount: Array.isArray(r.alerts) ? r.alerts.length : 0,
      chatCount: Array.isArray(r.chats) ? Math.ceil(r.chats.length / 2) : 0,
      snippet: String(r.text || '').replace(/\s+/g, ' ').slice(0, 140),
    }));
  }

  getAnalysis(id) {
    const hit = (this.data.analyses || []).find((r) => r.id === String(id));
    return hit ? { ...hit } : null;
  }

  /**
   * 往一条分析记录里追加一轮追问（用户问题 + 模型回答）。
   * @param {string} id 分析记录 id
   * @param {{question:string, answer:string, quote?:string, model?:string}} chat
   * @returns {Promise<{ok:boolean, chats?:number, error?:string}>}
   */
  async appendChat(id, chat = {}) {
    await this.ensureLoaded();
    const rec = (this.data.analyses || []).find((r) => r.id === String(id));
    if (!rec) return { ok: false, error: '这条分析记录不存在或已被删除' };
    const question = String(chat.question || '').trim();
    const answer = String(chat.answer || '').trim();
    if (!question || !answer) return { ok: false, error: '问题和回答都不能为空' };
    const quote = chat.quote ? String(chat.quote).slice(0, 1200) : '';
    const model = chat.model ? String(chat.model) : '';
    rec.chats = normalizeChats([
      ...(Array.isArray(rec.chats) ? rec.chats : []),
      { role: 'user', content: question, quote, at: Date.now(), model },
      { role: 'assistant', content: answer, quote, at: Date.now(), model },
    ]);
    await this.save();
    return { ok: true, chats: rec.chats.length };
  }

  async removeAnalysis(id) {
    await this.ensureLoaded();
    const before = (this.data.analyses || []).length;
    this.data.analyses = (this.data.analyses || []).filter((r) => r.id !== String(id));
    const removed = before !== this.data.analyses.length;
    if (removed) await this.save();
    return removed;
  }

  async clearAnalyses() {
    await this.ensureLoaded();
    const n = (this.data.analyses || []).length;
    if (n) {
      this.data.analyses = [];
      await this.save();
    }
    return n;
  }

  /**
   * 记录一次基金份额快照（同一天多次只保留最后一笔），用于累积出份额变化序列。
   * @param {string} code 6 位代码
   * @param {number} shares 总份额（份）
   * @param {string} [date] YYYY-MM-DD，缺省今天（北京时间）
   * @returns {Promise<{ok:boolean, days?:number}>}
   */
  async recordShareSnapshot(code, shares, date) {
    await this.ensureLoaded();
    const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
    const n = Number(shares);
    if (!clean || !Number.isFinite(n) || n <= 0) return { ok: false };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
      ? String(date)
      : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (!this.data.shareSnapshots || typeof this.data.shareSnapshots !== 'object') {
      this.data.shareSnapshots = {};
    }
    const list = Array.isArray(this.data.shareSnapshots[clean]) ? this.data.shareSnapshots[clean] : [];
    const kept = list.filter((s) => s && s.date !== day);
    kept.push({ date: day, shares: n });
    kept.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    this.data.shareSnapshots[clean] = kept.slice(-MAX_SHARE_SNAPSHOTS);
    await this.save();
    return { ok: true, days: this.data.shareSnapshots[clean].length };
  }

  /** 取某只基金的份额快照序列（升序） */
  getShareSnapshots(code) {
    const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
    const list = (this.data.shareSnapshots && this.data.shareSnapshots[clean]) || [];
    return Array.isArray(list) ? list.map((s) => ({ ...s })) : [];
  }

  /* ---------------- 净值快照（收益曲线） ---------------- */

  /**
   * 记一天的组合净值。同一天重复调用只更新当天那一行（当天最后一次写入即收盘值）。
   * @param {{date?:string, marketValue:number, costValue:number, pnl:number,
   *          pnlPct:number, dayPnl:number, positions?:number}} entry
   */
  async recordEquitySnapshot(entry = {}) {
    await this.ensureLoaded();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || ''))
      ? String(entry.date)
      : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const marketValue = num(entry.marketValue);
    const costValue = num(entry.costValue);
    // 没有持仓（市值和成本都是 0）就不记，避免空仓时曲线掉到 0
    if (!(marketValue > 0) && !(costValue > 0)) return null;
    const pnl = Number.isFinite(Number(entry.pnl)) ? Number(entry.pnl) : marketValue - costValue;
    const pnlPct = Number.isFinite(Number(entry.pnlPct))
      ? Number(entry.pnlPct)
      : (costValue > 0 ? (pnl / costValue) * 100 : 0);
    const row = {
      date: day,
      at: num(entry.at, Date.now()),
      marketValue: round2(marketValue),
      costValue: round2(costValue),
      pnl: round2(pnl),
      pnlPct: round2(pnlPct),
      dayPnl: round2(num(entry.dayPnl)),
      positions: Math.max(0, Math.round(num(entry.positions))),
    };
    if (!this.data.equitySnapshots || !Array.isArray(this.data.equitySnapshots)) {
      this.data.equitySnapshots = [];
    }
    const kept = this.data.equitySnapshots.filter((s) => s && s.date !== day);
    kept.push(row);
    kept.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    this.data.equitySnapshots = kept.slice(-MAX_EQUITY_SNAPSHOTS);
    await this.save();
    return { ...row };
  }

  /** 取最近 N 天净值（升序，最老的在前面） */
  async listEquitySnapshots(limit = 120) {
    await this.ensureLoaded();
    const n = Math.min(MAX_EQUITY_SNAPSHOTS, Math.max(1, Math.round(Number(limit) || 120)));
    const list = Array.isArray(this.data.equitySnapshots) ? this.data.equitySnapshots : [];
    return list.slice(-n).map((s) => ({ ...s }));
  }

  /** 清空净值快照，返回清掉的条数 */
  async clearEquitySnapshots() {
    await this.ensureLoaded();
    const n = Array.isArray(this.data.equitySnapshots) ? this.data.equitySnapshots.length : 0;
    this.data.equitySnapshots = [];
    await this.save();
    return n;
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
        advice: patch.advice ? String(patch.advice).slice(0, 80) : '',
        firedAt: null,
        lastFiredAt: null,
        createdAt: Date.now(),
      };
      // 去重：同一标的 + 同类型 + 同方向，阈值只差一点点的算同一条——
      // 更新原预警而不是再堆一条。AI 计划每次跑出来的价位都会挪一点，
      // 不 dedupe 的话预警列表会越积越多（用户反馈的「重复预警」）。
      const eps = alert.kind === 'pct' ? 0.3 : Math.max(Math.abs(value) * 0.005, 0.001);
      const dup = this.data.alerts.find((a) => a.symbol === symbol && a.kind === alert.kind
        && a.op === alert.op && Math.abs(Number(a.value) - value) <= eps);
      if (dup) {
        dup.value = value;
        if (patch.note) dup.note = String(patch.note).slice(0, 80);
        if (patch.advice) dup.advice = String(patch.advice).slice(0, 80);
        dup.enabled = patch.enabled !== false;
        dup.firedAt = null;
        await this.save();
        return dup;
      }
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
    if (patch.advice !== undefined) next.advice = String(patch.advice).slice(0, 80);
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
      const quote = lookup(a.symbol);
      const { hit, current } = evalAlert(a, quote);

      if (hit && !a.firedAt) {
        const now = Date.now();
        // 同一条预警两次触发至少隔 ALERT_REFIRE_MS：价格在阈值附近赖着不走时，
        // 不至于每轮轮询都弹一次（冷却里不武装、不记录，等冷却过了仍 hit 再报一次）。
        if (!(a.lastFiredAt && now - a.lastFiredAt < ALERT_REFIRE_MS)) {
          a.firedAt = now;
          a.lastFiredAt = now;
          dirty = true;
          const event = {
            ...a,
            current,
            hit: true,
            volRatio: quote && quote.volRatio != null ? Number(quote.volRatio) : null,
          };
          fired.push(event);
          this.pendingFired.push(event);
          // 触发历史：只留能看懂的几个字段，落盘后重启也还在
          this.data.alertEvents ||= [];
          this.data.alertEvents.push({
            id: `${a.id}-${a.firedAt}`,
            alertId: a.id,
            symbol: a.symbol,
            code: a.code || String(a.symbol || '').replace(/^[a-z]+/, ''),
            name: a.name || a.symbol,
            kind: a.kind === 'pct' ? 'pct' : 'price',
            op: a.op === '<=' ? '<=' : '>=',
            value: Number(a.value),
            current: current != null && Number.isFinite(current) ? current : null,
            volRatio: quote && quote.volRatio != null ? Number(quote.volRatio) : null,
            note: a.note ? String(a.note).slice(0, 80) : '',
            at: a.firedAt,
          });
          if (this.data.alertEvents.length > MAX_ALERT_EVENTS) {
            this.data.alertEvents = this.data.alertEvents.slice(-MAX_ALERT_EVENTS);
          }
        }
      } else if (!hit && (a.firedAt != null || a.lastFiredAt != null)) {
        // 防抖：价格只在阈值附近来回穿时，不重新武装。
        // 价格预警必须离开阈值 0.5%（<= 预警要回到 value*1.005 上方）才清零；
        // 涨跌幅预警的「0.5% 相对值」太小（-3% 预警只隔 0.015 个百分点就重新武装，
        // 等于天天弹），改成绝对 0.3 个百分点。
        const v = Number(a.value);
        const back = current != null && Number.isFinite(current) && Number.isFinite(v)
          ? (a.kind === 'pct'
            ? (a.op === '<=' ? current >= v + 0.3 : current <= v - 0.3)
            : (a.op === '<=' ? current >= v * 1.005 : current <= v * 0.995))
          : true;
        if (back) {
          a.firedAt = null;
          // 真的离开了阈值：连冷却一起清掉，下一次穿越算是新事件，立刻可报
          a.lastFiredAt = null;
          dirty = true;
        }
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

  /** 预警触发历史，最新在前 */
  async listAlertEvents(limit = 50) {
    await this.ensureLoaded();
    const all = Array.isArray(this.data.alertEvents) ? this.data.alertEvents : [];
    const n = Math.max(0, Math.trunc(Number(limit) || 0)) || 50;
    return all.slice(-n).reverse();
  }

  async clearAlertEvents() {
    await this.ensureLoaded();
    const n = Array.isArray(this.data.alertEvents) ? this.data.alertEvents.length : 0;
    this.data.alertEvents = [];
    await this.save();
    return n;
  }

  /**
   * 「按流水同步持仓」：把每只票的流水按日期整本重放一遍（与记一笔时用的
   * _applyTradeToItem 完全同一套增量算法），把结果写回 items 的股数/成本价。
   * 重放里遇到「卖出超过流水攒下的股数」就跳过那笔（流水没记全的票不会算出负数）。
   */
  async applyDerivedPositions() {
    await this.ensureLoaded();
    const bySym = new Map();
    for (const t of this.data.trades) {
      let st = bySym.get(t.symbol);
      if (!st) {
        st = { shares: 0, cost: 0, code: t.code, market: t.market, name: t.name, count: 0 };
        bySym.set(t.symbol, st);
      }
      const held = st.shares;
      if (t.side === 'buy') {
        const total = held + t.shares;
        if (total > 0) {
          st.shares = total;
          st.cost = (st.cost * held + t.price * t.shares + t.fee) / total;
        }
      } else {
        const left = held - t.shares;
        if (left >= 0) {
          st.shares = left;
          if (left > 0) st.cost = (st.cost * held - t.price * t.shares) / left;
        }
      }
      if (t.shares > 0) st.count++;
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    let changed = 0;
    for (const [symbol, st] of bySym) {
      const shares = Math.round(st.shares * 1e6) / 1e6;
      const cost = st.shares > 0 ? r4(st.cost) : 0;
      if (shares <= 0 && st.count === 0) continue;
      let item = this.data.items.find((it) => it.symbol === symbol);
      if (!item) {
        // 只记了流水、没加过自选的标的，同步时补进持仓列表（已清仓的不补）
        if (!(shares > 0)) continue;
        const created = {
          symbol,
          code: st.code || symbol.replace(/^[a-z]+/, ''),
          market: st.market ?? null,
          name: st.name || symbol,
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
    return { changed };
  }
}

/* ------------------------------------------------------------------ */

function emptyData() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    items: [],
    trades: [],
    alerts: [],
    alertEvents: [],
    analyses: [],
    shareSnapshots: {},
    equitySnapshots: [],
  };
}

let idSeq = 0;
function newId(prefix) {
  idSeq = (idSeq + 1) % 100000;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`;
}

/** 归一化模型给的结构化计划，落盘前把关（宁缺毋滥，坏字段直接丢） */
function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const levels = [];
  for (const lv of Array.isArray(raw.levels) ? raw.levels : []) {
    const price = Number(lv && lv.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    levels.push({
      label: String((lv && lv.label) || '价位').slice(0, 8),
      price,
      op: lv && lv.op === '>=' ? '>=' : '<=',
    });
    if (levels.length >= 6) break;
  }
  const stance = raw.stance ? String(raw.stance).trim().slice(0, 12) : '';
  if (!stance && !levels.length) return null;
  const conf = Number(raw.confidence);
  const pos = Number(raw.positionPct);
  return {
    stance,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : null,
    action: raw.action ? String(raw.action).trim().slice(0, 20) : '',
    positionPct: Number.isFinite(pos) ? Math.max(0, Math.min(100, Math.round(pos))) : null,
    levels,
  };
}

/** 归一化「追问对话」：只保留 user/assistant 两种角色，单条与总条数都封顶 */
function normalizeChats(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const role = c.role === 'assistant' ? 'assistant' : c.role === 'user' ? 'user' : '';
    if (!role) continue;
    const content = c.content ? String(c.content).slice(0, 4000) : '';
    if (!content.trim()) continue;
    out.push({
      role,
      content,
      quote: c.quote ? String(c.quote).slice(0, 1200) : '',
      at: Number(c.at) || Date.now(),
      model: c.model ? String(c.model) : '',
    });
  }
  return out.slice(-MAX_CHATS);
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
    // 上界 0：行情条不许进窗口标题栏 —— 那里是原生拖窗区，
    // 指针进去就收不到 pointerup，会像「鼠标失控」一样卡在拖动态
    case 'topOffset': return Math.min(400, Math.max(0, Number(value) || 0));
    case 'leftOffset': return Math.min(4000, Math.max(0, Number(value) || 0));
    // 百分比位置：null 表示「没设过/已切回像素模式」，其余夹在 0–100
    case 'leftPct':
    case 'topPct':
      if (value === null || value === undefined || value === '') return null;
      return Math.min(100, Math.max(0, Number(value) || 0));
    case 'opacity': return Math.min(1, Math.max(0.3, Number(value) || DEFAULT_SETTINGS.opacity));
    case 'klineCount': return Math.min(800, Math.max(30, Number(value) || DEFAULT_SETTINGS.klineCount));
    case 'trendDays': return Math.min(5, Math.max(1, Math.round(Number(value) || DEFAULT_SETTINGS.trendDays)));
    case 'aiTrendDays': return Math.min(5, Math.max(1, Math.round(Number(value) || DEFAULT_SETTINGS.aiTrendDays)));
    case 'aiChatSplit': return Math.min(0.75, Math.max(0.25, Number(value) || DEFAULT_SETTINGS.aiChatSplit));
    case 'chart': return ['trend', 'kline'].includes(value) ? value : 'trend';
    case 'period': return ['1m', '5m', '15m', '30m', '60m', 'day', 'week', 'month'].includes(value) ? value : 'day';
    case 'adjust': return ['none', 'pre', 'post'].includes(value) ? value : 'pre';
    case 'subIndicator': return ['none', 'macd', 'kdj', 'rsi'].includes(value) ? value : 'macd';
    case 'aiStyle': return value === 'detail' ? 'detail' : 'short';
    case 'aiProvider': return String(value == null ? '' : value).slice(0, 80);
    case 'aiModel': return String(value == null ? '' : value).slice(0, 120);
    case 'autoTrackTimes': {
      const list = String(value == null ? '' : value)
        .split(/[,，;；\s]+/)
        .map((x) => x.trim())
        .filter((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x));
      const uniq = [...new Set(list)].sort();
      if (!uniq.length) return DEFAULT_SETTINGS.autoTrackTimes;
      return uniq.join(',');
    }
    case 'autoPlanTime': {
      const v = String(value == null ? '' : value).trim();
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : DEFAULT_SETTINGS.autoPlanTime;
    }
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
      onStrip: raw.onStrip !== false,
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
      advice: raw.advice ? String(raw.advice).slice(0, 80) : '',
      firedAt: raw.firedAt ? Number(raw.firedAt) : null,
      lastFiredAt: raw.lastFiredAt ? Number(raw.lastFiredAt) : null,
      createdAt: raw.createdAt ? Number(raw.createdAt) : Date.now(),
    });
  }

  // 触发历史：只认字段齐的，时间按升序存（展示时再倒过来）
  const events = Array.isArray(parsed.alertEvents) ? parsed.alertEvents : [];
  for (const raw of events) {
    if (!raw || typeof raw !== 'object' || !raw.symbol) continue;
    const at = Number(raw.at);
    const value = Number(raw.value);
    if (!Number.isFinite(at) || !Number.isFinite(value)) continue;
    out.alertEvents.push({
      id: raw.id ? String(raw.id) : `${raw.symbol}-${at}`,
      alertId: raw.alertId ? String(raw.alertId) : '',
      symbol: String(raw.symbol),
      code: String(raw.code || String(raw.symbol).replace(/^[a-z]+/, '')),
      name: raw.name ? String(raw.name) : String(raw.symbol),
      kind: raw.kind === 'pct' ? 'pct' : 'price',
      op: raw.op === '<=' ? '<=' : '>=',
      value,
      current: Number.isFinite(Number(raw.current)) ? Number(raw.current) : null,
      volRatio: Number.isFinite(Number(raw.volRatio)) ? Number(raw.volRatio) : null,
      note: raw.note ? String(raw.note).slice(0, 80) : '',
      at,
    });
  }
  out.alertEvents.sort((a, b) => a.at - b.at);
  out.alertEvents = out.alertEvents.slice(-MAX_ALERT_EVENTS);

  const analyses = Array.isArray(parsed.analyses) ? parsed.analyses : [];
  const seenAnalysis = new Set();
  for (const raw of analyses) {
    if (!raw || typeof raw !== 'object' || !raw.symbol || !raw.text) continue;
    const id = raw.id ? String(raw.id) : newId('a');
    if (seenAnalysis.has(id)) continue;
    seenAnalysis.add(id);
    out.analyses.push({
      id,
      at: raw.at ? Number(raw.at) : Date.now(),
      symbol: String(raw.symbol),
      name: raw.name ? String(raw.name) : String(raw.symbol),
      provider: raw.provider ? String(raw.provider) : '',
      model: raw.model ? String(raw.model) : '',
      style: raw.style === 'detail' ? 'detail' : 'short',
      kind: raw.kind === 'auto' ? 'auto' : 'manual',
      trigger: raw.trigger ? String(raw.trigger).slice(0, 20) : 'manual',
      periods: Array.isArray(raw.periods)
        ? raw.periods.map((p) => ({
          period: String((p && p.period) || ''),
          label: String((p && p.label) || ''),
        })).filter((p) => p.period)
        : [],
      trendDays: Math.min(5, Math.max(1, Number(raw.trendDays) || 1)),
      include: raw.include && typeof raw.include === 'object' ? { ...raw.include } : {},
      chars: Number(raw.chars) || String(raw.text).length,
      has: Array.isArray(raw.has) ? raw.has.map((x) => String(x)) : [],
      text: String(raw.text),
      usage: raw.usage && typeof raw.usage === 'object' ? { ...raw.usage } : null,
      elapsedMs: Number(raw.elapsedMs) || 0,
      finish: raw.finish ? String(raw.finish) : 'stop',
      error: raw.error ? String(raw.error) : null,
      promptVersion: raw.promptVersion ? String(raw.promptVersion) : '',
      plan: normalizePlan(raw.plan),
      pack: raw.pack ? String(raw.pack).slice(0, MAX_PACK_CHARS) : '',
      alerts: Array.isArray(raw.alerts) ? raw.alerts.map((x) => String(x)) : [],
      chats: normalizeChats(raw.chats),
    });
  }
  out.analyses.sort((a, b) => b.at - a.at);
  out.analyses = out.analyses.slice(0, MAX_ANALYSES);

  // 基金份额快照：{ '515050': [{date, shares}] }，只认合法日期与正数份额
  const snaps = parsed.shareSnapshots;
  if (snaps && typeof snaps === 'object') {
    for (const [code, list] of Object.entries(snaps)) {
      const clean = String(code).replace(/\D/g, '').slice(0, 6);
      if (!clean || !Array.isArray(list)) continue;
      const seen = new Set();
      const rows = [];
      for (const s of list) {
        if (!s || typeof s !== 'object') continue;
        const date = String(s.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
        const shares = Number(s.shares);
        if (!Number.isFinite(shares) || shares <= 0) continue;
        seen.add(date);
        rows.push({ date, shares });
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      if (rows.length) out.shareSnapshots[clean] = rows.slice(-MAX_SHARE_SNAPSHOTS);
    }
  }

  // 组合净值快照：[{date, at, marketValue, costValue, pnl, pnlPct, dayPnl, positions}]
  const equity = Array.isArray(parsed.equitySnapshots) ? parsed.equitySnapshots : [];
  {
    const seen = new Set();
    const rows = [];
    for (const s of equity) {
      if (!s || typeof s !== 'object') continue;
      const date = String(s.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
      const marketValue = Number(s.marketValue);
      const costValue = Number(s.costValue);
      if (!Number.isFinite(marketValue) || !Number.isFinite(costValue)) continue;
      if (marketValue <= 0 && costValue <= 0) continue;
      seen.add(date);
      rows.push({
        date,
        at: Number.isFinite(Number(s.at)) ? Number(s.at) : 0,
        marketValue,
        costValue,
        pnl: Number.isFinite(Number(s.pnl)) ? Number(s.pnl) : marketValue - costValue,
        pnlPct: Number.isFinite(Number(s.pnlPct)) ? Number(s.pnlPct) : 0,
        dayPnl: Number.isFinite(Number(s.dayPnl)) ? Number(s.dayPnl) : 0,
        positions: Math.max(0, Math.round(Number(s.positions) || 0)),
      });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    out.equitySnapshots = rows.slice(-MAX_EQUITY_SNAPSHOTS);
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
