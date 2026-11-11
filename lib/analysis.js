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

export const PROMPT_VERSION = 'stock-analysis-v3';

/** 默认给模型的日K根数：60 根够看出趋势和形态，又不至于把上下文撑爆 */
export const DEFAULT_KLINE_BARS = 60;
/** 分时摘要的采样点数（按等间隔抽，不送 241 个点） */
export const TREND_SAMPLE = 8;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fx = (v, d = 2) => (num(v) === null ? '--' : num(v).toFixed(d));
const pct = (v) => (num(v) === null ? '--' : `${num(v) > 0 ? '+' : ''}${num(v).toFixed(2)}%`);
/** 金额：元 -> 万/亿（带符号），模型读起来比一串 0 稳 */
const money = (v) => {
  const n = num(v);
  if (n === null) return '--';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)}亿`;
  return `${sign}${Math.round(a / 1e4)}万`;
};

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

/** 把日K聚合成 N 日K。
 *  从最新一根往回按 N 根分组，最老的不足一组直接丢掉（只保留完整窗口）；
 *  日期用窗口最后一根的日期，开=首根开、收=末根收、高/低取组内极值、量额求和。
 *  这样 3日K/5日K 的均线和「N日累计」才是可比的，不会混进半天数据。 */
export function aggregateCandles(candles, n) {
  const list = (Array.isArray(candles) ? candles : []).filter((c) => c && c.date && num(c.close) !== null);
  const step = Math.floor(Number(n) || 1);
  if (step < 2 || list.length < step) return list;
  const out = [];
  for (let i = list.length % step; i + step <= list.length; i += step) {
    const part = list.slice(i, i + step);
    const last = part[part.length - 1];
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let amount = 0;
    for (const c of part) {
      if (num(c.high) !== null) high = Math.max(high, c.high);
      if (num(c.low) !== null) low = Math.min(low, c.low);
      volume += num(c.volume) || 0;
      amount += num(c.amount) || 0;
    }
    out.push({
      ...last,
      date: last.date,
      open: part[0].open,
      close: last.close,
      high: high === -Infinity ? last.high : high,
      low: low === Infinity ? last.low : low,
      volume,
      amount,
      aggregate: step,
    });
  }
  return out;
}

/** 把日K压成 CSV 行；只保留最后 max 根，且第一行带表头方便模型对齐列 */
export function condenseCandles(candles, max = DEFAULT_KLINE_BARS, label = '') {
  const list = (Array.isArray(candles) ? candles : []).filter((c) => c && c.date && num(c.close) !== null);
  if (list.length === 0) return '';
  const picked = list.slice(-max);
  // 周K/月K 的日期只留 MM-DD 会看不出年份，直接给完整日期
  const weekly = /周/.test(label);
  const monthly = /月/.test(label);
  const firstCol = weekly ? '周' : monthly ? '月' : '日期';
  const rows = picked.map((c) =>
    [
      weekly || monthly ? String(c.date) : String(c.date).slice(5),
      fx(c.open),
      fx(c.high),
      fx(c.low),
      fx(c.close),
      num(c.volume) === null ? '--' : String(Math.round(c.volume)),
    ].join(','),
  );
  return [`${firstCol},开,高,低,收,量(手)`, ...rows].join('\n');
}

/** 分时关键时点：开盘半小时、上下午关键节点、尾盘。每天各取最近的一根，再补上当天最后一根 */
const TREND_TARGETS = ['09:35', '09:45', '10:00', '10:30', '11:00', '11:30', '13:05', '13:30', '14:00', '14:30', '14:57'];

const hhmm = (t) => String(t || '').slice(-5);
const toMin = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm).slice(-5));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 分时摘要：关键时点采样 + 每日概况（开/高/低/收/涨跌），外加"在均价线上方的时间占比" */
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

  // 按天分组：东财的 time 可能是 "2026-10-16 09:31"，也可能只有 "09:31"
  const groups = [];
  for (const p of pts) {
    const key = /^\d{4}-\d{2}-\d{2}/.test(String(p.time)) ? String(p.time).slice(0, 10) : '';
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, pts: [] }; groups.push(g); }
    g.pts.push(p);
  }

  const dayStats = [];
  const sample = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const dayPrices = g.pts.map((p) => p.price);
    const prevDayLast = gi > 0 ? groups[gi - 1].pts[groups[gi - 1].pts.length - 1].price : prevClose;
    dayStats.push({
      date: g.key || hhmm(g.pts[0].time),
      open: num(g.pts[0].open) !== null ? g.pts[0].open : g.pts[0].price,
      high: Math.max(...dayPrices),
      low: Math.min(...dayPrices),
      last: dayPrices[dayPrices.length - 1],
      chgPct: prevDayLast ? ((dayPrices[dayPrices.length - 1] - prevDayLast) / prevDayLast) * 100 : null,
    });

    const picked = [];
    for (const tgt of TREND_TARGETS) {
      let best = null;
      let bestDiff = Infinity;
      const tgtMin = toMin(tgt);
      for (const p of g.pts) {
        const mm = toMin(hhmm(p.time));
        if (mm === null) continue;
        const diff = Math.abs(mm - tgtMin);
        if (diff < bestDiff) { bestDiff = diff; best = p; }
      }
      // 离目标时点 8 分钟以内才算有效，避免把 10:30 的采样硬贴到 13:30
      if (best && bestDiff <= 8 && !picked.includes(best)) picked.push(best);
    }
    const dayLast = g.pts[g.pts.length - 1];
    if (!picked.includes(dayLast)) picked.push(dayLast);
    for (const p of picked) sample.push(`${hhmm(p.time)}=${fx(p.price)}`);
  }

  return {
    days: trends.days || groups.length || 1,
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
    dayStats,
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
 * 多日资金流摘要。金额单位统一换算成「万/亿」再交给模型，避免一串看不懂的 0。
 * 只统计二级市场大单口径（主力 = 大单 + 超大单），ETF 的份额申赎不在这里。
 */
export function summarizeFundFlow(flow) {
  const days = flow && Array.isArray(flow.days) ? flow.days.filter(Boolean) : [];
  if (!days.length) return null;
  const last = days[days.length - 1];
  const sum = (n) => days.slice(-n).reduce((a, d) => a + (num(d.main) || 0), 0);
  const dir = Math.sign(num(last.main) || 0);
  let streak = 0;
  if (dir !== 0) {
    for (let i = days.length - 1; i >= 0; i--) {
      if (Math.sign(num(days[i].main) || 0) !== dir) break;
      streak++;
    }
  }
  return {
    name: flow.name || null,
    bars: days.length,
    last,
    sum3: sum(3),
    sum5: sum(5),
    sum10: sum(10),
    sum20: sum(20),
    streak,
    streakUp: dir > 0,
    recent: days.slice(-5),
  };
}

/**
 * 持仓成分股摘要。rows 由调用方补齐行情与资金流：
 * `{code,name,weight,chgPct,mainToday,main5}`，缺数据的字段允许为 null。
 */
export function summarizeHoldings(data) {
  const rows = data && Array.isArray(data.rows) ? data.rows.filter((r) => r && r.code) : [];
  if (!rows.length) return null;
  const validWeight = rows.filter((r) => num(r.weight) !== null);
  const totalWeight = validWeight.reduce((a, r) => a + r.weight, 0);
  const wChg = rows.filter((r) => num(r.weight) !== null && num(r.chgPct) !== null);
  const wChgSum = wChg.reduce((a, r) => a + r.weight, 0);
  const weightedChg = wChgSum > 0
    ? wChg.reduce((a, r) => a + r.weight * r.chgPct, 0) / wChgSum
    : null;
  const withFlow = rows.filter((r) => num(r.mainToday) !== null);
  const flowToday = withFlow.length ? withFlow.reduce((a, r) => a + r.mainToday, 0) : null;
  const withFlow5 = rows.filter((r) => num(r.main5) !== null);
  const flow5 = withFlow5.length ? withFlow5.reduce((a, r) => a + r.main5, 0) : null;
  const up = rows.filter((r) => num(r.chgPct) !== null && r.chgPct > 0).length;
  const down = rows.filter((r) => num(r.chgPct) !== null && r.chgPct < 0).length;
  return {
    asOf: data.asOf || null,
    count: rows.length,
    totalWeight,
    weightedChg,
    flowToday,
    flow5,
    up,
    down,
    rows,
  };
}

/**
 * 单周期 K 线指标 + 明细的文本块。日K/周K/月K 共用一套口径，只换单位词。
 * @param {string} label 例如 '日K' / '周K' / '月K'
 * @param {object} s summarizeCandles 的结果
 * @param {string} text condenseCandles 的结果
 */
function klineBlock(label, s, text) {
  const unit = /周K$/.test(label) ? '周' : /月K$/.test(label) ? '月' : '日';
  const lines = [];
  const maText = Object.keys(s.ma)
    .filter((k) => num(s.ma[k]) !== null)
    .map((k) => `MA${k}=${fx(s.ma[k])}`)
    .join('  ');
  lines.push(`【${label}指标】最近 ${s.bars} 根（${s.firstDate} ~ ${s.lastDate}）`);
  if (maText) lines.push(maText);
  lines.push(
    `20${unit}高 ${fx(s.hi20)} / 低 ${fx(s.lo20)}（现价距高点 ${pct(s.fromHi20Pct)}、距低点 ${pct(s.fromLo20Pct)}，` +
      `位于区间 ${s.posIn20 === null ? '--' : s.posIn20 + '%'} 分位）`,
  );
  lines.push(`60${unit}高 ${fx(s.hi60)} / 低 ${fx(s.lo60)}`);
  lines.push(
    `近5${unit} ${pct(s.chg5)}  近20${unit} ${pct(s.chg20)}  近60${unit} ${pct(s.chg60)}  ` +
      `ATR14 ${fx(s.atr14)}(${fx(s.atr14Pct)}%)  20${unit}波动率 ${fx(s.vol20Pct)}%`,
  );
  if (num(s.volRatio) !== null) lines.push(`5${unit}均量/20${unit}均量 = ${fx(s.volRatio)}`);
  if (text) {
    lines.push(`【${label}数据（最后${DEFAULT_KLINE_BARS}根，量单位手）】`);
    lines.push(text);
  }
  return lines;
}

/**
 * 组装数据包。owner 决定建议的口径：
 *  - 有持仓 -> 要给仓位动作（持有/减/加/清）和金额化的风险
 *  - 无持仓 -> 只给观察口径，不能凭空建议买入
 *
 * K 线支持两种传法：
 *  - klines: [{period,label,summary,text}] —— 多周期（日/周/月 K 一起喂）
 *  - candleSummary/candleText/periodLabel —— 单周期兼容路径（老调用方与单测）
 */
export function buildDataPack({
  symbol,
  name,
  code,
  quote = null,
  candleSummary = null,
  candleText = '',
  periodLabel = '日K',
  klines = null,
  trendSummary = null,
  bookSummary = null,
  flowSummary = null,
  holdingsSummary = null,
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

  if (flowSummary) {
    const f = flowSummary;
    L.push(`【资金流向（多日，近${f.bars}个交易日）】`);
    L.push('注：这里是二级市场按单笔金额统计的大单口径（主力=大单+超大单），ETF 的份额申赎是另一套账，不能替代。');
    const last = f.last || {};
    L.push(
      `今日主力 ${money(last.main)}（占比 ${fx(last.mainPct)}%）  ` +
        `小单 ${money(last.small)}  中单 ${money(last.mid)}  大单 ${money(last.big)}  超大单 ${money(last.superBig)}`,
    );
    L.push(
      `累计主力：3日 ${money(f.sum3)} / 5日 ${money(f.sum5)} / 10日 ${money(f.sum10)} / 20日 ${money(f.sum20)}`,
    );
    if (f.streak > 0) {
      L.push(`已连续 ${f.streak} 个交易日主力净${f.streakUp ? '流入' : '流出'}`);
    }
    if (Array.isArray(f.recent) && f.recent.length) {
      L.push(
        '最近5日：' +
          f.recent
            .map((d) => `${String(d.date).slice(5)} ${money(d.main)}(${pct(d.chgPct)})`)
            .join('  '),
      );
    }
    has('资金流', true);
  }

  if (holdingsSummary) {
    const h = holdingsSummary;
    L.push(`【ETF/基金持仓成分股】前 ${h.count} 大${h.asOf ? `（截止 ${h.asOf}）` : ''}`);
    const bits = [];
    if (num(h.totalWeight) !== null) bits.push(`权重合计 ${fx(h.totalWeight)}%`);
    if (num(h.weightedChg) !== null) bits.push(`加权涨跌 ${pct(h.weightedChg)}`);
    if (num(h.flowToday) !== null) bits.push(`今日主力合计 ${money(h.flowToday)}`);
    if (num(h.flow5) !== null) bits.push(`5日主力合计 ${money(h.flow5)}`);
    if (h.up + h.down > 0) bits.push(`${h.up}涨/${h.down}跌`);
    if (bits.length) L.push(bits.join('  '));
    for (const r of h.rows) {
      const seg = [`${r.name || ''}(${r.code})`, `权重${fx(r.weight)}%`];
      if (num(r.chgPct) !== null) seg.push(`涨跌${pct(r.chgPct)}`);
      if (num(r.mainToday) !== null) seg.push(`今日主力${money(r.mainToday)}`);
      if (num(r.main5) !== null) seg.push(`5日主力${money(r.main5)}`);
      L.push(`  ${seg.join(' ')}`);
    }
    has('成分股', true);
  }

  const klineList = (Array.isArray(klines) ? klines : [])
    .filter((k) => k && k.label && k.summary);
  if (klineList.length) {
    for (const k of klineList) {
      for (const line of klineBlock(k.label, k.summary, k.text || '')) L.push(line);
      meta.has.push(`${k.label}指标`);
      if (k.text) meta.has.push(`${k.label}明细`);
    }
    meta.periods = klineList.map((k) => k.period);
  } else {
    if (candleSummary) {
      const s = candleSummary;
      for (const line of klineBlock(periodLabel, s, '')) L.push(line);
      meta.has.push(periodLabel);
      has('K线明细', !!candleText);
    }
    if (candleText) {
      L.push(`【${periodLabel}数据（最后${DEFAULT_KLINE_BARS}根，量单位手）】`);
      L.push(candleText);
    }
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
    if (Array.isArray(t.dayStats) && t.dayStats.length > 1) {
      L.push('按日概况：');
      for (const d of t.dayStats) {
        L.push(`  ${String(d.date).slice(5)} 开 ${fx(d.open)} 高 ${fx(d.high)} 低 ${fx(d.low)} 收 ${fx(d.last)} ${pct(d.chgPct)}`);
      }
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
  '判断资金面时，必须结合【资金流向（多日）】的 3/5/10/20 日累计与连续流入/流出天数，以及【ETF/基金持仓成分股】的涨跌与资金；单日主力净流入/流出不能单独作为看多或看空的依据。',
  '如果价格与主力方向背离，先用成分股走势、多日累计、小单承接等数据尝试解释；解释不了就明确写"背离"，并指出缺少哪类数据（例如没有份额申赎、没有板块涨跌）。',
  'ETF 的二级市场大单流向与一级市场份额申赎是两套口径；数据里没有申赎数据时，不得臆测申购/赎回。',
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
  '### 结构化数据（最后输出，不计入正文字数）',
  '正文结束后追加一个 json 代码块，只放这些字段：',
  '{"stance":"偏多|偏空|中性","confidence":72,"action":"持有|减仓|加仓|清仓|观察|回避","positionPct":30,"levels":[{"label":"支撑","price":1650,"op":"<="},{"label":"压力","price":1720,"op":">="}]}',
  '要求：价格必须来自上面的数据；label 用 支撑/压力/失效；op 用 "<="（跌到该价提醒）或 ">="（涨到该价提醒）；',
  '没有把握的档位不要写。界面会用这个代码块自动设置价格预警，所以价格要能对上数据里的具体指标或区间。',
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
    日K指标: '日K指标',
    日K明细: '日K明细',
    周K指标: '周K指标',
    周K明细: '周K明细',
    月K指标: '月K指标',
    月K明细: '月K明细',
    分时: '分时',
    盘口: '五档盘口',
    资金流: '多日资金流',
    成分股: '持仓成分股',
    持仓: '我的持仓',
    预警: '预警线',
  };
  const names = (meta && meta.has ? meta.has : []).map((k) => labels[k] || k);
  return names.length ? names.join(' + ') : '无可用数据';
}

/**
 * 从模型正文里抽出结构化计划（```json 代码块，或正文末尾的裸 JSON）。
 * 解析失败返回 null —— 正文照样展示，只是不自动设预警，不要因此让整次分析失败。
 */
export function parsePlan(text) {
  const src = String(text || '');
  let raw = '';
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(src);
  if (fence) raw = fence[1];
  else {
    const idx = src.indexOf('{');
    if (idx >= 0) raw = src.slice(idx).trim();
  }
  if (!raw) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const stance = typeof obj.stance === 'string' ? obj.stance.trim().slice(0, 12) : '';
  const action = typeof obj.action === 'string' ? obj.action.trim().slice(0, 20) : '';
  const conf = Number(obj.confidence);
  const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : null;
  const pos = Number(obj.positionPct);
  const positionPct = Number.isFinite(pos) ? Math.max(0, Math.min(100, Math.round(pos))) : null;

  const levels = [];
  for (const lv of Array.isArray(obj.levels) ? obj.levels : []) {
    if (!lv || typeof lv !== 'object') continue;
    const price = Number(lv.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const label = typeof lv.label === 'string' ? lv.label.trim().slice(0, 8) : '';
    let op = lv.op === '<=' || lv.op === '>=' ? lv.op : null;
    // 模型没写 op 时按 label 推断：压力/阻力/突破 = 涨上去提醒；其余（支撑/失效）= 跌破提醒
    if (!op) op = /压力|阻力|突破/.test(label) ? '>=' : '<=';
    if (levels.some((x) => x.price === price && x.op === op)) continue;
    levels.push({ label: label || '价位', price, op });
    if (levels.length >= 6) break;
  }

  if (!stance && !levels.length) return null;
  return { stance, confidence, action, positionPct, levels };
}

/** 去掉正文里的 JSON 代码块，只留给用户看的复盘文字 */
export function stripPlan(text) {
  return String(text || '')
    .replace(/```(?:json)?\s*\{[\s\S]*?"(?:levels|stance)"[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------------- 追问对话 ---------------- */

/** 追问场景的 system：只解释、不重写整篇复盘，缺数据要认账。 */
export const CHAT_SYSTEM = [
  '你是这只标的的复盘助手，正在回答用户针对一份已经生成好的复盘（和它当时的数据包）的追问。',
  '规则：',
  '1. 只依据【本次分析的数据包】和【用户引用的段落】回答。数据包里没有的东西（新闻、公告、财报、传闻、实时盘口）直接说「这份数据里没有」，不要编，也不要拿常识补。',
  '2. 用户引用了某一段时，优先解释那一段；问「为什么/什么意思/依据是什么」时，把相关的具体数字点出来。',
  '3. 回答简短，默认 200 字以内，用大白话；用户要求展开再展开。不要重写整篇复盘，不要每次都重复免责声明。',
  '4. 涉及买卖时只给观察口径和触发条件，不承诺收益、不喊单。',
].join('\n');

/**
 * 组装一次追问的 messages。
 * @param {{pack?:string, quote?:string, question?:string,
 *          history?:Array<{role:string,content:string}>}} args
 */
export function buildChatMessages({ pack = '', quote = '', question = '', history = [] } = {}) {
  const hist = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  const body = [
    pack
      ? `【本次分析的数据包】\n${String(pack).slice(0, 12000)}`
      : '（这次分析没有保存数据包，只能依据引用段落回答）',
    quote ? `【用户引用的段落】\n${String(quote).slice(0, 1200)}` : '',
    `【用户的问题】\n${String(question).slice(0, 2000)}`,
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: CHAT_SYSTEM },
    ...hist,
    { role: 'user', content: body },
  ];
}
