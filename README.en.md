# dsh-stock-bar

[中文](README.md) · **English**

[![release](https://img.shields.io/github/v/release/NoCandles/dsh-stock-bar?color=2fd08a)](https://github.com/NoCandles/dsh-stock-bar/releases)
[![license](https://img.shields.io/github/license/NoCandles/dsh-stock-bar?color=6b5ce7)](LICENSE)

A stock ticker strip pinned to the top of the DSH window: quotes, holdings, charts, AI review.

## Features

- **Ticker strip** — live price and change for watchlist and holdings, scrolling marquee (mouse wheel works too), limit-up/down badges, collapses into a small pill in the title bar; the `⋮⋮` grip on the left **drags the whole strip anywhere** (position is remembered as a percentage of the window, so it stays put across monitors and resizes; double-click the grip to reset)
- **Charts** — intraday (1/3/5 day, with a top-left read-out for price and average price; the x-axis is a **fixed trading-session axis**: ticks at 9:30/10:30/11:30|13:00/14:00/15:00 with the lunch break folded into one tick, the line only extends to the current time and the rest of the day stays blank; the right axis labels **price first, change-percentage underneath**, and the **y-axis auto-fits the day's actual range** (like Eastmoney's app, so even a ±1% day shows its trend clearly)) and candlesticks (day/week/month/minute) with MA5/10/20/30/60 (price read-outs in the chart's top-left corner plus matching tags on the right axis, both following the crosshair), volume, crosshair, and a cost line; the sub-pane switches between **MACD / KDJ / RSI** with read-outs following the crosshair; **drag left-to-right on the candles to zoom into that slice of the timeline** — the overview bar under the chart (both ends labelled with the full year) shows the full range and the current window, **drag the window's edges to change the granularity or its middle to pan** (pixel-accurate, widened to avoid mis-clicks), click outside it or hit “All” to reset
- **Order book** — 5 levels each side + bid/ask imbalance (a percentage; hover for the formula, both sides' totals and the difference)
- **Holdings** — shares, cost price, market value, floating and daily P&L (split per currency); an **equity curve** records the portfolio value once a day (plotted as floating P&L %, with period return and max drawdown)
- **Ledger** — trade history, realized P&L; recording a buy/sell automatically updates the position's shares and cost (weighted average on buys, gains/losses diluted into the remaining shares, same as brokers); cost stays hand-editable
- **Alerts** — price or percentage thresholds with a toast; **every trigger is kept in a history table** (time / name / condition / price, clearable)
- **AI review** — uses the models already configured in DSH (provider → model picker), streamed output
- **Sidebar page (optional)** — with [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) installed, the same panel also opens as a "股票" tab in the right sidebar, sharing holdings and settings with the top strip; polling pauses while the tab is hidden

## Install

**Search `dsh-stock-bar` in the DSH plugin market**.

Or install from this repo:

```bash
dsh plugin --profile desktop add github:NoCandles/dsh-stock-bar
```

Then add `dsh-stock-bar` to `dsh.profile.bundles` in `<profile>/package.json` (`dsh plugin` only forwards args to pnpm and does not edit that field — a bundle that is not listed is never loaded), and **quit DSH completely and relaunch** — a page refresh is not enough.

Uninstall:

```bash
dsh plugin --profile desktop remove dsh-stock-bar
```

## Usage

Click any symbol in the top strip to open the panel: Holdings / Watchlist / Add / AI review / Trades / Alerts / Settings. Share counts and cost prices are edited inline in the table; table headers sort, there is a code/name search box, and a summary row sits at the bottom.

With `dsh-better-sidebar` installed, a "股票" tab also appears in the right sidebar (same components as the top strip; polling pauses while the tab is hidden).

## Self-checks

```bash
node scripts/verify.mjs           # host, 262 assertions offline (add --offline)
node scripts/verify-client.mjs    # client rendering, 637 assertions
node scripts/verify-live.mjs      # real HTTP end-to-end, 180 assertions
node scripts/verify-analysis.mjs  # AI data pack, 151 assertions
```

1230 assertions in total; none of them need DSH or any API key.

## Notes

- Quotes come from public Eastmoney and Tencent endpoints — **not investment advice**; the plugin does not trade
- The strip lives inside the DSH window; it is not a desktop-wide always-on-top overlay
- The expanded strip is a self-sizing floating card that lets clicks through its empty background; collapse it with "—" and click the pill to expand again (no hover-to-expand, which used to make the UI vanish as soon as the mouse moved)
- Editing `lib/client.js` needs a page refresh; editing `lib/index.js` (host) needs a DSH restart

Routes, internals and known limitations: [docs/notes.md](docs/notes.md) (Chinese). Changelog: [CHANGELOG.md](CHANGELOG.md).

## License

MIT
