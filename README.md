# dsh-stock-ticker

**中文** · [English](README.en.md)

[![release](https://img.shields.io/github/v/release/NoCandles/dsh-stock-ticker?color=2fd08a)](https://github.com/NoCandles/dsh-stock-ticker/releases)
[![license](https://img.shields.io/github/license/NoCandles/dsh-stock-ticker?color=6b5ce7)](LICENSE)

钉在 DSH 窗口顶部的股票行情条：看行情、记持仓、画 K 线、让 AI 复盘。

## 功能

- **行情条**：自选和持仓的实时价、涨跌幅、跑马灯（鼠标滚轮可横滑）、涨跌停标记，可折叠成标题栏小胶囊
- **图表**：分时（1/3/5 日）与 K 线（日/周/月/分钟），MA5/10/20/60、成交量、十字光标、成本虚线
- **盘口**：五档买卖 + 委比
- **持仓**：股数、成本价、市值、浮动与当日盈亏（按币种分开）
- **记账**：交易流水、加权平均成本、已实现盈亏
- **预警**：价格或涨跌幅到线弹提示
- **AI 分析**：用 DSH 已配置的模型（供应商 → 模型两级选择），流式输出复盘

## 安装

**在 DSH 插件市场里搜 `dsh-stock-ticker` 直接装**（收录后可用）。

或者从本仓库装：

```bash
dsh plugin --profile desktop add github:NoCandles/dsh-stock-ticker
```

再把 `dsh-stock-ticker` 加进 `<profile>/package.json` 的 `dsh.profile.bundles`（`dsh plugin` 只把参数转发给 pnpm，不会改这个字段，没列进去的 bundle 不会被加载），然后**完全退出 DSH 再打开** —— 只刷新页面不够。

卸载：

```bash
dsh plugin --profile desktop remove dsh-stock-ticker
```

## 使用

点顶栏任意一只股票展开面板，七个标签页：持仓 / 自选 / 添加 / AI 分析 / 流水 / 预警 / 设置。持仓的股数和成本价直接在表格里改。

## 自检

```bash
node scripts/verify.mjs           # 宿主 249 条
node scripts/verify-client.mjs    # 客户端渲染 240 条
node scripts/verify-live.mjs      # 真 HTTP 端到端 173 条
node scripts/verify-analysis.mjs  # AI 数据包 83 条
```

合计 745 条断言，不需要 DSH，也不需要任何密钥。

## 说明

- 行情来自东方财富与腾讯的公开接口，**不构成投资建议**；插件不做交易
- 行情条在 DSH 窗口内，不是覆盖全桌面的悬浮窗
- 只改 `lib/client.js` 刷新页面即可；改了 `lib/index.js`（宿主）必须重启 DSH

接口、实现细节与已知限制见 [docs/notes.md](docs/notes.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT
