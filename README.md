# dsh-stock-bar

**中文** · [English](README.en.md)

[![release](https://img.shields.io/github/v/release/NoCandles/dsh-stock-bar?color=2fd08a)](https://github.com/NoCandles/dsh-stock-bar/releases)
[![license](https://img.shields.io/github/license/NoCandles/dsh-stock-bar?color=6b5ce7)](LICENSE)

钉在 DSH 窗口顶部的股票行情条：看行情、记持仓、画 K 线、让 AI 复盘。

## 功能

- **行情条**：自选和持仓的实时价、涨跌幅、跑马灯（鼠标滚轮可横滑）、涨跌停标记，可折叠成标题栏小胶囊；胶囊**注册进共享的顶栏停靠栈**，和其它顶栏插件（如「每日一关」）自动排队，不会互相压住
- **图表**：分时（1/3/5 日）与 K 线（日/周/月/分钟），MA5/10/20/60、成交量、十字光标、成本虚线
- **盘口**：五档买卖 + 委比
- **持仓**：股数、成本价、市值、浮动与当日盈亏（按币种分开）
- **记账**：交易流水、加权平均成本、已实现盈亏
- **预警**：价格或涨跌幅到线弹提示；触发时通知会带现价、量比和一句条件式建议（例如「跌破 0.68：先看量能，放量才减，缩量等收盘」）；同一阈值来回穿不会反复弹
- **AI 分析**：用 DSH 已配置的模型（供应商 → 模型两级选择），可选日K/3日K/5日K/周K/月K、分时 1/3/5 日等数据窗口，并把**多日资金流（3/5/10/20 日累计 + 连续天数）**、**ETF 前十大成分股的涨跌和资金**、**一级市场份额申赎（季报净申赎 + 每日份额快照变化）**一起喂给模型，流式输出复盘；切标签不丢结果、换标的自动重置，正文可收起展开；分析结论会附「倾向 / 置信度 / 动作 / 仓位 + 关键价位」卡片，并按关键价位自动设好价格预警（可在面板关掉）；每次分析自动进历史，回看时连当时喂给模型的数据快照一起保留；在正文里划选一段就能就着它继续追问，也能直接问整篇——追问挂在这次分析上（宽屏右栏默认占一半、中间可拖，窄屏叠成抽屉），追问入口在正文底部，只带引用段、数据包快照、最近几轮对话和**提问时现抓的实时行情**，对话随历史一起保存；不手动点也行：打开「AI 自动跟踪」后，按 09:35/10:30/11:30/13:35/14:30 自动跑盘中简报，15:05 自动完整复盘并更新预警（只跟持仓，时间点可改），每次跑完右下角弹一条通知，点开直达全文
- **侧边栏页（可选）**：装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 时，同一套面板还能作为右侧栏标签页「股票」打开，与顶栏行情条共用持仓和设置；标签页不可见时自动暂停轮询

## 安装

**在 DSH 插件市场里搜 `dsh-stock-bar` 直接装**。

或者从本仓库装：

```bash
dsh plugin --profile desktop add github:NoCandles/dsh-stock-bar
```

再把 `dsh-stock-bar` 加进 `<profile>/package.json` 的 `dsh.profile.bundles`（`dsh plugin` 只把参数转发给 pnpm，不会改这个字段，没列进去的 bundle 不会被加载），然后**完全退出 DSH 再打开** —— 只刷新页面不够。

卸载：

```bash
dsh plugin --profile desktop remove dsh-stock-bar
```

## 使用

点顶栏任意一只股票展开面板，七个标签页：持仓 / 自选 / 添加 / AI 分析 / 流水 / 预警 / 设置。持仓的股数和成本价直接在表格里改。

装了 `dsh-better-sidebar` 扩展时，右侧栏会多一个「股票」标签页（组件与顶栏共用，标签页不可见时自动暂停轮询）。

## 自检

```bash
node scripts/verify.mjs           # 宿主 249 条（需要联网接口，离线用 --offline）
node scripts/verify-client.mjs    # 客户端渲染 312 条
node scripts/verify-live.mjs      # 真 HTTP 端到端 173 条
node scripts/verify-analysis.mjs  # AI 数据包 95 条
```

合计 829 条断言，不需要 DSH，也不需要任何密钥。

## 说明

- 行情来自东方财富与腾讯的公开接口，**不构成投资建议**；插件不做交易
- 行情条在 DSH 窗口内，不是覆盖全桌面的悬浮窗
- 折叠胶囊不自己写坐标，而是 `createPortal` 进共享容器 `#dsh-topbar-dock`，靠 flex `order` 与其它顶栏插件排队（本插件 `order:40` 靠左，「每日一关」`order:90` 靠右）；容器 `pointer-events:none`，只有子项吃点击
- 只改 `lib/client.js` 刷新页面即可；改了 `lib/index.js`（宿主）必须重启 DSH

接口、实现细节与已知限制见 [docs/notes.md](docs/notes.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT
