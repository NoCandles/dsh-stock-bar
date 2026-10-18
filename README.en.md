# dsh-stock-ticker · always-on stock quotes strip for DeepSeek Harness

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-1.0.0-informational.svg)](https://github.com/NoCandles/dsh-stock-ticker/releases)
[![dsh-plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5.svg)](https://github.com/topics/dsh-plugin)

[中文](README.md) · **English**

A DeepSeek Harness **plugin** (host half + client half) that pins a **live quotes strip** to the very
top of the DSH window — visible all the time, like a taskbar ticker. Click it open for the full
watchlist, holdings, candlestick / intraday charts, level-2 order book, trade ledger, price alerts and
AI review.

- **Visible without opening a sidebar.** When there are more symbols than fit, the strip scrolls
  itself; the mouse wheel scrolls it horizontally and drag-holding left button drags it.
- **Holdings are editable in place** — click a share-count or cost-price cell to edit; P&L updates live,
  and a cost line is drawn onto the charts.
- **Zero third-party runtime dependencies.** Quotes come from Eastmoney's public quotes endpoint with
  Tencent as fallback. No telemetry; it only displays and keeps books.
- It is a status bar **inside the DSH window**, not an OS-level overlay window. Quotes are delayed and
  **nothing here is investment advice**.

## Features

| | |
| --- | --- |
| Top strip | Registers into the frame-level `shell.overlay` slot and positions itself with its own CSS. On Windows it sits inside the native 40px title bar, so it does not cover content or the toolbar. Collapses into a small pill docked to the right of the title bar. |
| Quotes | Price, change %, open/high/low, volume & turnover, turnover rate, volume ratio, P/E, P/B. Shanghai / Shenzhen / ChiNext / STAR / Beijing / HK / US. |
| Indices | SSE Composite, SZSE Component and ChiNext are pre-seeded (toggleable). |
| Session | Call auction / trading / lunch break / closed / weekend, with exchange time. |
| Charts | Intraday (1/3/5 days, average line, previous-close axis, volume) and candlesticks (1m–monthly, three adjust modes, MA5/10/20/60, crosshair). Hand-drawn on canvas — **no charting library**. |
| Holdings | Shares, cost price, market value, unrealized P&L, P&L %, day P&L. Multi-currency totals are kept separate. |
| Order book | 5 levels each side, bid/ask imbalance. |
| Trade ledger | Records buys and sells with fees; realized P&L by weighted-average cost; one click syncs holdings from the ledger. |
| Alerts | Price or change-% thresholds (≥ / ≤), toast on hit, can be disabled and re-armed. |
| AI review | Uses whichever model DSH already has configured, **streamed**. Model picker is grouped provider → model. You choose which data to feed (daily candles / intraday / order book / ledger / indices), plus free-form extra instructions. Reasoning is collapsible, Stop keeps the partial answer. |
| Component toggles | Turn off the totals badge, either chart, the order book, or the ledger / alerts / AI tabs individually. Disabled controls are removed, not left dead. |

## Install

### In DSH (recommended)

Open the plugin market in DSH, search for **dsh-stock-ticker**, install it, and enable it.
The market performs the pnpm install, the `dsh.profile.bundles` registration and the patch-layer wiring
for you. Restart DSH once after installing so the host half's HTTP routes are registered.

### From this repository

```powershell
# 1. resolve the package into your profile
& '<dsh install>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add github:NoCandles/dsh-stock-ticker

# 2. register the bundle layer — add "dsh-stock-ticker" to dsh.profile.bundles
#    in <profile>/package.json (dsh plugin add only forwards to pnpm; it does not
#    edit dsh.profile.bundles, and a bundle that is not listed there is never loaded)

# 3. quit DSH completely and relaunch
```

> Both the profile's `package.json` and this plugin's must be **UTF-8 without BOM**. A BOM makes pnpm
> die with `Unexpected token '锘?...' is not valid JSON`, which does not read like a BOM problem at all.

### Manual

Copy this directory to `<profile>/node_modules/dsh-stock-ticker/`, add
`"dsh-stock-ticker": "file:<absolute path>"` to the profile's `dependencies`, and add
`"dsh-stock-ticker"` to `dsh.profile.bundles`.

## How changes take effect

| What you changed | What to do |
| --- | --- |
| `lib/client.js` (the UI) | Press **F5**. |
| Host half (`lib/index.js`, `lib/store.js`, `lib/providers.js`, `lib/analysis.js`) | **Restart DSH.** Cordis memoizes resolved module entries, so disabling/re-enabling or reinstalling the same package name does not re-execute new code. |
| Host not restarted yet | The client sees **401** (DSH answers 401 for unregistered routes — it is not an auth problem). The strip shows a `⚠ 宿主待重启` badge; click it to read the reason. |

## HTTP routes

Everything goes through DSH's own HTTP server (`ctx.webServer.register`); the client fetches
same-origin. Every failure is HTTP **200** with `{ ok: false, error }` — never 4xx/5xx — and responses
carry `Cache-Control: no-store`.

```
GET  /api/stock-ticker/state             quotes + watchlist/holdings + totals + settings + session + fired alerts
GET  /api/stock-ticker/kline             candles (symbol / period / adjust / count)
GET  /api/stock-ticker/trends            intraday (symbol / days = 1|3|5)
GET  /api/stock-ticker/orderbook         5 levels + imbalance
GET  /api/stock-ticker/search            search by code / name / pinyin
GET  /api/stock-ticker/trades            ledger + realized P&L
GET  /api/stock-ticker/alerts            alert list
GET  /api/stock-ticker/ai/models         configured providers + models
GET  /api/stock-ticker/health            self-test: quote / kline / trend / book probes, cache sizes
POST /api/stock-ticker/items/save        add or update a watchlist / holding row
POST /api/stock-ticker/items/remove      remove a row
POST /api/stock-ticker/settings/save     patch settings (unknown keys are dropped)
POST /api/stock-ticker/trades/save       record a trade
POST /api/stock-ticker/trades/remove     delete a trade
POST /api/stock-ticker/trades/clear      clear the ledger
POST /api/stock-ticker/trades/apply      derive holdings from the ledger
POST /api/stock-ticker/alerts/save       create / update an alert
POST /api/stock-ticker/alerts/remove     delete an alert
POST /api/stock-ticker/alerts/ack        re-arm a fired alert
POST /api/stock-ticker/ai/analyze        streaming review (application/x-ndjson)
```

`/ai/analyze` is the only streaming route: NDJSON, one event per line (`meta` → `reasoning` → `delta`
→ `done`, or `error`). Failures **before** the stream starts are still ordinary JSON with `ok:false`,
so the client checks `Content-Type` first.

## Self-checks

No test framework, no network required for the structural half:

```powershell
node scripts/verify.mjs              # host half — routes, store, alert/pnl math, legacy-file migration (249)
node scripts/verify-client.mjs       # client half — React+DOM shim renders the real bundle (240)
node scripts/verify-live.mjs         # real node:http end-to-end, real TCP + real bodies (173)
node scripts/verify-analysis.mjs     # AI data pack: indicators and message assembly (83)
```

745 assertions total, all green. `scripts/probe.mjs` and `scripts/peek-pack.mjs` are for looking at
live provider payloads and the exact data pack sent to the model.

> If an upstream quotes endpoint is down, `verify.mjs` / `verify-live.mjs` report the section as
> **skipped**, not failed — an outage at Eastmoney is not a plugin bug.

## Notes

- The store lives at `~/.dsh/dsh-stock-ticker/portfolio.json`; writes are atomic, a corrupt file is
  renamed aside rather than silently discarded, and older files are upgraded in place without losing
  holdings.
- Quote cache is an LRU capped at 200 entries; polling follows the trading session (≥30s at lunch,
  ≥60s after close) and pauses while the page is hidden.
- AI analysis never imports an `@deepseek-ai/*` package; it reads the already-mounted services through
  `ctx.get('llm')` / `ctx.get('agentDefaultModel')`, so it works even when those packages cannot be
  resolved from the profile.

## License

MIT
