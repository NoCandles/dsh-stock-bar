/**
 * 把「一只股票的全部已知信息」压成一段紧凑的中文数据包，再拼成给模型的消息。
 *
 * 为什么要单独一个文件：
 *  - 传输层（怎么调模型）和「喂什么数据」是两件事，分开才能各自单测；
 *  - 模型看不到图，只能看数字，所以指标必须在宿主侧算好、算对，
 *    否则模型会自己"心算"均线，算出来的支撑位就是编的。
 *
 * 纯函数、无依赖、无 IO。所有金额单位：元；成交量单位：手（1 手 = 100 股）。
 */

export const PROMPT_VERSION = 'stock-analysis-v1';

/** 默认给模型的日K根数：60 根够看出趋势和形态，又不至于把上下文撑爆 */
export const DEFAULT_KLINE_BARS = 60;
/** 分时摘要的采样点数（按等间隔抽，不送 241 个点） */
export const TREND_SAMPLE = 8;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fx = (v, d = 2) => (num(v) === null ? '--' : num(v).toFixed(d));
const pct = (v) => (num(v) === null ? '--' : `${num(v) > 0 ? '+' : ''}${num(v).toFixed(2)}%`);

/** 简单移动平均：数据不足返回 null（不要用不足的窗口硬算） */
export function sma(values, n) {
  if (!Array.isArray(values) || values.length < n || n <= 0) return null;
  const slice = values.slice(-n);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / n;
}

/** 序列的百分比变化（首 -> 末） */
export function changePctOf(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (!first) return null;
  return ((last - first) / first) * 100;
}

/** 标准差（总体），用于波动率 */
export function stdev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

/**
 * 日K派生指标。返回的每个数字都会原样进 prompt，所以宁可返回 null 也不要瞎算。
 */
export function summarizeCandles(candles, { maPeriods = [5, 10, 20, 60] } = {}) {
  const list = (Array.isArray(candles) ? candles : []).filter((c) => c && num(c.close) !== null);
  if (list.length === 0) return null;
  const closes = list.map((c) => c.close);
  const highs = list.map((c) => (num(c.high) === null ? c.close : c.high));
  const lows = list.map((c) => (num(c.low) === null ? c.close : c.low));
  const vols = list.map((c) => (num(c.volume) === null ? 0 : c.volume));
  const last = list[list.length - 1];

  const ma = {};
  for (const p of maPeriods) ma[p] = sma(closes, p);

  const win = (arr, n) => (arr.length >= n ? arr.slice(-n) : arr.slice());
  const hi20 = Math.max(...win(highs, 20));
  const lo20 = Math.min(...win(lows, 20));
  const hi60 = Math.max(...win(highs, 60));
  const lo60 = Math.min(...win(lows, 60));

  // 真实波幅（ATR14）：用高开低收算，比收盘价标准差更贴近止损位的量级
  const trs = [];
  for (let i = 1; i < list.length; i++) {
    const h = highs[i];
    const l = lows[i];
    const pc = closes[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr14 = sma(trs, 14);

  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const vol20 = stdev(win(rets, 20).map((r) => r * 100));

  const v5 = sma(vols, 5);
  const v20 = sma(vols, 20);

  return {
    bars: list.length,
    firstDate: list[0].date || null,
    lastDate: last.date || null,
    ma,
    hi20,
    lo20,
    hi60,
    lo60,
    fromHi20Pct: hi20 ? ((last.close - hi20) / hi20) * 100 : null,
    fromLo20Pct: lo20 ? ((last.close - lo20) / lo20) * 100 : null,
    chg5: changePctOf(closes.slice(-6)),
    chg20: changePctOf(closes.slice(-21)),
    chg60: changePctOf(closes.slice(-61)),
    atr14,
    atr14Pct: atr14 && last.close ? (atr14 / last.close) * 100 : null,
    vol20Pct: vol20,
    vol5: v5,
    vol20: v20,
    volRatio: v5 && v20 ? v5 / v20 : null,
    posIn20:
      hi20 && lo20 && hi20 > lo20
        ? Math.max(0, Math.min(100, Math.round(((last.close - lo20) / (hi20 - lo20)) * 100)))
        : null,
  };
}

/** 把日K压成 CSV 行；只保留最后 max 根，且第一行带表头方便模型对齐列 */
export function condenseCandles(candles, max = DEFAULT_KLINE_BARS) {
  const list = (Array.isArray(candles) ? candles : []).filter((c) => c && c.date && num(c.close) !== null);
  if (list.length === 0) return '';
  const picked = list.slice(-max);
  const rows = picked.map((c) =>
    [
      String(c.date).slice(5),
      fx(c.open),
      fx(c.high),
      fx(c.low),
      fx(c.close),
      num(c.volume) === null ? '--' : String(Math.round(c.volume)),
    ].join(','),
  );
  return ['日期,开,高,低,收,量(手)', ...rows].join('\n');
}

/** 分时摘要：不送 241 个点，只送关键值 + 等间隔采样，外加"在均价线上方的时间占比" */
export function summarizeTrends(trends) {
  const pts = (trends && Array.isArray(trends.points) ? trends.points : []).filter((p) => num(p.price) !== null);
  if (pts.length === 0) return null;
  const prevClose = num(trends.prevClose);
  const prices = pts.map((p) => p.price);
  const last = prices[prices.length - 1];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const avgPts = pts.filter((p) => num(p.avg) !== null);
  const above = avgPts.filter((p) => p.price >= p.avg).length;
  const step = Math.max(1, Math.floor(pts.length / TREND_SAMPLE));
  const sample = [];
  for (let i = 0; i < pts.length; i += step) sample.push(`${String(pts[i].time).slice(-5)}=${fx(pts[i].price)}`);
  return {
    days: trends.days || 1,
    points: pts.length,
    prevClose,
    open: num(pts[0].open) !== null ? pts[0].open : pts[0].price,
    high,
    low,
    last,
    avg: avgPts.length ? avgPts[avgPts.length - 1].avg : null,
    highPct: prevClose ? ((high - prevClose) / prevClose) * 100 : null,
    lowPct: prevClose ? ((low - prevClose) / prevClose) * 100 : null,
    lastPct: prevClose ? ((last - prevClose) / prevClose) * 100 : null,
    aboveAvgRatio: avgPts.length ? (above / avgPts.length) * 100 : null,
    sample,
  };
}

/** 五档摘要：买卖各五档 + 委比 */
export function summarizeBook(book) {
  if (!book || (!Array.isArray(book.bids) && !Array.isArray(book.asks))) return null;
  const bids = (book.bids || []).slice(0, 5);
  const asks = (book.asks || []).slice(0, 5);
  const bv = bids.reduce((a, b) => a + (num(b.volume) || 0), 0);
  const av = asks.reduce((a, b) => a + (num(b.volume) || 0), 0);
  const fmt = (arr, label) =>
    arr.map((r, i) => `${label}${i + 1} ${fx(r.price)}×${Math.round(num(r.volume) || 0)}手`).join('  ');
  return {
    price: num(book.price),
    askText: fmt(asks, '卖'),
    bidText: fmt(bids, '买'),
    bidVolume: bv,
    askVolume: av,
    imbalancePct: bv + av > 0 ? ((bv - av) / (bv + av)) * 100 : null,
    commissionRatio: num(book.commissionRatio),
  };
}

/**
 * 流水摘要：已实现盈亏按加权平均（和 store.js 的 computeRealized 同一套口径）。
 * 这里只做展示用摘要，真正的账本仍然在 store.js —— 不复算，只引用。
 */
export function summarizeTrades(trades, symbol) {
  const list = (Array.isArray(trades) ? trades : []).filter((t) => t && t.symbol === symbol);
  if (list.length === 0) return null;
  const sorted = list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const buys = sorted.filter((t) => t.side === 'buy');
  const sells = sorted.filter((t) => t.side === 'sell');
  const buyShares = buys.reduce((a, t) => a + (num(t.shares) || 0), 0);
  const buyAmount = buys.reduce((a, t) => a + (num(t.price) || 0) * (num(t.shares) || 0), 0);
  const sellShares = sells.reduce((a, t) => a + (num(t.shares) || 0), 0);
  const sellAmount = sells.reduce((a, t) => a + (num(t.price) || 0) * (num(t.shares) || 0), 0);
  const recent = sorted.slice(-6).map((t) => `${t.date} ${t.side === 'buy' ? '买' : '卖'} ${fx(t.price)}×${t.shares}`);
  return {
    count: sorted.length,
    firstDate: sorted[0].date,
    lastDate: sorted[sorted.length - 1].date,
    buyShares,
    sellShares,
    avgBuy: buyShares ? buyAmount / buyShares : null,
    avgSell: sellShares ? sellAmount / sellShares : null,
    openShares: buyShares - sellShares,
    recent,
  };
}

/**
 * 组装数据包。owner 决定建议的口径：
 *  - 有持仓 -> 要给仓位动作（持有/减/加/清）和金额化的风险
 *  - 无持仓 -> 只给观察口径，不能凭空建议买入
 */
export function buildDataPack({
  symbol,
  name,
  code,
  quote = null,
  candleSummary = null,
  candleText = '',
  periodLabel = '日K',
  trendSummary = null,
  bookSummary = null,
  tradeSummary = null,
  market = null,
  position = null,
  alerts = [],
  indexes = [],
  asOf = new Date(),
} = {}) {
  const L = [];
  const meta = { chars: 0, has: [] };
  const has = (k, v) => { if (v) meta.has.push(k); };

  L.push('【标的】');
  L.push(`${name || ''}(${code || ''})  行情源:${(quote && quote.provider) || '未知'}`);
  if (quote) {
    L.push('【最新行情】');
    L.push(
      `现价 ${fx(quote.price)}  涨跌 ${fx(quote.change)} (${pct(quote.changePct)})  昨收 ${fx(quote.prevClose)}`,
    );
    L.push(
      `今开 ${fx(quote.open)}  最高 ${fx(quote.high)}  最低 ${fx(quote.low)}  ` +
        `振幅 ${fx(quote.amplitude)}%`,
    );
    L.push(
      `成交量 ${num(quote.volume) === null ? '--' : Math.round(quote.volume)}手  ` +
        `成交额 ${num(quote.amount) === null ? '--' : (quote.amount / 1e8).toFixed(2) + '亿'}  ` +
        `换手 ${fx(quote.turnover)}%  量比 ${fx(quote.volRatio)}`,
    );
    const fund = [];
    if (num(quote.pe) !== null) fund.push(`市盈率 ${fx(quote.pe)}`);
    if (num(quote.pb) !== null) fund.push(`市净率 ${fx(quote.pb)}`);
    if (num(quote.marketCap) !== null) fund.push(`总市值 ${(quote.marketCap / 1e8).toFixed(0)}亿`);
    if (num(quote.floatCap) !== null) fund.push(`流通市值 ${(quote.floatCap / 1e8).toFixed(0)}亿`);
    if (fund.length) L.push(fund.join('  '));
    if (num(quote.mainInflow) !== null) {
      L.push(`主力净流入 ${(quote.mainInflow / 1e4).toFixed(0)}万`);
    }
    has('行情', true);
  } else {
    L.push('【最新行情】取不到（可能已停牌或代码有误）');
  }

  if (indexes && indexes.length) {
    L.push('【大盘环境】');
    L.push(indexes.map((i) => `${i.name} ${fx(i.price)} ${pct(i.changePct)}`).join('  '));
    has('大盘', true);
  }

  if (candleSummary) {
    const s = candleSummary;
    const maText = Object.keys(s.ma)
      .filter((k) => num(s.ma[k]) !== null)
      .map((k) => `MA${k}=${fx(s.ma[k])}`)
      .join('  ');
    L.push(`【日K指标】最近 ${s.bars} 根（${s.firstDate} ~ ${s.lastDate}）`);
    if (maText) L.push(maText);
    L.push(
      `20日高 ${fx(s.hi20)} / 低 ${fx(s.lo20)}（现价距高点 ${pct(s.fromHi20Pct)}、距低点 ${pct(s.fromLo20Pct)}，` +
        `位于区间 ${s.posIn20 === null ? '--' : s.posIn20 + '%'} 分位）`,
    );
    L.push(`60日高 ${fx(s.hi60)} / 低 ${fx(s.lo60)}`);
    L.push(
      `近5日 ${pct(s.chg5)}  近20日 ${pct(s.chg20)}  近60日 ${pct(s.chg60)}  ` +
        `ATR14 ${fx(s.atr14)}(${fx(s.atr14Pct)}%)  20日波动率 ${fx(s.vol20Pct)}%`,
    );
    if (num(s.volRatio) !== null) L.push(`5日均量/20日均量 = ${fx(s.volRatio)}`);
    has(periodLabel, true);
  }
  if (candleText) {
    L.push(`【${periodLabel}数据（最后${DEFAULT_KLINE_BARS}根，量单位手）】`);
    L.push(candleText);
    has('K线明细', true);
  }

  if (trendSummary) {
    const t = trendSummary;
    L.push(`【分时】${t.days}日 采样${t.points}点`);
    L.push(
      `开 ${fx(t.open)}  高 ${fx(t.high)}(${pct(t.highPct)})  低 ${fx(t.low)}(${pct(t.lowPct)})  ` +
        `现 ${fx(t.last)}(${pct(t.lastPct)})  均价 ${fx(t.avg)}`,
    );
    if (num(t.aboveAvgRatio) !== null) {
      L.push(`价格在均价线上方的时间占比 ${t.aboveAvgRatio.toFixed(0)}%`);
    }
    if (t.sample.length) L.push(`分时采样 ${t.sample.join(' ')}`);
    has('分时', true);
  }

  if (bookSummary) {
    const b = bookSummary;
    L.push('【五档盘口】');
    L.push(b.askText);
    L.push(b.bidText);
    if (num(b.imbalancePct) !== null) {
      L.push(`买盘/卖盘挂单 ${b.bidVolume}手 vs ${b.askVolume}手（委比 ${b.imbalancePct.toFixed(1)}%）`);
    }
    has('盘口', true);
  }

  if (position) {
    L.push('【我的持仓】');
    const p = position;
    // 宿主那边算过就直接用；没算过（external 调用）就地补算，别把 "--" 喂给模型
    const px = num(p.price) !== null ? p.price : (quote ? num(quote.price) : null);
    const shares = num(p.shares) || 0;
    const cost = num(p.cost) || 0;
    const mv = num(p.marketValue) !== null ? p.marketValue
      : (px !== null && shares ? px * shares : null);
    const costValue = cost && shares ? cost * shares : null;
    const pnl = num(p.pnl) !== null ? p.pnl
      : (mv !== null && costValue !== null ? mv - costValue : null);
    const pnlPct = num(p.pnlPct) !== null ? p.pnlPct
      : (pnl !== null && costValue ? (pnl / costValue) * 100 : null);
    const prevClose = num(quote && quote.prevClose);
    const dayPnl = num(p.dayPnl) !== null ? p.dayPnl
      : (px !== null && prevClose !== null && shares ? (px - prevClose) * shares : null);
    L.push(
      `持股 ${shares} 股  成本价 ${fx(cost)}  现价 ${fx(px)}  ` +
        `市值 ${fx(mv)}  浮动盈亏 ${fx(pnl)}(${pct(pnlPct)})  当日盈亏 ${fx(dayPnl)}`,
    );
    if (cost > 0 && px !== null && px > 0) {
      const need = ((cost - px) / px) * 100;
      // 已经在成本上方时说「回本需要涨 -2.1%」会读成负数，容易误导模型
      L.push(need > 0.01 ? `回本需要再涨 ${pct(need)}` : `现价已在成本价上方 ${(-need).toFixed(2)}%`);
    }
    if (tradeSummary) {
      L.push(
        `流水 ${tradeSummary.count} 笔（${tradeSummary.firstDate} ~ ${tradeSummary.lastDate}）：` +
          `买入均价 ${fx(tradeSummary.avgBuy)}、卖出均价 ${fx(tradeSummary.avgSell)}`,
      );
      if (tradeSummary.recent.length) L.push(`最近成交 ${tradeSummary.recent.join('；')}`);
    }
    has('持仓', true);
  } else {
    L.push('【我的持仓】未持有该标的（不要给出买入建议，只给观察口径）');
  }

  if (alerts && alerts.length) {
    L.push('【已设预警】');
    L.push(
      alerts
        .map((a) => `${a.kind === 'pct' ? '涨跌幅' : '价格'} ${a.op} ${a.value}${a.kind === 'pct' ? '%' : ''}${a.enabled === false ? '(停用)' : ''}`)
        .join('；'),
    );
    has('预警', true);
  }

  L.push(`【数据时间】${asOf.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);

  const text = L.join('\n');
  meta.chars = text.length;
  meta.symbol = symbol;
  return { text, meta };
}

export const SYSTEM_PROMPT = [
  '你是一位严谨的A股/港股分析师，为个人投资者做单只标的的复盘分析。',
  '你只能使用我提供的数字，禁止编造任何未给出的数据（财报、新闻、机构评级、传闻都不许引入）。',
  '所有结论必须能追溯到给定的具体数字；如果数据不足以支撑某个判断，就明确写"数据不足"。',
  '不要用"建议关注""逢低布局"这类空话，要给可验证的价位和条件。',
  '如果标的当时不在交易时段，请说明数据的时间点。',
  '结尾必须有一行免责声明：以上为基于公开行情数据的量化复盘，不构成投资建议。',
].join('\n');

/** 期望的输出结构。按这个顺序、用 Markdown 小标题输出，便于界面直接渲染。 */
export const OUTPUT_SPEC = [
  '请严格按下面的结构输出（Markdown，小标题用 ###）：',
  '### 一句话结论',
  '（偏多/偏空/中性 + 置信度 0-100，一句话说完）',
  '### 关键依据',
  '（3-5 条，每条必须以具体数字开头，例如"20日线 1650 上方运行 12 个交易日"）',
  '### 关键价位',
  '（支撑位、压力位、失效位各给一个价格，并说明依据是哪个指标或区间）',
  '### 我的持仓怎么办',
  '（有持仓：给持有/减仓/加仓/清仓之一，并给出触发条件与仓位比例；无持仓：给观察/回避，并给出什么样的信号出现才值得关注）',
  '### 风险与失效条件',
  '（列出 2-3 个会让上述判断失效的具体情形）',
].join('\n');

export function buildMessages(pack, { style = 'default', extra = '' } = {}) {
  const styleLine =
    style === 'short'
      ? '风格：极简。总字数控制在 250 字以内，只保留结论、价位、动作。'
      : style === 'detail'
        ? '风格：详细。逐项论证，可以引用多组数字交叉验证。'
        : '风格：正常。总字数 400-700 字，信息密度优先。';
  const user = [
    '下面是一只标的的全部已知数据，请据此分析。',
    '',
    pack.text,
    '',
    styleLine,
    extra ? `额外要求：${extra}` : '',
    OUTPUT_SPEC,
  ].filter((s) => s !== '').join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 给界面显示的一句话数据清单，让用户知道模型到底看了什么 */
export function describePack(meta) {
  const labels = {
    行情: '实时行情',
    大盘: '大盘指数',
    日K: '日K指标',
    K线明细: '日K明细',
    分时: '分时',
    盘口: '五档盘口',
    持仓: '我的持仓',
    预警: '预警线',
  };
  const names = (meta && meta.has ? meta.has : []).map((k) => labels[k] || k);
  return names.length ? names.join(' + ') : '无可用数据';
}
