/**
 * lib/analysis.js 的纯函数单测。
 *
 * 为什么单独一个脚本：这一层是「喂给模型的数字」，算错了模型就会拿着错数字
 * 一本正经地给出支撑位。所以这里不用网络、不用 DSH，只用人工可验算的数据，
 * 把每个指标和一组手算值对齐。
 *
 * 运行：node scripts/verify-analysis.mjs
 */

import {
  sma, stdev, changePctOf,
  summarizeCandles, condenseCandles, summarizeTrends, summarizeBook,
  summarizeTrades, buildDataPack, buildMessages, describePack,
  DEFAULT_KLINE_BARS,
} from '../lib/analysis.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); return; }
  fail++;
  failures.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
}

function near(a, b, tol = 1e-6) { return typeof a === 'number' && Math.abs(a - b) <= tol; }

function section(title) { console.log(`\n== ${title} ==`); }

/* ---------------- 夹具：70 根线性上涨的日K ----------------
   close = 100 + i（i 从 1 到 70）→ 最后一根收 170，每根 high=close+1, low=close-1, vol=1000+i
   手算：MA5=168  MA10=165.5  MA20=160.5  MA60=140.5  ATR14=2
*/
const CANDLES = [];
for (let i = 1; i <= 70; i++) {
  CANDLES.push({
    date: `2026-0${i <= 9 ? 1 : 2}-${String(i).padStart(2, '0')}`.replace(/-\d\d$/, `-${String(((i - 1) % 28) + 1).padStart(2, '0')}`),
    open: 100 + i - 0.5,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i,
    volume: 1000 + i,
  });
}
// 日期要严格递增到最后一根，便于断言 slice 行为
for (let i = 0; i < CANDLES.length; i++) {
  const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000);
  CANDLES[i].date = d.toISOString().slice(0, 10);
}

section('基础统计');
{
  check('sma 数据不足返回 null', sma([1, 2], 5) === null);
  check('sma 取最后 n 个', near(sma([1, 2, 3, 4, 5], 3), 4));
  check('sma 长度为 0 返回 null', sma([], 3) === null);
  check('stdev 常数序列为 0', near(stdev([5, 5, 5]), 0));
  check('stdev 已知值', near(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2));
  check('changePctOf 首末变化', near(changePctOf([100, 110]), 10));
  check('changePctOf 元素不足返回 null', changePctOf([100]) === null);
}

section('日K指标（对手算值）');
{
  const s = summarizeCandles(CANDLES);
  check('识别出 70 根', s.bars === 70, s.bars);
  check('MA5 = 168', near(s.ma[5], 168, 1e-9), s.ma[5]);
  check('MA10 = 165.5', near(s.ma[10], 165.5, 1e-9), s.ma[10]);
  check('MA20 = 160.5', near(s.ma[20], 160.5, 1e-9), s.ma[20]);
  check('MA60 = 140.5', near(s.ma[60], 140.5, 1e-9), s.ma[60]);
  check('20日最高 171', near(s.hi20, 171, 1e-9), s.hi20);
  check('20日最低 150', near(s.lo20, 150, 1e-9), s.lo20);
  check('距20日高点 -0.58%', near(s.fromHi20Pct, ((170 - 171) / 171) * 100, 1e-9), s.fromHi20Pct);
  check('距20日低点 +13.33%', near(s.fromLo20Pct, ((170 - 150) / 150) * 100, 1e-9), s.fromLo20Pct);
  check('20日区间分位 95', s.posIn20 === 95, s.posIn20);
  check('近5日 +3.03%', near(s.chg5, ((170 - 165) / 165) * 100, 1e-9), s.chg5);
  check('近20日 +13.33%', near(s.chg20, ((170 - 150) / 150) * 100, 1e-9), s.chg20);
  check('近60日 +54.55%', near(s.chg60, ((170 - 110) / 110) * 100, 1e-9), s.chg60);
  check('ATR14 = 2（每根振幅恒为 2）', near(s.atr14, 2, 1e-9), s.atr14);
  check('ATR 百分比 = 2/170', near(s.atr14Pct, (2 / 170) * 100, 1e-9), s.atr14Pct);
  check('5日均量 1068', near(s.vol5, 1068, 1e-9), s.vol5);
  check('20日均量 1060.5', near(s.vol20, 1060.5, 1e-9), s.vol20);
  check('量比 = 1068/1060.5', near(s.volRatio, 1068 / 1060.5, 1e-9), s.volRatio);
  check('日期区间取自首末', s.firstDate === CANDLES[0].date && s.lastDate === CANDLES[69].date,
    [s.firstDate, s.lastDate]);
  check('数据不足时 MA 为 null（不是硬算）', summarizeCandles(CANDLES.slice(0, 3)).ma[20] === null);
  check('空数组返回 null', summarizeCandles([]) === null);
}

section('日K压缩');
{
  const txt = condenseCandles(CANDLES, 60);
  const lines = txt.split('\n');
  check('只有最后 60 根 + 表头', lines.length === 61, lines.length);
  check('表头列名齐全', lines[0] === '日期,开,高,低,收,量(手)', lines[0]);
  check('第一行数据是第 11 根', lines[1].startsWith(CANDLES[10].date.slice(5)), lines[1]);
  check('最后一行是最新一根', lines[60].startsWith(CANDLES[69].date.slice(5)), lines[60]);
  check('每行 6 列', lines.slice(1).every((l) => l.split(',').length === 6));
  check('默认根数与常量一致', condenseCandles(CANDLES).split('\n').length === DEFAULT_KLINE_BARS + 1);
  check('空输入返回空串', condenseCandles([]) === '');
}

section('分时摘要');
{
  const points = [];
  for (let i = 0; i < 241; i++) {
    points.push({
      time: `09:30`.replace(/.*/, `0930`) + i,
      open: 100,
      price: 100 + i * 0.1,
      high: 100 + i * 0.1 + 0.05,
      low: 100 + i * 0.1 - 0.05,
      volume: 10,
      amount: 1000,
      avg: 100 + i * 0.09,
    });
  }
  const t = summarizeTrends({ prevClose: 100, days: 1, points });
  check('点数 241', t.points === 241, t.points);
  check('最高价 = 末点价', near(t.high, 124, 1e-9), t.high);
  check('最低价 = 首点价', near(t.low, 100, 1e-9), t.low);
  check('最高涨幅相对昨收', near(t.highPct, 24, 1e-9), t.highPct);
  check('均价线始终低于价格 -> 上方占比 100%', near(t.aboveAvgRatio, 100, 1e-9), t.aboveAvgRatio);
  check('采样点数被压缩到 8 个左右', t.sample.length <= 9 && t.sample.length >= 8, t.sample.length);
  check('空分时返回 null', summarizeTrends({ points: [] }) === null);
}

section('五档盘口摘要');
{
  const book = {
    price: 10.5,
    bids: [
      { price: 10.5, volume: 500 }, { price: 10.49, volume: 300 }, { price: 10.48, volume: 200 },
      { price: 10.47, volume: 100 }, { price: 10.46, volume: 50 },
    ],
    asks: [
      { price: 10.51, volume: 100 }, { price: 10.52, volume: 200 }, { price: 10.53, volume: 300 },
      { price: 10.54, volume: 400 }, { price: 10.55, volume: 500 },
    ],
  };
  const b = summarizeBook(book);
  check('买盘总量 1150', b.bidVolume === 1150, b.bidVolume);
  check('卖盘总量 1500', b.askVolume === 1500, b.askVolume);
  check('委比为负（卖压大）', b.imbalancePct < 0, b.imbalancePct);
  check('委比 = (1150-1500)/2650', near(b.imbalancePct, ((1150 - 1500) / 2650) * 100, 1e-9), b.imbalancePct);
  check('卖档从卖1 开始编号', /^卖1 10\.51/.test(b.askText), b.askText);
  check('买档从买1 开始编号', /^买1 10\.5/.test(b.bidText), b.bidText);
  check('两盘都空时委比为 null', summarizeBook({ bids: [], asks: [] }).imbalancePct === null);
  check('无盘口返回 null', summarizeBook(null) === null);
}

section('流水摘要');
{
  const trades = [
    { symbol: 'sh600519', side: 'buy', price: 1500, shares: 100, date: '2026-08-01' },
    { symbol: 'sh600519', side: 'buy', price: 1600, shares: 100, date: '2026-09-01' },
    { symbol: 'sh600519', side: 'sell', price: 1700, shares: 50, date: '2026-10-01' },
    { symbol: 'sz000001', side: 'buy', price: 10, shares: 1000, date: '2026-09-15' },
  ];
  const t = summarizeTrades(trades, 'sh600519');
  check('只统计算传入标的', t.count === 3, t.count);
  check('买入均价 = 1550', near(t.avgBuy, 1550, 1e-9), t.avgBuy);
  check('卖出均价 = 1700', near(t.avgSell, 1700, 1e-9), t.avgSell);
  check('净持仓 150 股', t.openShares === 150, t.openShares);
  check('首末日期正确', t.firstDate === '2026-08-01' && t.lastDate === '2026-10-01', [t.firstDate, t.lastDate]);
  check('无流水返回 null', summarizeTrades([], 'sh600519') === null);
}

section('数据包与消息');
{
  const quote = {
    price: 1680.5, change: 15.5, changePct: 0.93, prevClose: 1665, open: 1666, high: 1690, low: 1660,
    amplitude: 1.8, volume: 38502, amount: 6.4e9, turnover: 0.31, volRatio: 1.05,
    pe: 18.66, pb: 6.61, marketCap: 1.66e12, floatCap: 1.66e12, mainInflow: 4.68e8, provider: 'eastmoney',
  };
  const pack = buildDataPack({
    symbol: 'sh600519', name: '贵州茅台', code: '600519', quote,
    candleSummary: summarizeCandles(CANDLES), candleText: condenseCandles(CANDLES, 60),
    trendSummary: null, bookSummary: summarizeBook({ bids: [{ price: 1680, volume: 10 }], asks: [{ price: 1681, volume: 20 }] }),
    tradeSummary: summarizeTrades([{ symbol: 'sh600519', side: 'buy', price: 1500, shares: 100, date: '2026-08-01' }], 'sh600519'),
    market: null,
    position: { shares: 100, cost: 1500, price: 1680.5, marketValue: 168050, pnl: 18050, pnlPct: 12.03, dayPnl: 1550 },
    alerts: [{ kind: 'price', op: '>=', value: 1700, enabled: true }],
    indexes: [{ name: '上证指数', price: 3716.28, changePct: 0.24 }],
    asOf: new Date('2026-10-16T07:00:00Z'),
  });
  const t = pack.text;
  check('含标的行', t.includes('贵州茅台(600519)'), null);
  check('含现价', t.includes('现价 1680.50'), null);
  check('含市盈率市净率', t.includes('市盈率 18.66') && t.includes('市净率 6.61'), null);
  check('含主力净流入（万）', /主力净流入 46800万/.test(t) || /主力净流入 4680\d万/.test(t), null);
  check('含大盘环境', t.includes('上证指数 3716.28 +0.24%'), null);
  check('含持仓市值与浮盈', t.includes('持股 100 股') && /市值 [\d,]+\.\d\d/.test(t) && /浮动盈亏 [\d,]+\.\d\d\(\+?[\d.]+%\)/.test(t), null);
  // 成本 1500 < 现价 1680.5：要说「已在成本上方」，不能说「回本需要涨 -10.7%」
  check('成本上方时说「已在成本价上方」而不是负数回本',
    /现价已在成本价上方 10\.7\d%/.test(t) && !t.includes('回本需要再涨'), null);
  check('含预警线', t.includes('价格 >= 1700'), null);
  check('含日K明细表头', t.includes('日期,开,高,低,收,量(手)'), null);
  check('meta 记录了喂进去的数据', pack.meta.has.includes('行情') && pack.meta.has.includes('日K') && pack.meta.has.includes('持仓'),
    pack.meta.has);
  check('meta 记录了字符数', pack.meta.chars === t.length, pack.meta.chars);
  check('界面数据清单可读', describePack(pack.meta).includes('日K指标'), describePack(pack.meta));

  const noPos = buildDataPack({ symbol: 'sh600519', name: '贵州茅台', code: '600519', quote });
  check('未持有时明确写出来', noPos.text.includes('未持有该标的'), null);
  check('未持有时不含仓位段', !/回本需要涨/.test(noPos.text), null);

  // 被套的情况：成本高于现价，要给出「回本需要再涨」
  const losing = buildDataPack({
    symbol: 'sh600519', name: '贵州茅台', code: '600519', quote,
    position: { shares: 100, cost: 1800 },
  });
  check('被套时给出回本涨幅', /回本需要再涨 \+?7\.1\d%/.test(losing.text), losing.text.match(/回本需要[^\n]*/));
  // 宿主没算过市值/盈亏时（外部调用），数据包里也要自己补算，不能出现 --
  check('缺市值时自己补算而不是写 --',
    /市值 [\d,]+\.\d\d/.test(losing.text) && !/市值 --/.test(losing.text), null);
  check('缺浮动盈亏时自己补算', /浮动盈亏 -[\d,]+\.\d\d\(-[\d.]+%\)/.test(losing.text), null);
  check('缺当日盈亏时按昨收补算', /当日盈亏 [\d,]+\.\d\d/.test(losing.text), null);
  check('取不到行情时说清楚', /取不到/.test(buildDataPack({ name: 'X', code: '1' }).text), null);

  const msgs = buildMessages(pack, { style: 'short' });
  check('两条消息（system + user）', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user', msgs.map((m) => m.role));
  check('system 禁止编造数据', msgs[0].content.includes('禁止编造'), null);
  check('system 要求免责声明', msgs[0].content.includes('不构成投资建议'), null);
  check('user 里带了数据包', msgs[1].content.includes('贵州茅台(600519)'), null);
  check('user 里带了输出结构', msgs[1].content.includes('### 关键价位'), null);
  check('short 风格字数受限', /250 字以内/.test(msgs[1].content), null);
  check('detail 风格可切换', /详细/.test(buildMessages(pack, { style: 'detail' })[1].content), null);
  check('额外要求会拼进去', /只看量能/.test(buildMessages(pack, { extra: '只看量能' })[1].content), null);
}

console.log(`\n==== 通过 ${pass} / 失败 ${fail} ====`);
if (fail) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
