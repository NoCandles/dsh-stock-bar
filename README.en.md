# dsh-stock-bar

[中文](README.md) · **English**

[![release](https://img.shields.io/github/v/release/NoCandles/dsh-stock-bar?color=2fd08a)](https://github.com/NoCandles/dsh-stock-bar/releases)
[![license](https://img.shields.io/github/license/NoCandles/dsh-stock-bar?color=6b5ce7)](LICENSE)

A stock ticker strip pinned to the top of the DSH window: quotes, holdings, charts, AI review.

## Features

- **Ticker strip** — live price and change for watchlist and holdings, scrolling marquee (mouse wheel works too), limit-up/down badges, collapses into a small pill in the title bar
- **Charts** — intraday (1/3/5 day) and candlesticks (day/week/month/minute) with MA5/10/20/60, volume, crosshair, and a cost line
- **Order book** — 5 levels each side + bid/ask imbalance
- **Holdings** — shares, cost price, market value, floating and daily P&L (split per currency)
- **Ledger** — trade history, weighted-average cost, realized P&L
- **Alerts** — price or percentage thresholds with a toast
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

Click any symbol in the top strip to open the panel: Holdings / Watchlist / Add / AI review / Trades / Alerts / Settings. Share counts and cost prices are edited inline in the table.

With `dsh-better-sidebar` installed, a "股票" tab also appears in the right sidebar (same components as the top strip; polling pauses while the tab is hidden).

## Self-checks

```bash
node scripts/verify.mjs           # host, 249 assertions
node scripts/verify-client.mjs    # client rendering, 275 assertions
node scripts/verify-live.mjs      # real HTTP end-to-end, 173 assertions
node scripts/verify-analysis.mjs  # AI data pack, 83 assertions
```

780 assertions in total; none of them need DSH or any API key.

## Notes

- Quotes come from public Eastmoney and Tencent endpoints — **not investment advice**; the plugin does not trade
- The strip lives inside the DSH window; it is not a desktop-wide always-on-top overlay
- Editing `lib/client.js` needs a page refresh; editing `lib/index.js` (host) needs a DSH restart

Routes, internals and known limitations: [docs/notes.md](docs/notes.md) (Chinese). Changelog: [CHANGELOG.md](CHANGELOG.md).

## License

MIT
