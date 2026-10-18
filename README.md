# dsh-stock-ticker · 顶部股票行情条

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-1.0.0-informational.svg)](https://github.com/NoCandles/dsh-stock-ticker/releases)
[![dsh-plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f46e5.svg)](https://github.com/topics/dsh-plugin)

**中文** · [English](README.en.md)

DeepSeek Harness **插件**（宿主半边 + 客户端半边）：把一条**常驻的实时行情条**钉在 DSH 窗口最顶端，
像 Windows 任务栏 / 桌面歌词那样一直看得见；点开就是完整的自选、持仓、K 线、分时、盘口、流水、预警和 AI 复盘。

- 装上就能看见，不用打开侧栏；标的多了自动跑马灯，鼠标滚轮可横向滚、按住左键可拖动。
- 持仓的股数与成本价**点单元格直接改**，盈亏实时算；K 线/分时上会画出成本线。
- 行情来自东方财富公开接口（腾讯为备源），**零第三方运行时依赖**，不收集任何数据，只做展示与记账。
- 注意：它是 DSH **窗口内**的状态栏，不是操作系统级悬浮窗；行情有延迟，**不构成投资建议**。

![图标](icon.svg)

## 特性

| 能力 | 说明 |
| --- | --- |
| 顶部常驻条 | 注册进 frame 级 `shell.overlay` 槽位，靠自己的 CSS 钉在窗口最顶端（Windows 上落在原生标题栏那 40px 里，不占正文、不压工具栏） |
| 实时行情 | 东方财富为主源、腾讯为备源；现价、涨跌幅、今开/最高/最低、成交量额、换手、量比、市盈率、市净率 |
| 大盘指数 | 上证 / 深证 / 创业板默认自带，可关 |
| 交易时段 | 集合竞价 / 交易中 / 午间休市 / 已收盘 / 周末休市 + 服务器时间 |
| 跑马灯 | 标的多了自动横向滚动，鼠标悬停即暂停（桌面歌词那种效果）；**滚轮可横向滚、按住左键可拖动** |
| 价格闪烁 | 现价变化时闪一下红/绿，一眼看出刚动过 |
| 预警弹窗 | 价格或涨跌幅触发时，顶栏右下角弹出提示，可点击定位到该标的 |
| 展开面板 | 「持仓」「自选」「添加」「AI 分析」「流水」「预警」「设置」七个标签页 |
| 持仓表 | 现价 / 涨跌幅 / 股数 / 成本价 / 市值 / 浮动盈亏 / 盈亏% / 当日盈亏，股数和成本价**点单元格直接改**；**点一行展开详情，再点一次收起** |
| 图表 | **分时图**（1/3/5 日，含均价线、昨收中轴、成交量）与 **K 线图**（1m~月线、前复权/不复权/后复权、MA5/10/20/60、十字光标）之间切换，纯 canvas 手绘，无图表库 |
| 五档盘口 | 卖5~卖1 / 买1~买5、委比、买卖量对比 |
| 交易流水 | 记录每一笔买入/卖出（价格、股数、手续费、日期），用**加权平均成本法**算已实现盈亏；可一键「按流水反推持仓」 |
| 预警 | 按价格或涨跌幅设阈值（≥ / ≤），命中标红并弹提示；可停用、确认（重新武装）、删除 |
| AI 分析 | 用 DSH 已挂的模型对当前标的做复盘：**模型下拉框按供应商分组**（供应商 → 该供应商的模型两级选择，来源 `dsh-llm` 的 `listProviders()` / `listModels()`）、简版/详细、勾选喂哪些数据（日K / 分时 / 盘口 / 流水 / 大盘）、可加自定义要求；**流式输出**，边生成边显示，思考过程可折叠，可中途停止（保留半截结论），一键复制 |
| 组件开关 | 「设置 → 显示」里可以单独关掉：持仓汇总徽标、分时图、K线图、五档盘口、流水/预警/AI 三个标签页、预警弹窗。关掉图表后图表区给出提示，且周期/天数/复权这些没用的按钮一起隐藏（不留死控件）；关掉某个标签页时如果正停在那一页会自动退回一个还开着的页面 |
| 折叠态 | 折叠成一颗小胶囊：**钉在标题栏右侧的空白处**（原生窗口按钮左边），不占正文、不压工具栏；平时半透明，鼠标凑近才变实，点一下展开 |

## 安装

### 在 DSH 里装（推荐）

在 DSH 的**插件市场**里搜 `dsh-stock-ticker`，点安装、启用即可——市场会帮你完成 pnpm 安装、
`dsh.profile.bundles` 注册和补丁层接线。装完**完全退出 DSH 再重开一次**，宿主半边的 HTTP 接口才会注册上。

### 从本仓库装

```powershell
# 1. 把包解析进 profile
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add github:NoCandles/dsh-stock-ticker

# 2. 注册补丁层：把 "dsh-stock-ticker" 加进 <profile>/package.json 的 dsh.profile.bundles
#    （dsh plugin 只是把参数转发给 pnpm，它不会改 dsh.profile.bundles；
#     没列在那里的 bundle 永远不会被加载）

# 3. 完全退出 DSH 再重开
```

> **改完代码要怎么看效果**（这几点是实测出来的，不是猜的）：
>
> - 只改了 **`lib/client.js`**（界面）→ 按 **F5** 就行。
> - 改了 **宿主半边**（`lib/index.js` / `lib/store.js` / `lib/providers.js` / `lib/analysis.js`）→ **必须重启 DSH**，光刷新不够：
>   Cordis 对已解析的模块入口做了记忆化，`disable`/`enable` 或卸载后装同一个包名都不会重新执行新代码。
> - 宿主未重启时，客户端会先看到 **401**（DSH 对没注册的路由返回 401，不是没登录），
>   顶栏会出现「⚠ 宿主待重启」角标，点一下跳到设置页看完整原因。
> - 卸载：`& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-stock-ticker`

### 手工装（`plugin` 命令用不了时）

1. 把 `dsh-stock-ticker\` 整个目录复制到 `<profile>\node_modules\dsh-stock-ticker\`
   （默认 profile 是 `C:\Users\<你>\.dsh\profiles\desktop`）。
2. 在 profile 的 `package.json` 的 `dependencies` 里加 `"dsh-stock-ticker": "file:<那个目录的绝对路径>"`。
3. 把 `"dsh-stock-ticker"` 加进同一个 `package.json` 的 `dsh.profile.bundles` 数组。

> ⚠️ profile 与本插件的 `package.json` 必须是 **UTF-8 不带 BOM**。带 BOM 会让 pnpm 直接报
> `Unexpected token '锘?...' is not valid JSON`，而且报错信息完全看不出是 BOM 的问题。

## HTTP 接口

全部走 DSH 自带的 HTTP 服务（`ctx.webServer.register`），客户端同源 `fetch`。
写类接口一律 `POST`；**任何失败都是 HTTP 200 + `{ ok: false, error }`**，不会给 4xx/5xx（响应头带 `Cache-Control: no-store`）。

```
GET  /api/stock-ticker/state            行情 + 自选/持仓 + 汇总 + 设置 + 时段 + 触发的预警
GET  /api/stock-ticker/kline            K 线（symbol / period / adjust / count）
GET  /api/stock-ticker/trends           分时（symbol / days = 1|3|5）
GET  /api/stock-ticker/orderbook        五档盘口 + 委比
GET  /api/stock-ticker/search           按代码/名称/拼音搜标的
GET  /api/stock-ticker/trades           交易流水 + 已实现盈亏
GET  /api/stock-ticker/health           自检：node 版本、store 路径、行情/K线/盘口是否可用、缓存规模
POST /api/stock-ticker/items/save       加自选或改持仓（symbol 可写 600519 / sh600519 / 拼音）
POST /api/stock-ticker/items/remove     删自选
POST /api/stock-ticker/settings/save    改设置（只认已知键，数值会夹到合法区间）
POST /api/stock-ticker/trades/save      记一笔流水（side=buy|sell、price、shares、fee、date）
POST /api/stock-ticker/trades/remove    删一笔流水
POST /api/stock-ticker/trades/clear     清空某只（或全部）流水
POST /api/stock-ticker/trades/apply     按流水反推持仓（覆盖股数与成本价）
POST /api/stock-ticker/alerts/save      加/改预警，响应直接带 hit 与 current
POST /api/stock-ticker/alerts/remove    删预警
POST /api/stock-ticker/alerts/ack       确认触发（重新武装）
GET  /api/stock-ticker/ai/models        dsh-llm 里的供应商与模型目录 + 当前选择
POST /api/stock-ticker/ai/analyze       AI 分析：取数→组装数据包→调模型，NDJSON 流式回传
```

`/ai/analyze` 的响应是 `Content-Type: application/x-ndjson`，一行一个事件：
`meta` / `reasoning` / `delta` / `done` / `error`。模型没配、取不到行情、没指定模型这些情况也走
**合法 JSON + `ok:false`**，客户端先看 Content-Type 再决定怎么读。
请求里的 `symbol` 可以传 `600519`、`sh600519` 或拼音，宿主会先归一化再取数。

行情按「主源失败自动降级」实现（东方财富 / 腾讯 / 新浪），全部放在
`lib/providers.js`，`scripts/probe.mjs` 可以直接打真实接口跑连通性。

**持仓/流水/预警/设置都存在宿主侧的数据文件里**，不写浏览器 localStorage ——
换窗口、清缓存、换浏览器都不会丢。默认路径 `<DSH_HOME>\dsh-stock-ticker\portfolio.json`
（可用 `cordis.patch.yml` 的 `config.storePath` 改）。写入是「先写 `.tmp-<pid>` 再 rename」的原子替换；
文件损坏时会重命名成 `portfolio.json.broken-<时间戳>` 留着，而不是静默丢掉你的持仓。

## 开发与自检

四个脚本，共 **745 条断言**，全部不需要 DSH 在跑：

```powershell
# 1) 宿主侧：路由注册、存储、盈亏/流水/预警算法、缓存 LRU、AI 数据包与流、错误兜底（假 ctx，进程内）
node scripts/verify.mjs            # 249 条

# 2) 客户端：模块包装契约、槽位注册、真实渲染、canvas 绘制、成本线、涨跌停标记、AI 面板流式解析、组件开关联动、卸载清理
node scripts/verify-client.mjs     # 240 条

# 3) 真 HTTP 端到端：把 apply() 挂到一个真的 node:http 服务器上再打进去
node scripts/verify-live.mjs       # 173 条

# 4) AI 数据包（不需要网络与模型）：指标计算、消息组装、简版/详细两种口径
node scripts/verify-analysis.mjs   # 83 条
```

再加三个探针：

```powershell
# 真实上游接口连通性（东方财富/腾讯，含分时与盘口）
node scripts/probe.mjs

# 在线装配自检：直接问正在运行的 DSH 要本插件的客户端 bundle
node scripts/probe-client-served.mjs "<profile>\node_modules\dsh-stock-ticker\lib\client.js"

# 人工看一眼「喂给 AI 的数据包」长什么样（真实行情，不打模型）
node scripts/peek-pack.mjs sh600519 short
```

**为什么需要四个而不是一个。** `verify.mjs` 用假的 `req`/`res` 直接调 handler，跑得最快，
但绕过了两个真实环节：一是 `readBody()` 用的是 `for await (const chunk of req)`，依赖真实的
`IncomingMessage` 异步迭代器（假 req 只能"装作"能迭代）；二是 `Content-Length` / `Cache-Control`
这类响应头只有真服务器上才有意义。`verify-live.mjs` 就是补这两个洞的——它建立真实 TCP 连接、
发真实 JSON body、验证响应头字节数，并且额外覆盖了「19 条路由都随插件卸载而注销」和
「上游挂了也返回 200 + ok:false，绝不 5xx」。`verify-analysis.mjs` 单独管 AI 数据包（指标、口径、消息组装），
不需要网络也不需要模型服务。`verify-client.mjs` 自带一个极简 DOM + React Hook 替身，
能在 Node 里把组件真的渲染一遍并跑 effect，用来在上浏览器前抓出渲染期异常、槽位注册错误和 canvas 没画的问题——
客户端插件最难接受的失败模式是组件渲染时抛异常，框架只会把整个槽位清空，控制台留一句
`slot entry crashed in '<slot>'`。

`scripts/probe-client-served.mjs` 复盘了 DSH `dsh-client-modules` 的版本号算法
（`sha1("plugin-artifact" + mtimeMs/ctimeMs/size)` 取 12 位）并直接去请求那个 URL，
用来区分「200 → bundle 已经在对外提供」和「404 → 启动后文件被改过，rev 对不上了」。

## 实现要点（给改代码的人）

- **宿主半边**（`lib/index.js`）：`export const inject = ['webServer']`，`apply()` 里对每条路由
  `ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), '说明')`，
  这样插件卸载时路由会一起注销。handler 统一过了 `safe()`：任何异常都变成 200 + `{ ok:false, error }`，
  不会让 DSH 的 HTTP 服务给用户抛 500。缓存 TTL：行情 2s / K线 15s / 分时 20s / 盘口 3s。
- **客户端半边**（`lib/client.js`）：`window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名，
  只 `require('react')`（浏览器模块表里只有 react 等 9 个模块，DSH 文档明确禁止 require 它自己的内部包）。
  唯一的对外请求是 `fetch('/api/stock-ticker/...')`。
- **位置**：`shell.overlay` 是 `position:absolute; inset:0; pointer-events:none` 的图层，
  且只有直接子元素才恢复 `pointer-events:auto`。所以条子自己 `position:fixed`，
  顶部偏移取 `--dsh-frame-top-clearance`（Windows 上就是标题栏那 40px）+ 用户可调的 `topOffset`。
- **样式**：`<style data-plugin-css="...">` 只注入一次（按 `data-plugin-css` 去重，HMR 重复执行不会叠加），
  颜色全部走 `--dsw-alias-*` 主题变量并给字面量兜底，红涨绿跌用插件自己的 `--dst-up` / `--dst-down`，
  暗色下由 `body[data-ds-dark-theme]` 覆盖。
- **store 形状**：`{ version, settings, items, trades, alerts }`。`items`（持仓/自选）和 `trades`（流水）
  是**两本账**，互不自动覆盖；只有用户点「按流水同步持仓」才用 `computeRealized()` 的加权平均成本写回 items。
  老版本文件缺 `trades` / `alerts` / 新设置键时会自动补默认值，**升级不会丢持仓**（有专门的回归用例）。
- **流水算法**：手续费计入成本。买 1000 股 @10 手续费 5 → 成本 10.005；再买 1000 @12 → 10.0025；
  卖 500 @15 → 已实现 (15 − 10.0025) × 500。卖出超过流水持仓会被拒（提示是不是漏记了买入）。
- **预警**：`syncAlerts()` 每轮行情都判定，命中的进 `fired` 队列；这个队列**只由 `GET /state` 取走**
  （`consumeFired`），所以写接口不会把提示吞掉；`/alerts/ack` 清 `firedAt` 让同一个条件能再次触发。
- **缓存是 LRU**：`CACHE_MAX = 200`，按 symbol/关键词建键；`GET /health` 会报 `caches` 规模，
  自检里专门跑过 210 个不同关键词来验证淘汰真的发生。
- **轮询跟交易时段走**：盘中按用户设的间隔，午休 ≥30s，收盘后 ≥60s；页面不可见时不轮询。
- **宿主未加载的识别**：401/403 单独识别（DSH 对未注册路由返回 401），提示「宿主未加载 / 需要重启 DSH」；
  设置写回时如果宿主不认新键，也会把这条提示挂上去，并且**不会被下一轮成功的轮询擦掉**。
- **AI 分析**（`lib/analysis.js` 组装数据包，`lib/index.js` 转发模型调用）：
  - 宿主侧**不 import 任何 `@deepseek-ai/*` 包**，而是 `ctx.get('llm')` 拿已经挂好的 `dsh-llm` 服务
    （`ctx.get('agentDefaultModel')` 读默认模型）。这台机器上 `profiles\node_modules` 里的
    `@deepseek-ai/*` 是指向已消失的 G: 源码目录的坏 junction，直接 import 会炸。
  - 数据包全部现算：日K的 MA5/10/20/60、区间涨跌、量比，分时的均价与尾盘走势，盘口五档与委比，
    持仓的成本/浮盈/当日盈亏，流水的已实现盈亏与胜率，大盘指数。**模型只看到这些数字**，看不到你的账户。
  - `style: short` 限字数、`style: detail` 放开；`extra` 会把用户的额外要求拼进去。
  - 流式事件：`meta`（数据包统计 + 已喂数据来源）→ `reasoning`（思考过程，界面折叠显示）→
    `delta`（正文增量）→ `done`（完整正文 + token 用量 + 耗时 + finish）。客户端跨 chunk 拼行，
    所以偶尔把一行切成两半也不会丢字。
  - 上游把错误放在 `finish.reason.failure` 而不是抛异常（adapter 约定），所以 `done` 事件里
    也会带 `error`/`code`，界面按"半截结论 + 错误"渲染，不把已经生成的内容丢掉。
- 持仓股票在 K 线/分时图上会画一条**成本线**（虚线 + 「成本 xxx」标签），鼠标划过还能看到按持仓算的浮动盈亏；
  现价触到涨跌停时，顶栏胶囊和持仓表会打「涨停/跌停」标记（涨跌停幅度按代码前缀判断：主板 10%、
  创业板/科创板 20%、北交所 30%、ST 5%）。
- **组件开关**（`settings.showTotals / showTrend / showKline / showOrderBook / showTrades / showAlerts / showAi / alertToast`）：
  设置里改的是同一份 `settings`，客户端乐观更新 + 宿主 `POST /settings/save` 落盘。标签栏由
  `visibleTabs(settings)` 算出来（`持仓`/`添加`/`设置` 永远保留，不然用户会把自己锁死）；当前标签页被关掉时
  一个 effect 负责退回第一个还开着的页面。关掉两张图后图表区渲染提示文案，并且周期/天数/复权三组按钮
  一并不渲染——**开关关掉的东西不应该留下点了没反应的控件**。
- 顶栏横向滚动是自己实现的（`useMarquee`）：滚轮事件按 `deltaX/deltaY` 里绝对值大的那个转成横向滚动、
  按住左键可以拖动，只有在轨道真的溢出（`scrollWidth - clientWidth > 2`）时才 `preventDefault`，
  不溢出就不抢页面滚动；拖动结束时用 capture 阶段的 click 拦一次，避免"拖完顺手选中了某只"。
- **点选是切换式的**：再点一次同一行会收起详情（`setSelected(cur => cur === symbol ? null : symbol)`）。
  写自检时踩过这个坑——测试里连点两次行会把它取消选中，所以断言前要用 `ensureRowSelected()`。

## 已知限制

- 它是 DSH **窗口内**的状态栏，不是操作系统级的悬浮窗。页面级客户端插件没有创建
  Electron 置顶窗口的权限，所以做不到「浮在所有软件上面」的桌面歌词效果。
- 行情来自东方财富公开接口（腾讯为备源），有延迟，**不构成投资建议**。
- AI 分析用的是 DSH 里已挂的模型（走 `dsh-llm`），所以：① DSH 没配任何模型时这个标签页会
  直接告诉你读不到模型目录；② 消耗的是你自己的模型额度；③ 结论来自模型，**同样不构成投资建议**，
  数字请以行情为准自己核对。
- 插件不做交易，只做展示与记账。

## 收录到插件市场

本插件遵循 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的收录规则：
`package.json` 里同时声明了 `dsh.bundle`（可安装）与 `dsh.client`（带前端 UI），仓库根有
`cordis.patch.yml`，并带 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题。

待提交的条目已经写好：[`contrib/awesome-dsh-plugin.yml`](contrib/awesome-dsh-plugin.yml)，
对应目标是 `data/plugins/NoCandles__dsh-stock-ticker.yml`（该列表一个插件一个 YAML 文件，README 由脚本生成）。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT
