/**
 * 把「喂给 AI 的数据包」原样打出来看一眼。
 * 只用于人工核对数据质量，不参与 verify 套件。
 *
 *   node scripts/peek-pack.mjs [symbol] [style]
 */
import { fetchQuotes, fetchKline, fetchTrends, fetchOrderBook } from '../lib/providers.js';
import {
  buildDataPack, buildMessages, describePack,
  summarizeCandles, condenseCandles, summarizeTrends, summarizeBook, summarizeTrades,
} from '../lib/analysis.js';

const symbol = process.argv[2] || 'sh600519';
const style = process.argv[3] === 'detail' ? 'detail' : 'short';

const quoteMap = await fetchQuotes([symbol]);
const quote = quoteMap.get(symbol) || null;
if (!quote) {
  console.error(`取不到 ${symbol} 的行情`);
  process.exit(1);
}
const [klineRes, trends, book] = await Promise.all([
  fetchKline(symbol, { period: 'day', adjust: 'pre', count: 120 }).catch(() => null),
  fetchTrends(symbol, { days: 1 }).catch(() => null),
  fetchOrderBook(symbol).catch(() => null),
]);
// fetchKline 返回的是 { candles, provider, ... }，不是裸数组（宿主那边的用法见 lib/index.js）
const candles = (klineRes && Array.isArray(klineRes.candles)) ? klineRes.candles : [];

const trades = [
  { id: 't1', symbol, side: 'buy', price: quote.prevClose * 0.96, shares: 100, fee: 5, date: '2026-08-14' },
  { id: 't2', symbol, side: 'buy', price: quote.prevClose * 0.99, shares: 100, fee: 5, date: '2026-09-22' },
  { id: 't3', symbol, side: 'sell', price: quote.price * 1.01, shares: 60, fee: 6, date: '2026-10-09' },
];

const pack = buildDataPack({
  symbol,
  name: quote.name,
  code: quote.code,
  position: { ...quote, symbol, shares: 140, cost: 1300.5, index: false },
  quote,
  candleSummary: candles.length ? summarizeCandles(candles) : null,
  candleText: candles.length ? condenseCandles(candles, 60) : '',
  periodLabel: '日K',
  trendSummary: trends ? summarizeTrends(trends) : null,
  bookSummary: book ? summarizeBook(book) : null,
  tradeSummary: summarizeTrades(trades, symbol),
  market: { label: '已收盘', shanghai: '17:30' },
  indexes: [{ code: 'sh000001', name: '上证指数', price: 3716.28, changePct: 0.24 }],
  asOf: new Date(),
});

console.log('===== pack.meta =====');
console.log(JSON.stringify(pack.meta, null, 2));
console.log(`\n===== 数据包正文（${pack.meta.chars} 字）=====`);
console.log(pack.text);

const messages = buildMessages(pack, { style, extra: '只讲量能和价位，别谈基本面' });
for (const m of messages) {
  console.log(`\n===== ${m.role}（${m.content.length} 字）=====`);
  console.log(m.content.length > 2600 ? `${m.content.slice(0, 2600)}\n…（截断，共 ${m.content.length} 字）` : m.content);
}
console.log(`\n===== describePack =====\n${describePack(pack.meta)}`);
