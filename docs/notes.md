# dsh-stock-bar 实现笔记

接口细节、自检脚本、实现要点与已知限制。功能与安装见 [README](../README.md)。

## HTTP 接口

全部走 DSH 自带的 HTTP 服务（`ctx.webServer.register`），客户端同源 `fetch`。
写类接口一律 `POST`；**任何失败都是 HTTP 200 + `{ ok: false, error }`**，不会给 4xx/5xx（响应头带 `Cache-Control: no-store`）。

```
GET  /api/stock-bar/state            行情 + 自选/持仓 + 汇总 + 设置 + 时段 + 触发的预警
GET  /api/stock-bar/kline            K 线（symbol / period / adjust / count）
GET  /api/stock-bar/trends           分时（symbol / days = 1|3|5）
GET  /api/stock-bar/orderbook        五档盘口 + 委比
GET  /api/stock-bar/search           按代码/名称/拼音搜标的
GET  /api/stock-bar/trades           交易流水 + 已实现盈亏
GET  /api/stock-bar/health           自检：node 版本、store 路径、行情/K线/盘口是否可用、缓存规模
POST /api/stock-bar/items/save       加自选或改持仓（symbol 可写 600519 / sh600519 / 拼音）
POST /api/stock-bar/items/remove     删自选
POST /api/stock-bar/settings/save    改设置（只认已知键，数值会夹到合法区间）
POST /api/stock-bar/trades/save      记一笔流水（side=buy|sell、price、shares、fee、date）
POST /api/stock-bar/trades/remove    删一笔流水
POST /api/stock-bar/trades/clear     清空某只（或全部）流水
POST /api/stock-bar/trades/apply     按流水反推持仓（覆盖股数与成本价）
POST /api/stock-bar/alerts/save      加/改预警，响应直接带 hit 与 current
POST /api/stock-bar/alerts/remove    删预警
POST /api/stock-bar/alerts/ack       确认触发（重新武装）
GET  /api/stock-bar/ai/models        dsh-llm 里的供应商与模型目录 + 当前选择
POST /api/stock-bar/ai/analyze       AI 分析：取数→组装数据包→调模型，NDJSON 流式回传
GET  /api/stock-bar/ai/history       AI 分析历史列表（摘要，不含全文）
GET  /api/stock-bar/ai/history/get   取一条历史全文（?id=）
POST /api/stock-bar/ai/history/remove 删一条历史
POST /api/stock-bar/ai/history/clear  清空历史
POST /api/stock-bar/ai/chat          就某次分析/某段正文追问，NDJSON 流式回传
```

`/ai/analyze` 的响应是 `Content-Type: application/x-ndjson`，一行一个事件：
`meta` / `reasoning` / `delta` / `done` / `error`。模型没配、取不到行情、没指定模型这些情况也走
**合法 JSON + `ok:false`**，客户端先看 Content-Type 再决定怎么读。
请求里的 `symbol` 可以传 `600519`、`sh600519` 或拼音，宿主会先归一化再取数。
喂给模型的数据窗口可以按需组合：`periods`（`day`/`day3`/`day5`/`week`/`month`，可多选，缺省回落到 `period`）
决定 K 线周期（`day3`/`day5` 是宿主拿日K本地聚合出来的），`trendDays`（1..5）决定分时天数；
`include` 里再分别关掉 `kline`/`trend`/`book`/`trades`/`indexes`。分析成功落库后会历史记录一条，
`done` 事件里带回 `recordId` / `at` / `plan`（结构化计划）/ `alerts`（自动新建的预警条数）/ `promptVersion`。
如果模型在正文末尾给了 json 计划且 `settings.aiAutoAlert` 没关，宿主会自动把关键价位设成价格预警
（支撑/失效=跌破提醒，压力=涨到提醒，去重、过滤离谱价）。

行情按「主源失败自动降级」实现（东方财富 / 腾讯 / 新浪），全部放在
`lib/providers.js`，`scripts/probe.mjs` 可以直接打真实接口跑连通性。

**持仓/流水/预警/设置都存在宿主侧的数据文件里**，不写浏览器 localStorage ——
换窗口、清缓存、换浏览器都不会丢。默认路径 `<DSH_HOME>\dsh-stock-bar\portfolio.json`
（可用 `cordis.patch.yml` 的 `config.storePath` 改）。写入是「先写 `.tmp-<pid>` 再 rename」的原子替换；
文件损坏时会重命名成 `portfolio.json.broken-<时间戳>` 留着，而不是静默丢掉你的持仓。

## 开发与自检

四个脚本，共 **1004 条断言**，全部不需要 DSH 在跑：

```powershell
# 1) 宿主侧：路由注册、存储、盈亏/流水/预警算法、缓存 LRU、AI 数据包与流、多周期聚合、自动设预警、追问、错误兜底（假 ctx，进程内）
node scripts/verify.mjs            # 325 条（其中 2 条依赖东方财富实时分时源，源挂时会失败）

# 2) 客户端：模块包装契约、槽位注册、真实渲染、canvas 绘制、成本线、涨跌停标记、AI 面板流式解析、计划卡片、追问面板、组件开关联动、卸载清理
node scripts/verify-client.mjs     # 350 条（含侧边栏接线与渲染、AI 历史/周期选择/折叠/切标的重置/数据快照/追问/追问入口与比例/自动跟踪设置与完成通知）

# 3) 真 HTTP 端到端：把 apply() 挂到一个真的 node:http 服务器上再打进去
node scripts/verify-live.mjs       # 178 条（其中 1 条依赖实时分时源）

# 4) AI 数据包（不需要网络与模型）：指标计算、消息组装、简版/详细两种口径
node scripts/verify-analysis.mjs   # 151 条
```

再加三个探针：

```powershell
# 真实上游接口连通性（东方财富/腾讯，含分时与盘口）
node scripts/probe.mjs

# 在线装配自检：直接问正在运行的 DSH 要本插件的客户端 bundle
node scripts/probe-client-served.mjs "<profile>\node_modules\dsh-stock-bar\lib\client.js"

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
  唯一的对外请求是 `fetch('/api/stock-bar/...')`。
- **侧边栏页（可选，接 dsh-better-sidebar）**：客户端模块的静态 `inject` 仍然只有 `slots`；better-sidebar
  通过 `ctx.inject(['betterSidebar'], owner => ...)` 等它出现——没装这个插件时回调不执行，顶栏不受影响，
  写进静态 `inject` 反而会让没装的机器整个插件挂起。注册的 tab 用 `id: 'dsh-stock-bar:portfolio'`
  （必须带插件前缀，否则和内置 editor/git/subagent/... 撞名）、`single: true`、`order: 60`；注册包在
  `ctx.effect` 里，禁用/热更新/卸载时自动注销并释放座位。tab 组件就是同一个 `StockTicker`，只是传
  `variant: 'sidebar'`：顶栏是 fixed + `shell.overlay`，侧边栏用 `.dst-side` 的 `height:100%` flex 列
  （宿主 paneBody 是块级滚动容器，根元素得自己撑满、`min-height:0` 才能内部滚动）；面板正文抽成
  `buildPanelBody()` 两处共用。better-sidebar 传的 `visible: false` 会让 `useTicker(active)` 暂停轮询。
  主题变量 `--dst-*` 都定义在 `.dst-theme` 上，`.dst-root` / `.dst-side` 各挂一次，暗色跟随
  `body[data-ds-dark-theme]`。
- **位置**：`shell.overlay` 是 `position:absolute; inset:0; pointer-events:none` 的图层，
  且只有直接子元素才恢复 `pointer-events:auto`。所以条子自己 `position:fixed`，
  顶部偏移取 `--dsh-frame-top-clearance`（Windows 上就是标题栏那 40px）+ 用户可调的 `topOffset`。
- **样式**：`<style data-plugin-css="...">` 只注入一次（按 `data-plugin-css` 去重，HMR 重复执行不会叠加），
  颜色全部走 `--dsw-alias-*` 主题变量并给字面量兜底，红涨绿跌用插件自己的 `--dst-up` / `--dst-down`，
  暗色下由 `body[data-ds-dark-theme]` 覆盖。
- **store 形状**：`{ version, settings, items, trades, alerts, analyses }`。`items`（持仓/自选）和 `trades`（流水）
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
  - 数据窗口可选：K 线支持日K/3日K/5日K/周K/月K 同时喂（`periods` 数组，每个周期各算各的指标与表头；
    3日/5日 是日K 本地聚合，不额外打行情源），分时支持 1/3/5 日（`trendDays`）；
    界面的勾选存在 `settings.aiKline/aiDay3/aiDay5/aiWeek/aiMonth/aiTrendDays`（日K/分时默认开，后补的周期显式勾才喂）。
  - 分时采样按关键时点（09:35…14:57）各取最近一根，多日分时额外给「按日概况」。
  - **多日资金流与持仓成分股**：`fetchFundFlow`（东方财富 fflow/daykline，30 个交易日）给出今日主力/小中大成份、
    3/5/10/20 日主力累计、连续流入/流出天数与最近 5 日逐日；`fetchEtfHoldings`（天天基金 F10 前十大重仓）
    给出权重、今日/5 日主力，两者都进数据包，prompt 里明确「单日主力不能单独定多空、背离要解释」。
    界面对应 `settings.aiFlow` / `aiHoldings`（默认开）。个股没有基金持仓时该段自动省略。
  - **一级市场份额申赎**：`fetchFundShares` 读天天基金 F10 的 `gmbd`（季报：期间申购/赎回/期末份额/净资产，
    **接口必须带 Referer**，否则只回空壳），`fetchFundShareSnapshot` 从行情接口的 `f84` 抓当前总份额；
    宿主按天把快照记进 `portfolio.json` 的 `shareSnapshots`（每只最多 120 天），
    `summarizeShares` 给出最近报告期净申赎 + 快照近 3/5/10/20 日变化（按现价折算成金额），
    数据包里标注「季报频率、快照从哪天开始」，避免模型把季度数据当日内数据用。界面对应 `settings.aiShare`（默认开）。
  - **结构化计划**：*OUTPUT_SPEC* 让模型在正文末尾追加 json 代码块（倾向/置信度/动作/仓位/关键价位+`op`），
    宿主 `parsePlan()` 解析、`stripPlan()` 从展示正文里扣掉，客户端渲染成卡片。
    默认按计划自动设价格预警（`settings.aiAutoAlert`，支撑/失效 `<=`、压力 `>=`，去重并过滤偏离现价 30% 的价位，
    每只最多 4 条）。
  - 每次分析成功写进 `portfolio.json` 的 `analyses`（最多 50 条，`normalizeData` 容错加载），
    记录里额外存 `pack`（当时数据包快照，上限 2 万字）、`promptVersion`、`plan`、`alerts`（自动建预警 id）；
    列表接口只回摘要和 140 字片段（含倾向/置信度/预警数），点开才取全文，`done.recordId` 就是新记录的 id。
    分析状态在客户端提升成模块级单例，切标签页/侧边栏来回不会中断流式输出，也不会丢正文。
    切换自选（`target` 变化）时，如果面板里还是别的标的就自动 `reset()`，避免张冠李戴；
    正文可在 meta 行点「收起/展开」折叠，状态存在 `settings.aiCollapsed`，收起时只留一行摘要。
  - **追问对话**（`POST /ai/chat`）：界面右侧（宽了常驻、窄了叠成抽屉）就这次分析继续问；
    在正文里划选一段会浮出「问 AI」，引用原文带进对话。宽屏默认左右各一半，中间有可拖动的
    分隔条（比例存在 `settings.aiChatSplit`，夹在 0.25–0.75），打开时左右两栏等高、各自内部滚动；
    追问入口放在正文底部（`继续问…`），不占顶部工具行。宿主只喂四样东西——
    被引用的段落、这次分析保存的 `pack` 快照、最近 10 条对话、**提问时现抓的一份实时行情**
    （问「现在多少钱」这类问题不用只回答「数据里没有」），**不重写整篇**；
    system 明确要求「数据包里没有就说没有」。追问必须挂在 `recordId` 上（分析没落库/没跑完时界面禁用），
    成功后由 `appendChat()` 写进 `analyses[i].chats`（一问一答，最多 20 条、单条正文 4000 字），
    历史回看时连对话一起带出来；原复盘正文不会被改写。`done` 事件带 `analysisId` / `text` / `saved`。
  - **自动跟踪**（`settings.autoTrackEnabled`，默认开；`autoTrackTimes` 默认
    `09:35,10:30,11:30,13:35,14:30,15:05`）：宿主每 20 秒对一次表，命中时间点（容差 3 分钟、同一时刻只跑一次）
    就对**持仓**（`shares>0`、非指数）逐只跑自动分析，`15:05` 是完整复盘（多周期 + 资金/成分股/份额，更新预警），
    其余时间点是盘中简报（日K + 分时 + 资金，不重设预警）；记录 `kind:'auto'`、`trigger` 为该时间点，
    历史列表带「自动 15:05」小标记；跑完客户端会在右下角弹一条通知（15 秒轮询最近历史，最多 3 条，
    点开直达全文并切到对应标的）。定时器挂在 `ctx.effect` 上，插件卸载/重载自动清掉；周末休市跳过。
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
对应目标是 `data/plugins/NoCandles__dsh-stock-bar.yml`（该列表一个插件一个 YAML 文件，README 由脚本生成）。

