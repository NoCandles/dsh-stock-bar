/**
 * dsh-stock-bar / lib/client.js  —— Client(浏览器)半边
 *
 * 顶部状态栏行情条：注册进 frame 级 `shell.overlay` 槽位，自己在 CSS 里把它钉在
 * 窗口最顶端（类似 Windows 任务栏 / 桌面歌词那种常驻条）。
 *
 * 数据来自本插件 Host 半边的同源路由 /api/stock-bar/*。
 * 遵循 DSH Client 插件规范：
 *   - 只使用 window.__ModuleLoader__.load({ id, factory }) 包裹，id 必须等于包名
 *   - React 由 require('react') 从宿主模块表取得，不打包第二份 React
 *   - 不使用 @deepseek-ai/* 客户端包（无类型检查，抛错会打空整个槽位）
 *   - 样式只用主题 token（--dsw-alias-*）+ 自带回退色；红涨绿跌为业务语义色
 *   - 所有副作用（样式、定时器、监听）都在 apply 内建立
 */
window.__ModuleLoader__.load({
  id: 'dsh-stock-bar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    // 顶栏停靠栈需要把胶囊 portal 到共享容器里；离线 SSR 测试拿不到 DOM 时降级为原地渲染
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch { /* 没有 react-dom 就降级 */ }
    const createPortal = ReactDOM && typeof ReactDOM.createPortal === 'function'
      ? ReactDOM.createPortal : null;

    /* ---------- 顶栏停靠栈（与「每日一关」插件共用的约定） ----------
     * DSH 没有 topbar slot，顶部 40px 是 Windows 标题栏拖拽区。
     * 谁都不许各写各的 right:Npx 抢坐标：大家把自己那一小块 portal 进同一个
     * `#dsh-topbar-dock` flex 容器，用 `order` 排队（本插件 40 → 左，每日一关 90 → 右），
     * 别人装多少顶栏组件都不会重叠。容器按引用计数创建/销毁，插件卸载后不留垃圾节点。 */
    const TOPBAR_DOCK_ID = 'dsh-topbar-dock';

    function acquireTopbarDock() {
      if (typeof document === 'undefined' || !document.body) return null;
      let el = document.getElementById(TOPBAR_DOCK_ID);
      if (!el) {
        el = document.createElement('div');
        el.id = TOPBAR_DOCK_ID;
        el.setAttribute('data-dsh-topbar-dock', '');
        document.body.appendChild(el);
      }
      el.__dshTopbarCount = (el.__dshTopbarCount || 0) + 1;
      return el;
    }

    function releaseTopbarDock(el) {
      if (!el) return;
      el.__dshTopbarCount = Math.max(0, (el.__dshTopbarCount || 1) - 1);
      if (el.__dshTopbarCount === 0 && el.parentNode) el.parentNode.removeChild(el);
    }

    /* 把子节点 portal 进停靠栈；容器不存在 / 无 createPortal 时原地渲染 */
    function TopbarSlot(props) {
      const [host, setHost] = useState(null);
      useEffect(() => {
        const el = acquireTopbarDock();
        if (el) setHost(el);
        return () => releaseTopbarDock(el);
      }, []);
      if (!host || !createPortal) return props.children;
      return createPortal(props.children, host);
    }

    /* ============================================================ *
     * 常量与工具
     * ============================================================ */

    const API = '/api/stock-bar';
    const PERIODS = [
      ['1m', '1分'], ['5m', '5分'], ['15m', '15分'], ['30m', '30分'],
      ['60m', '60分'], ['day', '日K'], ['week', '周K'], ['month', '月K'],
    ];
    const ADJUSTS = [['pre', '前复权'], ['none', '不复权'], ['post', '后复权']];

    const CSS = `
/* 主题变量单独一份：顶栏（.dst-root）和侧边栏页（.dst-side）共用，
   这样在 dsh-better-sidebar 里打开时颜色也跟 DSH 皮肤一致 */
.dst-theme{--dst-up:#e5484d;--dst-down:#0f9d6e;--dst-flat:var(--dsw-alias-label-tertiary,#8b949e);
  /* --dst-bg 跟主题走，但它可能是半透明的图层色；凡是需要「不透明」的地方
     （面板、表格）都用 --dst-base 垫底，再把 --dst-bg 叠上去一层渐变。
     这样皮肤换了照样跟色，但底下的正文永远不会透过来。 */
  --dst-base:#ffffff;
  /* 盖在 K 线上的浮层（均线读数）用的半透明底垫：太实会挡住 K 线，太透会看不清字 */
  --dst-base-a:rgba(255,255,255,.82);
  --dst-bg:var(--dsw-alias-bg-layer-2,#ffffff);--dst-fg:var(--dsw-alias-label-primary,#1f2328);
  --dst-dim:var(--dsw-alias-label-tertiary,#8b949e);
  --dst-border:var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  --dst-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));
  --dst-sel:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08));
  /* 成本线用品牌色：红绿已经被涨跌占用了，再借就会看混 */
  --dst-cost:var(--dsw-alias-brand-primary,#6b5ce7);
  --dst-cost-bg:rgba(107,92,231,.12);
  --dst-limit-up-bg:rgba(229,72,77,.13);
  --dst-limit-down-bg:rgba(15,157,110,.13);
  font-family:var(--dsw-font,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);
  font-variant-numeric:tabular-nums;font-size:12px;line-height:1.35;color:var(--dst-fg);box-sizing:border-box}
.dst-root{position:fixed;left:0;right:0;z-index:1200;pointer-events:none}
body[data-ds-dark-theme] .dst-theme{--dst-up:#ff6b6b;--dst-down:#2fd08a;
  --dst-cost-bg:rgba(107,92,231,.22);
  --dst-limit-up-bg:rgba(255,107,107,.17);
  --dst-limit-down-bg:rgba(47,208,138,.17);
  --dst-base:#1b1d22;
  --dst-base-a:rgba(27,29,34,.84);
  --dst-bg:var(--dsw-alias-bg-layer-2,#1c1f24);--dst-fg:var(--dsw-alias-label-primary,#e6e6e6);
  --dst-border:var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  --dst-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));
  --dst-sel:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12))}
.dst-root *{box-sizing:border-box}
/* 顶栏停靠栈容器（与「每日一关」插件的约定，两边样式必须一致；先到者创建，后来者复用） */
#dsh-topbar-dock{position:fixed;z-index:1200;
  display:flex;align-items:center;gap:8px;
  right:150px;   /* 给 Windows 最小化/最大化/关闭按钮让位 */
  top:calc((var(--dsh-windows-titlebar-height, var(--dsh-frame-top-clearance, 40px)) - 28px) / 2);
  pointer-events:none;   /* 容器本身不吃点击，只有里面的胶囊吃 */
  height:28px}
#dsh-topbar-dock > *{pointer-events:auto}
/* 折叠态：注册进共享顶栏停靠栈（见文件顶部 acquireTopbarDock）。
   它现在是容器里的一个 flex 项，位置由 flex 队列 + order 决定，不再自己算 top/right，
   所以别的插件也往顶栏放东西时不会重叠。
   默认半透明，鼠标凑近才变实——不用它的时候几乎看不见，也就不挡任何东西。 */
.dst-dock{position:relative;order:40;display:flex;align-items:center;gap:6px;height:28px;
  padding:0 10px;border-radius:999px;border:1px solid var(--dst-border);background:var(--dst-bg);
  box-shadow:0 1px 6px rgba(0,0,0,.14);cursor:pointer;pointer-events:auto;
  opacity:.55;transition:opacity .16s ease,box-shadow .16s ease;
  -webkit-app-region:no-drag;user-select:none;white-space:nowrap;max-width:40vw;overflow:hidden}
.dst-dock:hover,.dst-dock:focus-visible{opacity:1;box-shadow:0 2px 10px rgba(0,0,0,.22)}
.dst-dock .dst-dock-icon{font-size:13px;line-height:1}
.dst-dock .dst-dock-x{opacity:.5;font-size:11px;padding:0 2px}
.dst-dock:hover .dst-dock-x{opacity:.9}
/* 涨停/跌停：胶囊底色 + 一个小角标 */
.dst-chip-up{background:var(--dst-limit-up-bg)!important;border-color:var(--dst-up)!important}
.dst-chip-down{background:var(--dst-limit-down-bg)!important;border-color:var(--dst-down)!important}
.dst-limit{font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;color:#fff;font-weight:600;letter-spacing:.02em}
.dst-limit-up{background:var(--dst-up)}
.dst-limit-down{background:var(--dst-down)}
.dst-cell-limit{font-weight:700;border-radius:4px;padding:0 4px}
.dst-cell-limit-up{background:var(--dst-limit-up-bg)}
.dst-cell-limit-down{background:var(--dst-limit-down-bg)}
/* 持仓成本摘要：图表上方那一行 */
.dst-cost-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  margin:-2px 0 6px;padding:5px 8px;border-radius:6px;
  background:var(--dst-cost-bg);border-left:3px solid var(--dst-cost);font-size:12px}
.dst-cost-line .dst-cost-k{color:var(--dst-dim)}
.dst-cost-line b{font-weight:600}
.dst-up{color:var(--dst-up)}
.dst-down{color:var(--dst-down)}
.dst-flat{color:var(--dst-flat)}

/* ---------- 顶部条 ---------- */
/* 关键改动：不再拉满整行铺成一条压住应用内容的横带。
   现在是左上角一张圆角浮卡，宽度跟着内容走（fit-content），只盖住它真正显示的那一块；
   卡片本身 pointer-events:none，只有里面的胶囊/按钮吃鼠标，空白处直接穿透到底下的界面。
   空闲时轻微透明，鼠标进来或面板展开才完全实心。 */
.dst-bar{pointer-events:none;position:relative;z-index:1200;display:flex;align-items:center;gap:6px;height:32px;
  padding:0 6px 0 4px;margin:6px 10px 0;width:fit-content;max-width:calc(100vw - 20px);
  background-color:var(--dst-base);
  background-image:linear-gradient(var(--dst-bg),var(--dst-bg));
  border:1px solid var(--dst-border);border-radius:10px;overflow:hidden;
  box-shadow:0 4px 16px rgba(0,0,0,.12);
  /* 别让 Electron 把行情条当成窗口拖窗区，否则拖它会变成拖整个窗口 */
  -webkit-app-region:no-drag;
  opacity:.9;transition:opacity .16s ease,box-shadow .16s ease}
.dst-bar:hover,.dst-bar:focus-within{opacity:1;box-shadow:0 8px 26px rgba(0,0,0,.20)}
.dst-bar > *{pointer-events:auto}
.dst-bar.dst-dragging{opacity:1;box-shadow:0 10px 30px rgba(0,0,0,.28);cursor:grabbing;
  transition:none;user-select:none}
.dst-bar.dst-dragging *{pointer-events:none}
/* 拖动把手：⋮⋮，按住它整条跟着走（做小但别小到点不着，18px 见方） */
.dst-drag{flex:none;display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;
  color:var(--dst-dim);font-size:12px;letter-spacing:0;line-height:1;
  min-width:18px;height:22px;padding:0 3px;border-radius:5px;text-align:center;
  -webkit-app-region:no-drag;touch-action:none}
.dst-drag:hover{color:var(--dst-fg);background:var(--dst-hover)}
.dst-bar.dst-dragging .dst-drag{cursor:grabbing;color:var(--dst-fg)}
.dst-brand{display:flex;align-items:center;gap:5px;flex:none;font-weight:600;
  padding-right:8px;border-right:1px solid var(--dst-border);cursor:pointer;user-select:none}
.dst-brand:hover{color:var(--dsw-alias-brand-primary,#3b82f6)}
.dst-dot{width:6px;height:6px;border-radius:50%;background:var(--dst-flat);flex:none}
.dst-dot.dst-live{background:var(--dst-down);box-shadow:0 0 0 3px rgba(47,208,138,.18)}
.dst-session{color:var(--dst-dim);font-size:11px;flex:none}
.dst-track{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;
  display:flex;align-items:center;gap:2px;white-space:nowrap;cursor:grab}
.dst-track:active{cursor:grabbing}
.dst-track::-webkit-scrollbar{display:none}
.dst-chip{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;
  padding:1px 7px;border-radius:5px;border:1px solid transparent;transition:background .12s}
.dst-chip:hover{background:var(--dst-hover)}
.dst-chip.dst-active{background:var(--dst-sel);border-color:var(--dst-border)}
.dst-chip[draggable="true"]{cursor:grab}
.dst-chip[draggable="true"]:active{cursor:grabbing}
.dst-chip.dst-dragging{opacity:.4;outline:1px dashed var(--dst-dim)}
.dst-chip.dst-drop-before{box-shadow:-3px 0 0 0 var(--dst-up);filter:brightness(1.18)}
.dst-chip.dst-drop-after{box-shadow:3px 0 0 0 var(--dst-up);filter:brightness(1.18)}
.dst-chip-name{font-weight:500;max-width:7.5em;overflow:hidden;text-overflow:ellipsis}
.dst-chip-code{color:var(--dst-dim);font-size:11px}
.dst-chip-price{font-weight:600;transition:background .5s}
.dst-flash-up{background:rgba(229,72,77,.22);border-radius:3px}
.dst-flash-down{background:rgba(15,157,110,.22);border-radius:3px}
.dst-actions{display:flex;align-items:center;gap:2px;flex:none;
  padding-left:8px;border-left:1px solid var(--dst-border)}
.dst-btn{pointer-events:auto;cursor:pointer;border:1px solid transparent;background:none;
  color:var(--dst-fg);font:inherit;font-size:12px;border-radius:5px;padding:2px 6px;line-height:1.4}
.dst-btn:hover{background:var(--dst-hover)}
.dst-btn.dst-on{background:var(--dst-sel);border-color:var(--dst-border)}
.dst-total{display:flex;align-items:center;gap:6px;flex:none;padding:0 8px;
  border-left:1px solid var(--dst-border);cursor:pointer}
.dst-total-label{color:var(--dst-dim);font-size:11px}

/* ---------- 面板 ---------- */
/* 面板是「浮窗」不是「横带」：居中、限宽、圆角、独立不透明底，
   绝不受顶栏那条的 opacity 影响（之前整棵 .dst-root 带 opacity，
   一调透明度就连面板里的表格一起变透，正文从底下透上来）。 */
.dst-panel{pointer-events:auto;position:fixed;left:50%;transform:translateX(-50%);z-index:1201;
  width:min(1180px,calc(100vw - 20px));
  max-height:min(74vh,760px);display:flex;flex-direction:column;
  background-color:var(--dst-base);
  background-image:linear-gradient(var(--dst-bg),var(--dst-bg));
  border:1px solid var(--dst-border);border-radius:12px;
  box-shadow:0 18px 60px rgba(0,0,0,.34);overflow:hidden;
  opacity:1;animation:dst-popin .14s ease-out}
@keyframes dst-popin{
  from{opacity:0;transform:translateX(-50%) translateY(-8px)}
  to{opacity:1;transform:translateX(-50%) translateY(0)}}
.dst-panel-head{display:flex;align-items:center;gap:8px;padding:7px 10px;flex:none;
  border-bottom:1px solid var(--dst-border);
  background-color:var(--dst-base);
  background-image:linear-gradient(var(--dst-bg),var(--dst-bg))}
.dst-panel-title{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px}
.dst-panel-close{margin-left:auto;flex:none}
.dst-tabs{display:flex;align-items:center;gap:4px;padding:6px 8px;
  border-bottom:1px solid var(--dst-border);flex:none;overflow-x:auto;scrollbar-width:none;
  background-color:var(--dst-base);
  background-image:linear-gradient(var(--dst-bg),var(--dst-bg))}
.dst-tabs::-webkit-scrollbar{display:none}
.dst-tab{cursor:pointer;border:none;background:none;color:var(--dst-dim);font:inherit;
  font-size:12px;padding:4px 10px;border-radius:6px}
.dst-tab:hover{background:var(--dst-hover)}
.dst-tab.dst-on{color:var(--dst-fg);background:var(--dst-sel);font-weight:600}
.dst-spacer{flex:1}
.dst-body{overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px}

/* ---------- 表格 ---------- */
/* 表格外面套一层圆角容器：表头粘顶、条纹隔行、选中行左侧一道品牌色竖条，
   数字列统一等宽数字对齐，长列表更容易扫读。 */
.dst-tablewrap{border:1px solid var(--dst-border);border-bottom:none;
  border-radius:10px 10px 0 0;overflow:auto;
  background-color:var(--dst-base);
  background-image:linear-gradient(var(--dst-bg),var(--dst-bg))}
.dst-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
.dst-table th{text-align:right;color:var(--dst-dim);font-weight:500;font-size:11px;
  padding:6px 8px;border-bottom:1px solid var(--dst-border);position:sticky;top:0;z-index:1;
  background-color:var(--dst-base);
  background-image:linear-gradient(var(--dst-bg),var(--dst-bg));
  white-space:nowrap;user-select:none}
.dst-table th.dst-th-sort{cursor:pointer}
.dst-table th.dst-th-sort:hover{color:var(--dst-fg)}
.dst-th-arrow{margin-left:3px;font-size:9px;opacity:.75}
.dst-table th:first-child,.dst-table td:first-child{text-align:left}
.dst-table td{padding:6px 8px;border-bottom:1px solid var(--dst-border);text-align:right;
  white-space:nowrap;font-variant-numeric:tabular-nums}
.dst-table tbody tr:last-child td{border-bottom:none}
.dst-table tbody tr{cursor:pointer}
.dst-table tbody tr:nth-child(even){background:rgba(127,127,127,.06)}
.dst-table tbody tr:hover{background:var(--dst-hover)}
.dst-table tbody tr.dst-rowsel{background:var(--dst-sel);box-shadow:inset 2px 0 0 var(--dst-cost)}
.dst-name{font-weight:500}
.dst-tag{color:var(--dst-dim);font-size:10px;margin-left:5px;padding:3px 6px;
  border:1px solid var(--dst-border);border-radius:4px;line-height:1;display:inline-block;
  white-space:nowrap;flex:none;vertical-align:middle}
/* 涨跌幅底下的量级条：细 3px 走右侧增长，颜色继承单元格的涨跌色，
   比在数字底下铺色块更清楚——数字不会被染色糊住，强弱量级照样一眼可比。 */
.dst-pctbar{position:relative;display:inline-block;min-width:58px;padding-bottom:4px;
  text-align:right}
.dst-pctbar::before{content:'';position:absolute;left:0;right:0;bottom:0;height:3px;
  border-radius:2px;background:currentColor;opacity:.12}
.dst-pctbar i{position:absolute;right:0;bottom:0;height:3px;border-radius:2px;
  background:currentColor;opacity:.6;pointer-events:none}
.dst-pctbar > span{position:relative}
/* 表格工具条：搜索 + 计数 */
.dst-tablebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 2px 6px}
.dst-search{display:flex;align-items:center;gap:5px;flex:0 1 220px;min-width:120px;
  padding:3px 8px;border:1px solid var(--dst-border);border-radius:8px}
.dst-search input{border:none;background:transparent;color:inherit;font:inherit;
  outline:none;padding:1px 0;width:100%;min-width:0}
.dst-search-x{cursor:pointer;color:var(--dst-dim);font-size:11px;padding:0 2px}
.dst-search-x:hover{color:var(--dst-fg)}
.dst-count{color:var(--dst-dim);font-size:11px;white-space:nowrap}
/* 表格底部汇总行 */
.dst-quote{display:flex;flex-direction:column;min-width:0}
.dst-tablefoot{display:flex;gap:16px;flex-wrap:wrap;padding:7px 10px;
  border:1px solid var(--dst-border);border-top:none;border-radius:0 0 10px 10px;
  font-size:11px;color:var(--dst-dim);
  background-color:var(--dst-base);
  background-image:linear-gradient(var(--dst-bg),var(--dst-bg))}
.dst-tablefoot b{font-weight:600;color:var(--dst-fg)}
.dst-empty{color:var(--dst-dim);text-align:center;padding:28px 12px;font-size:12px;line-height:1.9}
.dst-empty-ico{font-size:22px;display:block;margin-bottom:6px;opacity:.65}

/* ---------- K线 ---------- */
.dst-kline{position:relative;border:1px solid var(--dst-border);border-radius:8px;
  overflow:hidden;flex:none;
  background-color:var(--dst-base);
  background-image:linear-gradient(var(--dst-bg),var(--dst-bg))}
.dst-kline canvas{display:block;width:100%;cursor:crosshair}
.dst-kline-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:6px 8px;border-bottom:1px solid var(--dst-border)}
.dst-kline-title{font-weight:600}
.dst-zoom-hint{font-size:11px;white-space:nowrap;cursor:help}
.dst-kline-sel{position:absolute;top:0;bottom:0;z-index:3;pointer-events:none;
  background:rgba(59,157,255,.16);border-left:1px solid rgba(59,157,255,.75);
  border-right:1px solid rgba(59,157,255,.75)}
/* 时间轴总览条：整条 = 已加载的全部K线，蓝色窗口 = 当前放大到的区间。
   不放大时窗口铺满整条（等于「全部」）；窗口两端的手柄可以直接拖，改颗粒度。
   点窗口外面、按「全部」、或双击图表都回到全部。
   排两行：第一行只有「日期 — 轨道 — 日期」，第二行放当前区间和「全部」按钮，
   这样窄面板里日期变长（带年份）也不会把右边那截挤出去。
   轨道做高一点（20px）、手柄加宽到 12px 并上下探出轨道 —— 12px 高的轨道配 8px 手柄
   太细，手指/鼠标容易点偏，一点偏就变成「点空白回到全部」，把刚框好的区间弄丢。 */
.dst-timeline{display:flex;flex-direction:column;gap:4px;padding:7px 8px 3px;font-size:11px}
.dst-timeline-row{display:flex;align-items:center;gap:8px;min-width:0}
.dst-timeline-cap{color:var(--dst-dim);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}
.dst-timeline-track{position:relative;flex:1 1 120px;min-width:60px;height:20px;border-radius:10px;
  background:var(--dst-hover);cursor:pointer}
.dst-timeline-win{position:absolute;top:0;bottom:0;border-radius:10px;box-sizing:border-box;
  background:rgba(59,157,255,.34);border:1px solid rgba(59,157,255,.8);cursor:grab}
.dst-timeline-win:active{cursor:grabbing}
.dst-timeline-win.dst-full{background:rgba(59,157,255,.16);border-color:rgba(59,157,255,.42)}
/* 窗口两端的手柄：拖它们改范围（颗粒度），中间是平移。
   12px 宽、上下各探出 5px（整体 30px 高），比窗边那 1px 的边框好抓得多 */
.dst-timeline-grip{position:absolute;top:-5px;bottom:-5px;width:12px;border-radius:4px;
  background:rgba(59,157,255,.55);cursor:ew-resize}
.dst-timeline-grip:hover{background:rgba(59,157,255,.95)}
.dst-timeline-grip.dst-l{left:-6px}
.dst-timeline-grip.dst-r{right:-6px}
/* 当前区间那行：文字太长就省略，别把「全部」按钮挤出去 */
.dst-timeline-now{color:var(--dst-fg);flex:1 1 auto;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dst-timeline-all{flex:none;cursor:pointer;border:1px solid var(--dst-border);background:none;
  color:var(--dst-dim);font:inherit;font-size:11px;padding:1px 7px;border-radius:5px}
.dst-timeline-all:hover{background:var(--dst-hover);color:var(--dst-fg)}
.dst-timeline-all[disabled]{cursor:default;opacity:.45}
.dst-seg{display:flex;gap:2px;flex-wrap:wrap}
.dst-seg button{cursor:pointer;border:1px solid transparent;background:none;color:var(--dst-dim);
  font:inherit;font-size:11px;padding:2px 7px;border-radius:5px}
.dst-seg button:hover{background:var(--dst-hover)}
.dst-seg button.dst-on{color:var(--dst-fg);background:var(--dst-sel);border-color:var(--dst-border);font-weight:600}
.dst-tip{position:absolute;pointer-events:none;background:var(--dsw-alias-tooltip-bg,rgba(20,22,26,.92));
  color:var(--dsw-alias-toast-label,#f5f5f5);border-radius:6px;padding:5px 8px;font-size:11px;
  line-height:1.5;white-space:nowrap;z-index:5;box-shadow:0 4px 14px rgba(0,0,0,.3)}
/* 图例：默认是画布下面那行（分时图用）；
   .dst-legend-float 是浮在画布左上角的版本（K 线均线读数用），
   半透明底垫保证线从底下过也读得清。 */
.dst-legend{display:flex;gap:10px;font-size:11px;color:var(--dst-dim);flex-wrap:wrap;
  padding:4px 8px;align-items:center}
.dst-legend-float{position:absolute;left:7px;top:5px;z-index:2;gap:9px;
  padding:2px 6px;border-radius:6px;pointer-events:none;
  background:var(--dst-base-a);box-shadow:0 1px 3px rgba(0,0,0,.06);
  max-width:calc(100% - 62px)}
.dst-kline-plot{position:relative}
.dst-legend i{display:inline-block;width:8px;height:2px;vertical-align:middle;margin-right:3px}
.dst-legend-item{white-space:nowrap}
.dst-legend-val{font-weight:600;font-variant-numeric:tabular-nums;margin-left:3px}
.dst-legend-when{opacity:.8}

/* ---------- 表单 ---------- */
.dst-form{display:flex;gap:6px;align-items:center;flex-wrap:wrap;
  padding:8px;border:1px solid var(--dst-border);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dst-input{color:var(--dst-fg);background:var(--dsw-alias-bg-base,transparent);
  border:1px solid var(--dst-border);border-radius:6px;padding:4px 8px;font:inherit;font-size:12px;min-width:0}
.dst-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b82f6)}
.dst-input.dst-num{width:88px;text-align:right}
/* 副图指标选择器：带一个小标签，否则只显示 MACD 没人知道这是什么 */
.dst-sub-pick{display:inline-flex;align-items:center;gap:6px}
.dst-sub-pick>span{font-size:11px;color:var(--dst-dim)}
.dst-input.dst-search{width:210px}
.dst-btn-primary{cursor:pointer;border:1px solid transparent;font:inherit;font-size:12px;
  border-radius:6px;padding:4px 12px;background:var(--dsw-alias-button-primary-fill,#2563eb);
  color:var(--dsw-alias-label-primary-foreground,#fff)}
.dst-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#1d4ed8)}
.dst-btn-ghost{cursor:pointer;border:1px solid var(--dst-border);background:none;color:var(--dst-fg);
  font:inherit;font-size:12px;border-radius:6px;padding:4px 10px}
.dst-btn-ghost:hover{background:var(--dst-hover)}
.dst-hits{position:absolute;z-index:6;margin-top:2px;background:var(--dst-bg);
  border:1px solid var(--dst-border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.22);
  max-height:250px;overflow:auto;min-width:260px}
.dst-hit{display:flex;gap:8px;align-items:center;padding:6px 10px;cursor:pointer}
.dst-hit:hover{background:var(--dst-hover)}
.dst-hit-code{color:var(--dst-dim);font-size:11px;min-width:56px}
.dst-err{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px}
.dst-err-badge{
  flex:none;cursor:pointer;font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;
  color:var(--dsw-alias-state-error-primary,#e5484d);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 45%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 12%,transparent);
}
.dst-err-badge:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 22%,transparent)}
.dst-warn{color:var(--dsw-alias-state-warn-label,#b45309);font-size:11px}
.dst-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dst-field{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dst-dim)}
.dst-note{color:var(--dst-dim);font-size:11px;line-height:1.6}
.dst-muted{color:var(--dst-dim)}
.dst-table tbody tr.dst-hit-row{background:color-mix(in srgb,var(--dst-up) 12%,transparent)}

/* ---------- 五档盘口 ---------- */
.dst-book{border:1px solid var(--dst-border);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);
  padding:8px;font-size:11px;font-variant-numeric:tabular-nums}
.dst-book-head,.dst-book-foot{display:flex;align-items:center;gap:8px;color:var(--dst-dim);
  padding:2px 4px;font-size:11px}
.dst-book-head{font-weight:600;color:var(--dst-fg);margin-bottom:4px}
.dst-book-foot{margin-top:4px;border-top:1px solid var(--dst-border);padding-top:5px}
.dst-book-sides{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dst-book-col{display:flex;flex-direction:column;gap:1px}
.dst-book-row{position:relative;display:grid;grid-template-columns:34px 1fr auto;gap:6px;
  align-items:center;padding:2px 4px;border-radius:4px;overflow:hidden}
.dst-book-lv{color:var(--dst-dim)}
.dst-book-bar{position:absolute;right:0;top:0;bottom:0;z-index:0;border-radius:4px;opacity:.16}
.dst-book-ask .dst-book-bar{background:var(--dst-up)}
.dst-book-bid .dst-book-bar{background:var(--dst-down)}
.dst-book-ask .dst-book-px{color:var(--dst-up)}
.dst-book-bid .dst-book-px{color:var(--dst-down)}
.dst-book-px,.dst-book-vol{position:relative;z-index:1}
.dst-book-vol{color:var(--dst-dim);text-align:right}

/* ---------- 预警提示 ---------- */
.dst-toasts{position:fixed;right:16px;bottom:16px;z-index:1300;display:flex;flex-direction:column;
  gap:8px;max-width:min(340px,calc(100vw - 32px));pointer-events:auto}
.dst-toast{display:flex;gap:8px;align-items:flex-start;padding:9px 10px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dst-border);
  box-shadow:0 10px 28px rgba(0,0,0,.24);font-size:12px;color:var(--dst-fg)}
.dst-toast-icon{font-size:14px;line-height:1.2}
.dst-toast-body{flex:1;min-width:0;line-height:1.5}
.dst-toast-x{cursor:pointer;border:none;background:none;color:var(--dst-dim);font:inherit;padding:0 2px}
.dst-toast-x:hover{color:var(--dst-fg)}
.dst-toast-advice{margin-top:3px;padding:3px 6px;border-radius:4px;font-size:11px;
  background:rgba(255,196,0,.14);color:var(--dst-warn,#b8860b);line-height:1.45}
.dst-notice{cursor:pointer;border-left:3px solid var(--dst-accent,#4a8cff)}
.dst-notice:hover{border-color:var(--dst-accent,#4a8cff);box-shadow:0 12px 32px rgba(0,0,0,.3)}
.dst-notice .dst-toast-body b{font-size:11px;color:var(--dst-accent,#4a8cff)}
.dst-notice-hint{margin-top:2px;font-size:10px;color:var(--dst-dim)}

/* ---------- 流水 / 预警列表 ---------- */
.dst-sub{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 2px;font-size:11px;color:var(--dst-dim)}
.dst-sub b{color:var(--dst-fg)}
/* 设置页里的分组小标题，用来把「组件开关」和「标签页开关」分开 */
.dst-group-title{font-size:11px;font-weight:600;color:var(--dst-dim);letter-spacing:.4px;
  padding:2px 0 0;border-top:1px solid var(--dst-border);margin-top:2px}
.dst-sum{display:flex;gap:14px;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--dst-border);
  border-radius:8px;font-size:11px;color:var(--dst-dim);background:var(--dsw-alias-bg-layer-1,transparent)}
.dst-sum b{font-variant-numeric:tabular-nums}
.dst-seg{display:inline-flex;border:1px solid var(--dst-border);border-radius:6px;overflow:hidden}
.dst-seg button{cursor:pointer;border:none;background:none;color:var(--dst-dim);font:inherit;
  font-size:11px;padding:3px 9px}
.dst-seg button+button{border-left:1px solid var(--dst-border)}
.dst-seg button.dst-on{background:var(--dst-sel);color:var(--dst-fg)}
.dst-pill{display:inline-block;padding:1px 6px;border-radius:999px;font-size:10px;
  border:1px solid var(--dst-border);color:var(--dst-dim)}
.dst-pill.dst-on{color:var(--dsw-alias-label-primary-foreground,#fff);
  background:var(--dsw-alias-button-primary-fill,#2563eb);border-color:transparent}
.dst-pill.dst-hit{color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dst-up);border-color:transparent}
.dst-tabs-scroll{overflow-x:auto}

/* ---------- AI 分析 ---------- */
.dst-ai-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 2px}
.dst-ai-bar select,.dst-ai-bar input[type=text]{font:inherit;font-size:11px;padding:3px 6px;
  border:1px solid var(--dst-border);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#fff);
  color:var(--dst-fg);max-width:240px}
.dst-ai-bar input[type=text].dst-ai-extra{flex:1;min-width:140px;max-width:none}
.dst-ai-toggle{display:inline-flex;gap:4px;align-items:center;font-size:11px;color:var(--dst-dim);cursor:pointer}
.dst-ai-out{margin-top:8px;border:1px solid var(--dst-border);border-radius:8px;padding:10px 12px;
  background:var(--dsw-alias-bg-layer-1,transparent);font-size:12px;line-height:1.72;color:var(--dst-fg);
  max-height:52vh;overflow:auto;white-space:normal;position:relative}
.dst-ai-out.dst-ai-chatopen{display:flex;gap:10px;align-items:stretch}
.dst-ai-out.dst-ai-chatopen.dst-ai-wide{height:56vh;max-height:56vh;overflow:hidden}
.dst-ai-read{flex:1 1 0;min-width:0;position:relative}
.dst-ai-out.dst-ai-chatopen.dst-ai-wide .dst-ai-read{overflow:auto;padding-right:2px}
.dst-ai-selbubble{position:sticky;top:0;z-index:2;display:flex;gap:8px;align-items:center;flex-wrap:wrap;
  margin:0 0 6px;padding:6px 8px;border-radius:8px;font-size:10px;color:var(--dst-fg);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary,#2563eb) 10%, var(--dst-bg));
  border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#2563eb) 30%, transparent)}
.dst-ai-splitbar{flex:0 0 10px;align-self:stretch;cursor:col-resize;position:relative;border-radius:6px}
.dst-ai-splitbar::before{content:'';position:absolute;left:50%;top:0;bottom:0;width:2px;transform:translateX(-50%);
  border-radius:2px;background:var(--dst-border);transition:background .15s}
.dst-ai-splitbar:hover::before{background:var(--dsw-alias-brand-primary,#2563eb)}
.dst-ai-chat{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:6px;font-size:11px;
  border-left:1px solid var(--dst-border);padding-left:10px;align-self:stretch;max-height:none}
.dst-ai-out:not(.dst-ai-wide) .dst-ai-chat{position:absolute;right:8px;top:8px;bottom:8px;width:min(88%,320px);
  background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dst-border);border-radius:8px;
  padding:8px 10px;box-shadow:0 6px 24px rgba(0,0,0,.18);max-height:none;z-index:3}
.dst-ai-askentry{display:flex;align-items:center;gap:6px;width:100%;margin-top:10px;padding:7px 10px;
  position:sticky;bottom:-4px;z-index:1;cursor:pointer;text-align:left;font:inherit;font-size:11px;
  color:var(--dst-dim);border:1px dashed var(--dst-border);border-radius:8px;background:transparent;
  backdrop-filter:blur(6px)}
.dst-ai-askentry:hover{color:var(--dst-fg);border-color:var(--dsw-alias-brand-primary,#2563eb)}
.dst-ai-chathead{display:flex;gap:8px;align-items:center;font-size:11px}
.dst-ai-chathead .dst-pill{margin-left:auto;cursor:pointer}
.dst-ai-quote{display:flex;gap:6px;align-items:flex-start;padding:6px 8px;border-radius:6px;font-size:10px;
  color:var(--dst-dim);background:color-mix(in srgb,var(--dst-fg) 5%,transparent);max-height:84px;overflow:auto}
.dst-ai-quote span{flex:1;min-width:0}
.dst-ai-quote button{cursor:pointer;flex:none}
.dst-ai-msgs{flex:1 1 auto;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:40px}
.dst-ai-msg{max-width:100%;padding:6px 8px;border-radius:8px;font-size:11px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word}
.dst-ai-msg-user{align-self:flex-end;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 12%,transparent)}
.dst-ai-msg-ai{align-self:flex-start;background:color-mix(in srgb,var(--dst-fg) 4%,transparent)}
.dst-ai-msgquote{margin-bottom:4px;padding:3px 6px;border-left:2px solid var(--dst-border);
  color:var(--dst-dim);font-size:10px;max-height:64px;overflow:auto}
.dst-ai-chatbar{display:flex;gap:6px;align-items:center}
.dst-ai-chatbar input{flex:1;min-width:0}
.dst-ai-h{font-weight:600;margin:10px 0 4px;font-size:12px;color:var(--dsw-alias-brand-primary,var(--dst-fg))}
.dst-ai-h:first-child{margin-top:0}
.dst-ai-p{margin:3px 0}
.dst-ai-ul{margin:3px 0;padding-left:18px}
.dst-ai-ul li{margin:2px 0}
.dst-ai-strong{color:var(--dst-fg);font-weight:600}
.dst-ai-up{color:var(--dst-up)}
.dst-ai-down{color:var(--dst-down)}
.dst-ai-cursor{display:inline-block;width:7px;height:13px;vertical-align:-2px;margin-left:2px;
  background:var(--dsw-alias-brand-primary,#2563eb);animation:dst-blink .9s steps(2,start) infinite}
@keyframes dst-blink{to{visibility:hidden}}
.dst-ai-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:10px;color:var(--dst-dim);padding:2px 0 6px}
.dst-ai-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows .18s ease}
.dst-ai-bodyfold{grid-template-rows:0fr}
.dst-ai-bodyinner{overflow:hidden;min-height:0}
.dst-ai-foldhint{padding:2px 0 4px;font-size:10px;color:var(--dst-dim);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.dst-ai-plan{margin:2px 0 8px;padding:8px 10px;border:1px solid var(--dst-border);border-radius:8px;
  background:color-mix(in srgb, var(--dst-fg) 3%, transparent);font-size:11px}
.dst-ai-planhead{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.dst-ai-planhead b{font-size:12px}
.dst-ai-levels{display:grid;grid-template-columns:1fr auto auto;gap:2px 10px;margin-top:6px;
  font-variant-numeric:tabular-nums}
.dst-ai-level{display:contents}
.dst-ai-level span:first-child{color:var(--dst-dim)}
.dst-ai-level b{text-align:right}
.dst-ai-level span:last-child{font-size:10px;color:var(--dst-dim)}
.dst-ai-planfoot{margin-top:6px;font-size:10px;color:var(--dst-dim)}
.dst-ai-snap{margin-top:8px;font-size:10px;color:var(--dst-dim)}
.dst-ai-snap summary{cursor:pointer}
.dst-ai-snap pre{margin:4px 0 0;max-height:200px;overflow:auto;white-space:pre-wrap;
  background:var(--dst-bg);border:1px solid var(--dst-border);border-radius:6px;padding:6px;font-size:10px}
.dst-ai-warn{margin-top:6px;font-size:10px;color:var(--dst-dim);line-height:1.5}
.dst-ai-err{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.6;
  color:var(--dsw-alias-state-error-primary,#c0392b);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary,#c0392b) 40%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#c0392b) 8%, transparent)}
.dst-ai-think{margin-top:6px;font-size:11px;color:var(--dst-dim)}
.dst-ai-think summary{cursor:pointer}
.dst-ai-think div{margin-top:4px;white-space:pre-wrap;opacity:.85;max-height:120px;overflow:auto}
.dst-ai-empty{padding:18px 4px;font-size:12px;color:var(--dst-dim);text-align:center;line-height:1.8}
.dst-ai-bar select.dst-ai-days{max-width:64px}
.dst-ai-hist{margin-top:10px;border-top:1px solid var(--dst-border);padding-top:8px}
.dst-ai-hist summary{cursor:pointer;font-size:11px;color:var(--dst-dim);user-select:none}
.dst-ai-histrow{display:flex;gap:8px;align-items:flex-start;padding:5px 4px;
  border-bottom:1px dashed var(--dst-border)}
.dst-ai-histmain{flex:1;min-width:0;cursor:pointer;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.dst-ai-histmain b{font-size:12px}
.dst-ai-histwhen{font-size:10px;color:var(--dst-dim);font-variant-numeric:tabular-nums}
.dst-ai-histsnip{flex-basis:100%;font-size:10px;color:var(--dst-dim);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-ai-histfoot{padding:6px 4px 2px;text-align:right}

/* ---------- 侧边栏页（装了 dsh-better-sidebar 时打开） ---------- */
/* 侧边栏里没有 fixed 定位的余地：根节点要占满 tab 内容区（height:100%），
   头/标签栏不滚，正文自己滚。 */
.dst-side{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;
  width:100%;min-width:0;background:var(--dsw-alias-bg-layer-1,var(--dst-bg));
  color:var(--dst-fg);overflow:hidden}
.dst-side *{box-sizing:border-box}
.dst-side-head{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;
  padding:6px 10px;border-bottom:1px solid var(--dst-border);background:var(--dst-bg)}
.dst-side-title{font-size:13px;font-weight:600}
.dst-side-head .dst-spacer{flex:1}
.dst-side .dst-tabs{flex:none;flex-wrap:nowrap;overflow-x:auto;padding:5px 8px;
  background:var(--dst-bg);border-bottom:1px solid var(--dst-border);scrollbar-width:none}
.dst-side .dst-tabs::-webkit-scrollbar{display:none}
.dst-side .dst-tab{white-space:nowrap;padding:3px 9px}
/* 侧边栏比顶栏面板窄，标签栏右边那行统计放不下，收进标题行即可 */
.dst-side .dst-tabs .dst-note{display:none}
.dst-side-body{flex:1;min-height:0;overflow:auto;padding:10px;gap:10px}
.dst-side .dst-toasts{position:absolute;right:12px;bottom:12px;max-width:calc(100% - 24px)}
`;

    /* ---------------- 格式化 ---------------- */

    const nf = (n, d = 2) =>
      n === null || n === undefined || !Number.isFinite(Number(n))
        ? '--'
        : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });

    function fmtPrice(v) {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
      const n = Number(v);
      return nf(n, Math.abs(n) < 1 ? 3 : 2);
    }

    function fmtPct(v, sign = true) {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
      const n = Number(v);
      return `${sign && n > 0 ? '+' : ''}${nf(n, 2)}%`;
    }

    function fmtSigned(v, d = 2) {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
      const n = Number(v);
      return `${n > 0 ? '+' : ''}${nf(n, d)}`;
    }

    function fmtMoney(v) {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
      const n = Number(v);
      const a = Math.abs(n);
      const sign = n < 0 ? '-' : '';
      if (a >= 1e8) return `${sign}${nf(a / 1e8, 2)}亿`;
      if (a >= 1e4) return `${sign}${nf(a / 1e4, 2)}万`;
      return `${sign}${nf(a, 2)}`;
    }

    function fmtVol(v) {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
      const n = Number(v);
      if (n >= 1e8) return `${nf(n / 1e8, 2)}亿手`;
      if (n >= 1e4) return `${nf(n / 1e4, 2)}万手`;
      return `${nf(n, 0)}手`;
    }

    function fmtTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
      } catch {
        return '';
      }
    }

    /** 「今天 14:32」/「11-17 09:35」：预警历史里要看得出是哪天的触发 */
    function fmtWhen(ts) {
      const t = Number(ts);
      if (!Number.isFinite(t) || t <= 0) return '';
      const d = new Date(t);
      if (Number.isNaN(d.getTime())) return '';
      const now = new Date();
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      if (sameDay) return `今天 ${hm}`;
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
    }

    const dirClass = (v) => (v > 0 ? 'dst-up' : v < 0 ? 'dst-down' : 'dst-flat');

    /**
     * 涨跌停幅度：主板 10%（含 ST/*ST——2026-07-06 新规取消 5% 单档），
     * 创业板/科创板 20%，北交所 30%。
     */
    function limitPctOf(code, name) {
      const c = String(code || '');
      const n = String(name || '');
      // 双创类（创业板/科创板股票与其 ETF）±20%：代码兜不住的 ETF（159xxx 创业板 ETF 等）按名字认
      if (/创业|科创/.test(n)) return 20;
      if (/^(30[0-9]|301|302)/.test(c)) return 20;
      if (/^68[89]/.test(c)) return 20;
      if (/^58[89]/.test(c)) return 20;
      if (/^(43|83|87|88|92)/.test(c)) return 30;
      return 10;
    }

    /**
     * 是否涨停/跌停。判定用「现价是否触到涨跌停价」而不是「涨幅是否达到幅度」，
     * 因为昨收四舍五入后，9.98% 也可能已经是涨停了。
     * @returns {'up'|'down'|null}
     */
    function limitState(pos) {
      const q = pos && pos.quote;
      if (!q || q.price == null || q.prevClose == null || !q.prevClose) return null;
      const pct = limitPctOf(pos.code, pos.name);
      const up = Math.round(q.prevClose * (1 + pct / 100) * 100) / 100;
      const down = Math.round(q.prevClose * (1 - pct / 100) * 100) / 100;
      if (Math.abs(q.price - up) < 0.005) return 'up';
      if (Math.abs(q.price - down) < 0.005) return 'down';
      return null;
    }

    const LIMIT_TEXT = { up: '涨停', down: '跌停' };

    const CURRENCY_SIGN = { CNY: '¥', HKD: 'HK$', USD: '$' };

    /* ---------------- HTTP ---------------- */

    /**
     * 宿主接口没起来的特征状态码。
     * DSH 对未注册的路由会走鉴权兜底，回 401 —— 这不代表"没登录"，
     * 而是"这个接口当前不存在"，最常见的原因就是宿主半边是旧版本。
     */
    const STALE_HOST_HINT =
      '插件宿主未加载（改了宿主代码后需要重启 DSH，仅刷新页面不够）';

    async function api(path, options) {
      let res;
      try {
        res = await fetch(`${API}${path}`, {
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          ...options,
        });
      } catch (err) {
        throw new Error('连不上插件宿主（DSH 的本地服务没响应）');
      }
      if (res.status === 401 || res.status === 403) {
        const stale = new Error(STALE_HOST_HINT);
        stale.code = 'STALE_HOST';
        throw stale;
      }
      if (!res.ok) throw new Error(`宿主返回 HTTP ${res.status}`);
      const data = await res.json();
      if (data && data.ok === false) throw new Error(data.error || '请求失败');
      return data;
    }

    const post = (path, body) =>
      api(path, { method: 'POST', body: JSON.stringify(body || {}) });

    /* ============================================================ *
     * 数据 hook
     * ============================================================ */

    /**
     * 行情状态 hook。active=false 时暂停轮询 —— 侧边栏 tab 不可见时用它省流量/电量；
     * 顶栏常驻，不传参数就是一直轮询。
     */
    function useTicker(active) {
      const paused = active === false;
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [toasts, setToasts] = useState([]);
      const inFlight = useRef(false);
      const staleHost = useRef(false);
      const seenFired = useRef(new Set());
      const toastTimers = useRef([]);

      // 预警触发提示：同一条预警（同一个 firedAt）只弹一次
      const noteFired = useCallback((data) => {
        if (!data || !Array.isArray(data.fired) || !data.fired.length) return;
        if (data.settings && data.settings.alertToast === false) return;
        const fresh = [];
        for (const a of data.fired) {
          const key = `${a.id}:${a.firedAt || 0}`;
          if (seenFired.current.has(key)) continue;
          seenFired.current.add(key);
          fresh.push(a);
        }
        if (!fresh.length) return;
        setToasts((prev) => [...prev, ...fresh].slice(-4));
        for (const a of fresh) {
          const key = `${a.id}:${a.firedAt || 0}`;
          const t = setTimeout(() => {
            setToasts((prev) => prev.filter((x) => `${x.id}:${x.firedAt || 0}` !== key));
          }, 9000);
          toastTimers.current.push(t);
        }
      }, []);

      const load = useCallback(async (force) => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
          const data = await api(`/state${force ? '?fresh=1' : ''}`);
          setState(data);
          noteFired(data);
          // 宿主太旧导致设置项存不下去时，这个提示不能被下一轮成功的轮询擦掉：
          // 轮询成功只说明行情通了，不代表宿主已经重启过。
          if (!staleHost.current) setError(null);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          inFlight.current = false;
          setLoading(false);
        }
      }, [noteFired]);

      // 卸载时清掉所有提示定时器，别留下悬挂的 timer
      useEffect(() => () => {
        for (const t of toastTimers.current) clearTimeout(t);
        toastTimers.current = [];
      }, []);

      const refreshMs = state && state.settings ? state.settings.refreshMs : 5000;

      /**
       * 按交易时段自适应轮询间隔。
       * 收盘后行情根本不会变，还每 5 秒打一次接口纯属浪费电和流量；
       * 午休也降一档。集合竞价和盘中维持用户设定的频率。
       */
      const session = (state && state.market && state.market.session) || '';
      const base = Math.max(1000, Number(refreshMs) || 5000);
      const TRADING = { auction: 1, preopen: 1, morning: 1, afternoon: 1 };
      const effectiveMs = TRADING[session]
        ? base
        : session === 'lunch'
          ? Math.max(base, 30000)
          : Math.max(base, 60000);

      useEffect(() => {
        if (!paused) load(false);
      }, [load, paused]);

      // 时段变化只重启定时器，不额外触发一次请求
      useEffect(() => {
        if (paused) return undefined;
        const id = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          load(false);
        }, effectiveMs);
        return () => clearInterval(id);
      }, [load, effectiveMs, paused]);

      const applyState = useCallback((payload) => {
        if (payload && payload.settings) setState(payload);
      }, []);

      const save = useCallback(async (item) => {
        const data = await post('/items/save', item);
        if (data.state) setState(data.state);
        return data.item;
      }, []);

      const remove = useCallback(async (symbol) => {
        const data = await post('/items/remove', { symbol });
        if (data.state) setState(data.state);
      }, []);

      /**
       * 行情条拖动排序：先乐观换序（拖完立刻就位，不等网络），
       * 再落库；失败时把原因挂到角标，下一轮轮询会把顺序刷回真实状态。
       * @param {string[]} order 完整的 symbol 顺序
       */
      const reorder = useCallback(async (order) => {
        setState((prev) => {
          if (!prev) return prev;
          const rank = new Map((order || []).map((s, i) => [s, i]));
          const n = rank.size;
          const items = [...(prev.items || [])].sort((a, b) => {
            const ra = rank.has(a.symbol) ? rank.get(a.symbol) : n;
            const rb = rank.has(b.symbol) ? rank.get(b.symbol) : n;
            return ra - rb;
          });
          return { ...prev, items };
        });
        try {
          const data = await post('/items/reorder', { order });
          if (data.state) setState(data.state);
        } catch (err) {
          setError((err && err.message) || String(err));
        }
      }, []);

      const patchSettings = useCallback(async (patch) => {
        try {
          const data = await post('/settings/save', patch);
          // 宿主是旧版本时不认识新设置项（patchSettings 只接受它自己默认表里的键），
          // 会悄悄把这次修改丢掉。与其让用户看到「点了开关又自己弹回去」，不如把原因挂到顶栏角标。
          // 只看"键是不是整个不见了"，不看值——宿主会把 refreshMs 之类的夹到合法区间。
          const saved = (data && data.settings) || {};
          const lost = Object.keys(patch || {}).filter((k) => !(k in saved));
          if (lost.length) {
            const stale = new Error(`${STALE_HOST_HINT}（设置项 ${lost.join('、')} 没被保存）`);
            stale.code = 'STALE_HOST';
            throw stale;
          }
          setError(null);
          staleHost.current = false;
          setState((prev) => (prev ? { ...prev, settings: data.settings } : prev));
          return true;
        } catch (err) {
          // 调用方全是「点一下就走」的用法，抛出去只会变成 unhandled rejection；
          // 统一在这里吞掉，把原因显示到顶栏的 ⚠ 角标（点开就是设置页里的完整说明）。
          if (err && err.code === 'STALE_HOST') staleHost.current = true;
          setError((err && err.message) || String(err));
          return false;
        }
      }, []);

      const dismissToast = useCallback((key) => {
        setToasts((prev) => prev.filter((t) => `${t.id}:${t.firedAt || 0}` !== key));
      }, []);

      const saveAlert = useCallback(async (patch) => {
        const data = await post('/alerts/save', patch);
        if (data.state) setState(data.state);
        return data.alert;
      }, []);

      const removeAlert = useCallback(async (id) => {
        const data = await post('/alerts/remove', { id });
        setState((prev) => (prev ? { ...prev, alerts: (prev.alerts || []).filter((a) => a.id !== id) } : prev));
        return data.removed;
      }, []);

      const ackAlert = useCallback(async (id) => {
        await post('/alerts/ack', { id });
        load(false);
      }, [load]);

      return {
        state, error, loading, toasts, dismissToast,
        load, save, remove, reorder, patchSettings, applyState,
        saveAlert, removeAlert, ackAlert,
      };
    }

    /**
     * 流水不在 /state 的 5 秒轮询里（会长），只在打开"流水"标签时单独取。
     */
    function useTrades(active) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);

      const reload = useCallback(async () => {
        setBusy(true);
        try {
          const d = await api('/trades');
          setData(d);
          setError(null);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        if (!active) return undefined;
        reload();
        return undefined;
      }, [active, reload]);

      const addTrade = useCallback(async (patch) => {
        const d = await post('/trades/save', patch);
        await reload();
        return d.trade;
      }, [reload]);

      const removeTrade = useCallback(async (id) => {
        await post('/trades/remove', { id });
        await reload();
      }, [reload]);

      const clearTrades = useCallback(async (symbol) => {
        await post('/trades/clear', symbol ? { symbol } : {});
        await reload();
      }, [reload]);

      const applyTrades = useCallback(async () => {
        const d = await post('/trades/apply', {});
        await reload();
        return d;
      }, [reload]);

      return { data, error, busy, reload, addTrade, removeTrade, clearTrades, applyTrades };
    }

    /* ============================================================ *
     * K 线图（canvas 手绘，无图表库依赖）
     * ============================================================ */

    // 均线周期与配色：5/10/20/30/60，颜色彼此拉开，也避开涨红跌绿
    const MA_DEFS = [
      { n: 5, color: '#e8b339' },
      { n: 10, color: '#3b9dff' },
      { n: 20, color: '#c264e0' },
      { n: 30, color: '#ff9f6b' },
      { n: 60, color: '#48b8a0' },
    ];

    function computeMA(candles, n) {
      const out = new Array(candles.length).fill(null);
      let sum = 0;
      for (let i = 0; i < candles.length; i++) {
        sum += candles[i].close;
        if (i >= n) sum -= candles[i - n].close;
        if (i >= n - 1) out[i] = sum / n;
      }
      return out;
    }

    /* ---------------- 副图指标（纯函数，无依赖） ---------------- *
     *
     * 三种都返回「跟 K 线等长的数组」，前面凑不够周期的地方是 null，
     * 画图时直接跳过 null 即可。
     */

    /** MACD(12,26,9)：DIF=EMA12-EMA26，DEA=DIF 的 9 日 EMA，柱=(DIF-DEA)*2 */
    function computeMACD(candles, fast = 12, slow = 26, signal = 9) {
      const n = candles.length;
      const dif = new Array(n).fill(null);
      const dea = new Array(n).fill(null);
      const macd = new Array(n).fill(null);
      if (!n) return { dif, dea, macd };
      const kFast = 2 / (fast + 1);
      const kSlow = 2 / (slow + 1);
      const kSig = 2 / (signal + 1);
      let emaF = candles[0].close;
      let emaS = candles[0].close;
      let deaPrev = 0;
      let started = false;
      for (let i = 0; i < n; i++) {
        const c = candles[i].close;
        emaF = i === 0 ? c : c * kFast + emaF * (1 - kFast);
        emaS = i === 0 ? c : c * kSlow + emaS * (1 - kSlow);
        const d = emaF - emaS;
        // DEA 从第一根 DIF 开始递推（前面没有 DIF 的段落也照样算，只是不显示）
        deaPrev = started ? d * kSig + deaPrev * (1 - kSig) : d;
        started = true;
        if (i >= slow - 1) {
          dif[i] = d;
          dea[i] = deaPrev;
          macd[i] = (d - deaPrev) * 2;
        }
      }
      return { dif, dea, macd };
    }

    /** KDJ(9,3,3)：RSV 的 3 日平滑，K/D 初值 50，J=3K-2D */
    function computeKDJ(candles, n = 9, m1 = 3, m2 = 3) {
      const len = candles.length;
      const k = new Array(len).fill(null);
      const d = new Array(len).fill(null);
      const j = new Array(len).fill(null);
      let kPrev = 50;
      let dPrev = 50;
      for (let i = 0; i < len; i++) {
        if (i < n - 1) continue;
        let hi = -Infinity;
        let lo = Infinity;
        for (let x = i - n + 1; x <= i; x++) {
          if (candles[x].high > hi) hi = candles[x].high;
          if (candles[x].low < lo) lo = candles[x].low;
        }
        const span = hi - lo;
        const rsv = span > 0 ? ((candles[i].close - lo) / span) * 100 : 50;
        kPrev = ((m1 - 1) * kPrev + rsv) / m1;
        dPrev = ((m2 - 1) * dPrev + kPrev) / m2;
        k[i] = kPrev;
        d[i] = dPrev;
        j[i] = 3 * kPrev - 2 * dPrev;
      }
      return { k, d, j };
    }

    /** RSI(n)：Wilder 平滑；前 n 根用简单均值打底 */
    function computeRSI(candles, n = 14) {
      const len = candles.length;
      const out = new Array(len).fill(null);
      if (len < 2) return out;
      let gain = 0;
      let loss = 0;
      for (let i = 1; i < len; i++) {
        const ch = candles[i].close - candles[i - 1].close;
        const up = ch > 0 ? ch : 0;
        const down = ch < 0 ? -ch : 0;
        if (i <= n) {
          gain += up;
          loss += down;
          if (i === n) {
            gain /= n;
            loss /= n;
            out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
          }
        } else {
          gain = (gain * (n - 1) + up) / n;
          loss = (loss * (n - 1) + down) / n;
          out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
        }
      }
      return out;
    }

    /** 副图指标定义：一份配置同时驱动画布、读数条和切换按钮 */
    const SUB_DEFS = {
      macd: {
        label: 'MACD',
        title: 'MACD(12,26,9)',
        // 读数顺序 = 画线顺序，颜色跟线一致
        series: [
          { key: 'dif', label: 'DIF', color: '#3b9dff' },
          { key: 'dea', label: 'DEA', color: '#e8b339' },
          { key: 'macd', label: 'MACD', color: '#c264e0', bar: true },
        ],
        build: (candles) => computeMACD(candles),
      },
      kdj: {
        label: 'KDJ',
        title: 'KDJ(9,3,3)',
        series: [
          { key: 'k', label: 'K', color: '#3b9dff' },
          { key: 'd', label: 'D', color: '#e8b339' },
          { key: 'j', label: 'J', color: '#c264e0' },
        ],
        build: (candles) => computeKDJ(candles),
      },
      rsi: {
        label: 'RSI',
        title: 'RSI(6,12,24)',
        series: [
          { key: 'r6', label: 'RSI6', color: '#3b9dff' },
          { key: 'r12', label: 'RSI12', color: '#e8b339' },
          { key: 'r24', label: 'RSI24', color: '#c264e0' },
        ],
        build: (candles) => ({ r6: computeRSI(candles, 6), r12: computeRSI(candles, 12), r24: computeRSI(candles, 24) }),
      },
    };

    const SUB_OPTIONS = [['none', '无副图'], ['macd', 'MACD'], ['kdj', 'KDJ'], ['rsi', 'RSI']];

    function KLineChart({ candles, height = 300, title, onNeedMore, cost = null, shares = 0, sub = 'none' }) {
      const wrapRef = useRef(null);
      const plotRef = useRef(null);
      const canvasRef = useRef(null);
      const trackRef = useRef(null);
      const [width, setWidth] = useState(720);
      const [hover, setHover] = useState(null);
      const stateRef = useRef({ layout: null });
      // 框选区间：view 存的是日期（不是下标）——「更多历史」会在开头补数据，
      // 下标会整体往后挪，日期不会。null = 显示全部。
      const [view, setView] = useState(null);
      // 拖拽中的选框（画布内的横坐标），松手才真的换区间
      const [sel, setSel] = useState(null);
      // 总览条上的拖拽（平移窗口 / 拖两端改范围）
      const [tl, setTl] = useState(null);
      // 拖动中的窗口像素位置：连续跟手，不去按「第几根」取整 —— 否则一条 120 根、
      // 一千像素宽的轨道上每跳一格就是 8px，看着一顿一顿的
      const [tlBox, setTlBox] = useState(null);
      // 拖完紧跟一次 click，别把刚调好的区间又复位了
      const draggedRef = useRef(false);

      // 日期 → 当前数组里的下标。数据换了（切周期、补历史）也能落到同一段时间上
      const viewIdx = useMemo(() => {
        if (!view || !candles.length) return null;
        let s = candles.findIndex((c) => String(c.date) >= view.from);
        if (s < 0) s = 0;
        let e = candles.length - 1;
        while (e > s && String(candles[e].date) > view.to) e -= 1;
        if (e <= s) return null;
        return { start: s, end: e };
      }, [view, candles]);

      // 选框拖到画布外面也照样跟手，所以移动/松手都挂在 window 上
      useEffect(() => {
        if (!sel) return undefined;
        const xOf = (e) => {
          const el = plotRef.current;
          const left = el && typeof el.getBoundingClientRect === 'function'
            ? el.getBoundingClientRect().left : 0;
          const max = el && el.getBoundingClientRect ? el.getBoundingClientRect().width : width;
          const x = Number(e.clientX) - left;
          return Math.max(0, Math.min(Number.isFinite(max) ? max : width, x));
        };
        const onMove = (e) => {
          const x = xOf(e);
          setSel((s) => (s ? { ...s, x1: x } : s));
        };
        const onUp = (e) => {
          const layout = stateRef.current.layout;
          const x = xOf(e);
          const box = { x0: sel.x0, x1: x };
          setSel(null);
          if (!layout || !Number.isFinite(layout.cw) || layout.cw <= 0) return;
          // 太窄当点击（不改区间），至少要看 2 根
          if (Math.abs(box.x1 - box.x0) < 8) return;
          const lo = Math.min(box.x0, box.x1);
          const hiX = Math.max(box.x0, box.x1);
          const idxOf = (px) => layout.start + Math.floor((px - layout.padL) / layout.cw);
          const i0 = Math.max(layout.start, Math.min(idxOf(lo), layout.start + layout.count - 1));
          const i1 = Math.max(layout.start, Math.min(idxOf(hiX), layout.start + layout.count - 1));
          if (i1 - i0 < 1) return;
          setHover(null);
          setView({ from: String(candles[i0].date), to: String(candles[i1].date) });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }, [sel, candles, width]);

      // 总览条拖拽：窗口跟着鼠标连续走（像素），数据按根数换算后写回 view。
      // 视觉连续 + 数据取整，两件事分开做，拖起来才不一顿一顿的。
      useEffect(() => {
        if (!tl || !candles.length) return undefined;
        const last = candles.length - 1;
        const MIN_PX = 6; // 窗口最窄也有 6px，不然抓不住
        const onMove = (e) => {
          const dx = Number(e.clientX) - tl.x0;
          if (!Number.isFinite(dx)) return;
          if (Math.abs(dx) >= 2) draggedRef.current = true;
          const w = tl.width;
          let leftPx = tl.baseLeftPx;
          let widthPx = tl.baseWidthPx;
          if (tl.mode === 'move') {
            leftPx = Math.max(0, Math.min(w - widthPx, tl.baseLeftPx + dx));
          } else if (tl.mode === 'left') {
            const right = tl.baseLeftPx + tl.baseWidthPx;
            leftPx = Math.max(0, Math.min(right - MIN_PX, tl.baseLeftPx + dx));
            widthPx = right - leftPx;
          } else {
            widthPx = Math.max(MIN_PX, Math.min(w - tl.baseLeftPx, tl.baseWidthPx + dx));
          }
          setTlBox({ left: leftPx, width: widthPx });
          // 落进窗口的每一根都算：左边取最近的根、右边向上取到边界那根。
          // 用 round 而不是 floor —— 百分比来回换算有浮点误差（10/120*720 可能是 59.999…），
          // floor 会凭空多吃/少吃一根。
          let s = Math.round((leftPx / w) * candles.length);
          let en = Math.round(((leftPx + widthPx) / w) * candles.length) - 1;
          s = Math.max(0, Math.min(last, s));
          en = Math.max(s, Math.min(last, en));
          // 拖回整段就当成没放大，窗口重新铺满
          if (s <= 0 && en >= last) { setView(null); return; }
          const next = { from: String(candles[s].date), to: String(candles[en].date) };
          setView((v) => (v && v.from === next.from && v.to === next.to ? v : next));
        };
        const onUp = () => { setTl(null); setTlBox(null); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }, [tl, candles]);

      useEffect(() => {
        const el = wrapRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => setWidth(el.clientWidth || 720));
        ro.observe(el);
        setWidth(el.clientWidth || 720);
        return () => ro.disconnect();
      }, []);

      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        canvas.width = Math.max(1, Math.floor(width * dpr));
        canvas.height = Math.max(1, Math.floor(height * dpr));
        drawChart(canvas, candles, { width, height, dpr, hover, stateRef, cost, shares, sub, view: viewIdx });
      }, [candles, width, height, hover, cost, shares, sub, viewIdx]);

      const handleMove = (e) => {
        if (sel) return; // 拖框的时候不更新十字光标
        const layout = stateRef.current.layout;
        if (!layout || !candles.length) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const local = Math.floor((x - layout.padL) / layout.cw);
        if (local < 0 || local >= layout.count) {
          setHover(null);
          return;
        }
        setHover({ i: layout.start + local, x, y: e.clientY - rect.top });
      };

      const handleDown = (e) => {
        const layout = stateRef.current.layout;
        if (!layout || !candles.length) return;
        if (typeof e.button === 'number' && e.button !== 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        setHover(null);
        setSel({ x0: x, x1: x });
      };

      const hovered = hover && candles[hover.i] ? candles[hover.i] : null;

      // 均线数值：悬停时跟着光标走（看那天各均线在哪），不悬停时给最新一根
      const mas = useMemo(
        () => MA_DEFS.map((m) => ({ ...m, data: computeMA(candles, m.n) })),
        [candles],
      );
      const maIndex = hover && candles[hover.i] ? hover.i : candles.length - 1;
      const maReadOut = MA_DEFS.map((m) => {
        const series = mas.find((x) => x.n === m.n);
        const v = series && maIndex >= 0 ? series.data[maIndex] : null;
        return { ...m, value: v == null || !Number.isFinite(v) ? null : v };
      });

      // 时间轴总览条要用的一组量：整段根数、当前窗口在整段里的百分比位置
      const totalBars = candles.length;
      // 时间轴上一定带年份：只有「08-02」看不出是哪年，翻两年的图尤其糊
      const ymd = (d) => {
        const s = String(d == null ? '' : d);
        return s.length >= 10 ? s.slice(0, 10) : s;
      };
      const hmOf = (d) => {
        const s = String(d == null ? '' : d);
        return s.length > 10 ? s.slice(11, 16) : '';
      };
      const resetView = () => { setView(null); setSel(null); setHover(null); };
      const selStart = viewIdx ? viewIdx.start : 0;
      const selEnd = viewIdx ? viewIdx.end : Math.max(0, totalBars - 1);
      const winLeft = totalBars > 1 ? (selStart / totalBars) * 100 : 0;
      const winWidth = totalBars > 1 ? ((selEnd - selStart + 1) / totalBars) * 100 : 100;
      // 当前区间文案：同年只写一次年份（2024-12-02 ~ 03-15），跨年两边都写全
      const rangeText = () => {
        if (!viewIdx) return `全部 ${totalBars} 根`;
        const a = candles[selStart].date;
        const b = candles[selEnd].date;
        const right = ymd(a).slice(0, 4) === ymd(b).slice(0, 4) ? ymd(b).slice(5) : ymd(b);
        const t = hmOf(a) || hmOf(b) ? ` ${hmOf(a) || '00:00'}~${hmOf(b) || '00:00'}` : '';
        return `${ymd(a)} ~ ${right}${t} · ${selEnd - selStart + 1}/${totalBars} 根`;
      };
      // 点总览条上窗口外面的空白 = 回到全部；点窗口里不动（避免手抖把刚框好的区间点没了）
      const onTrackClick = (e) => {
        // 刚在总览条上拖过窗口（平移/改范围），这次 click 是拖拽的余波，别拿它当点击
        if (draggedRef.current) {
          draggedRef.current = false;
          return;
        }
        if (!viewIdx) return;
        const el = e.currentTarget;
        const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        if (!rect || !rect.width) return;
        const px = Math.max(0, Math.min(rect.width, Number(e.clientX) - rect.left));
        const x0 = (winLeft / 100) * rect.width;
        const x1 = ((winLeft + winWidth) / 100) * rect.width;
        // 窗口边上留 12px 缓冲：想抓手柄没抓准、落在窗边外面一点点，也别当成「点空白」把区间清了
        if (px > x0 - 12 && px < x1 + 12) return;
        resetView();
      };

      // 直接在总览条上改颗粒度：拖窗口中间 = 平移这段，拖左右两端 = 改范围大小。
      // 起点记成像素（baseLeftPx/baseWidthPx），拖动时才不会先跳半格。
      const startTimelineDrag = (mode) => (e) => {
        if (typeof e.button === 'number' && e.button !== 0) return;
        if (e.stopPropagation) e.stopPropagation();
        const el = trackRef.current;
        const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        if (!rect || !rect.width || totalBars < 2) return;
        draggedRef.current = false;
        setHover(null);
        setSel(null);
        setTl({
          mode,
          x0: Number(e.clientX),
          width: rect.width,
          baseLeftPx: (winLeft / 100) * rect.width,
          baseWidthPx: (winWidth / 100) * rect.width,
        });
        setTlBox({ left: (winLeft / 100) * rect.width, width: (winWidth / 100) * rect.width });
      };

      return h('div', { className: 'dst-kline', ref: wrapRef },
        h('div', { className: 'dst-kline-head' },
          h('span', { className: 'dst-kline-title' }, title || 'K线'),
          hovered
            ? h('span', { className: dirClass(hovered.changePct) },
                `${hovered.date}  开${fmtPrice(hovered.open)} 高${fmtPrice(hovered.high)} ` +
                `低${fmtPrice(hovered.low)} 收${fmtPrice(hovered.close)} ${fmtPct(hovered.changePct)}`)
            : null,
          h('span', { className: 'dst-spacer' }),
          h('span', { className: 'dst-muted dst-zoom-hint',
            title: viewIdx
              ? '已放大到框选的区间；拖下方时间轴窗口的两端可以继续改范围，双击图表回到全部'
              : '按住鼠标在图上横向拖动，松手就放大到框选的那一段时间；也可以直接拖下方时间轴窗口的两端' },
            viewIdx
              ? `区间 ${viewIdx.end - viewIdx.start + 1} 根 · 双击复位`
              : `共 ${candles.length} 根 · 拖动框选区间`),
          onNeedMore
            ? h('button', { className: 'dst-btn', onClick: onNeedMore, title: '加载更多历史' }, '更多历史')
            : null,
        ),
        // 画布 + 浮在左上角的均线读数（像行情软件那样压在图上，不单独占一行）
        h('div', {
          className: 'dst-kline-plot',
          ref: plotRef,
          // 双击复位：框选几次之后迷路了，点两下回到全部
          onDoubleClick: () => { setView(null); setSel(null); setHover(null); },
        },
          h('canvas', {
            ref: canvasRef,
            style: { height: `${height}px` },
            onMouseDown: handleDown,
            onMouseMove: handleMove,
            onMouseLeave: () => setHover(null),
          }),
          // 拖拽中的选框：纯 DOM 覆盖层，跟着鼠标走，不用一格一格重画画布
          sel
            ? h('div', {
                className: 'dst-kline-sel',
                style: {
                  left: `${Math.min(sel.x0, sel.x1)}px`,
                  width: `${Math.max(1, Math.abs(sel.x1 - sel.x0))}px`,
                },
              })
            : null,
          h('div', { className: 'dst-legend dst-legend-float' },
            MA_DEFS.map((m) => {
              const it = maReadOut.find((x) => x.n === m.n);
              return h('span', { key: m.n, className: 'dst-legend-item',
                title: `${m.n} 日均线${hover && hovered ? `（${hovered.date}）` : '（最新一根）'}` },
                h('i', { style: { background: m.color } }),
                `MA${m.n}`,
                h('b', { className: 'dst-legend-val', style: { color: m.color } },
                  it && it.value != null ? fmtPrice(it.value) : '--'));
            }),
            hover && hovered
              ? h('span', { className: 'dst-muted dst-legend-when' }, `← ${hovered.date}`)
              : null,
          ),
        ),
        !candles.length
          ? h('div', { className: 'dst-empty' }, '暂无K线数据')
          : null,
        // 时间轴总览：左边是最早一根、右边是最新一根，中间的蓝色窗口就是现在看到的区间。
        // 放大之后这是唯一一眼能看出「我在整段的哪个位置、丢了多少」的地方，也是复位入口。
        // 排两行：上行只有「日期 — 轨道 — 日期」，下行放当前区间和「全部」，
        // 窄面板里日期带年份变长也不会把右边那截挤出去。
        (totalBars > 1
          ? h('div', { className: 'dst-timeline' },
              h('div', { className: 'dst-timeline-row' },
                h('span', { className: 'dst-timeline-cap', title: `最早一根 ${candles[0].date}` },
                  ymd(candles[0].date)),
                h('div', {
                  className: 'dst-timeline-track',
                  ref: trackRef,
                  title: viewIdx
                    ? `整段 ${totalBars} 根，蓝色窗口是当前放大的 ${selEnd - selStart + 1} 根；`
                      + '拖窗口中间平移、拖左右两端改范围，点窗口外面回到全部'
                    : `整段 ${totalBars} 根，全部显示中；拖窗口两端可以缩小范围（改颗粒度），`
                      + '也可以在图上横向拖动框选',
                  onClick: onTrackClick,
                },
                  h('div', {
                    className: viewIdx ? 'dst-timeline-win' : 'dst-timeline-win dst-full',
                    style: tlBox
                      // 拖动中：直接按像素画，跟手、不取整、不要过渡动画
                      ? { left: `${tlBox.left}px`, width: `${Math.max(2, tlBox.width)}px`, transition: 'none' }
                      // 松手后：按理算出来的百分比，复位/切区间时补一个短过渡，别硬跳
                      : {
                          left: `${winLeft}%`,
                          width: `${Math.max(2, winWidth)}%`,
                          transition: tl ? 'none' : 'left .16s ease, width .16s ease',
                        },
                    onMouseDown: startTimelineDrag('move'),
                    // 拖过窗口之后的那次 click 不要冒到轨道上被当成「点空白复位」
                    onClick: (e) => { if (e.stopPropagation) e.stopPropagation(); },
                  },
                    h('div', {
                      className: 'dst-timeline-grip dst-l',
                      title: '拖动调整起点（改范围）',
                      onMouseDown: startTimelineDrag('left'),
                    }),
                    h('div', {
                      className: 'dst-timeline-grip dst-r',
                      title: '拖动调整终点（改范围）',
                      onMouseDown: startTimelineDrag('right'),
                    }))),
                h('span', { className: 'dst-timeline-cap', title: `最新一根 ${candles[totalBars - 1].date}` },
                  ymd(candles[totalBars - 1].date)),
              ),
              h('div', { className: 'dst-timeline-row' },
                h('span', { className: 'dst-timeline-now', title: rangeText() }, rangeText()),
                h('button', {
                  className: 'dst-timeline-all',
                  disabled: !viewIdx,
                  title: viewIdx ? '回到全部时间范围（也可以双击图表）' : '已经在全部范围',
                  onClick: resetView,
                }, '全部'),
              ),
            )
          : null),
      );
    }

    function drawChart(canvas, candles, opts) {
      const { width, height, dpr, hover, cost = null, shares = 0 } = opts;
      const sub = opts.sub && SUB_DEFS[opts.sub] ? opts.sub : 'none';
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const padL = 8;
      const padR = 52;
      // 顶上留出均线读数条的高度，K 线不会从读数条底下穿出来
      const padT = 26;
      const axisH = 16;
      const gap = 6;
      // 副图（MACD/KDJ/RSI）占一条 20% 的横带；开了副图就把成交量压窄一点，
      // 主图高度最后再兜一个下限，免得小窗口里 K 线被挤成一条缝
      const subH = sub === 'none' ? 0 : Math.max(46, Math.round(height * 0.2));
      const volH = Math.round(Math.min(height * 0.2, (height - padT - axisH - subH - gap * 2) * 0.28));
      const priceH = Math.max(60, height - padT - volH - axisH - gap - (subH ? subH + gap : 0));
      const plotW = Math.max(10, width - padL - padR);
      // 成交量带和副图带的顶边：两者都跟主图共用横轴，必须按同一套算术算出来
      const volTopY = padT + priceH + gap;
      const subTop = subH ? volTopY + volH + gap : 0;

      if (!candles.length) {
        opts.stateRef.current.layout = null;
        return;
      }

      // 框选区间：只画选中的那一段。均线仍按整段数据算再切片，否则选区左端会缺一截均线。
      const view = opts.view || null;
      let viewStart = 0;
      let shown = candles;
      if (view && candles.length) {
        viewStart = Math.max(0, Math.min(Math.round(view.start) || 0, candles.length - 1));
        const viewEnd = Math.max(viewStart, Math.min(Math.round(view.end) || 0, candles.length - 1));
        shown = candles.slice(viewStart, viewEnd + 1);
      }
      // 光标索引换算到「选区里的第几根」，选区间外/选区外的光标不画
      const hov = hover && hover.i >= viewStart && hover.i < viewStart + shown.length
        ? { ...hover, i: hover.i - viewStart }
        : null;

      const cs = getComputedStyle(canvas);
      const up = (cs.getPropertyValue('--dst-up') || '#e5484d').trim();
      const down = (cs.getPropertyValue('--dst-down') || '#0f9d6e').trim();
      const grid = 'rgba(128,138,152,.22)';
      const dim = 'rgba(128,138,152,.9)';
      const costColor = (cs.getPropertyValue('--dst-cost') || '#6b5ce7').trim();

      let hi = -Infinity;
      let lo = Infinity;
      for (const c of shown) {
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
      }
      const mas = MA_DEFS.map((m) => ({
        ...m,
        data: computeMA(candles, m.n).slice(viewStart, viewStart + shown.length),
      }));
      for (const m of mas) {
        for (const v of m.data) {
          if (v === null) continue;
          if (v > hi) hi = v;
          if (v < lo) lo = v;
        }
      }
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) return;

      // 成本线：落在 K 线附近（±30% 幅度内）就把它纳入纵轴范围，保证看得见；
      // 离得太远就贴边显示，免得为了画一根线把 K 线压成一条缝
      const costNum = Number(cost) > 0 ? Number(cost) : 0;
      let costClamped = null;
      if (costNum) {
        const span = hi - lo || Math.abs(hi) * 0.02 || 1;
        if (costNum >= lo - span * 0.3 && costNum <= hi + span * 0.3) {
          if (costNum > hi) hi = costNum;
          if (costNum < lo) lo = costNum;
        } else {
          costClamped = costNum > hi ? 'above' : 'below';
        }
      }

      const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.02 || 1;
      hi += pad;
      lo -= pad;

      const yOf = (p) => padT + priceH - ((p - lo) / (hi - lo)) * priceH;
      const cw = plotW / shown.length;

      // 均线数值贴右轴：先算好每条均线当前（光标那天）的价位和标签位置，
      // 挨太近就按 13px 逐条错开，错到图外就丢掉——宁可少贴一个也不要糊成一团。
      // 价格刻度如果被标签压住就不画那个刻度，免得两排数字叠在一起。
      const maPills = [];
      {
        const maIdx = hov && shown[hov.i] ? hov.i : shown.length - 1;
        const raw = [];
        for (const m of mas) {
          const v = m.data[maIdx];
          if (v === null || v === undefined || !Number.isFinite(v)) continue;
          raw.push({ color: m.color, v, y: yOf(v) });
        }
        raw.sort((a, b) => a.y - b.y);
        ctx.font = '10px system-ui,sans-serif';
        let lastPillY = padT - 99;
        for (const p of raw) {
          const y = Math.max(p.y, lastPillY + 13);
          if (y > padT + priceH + 4) continue;
          lastPillY = y;
          maPills.push({ ...p, y, w: Math.min(padR - 2, ctx.measureText(fmtPrice(p.v)).width + 10) });
        }
      }

      // 网格 + 价格刻度
      ctx.font = '10px system-ui,sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (let g = 0; g <= 4; g++) {
        const y = padT + (priceH * g) / 4;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        if (maPills.some((p) => Math.abs(p.y - y) < 8)) continue;
        ctx.fillStyle = dim;
        ctx.fillText(fmtPrice(hi - ((hi - lo) * g) / 4), padL + plotW + 5, y);
      }

      // 成交量
      let maxVol = 0;
      for (const c of shown) if (c.volume > maxVol) maxVol = c.volume;
      const volTop = volTopY;
      if (maxVol > 0) {
        for (let i = 0; i < shown.length; i++) {
          const c = shown[i];
          const bh = (c.volume / maxVol) * (volH - 2);
          const x = padL + i * cw;
          ctx.fillStyle = c.close >= c.open ? up : down;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(x + Math.max(0, cw * 0.15), volTop + (volH - 2 - bh), Math.max(1, cw * 0.7), bh);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = dim;
        ctx.textAlign = 'left';
        ctx.fillText(fmtVol(maxVol), padL + 2, volTop + 6);
      }

      // 副图（MACD / KDJ / RSI）：独占一条横带，跟主图共用横轴和十字光标
      if (subH) {
        drawSubPane(ctx, {
          def: SUB_DEFS[sub], candles: shown, padL, plotW, cw,
          subTop, subH, hover: hov, up, down, dim, grid,
        });
      }

      // K 线
      const bw = Math.max(1, Math.min(cw * 0.72, 22));
      for (let i = 0; i < shown.length; i++) {
        const c = shown[i];
        const x = padL + i * cw + cw / 2;
        const rise = c.close >= c.open;
        const color = rise ? up : down;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, yOf(c.high));
        ctx.lineTo(Math.round(x) + 0.5, yOf(c.low));
        ctx.stroke();
        const yO = yOf(c.open);
        const yC = yOf(c.close);
        const top = Math.min(yO, yC);
        const bh2 = Math.max(1, Math.abs(yC - yO));
        if (rise) {
          ctx.fillStyle = 'transparent';
          ctx.fillRect(x - bw / 2, top, bw, bh2);
          ctx.strokeRect(x - bw / 2 + 0.5, top + 0.5, bw - 1, Math.max(1, bh2 - 1));
        } else {
          ctx.fillRect(x - bw / 2, top, bw, bh2);
        }
      }

      // 均线
      ctx.lineWidth = 1.2;
      for (const m of mas) {
        ctx.strokeStyle = m.color;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < m.data.length; i++) {
          const v = m.data[i];
          if (v === null) continue;
          const x = padL + i * cw + cw / 2;
          const y = yOf(v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // 持仓成本线
      if (costNum) {
        const y = costClamped === 'above' ? padT + 1
          : costClamped === 'below' ? padT + priceH - 1
            : yOf(costNum);
        if (y >= padT - 1 && y <= padT + priceH + 1) {
          ctx.save();
          ctx.strokeStyle = costColor;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(padL, Math.round(y) + 0.5);
          ctx.lineTo(padL + plotW, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          const arrow = costClamped === 'above' ? ' ↑' : costClamped === 'below' ? ' ↓' : '';
          const label = `成本 ${fmtPrice(costNum)}${arrow}`;
          ctx.font = '10px system-ui,sans-serif';
          const lw = ctx.measureText(label).width + 8;
          ctx.fillStyle = costColor;
          // 出轴（贴边）时贴左端画：右端是均线数值块/价格轴，黑块会压上去；
          // 轴内时贴右端画，避开左上角的均线/价格读数浮层
          const lx = costClamped ? padL + 4 : padL + plotW - lw - 6;
          const ly = costClamped === 'above' ? y + 2 : costClamped === 'below' ? y - 2 : y;
          ctx.fillRect(lx, ly - 8, lw, 15);
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(label, lx + 4, ly);
          ctx.restore();
        }
      }

      // 均线数值贴右轴：一眼看出「这根均线在图上什么高度」
      {
        ctx.font = '10px system-ui,sans-serif';
        ctx.textAlign = 'left';
        for (const p of maPills) {
          const x = padL + plotW + 1;
          const top = p.y - 6.5;
          const r = 3;
          ctx.globalAlpha = 0.92;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(x + r, top);
          ctx.lineTo(x + p.w - r, top);
          ctx.quadraticCurveTo(x + p.w, top, x + p.w, top + r);
          ctx.lineTo(x + p.w, top + 13 - r);
          ctx.quadraticCurveTo(x + p.w, top + 13, x + p.w - r, top + 13);
          ctx.lineTo(x + r, top + 13);
          ctx.quadraticCurveTo(x, top + 13, x, top + 13 - r);
          ctx.lineTo(x, top + r);
          ctx.quadraticCurveTo(x, top, x + r, top);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#fff';
          ctx.fillText(fmtPrice(p.v), x + 5, p.y);
        }
      }

      // 日期轴
      ctx.fillStyle = dim;
      ctx.textAlign = 'center';
      const ticks = Math.max(2, Math.min(6, Math.floor(plotW / 90)));
      // 整段跨年时，每年第一根把年份写全 —— 只写「12-20 / 03-15」看不出是哪年
      const yrOf = (d) => String(d == null ? '' : d).slice(0, 4);
      const crossYear = shown.length > 1 && yrOf(shown[0].date) !== yrOf(shown[shown.length - 1].date);
      let seenYear = '';
      for (let t = 0; t <= ticks; t++) {
        const i = Math.round(((shown.length - 1) * t) / ticks);
        const c = shown[i];
        if (!c) continue;
        const x = padL + i * cw + cw / 2;
        const yr = yrOf(c.date);
        let label = String(c.date).slice(5);
        if (crossYear && yr && yr !== seenYear) label = String(c.date).slice(0, 10);
        seenYear = yr;
        ctx.fillText(label, Math.min(width - 32, Math.max(32, x)), height - axisH / 2 - 2);
      }

      // 十字光标
      if (hov && shown[hov.i]) {
        const i = hov.i;
        const x = padL + i * cw + cw / 2;
        const c = shown[i];
        ctx.save();
        ctx.strokeStyle = 'rgba(128,138,152,.75)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, subH ? subTop + subH : padT + priceH);
        ctx.stroke();
        if (hov.y > padT && hov.y < padT + priceH) {
          const p = hi - ((hov.y - padT) / priceH) * (hi - lo);
          ctx.beginPath();
          ctx.moveTo(padL, hov.y);
          ctx.lineTo(padL + plotW, hov.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(128,138,152,.9)';
          ctx.fillRect(padL + plotW + 1, hov.y - 7, padR - 3, 14);
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(fmtPrice(p), padL + plotW + 5, hov.y);

          // 光标价位对应的持仓盈亏——"如果在这个价位，我是赚还是亏"
          if (costNum && Number(shares) > 0) {
            const pnl = (p - costNum) * Number(shares);
            const pct = costNum > 0 ? ((p - costNum) / costNum) * 100 : 0;
            const txt = `${pnl >= 0 ? '+' : '-'}${fmtMoney(Math.abs(pnl))} ${pct >= 0 ? '+' : ''}${nf(pct, 2)}%`;
            ctx.font = '10px system-ui,sans-serif';
            const tw = ctx.measureText(txt).width + 8;
            const by = hov.y + 18 < padT + priceH ? hov.y + 18 : hov.y - 18;
            ctx.fillStyle = pnl >= 0 ? up : down;
            ctx.fillRect(padL + 4, by - 8, tw, 15);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'left';
            ctx.fillText(txt, padL + 8, by);
          }
        }
        ctx.restore();
        void c;
      }

      opts.stateRef.current.layout = {
        padL, cw, priceH, padT, hi, lo,
        // 框选区间时把「选区从整段的第几根开始、一共几根」也带上，鼠标位置才能换算回整段索引
        start: viewStart, count: shown.length,
      };
    }

    /**
     * 画副图（MACD / KDJ / RSI）。
     *
     * 横轴跟主图完全对齐（同一个 padL / cw），纵轴各自自适应：
     * MACD 以 0 轴上下对称，KDJ/RSI 固定 0~100 并画 20/50/80（RSI 30/70）参考线。
     * KDJ 的 J 值会跑出 0~100，所以整段画在 clip 里，宁可截断也不能画到图外去。
     */
    function drawSubPane(ctx, o) {
      const { def, candles, padL, plotW, cw, subTop, subH, hover, up, down, dim, grid } = o;
      const series = def.build(candles);
      const idx = hover && candles[hover.i] ? hover.i : candles.length - 1;
      const isMacd = def.label === 'MACD';

      let hi = 0;
      let lo = 0;
      if (isMacd) {
        for (const s of def.series) {
          for (const v of series[s.key] || []) {
            if (v == null || !Number.isFinite(v)) continue;
            if (v > hi) hi = v;
            if (v < lo) lo = v;
          }
        }
        const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.05 || 0.01;
        hi += pad;
        lo -= pad;
      } else {
        // KDJ 的 J 会跑出 0~100（J = 3K - 2D），RSI 也偶尔越界。
        // 固定按 0~100 画就会在上下边缘被裁掉一段，看着像画不完，
        // 所以真实极值超出去时把纵轴撑开，没超出去仍按 0~100 画。
        let mx = 100;
        let mn = 0;
        for (const s of def.series) {
          for (const v of series[s.key] || []) {
            if (v == null || !Number.isFinite(v)) continue;
            if (v > mx) mx = v;
            if (v < mn) mn = v;
          }
        }
        if (mx > 100 || mn < 0) {
          const pad = (mx - mn) * 0.04 || 1;
          hi = mx + pad;
          lo = mn - pad;
        } else {
          hi = 100;
          lo = 0;
        }
      }
      const span = hi - lo || 1;
      // 顶部留一条读数带，曲线只在下半段画，读数不会被 K/D/J 穿过
      const bandH = 13;
      const plotTop = subTop + bandH;
      const plotH = Math.max(8, subH - bandH);
      const yOf = (v) => plotTop + plotH - ((v - lo) / span) * plotH;

      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, subTop, plotW, subH);
      ctx.clip();

      // 读数带和曲线区之间的分隔线（画在曲线区顶上，读数带里不落任何线）
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(plotTop) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(plotTop) + 0.5);
      ctx.stroke();
      const refs = (isMacd ? [0] : def.label === 'KDJ' ? [20, 50, 80] : [30, 70])
        .filter((r) => r >= lo && r <= hi);
      for (const r of refs) {
        const y = Math.round(yOf(r)) + 0.5;
        ctx.setLineDash(r === 50 || r === 0 ? [] : [3, 3]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.setLineDash([]);

      // MACD 的柱子先画，折线压在上面
      if (isMacd) {
        const bars = series.macd || [];
        const bw = Math.max(1, Math.min(cw * 0.5, 6));
        const zeroY = yOf(0);
        for (let i = 0; i < candles.length; i++) {
          const v = bars[i];
          if (v == null || !Number.isFinite(v)) continue;
          const y = yOf(v);
          ctx.fillStyle = v >= 0 ? up : down;
          ctx.globalAlpha = 0.5;
          ctx.fillRect(padL + i * cw + cw / 2 - bw / 2, Math.min(y, zeroY), bw, Math.max(1, Math.abs(y - zeroY)));
          ctx.globalAlpha = 1;
        }
      }

      // 折线
      ctx.lineWidth = 1.2;
      for (const s of def.series) {
        if (s.bar) continue;
        const data = series[s.key] || [];
        ctx.strokeStyle = s.color;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < candles.length; i++) {
          const v = data[i];
          if (v == null || !Number.isFinite(v)) { started = false; continue; }
          const x = padL + i * cw + cw / 2;
          const y = yOf(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // 读数条：独占副图顶部那条 13px 的带子，曲线从带子底下开始画，
      // 所以不会出现线穿字、或者读数被裁成半截
      ctx.font = '10px system-ui,sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const limitX = padL + plotW;
      let tx = padL + 2;
      const ty = subTop + bandH / 2 + 1;
      ctx.fillStyle = dim;
      ctx.fillText(def.title, tx, ty);
      tx += ctx.measureText(def.title).width + 8;
      for (const s of def.series) {
        const v = (series[s.key] || [])[idx];
        const txt = `${s.label} ${v == null || !Number.isFinite(v) ? '--' : (isMacd ? fmtSigned(v, 3) : nf(v, 2))}`;
        // 窄图里最后一项可能放不下，放不下就不画，别让它被裁掉一半
        if (tx + ctx.measureText(txt).width > limitX) break;
        ctx.fillStyle = s.color;
        ctx.fillText(txt, tx, ty);
        tx += ctx.measureText(txt).width + 8;
      }
      ctx.restore();
    }

    /* ============================================================ *
     * 分时图（canvas 手绘）
     * ============================================================ */

    /* 组合净值曲线：一天一个点，画的是浮动盈亏率。
       持仓页里折叠着，不展开就完全不发请求。 */
    function drawEquity(canvas, snaps, opts) {
      const ctx = canvas.getContext('2d');
      if (!ctx || !snaps || snaps.length < 2) return;
      const { width, height, dpr } = opts;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const padL = 42;
      const padR = 12;
      const padT = 10;
      const padB = 18;
      const plotW = Math.max(10, width - padL - padR);
      const plotH = Math.max(10, height - padT - padB);
      const vals = snaps.map((s) => Number(s.pnlPct) || 0);
      let hi = Math.max(0, ...vals);
      let lo = Math.min(0, ...vals);
      if (hi === lo) { hi += 1; lo -= 1; }
      const pad = (hi - lo) * 0.14;
      const top = hi + pad;
      const bot = lo - pad;
      const yOf = (v) => padT + plotH - ((v - bot) / (top - bot)) * plotH;
      const xOf = (i) => padL + (plotW * i) / Math.max(1, snaps.length - 1);

      // 0 轴
      const zeroY = yOf(0);
      ctx.strokeStyle = 'rgba(128,128,128,.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, zeroY);
      ctx.lineTo(padL + plotW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);

      const lastVal = vals[vals.length - 1];
      const chg = lastVal - vals[0];
      const color = chg >= 0 ? '#e5484d' : '#0f9d6e';

      // 面积
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, chg >= 0 ? 'rgba(229,72,77,.22)' : 'rgba(15,157,110,.22)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(vals[0]));
      for (let i = 1; i < vals.length; i++) ctx.lineTo(xOf(i), yOf(vals[i]));
      ctx.lineTo(xOf(vals.length - 1), padT + plotH);
      ctx.lineTo(xOf(0), padT + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // 折线
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(vals[0]));
      for (let i = 1; i < vals.length; i++) ctx.lineTo(xOf(i), yOf(vals[i]));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 末点
      ctx.beginPath();
      ctx.arc(xOf(vals.length - 1), yOf(lastVal), 2.4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // 轴标签：上下界百分比 + 起止日期
      ctx.font = '10px system-ui,sans-serif';
      ctx.fillStyle = 'rgba(128,128,128,.95)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${nf(hi, 1)}%`, padL - 6, yOf(hi));
      ctx.fillText(`${nf(lo, 1)}%`, padL - 6, yOf(lo));
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(String(snaps[0].date || '').slice(5), padL, padT + plotH + 5);
      ctx.textAlign = 'right';
      ctx.fillText(String(snaps[snaps.length - 1].date || '').slice(5), padL + plotW, padT + plotH + 5);
    }

    function EquityCard({ refreshKey }) {
      const [open, setOpen] = useState(false);
      const [snaps, setSnaps] = useState(null);
      const [error, setError] = useState(null);
      const [width, setWidth] = useState(680);
      const wrapRef = useRef(null);
      const canvasRef = useRef(null);
      const height = 140;

      useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        api('/equity?limit=120')
          .then((d) => {
            if (!alive) return;
            setSnaps(Array.isArray(d && d.snapshots) ? d.snapshots : []);
            setError(null);
          })
          .catch((err) => { if (alive) setError(err && err.message ? err.message : String(err)); });
        return () => { alive = false; };
      }, [open, refreshKey]);

      useEffect(() => {
        if (!open) return undefined;
        const el = wrapRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => setWidth(el.clientWidth || 680));
        ro.observe(el);
        setWidth(el.clientWidth || 680);
        return () => ro.disconnect();
      }, [open]);

      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !open || !snaps || snaps.length < 2) return;
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        canvas.width = Math.max(1, Math.floor(width * dpr));
        canvas.height = Math.max(1, Math.floor(height * dpr));
        canvas.style.width = `${width}px`;
        drawEquity(canvas, snaps, { width, height, dpr });
      }, [snaps, width, open]);

      const list = snaps || [];
      const first = list[0];
      const last = list[list.length - 1];
      const span = first && last ? (Number(last.pnlPct) || 0) - (Number(first.pnlPct) || 0) : null;
      let drawdown = 0;
      let peak = -Infinity;
      for (const s of list) {
        const v = Number(s.pnlPct) || 0;
        if (v > peak) peak = v;
        const d = peak - v;
        if (d > drawdown) drawdown = d;
      }

      const clearAll = async () => {
        try {
          const d = await post('/equity/clear', {});
          if (d && d.ok === false) throw new Error(d.error || '清空失败');
          setSnaps([]);
          setError(null);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        }
      };

      return h('div', { className: 'dst-equity', ref: wrapRef },
        h('div', { className: 'dst-row', style: { margin: '6px 0 4px' } },
          h('button', {
            className: `dst-btn ${open ? 'dst-on' : ''}`,
            title: '展开/收起收益曲线',
            onClick: () => setOpen((v) => !v),
          }, open && list.length ? `收益曲线 (${list.length} 天)` : '收益曲线'),
          open
            ? h('span', { className: 'dst-muted' }, '每天一个点，用浮动盈亏率画，剔除加仓造成的跳变')
            : h('span', { className: 'dst-muted' }, '按天记净值，看组合整体的走势'),
        ),
        open
          ? h('div', { className: 'dst-equity-body' },
              error
                ? h('div', { className: 'dst-empty' }, error)
                : !list.length
                  ? h('div', { className: 'dst-empty' }, '还没有净值记录。交易时段打开就会开始记，一天一个点。')
                  : [
                      h('div', { className: 'dst-row dst-equity-sum' },
                        h('span', { className: 'dst-muted' }, `共 ${list.length} 天`),
                        span != null
                          ? h('span', { className: dirClass(span) }, `区间 ${fmtSigned(span)}%`)
                          : null,
                        h('span', { className: 'dst-muted' }, `最大回撤 ${nf(drawdown, 1)}%`),
                        last
                          ? h('span', { className: dirClass(last.pnlPct) }, `当前 ${fmtPct(last.pnlPct)}`)
                          : null,
                        h('span', { className: 'dst-spacer' }),
                        h('button', {
                          className: 'dst-btn-ghost', title: '清空净值历史',
                          onClick: clearAll,
                        }, '清空'),
                      ),
                      list.length >= 2
                        ? h('div', { className: 'dst-kline-plot' },
                            h('canvas', { ref: canvasRef, style: { height: `${height}px` } }))
                        : h('div', { className: 'dst-empty' }, '至少要两天的记录才能画曲线，明天再看。'),
                    ]
            )
          : null,
      );
    }

    /* ---------------- 分时图的时间轴 ----------------
     * 分时图的横轴不是「第几个点」，而是「今天第几个交易分钟」。A 股每天两段
     * 09:30–11:30、13:00–15:00，各 120 分钟；午休不占宽度（11:30 和 13:00 画在同一处，
     * 和东财分时图一样）。这样开盘后曲线从左往右长、右边留着当天剩下的时间，
     * 而不是每来一个点就把整条曲线重新挤一遍。
     */
    const TREND_SLOTS = 240; // 一个交易日的分钟槽数
    const TREND_OPEN = 9 * 60 + 30;
    const TREND_NOON = 11 * 60 + 30;
    const TREND_AFTERNOON = 13 * 60;
    const TREND_CLOSE = 15 * 60;
    // 单日刻度的固定标签（槽位 0 / 60 / 120 / 180 / 240）
    const TREND_TICKS = ['9:30', '10:30', '11:30/13:00', '14:00', '15:00'];
    // 纵轴幅度吸附档位：1/4 格取整到这些「好看的刻度」，轴缘是 ±8.00% / ±3.00% 这类数字；
    // 当天逼近涨跌停时（±9.9% 级别）自然吸到 ±10.00%，和直觉一致
    const TREND_STEP_LADDER = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10, 15, 20, 30];
    function niceTrendStep(x) {
      for (const s of TREND_STEP_LADDER) if (s >= x - 1e-9) return s;
      return Math.ceil(x);
    }

    /** "2026-11-24 09:30" / "09:30" / "09:30:00" -> 当天第几分钟 */
    function trendMinuteOf(time) {
      const m = /(\d{1,2}):(\d{2})/.exec(String(time || ''));
      if (!m) return null;
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
      return h * 60 + mi;
    }

    /** 当天第几分钟 -> 分钟槽（0..240，午休折叠） */
    function trendSlotOf(time) {
      const min = trendMinuteOf(time);
      if (min == null) return null;
      if (min <= TREND_OPEN) return 0;
      if (min <= TREND_NOON) return min - TREND_OPEN;
      if (min < TREND_AFTERNOON) return TREND_NOON - TREND_OPEN; // 午休里的点贴到折点
      if (min <= TREND_CLOSE) return (TREND_NOON - TREND_OPEN) + (min - TREND_AFTERNOON);
      return TREND_SLOTS; // 盘后（15:00 之后）夹到收盘
    }

    /** 时间里的 HH:MM，取不到就原样返回 */
    function trendHm(time) {
      const m = /(\d{1,2}):(\d{2})/.exec(String(time || ''));
      return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : String(time || '');
    }

    /** 时间里的 MM-DD（多日分时的日分隔用） */
    function trendDay(time) {
      const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(time || ''));
      return m ? `${m[2]}-${m[3]}` : '';
    }

    /**
     * 把一串分时点摊成「连续槽位」：返回每点的槽、跨了几天、总槽数。
     * 多日数据是一天接一天拼起来的，时间从 15:00 跳回 09:30 就认为换了一天
     * （午休 11:30 -> 13:00 是往前跳，不会被误判）。
     */
    function trendLayout(points) {
      const days = [];
      const slots = [];
      let dayIdx = 0;
      let dayKey = '';
      let prevMin = null;
      for (const p of points) {
        const min = trendMinuteOf(p.time);
        if (prevMin != null && min != null && min < prevMin - 60) dayIdx += 1;
        // 带日期时优先用日期判天，跨月/跨年也不会串
        const key = /^\s*\d{4}-\d{2}-\d{2}/.test(String(p.time || '')) ? trendDay(p.time) : '';
        if (key && dayKey && key !== dayKey) dayIdx = Math.max(dayIdx, days.length);
        if (key) dayKey = key;
        if (!days[dayIdx]) days[dayIdx] = { index: dayIdx, label: key || '' };
        const slot = trendSlotOf(p.time);
        slots.push(dayIdx * TREND_SLOTS + (slot == null ? 0 : slot));
        if (min != null) prevMin = min;
      }
      const dayCount = Math.max(1, days.length);
      return { slots, dayCount, total: dayCount * TREND_SLOTS, days };
    }

    /** 槽位数组是单调不减的，二分找离 target 最近的下标 */
    function nearestSlotIndex(slots, target) {
      if (!slots || !slots.length) return -1;
      if (target <= slots[0]) return 0;
      const lastIdx = slots.length - 1;
      if (target >= slots[lastIdx]) return lastIdx;
      let lo = 0;
      let hi = lastIdx;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (slots[mid] < target) lo = mid + 1; else hi = mid;
      }
      // lo 是第一个 >= target 的位置，和它前一个比谁更近
      const prevIdx = Math.max(0, lo - 1);
      const dPrev = Math.abs(slots[prevIdx] - target);
      const dNext = Math.abs(slots[lo] - target);
      return dPrev <= dNext ? prevIdx : lo;
    }

    /** 悬停读数里的时间：多日分时带日期，单日只给 HH:MM */
    function trendStamp(time, multiDay) {
      const hm = trendHm(time);
      const d = trendDay(time);
      return d && multiDay ? `${d} ${hm}` : hm;
    }

    function TrendChart({ data, height = 300, title, cost = null, shares = 0, code = '', name = '', symbol = '' }) {
      const wrapRef = useRef(null);
      const canvasRef = useRef(null);
      const [width, setWidth] = useState(720);
      const [hover, setHover] = useState(null);
      const stateRef = useRef({ layout: null });

      useEffect(() => {
        const el = wrapRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => setWidth(el.clientWidth || 720));
        ro.observe(el);
        setWidth(el.clientWidth || 720);
        return () => ro.disconnect();
      }, []);

      const points = (data && data.points) || [];

      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        canvas.width = Math.max(1, Math.floor(width * dpr));
        canvas.height = Math.max(1, Math.floor(height * dpr));
        drawTrend(canvas, data, { width, height, dpr, hover, stateRef, cost, shares, code, name, symbol });
      }, [data, width, height, hover, cost, shares, code, name, symbol]);

      const handleMove = (e) => {
        const layout = stateRef.current.layout;
        if (!layout || !points.length || !layout.slots) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const slot = ((x - layout.padL) / layout.plotW) * layout.total;
        const i = nearestSlotIndex(layout.slots, slot);
        if (i < 0) return;
        setHover({ i, x, y: e.clientY - rect.top });
      };

      const multiDay = Number(data && data.days) > 1;
      const hovered = hover && points[hover.i] ? points[hover.i] : null;
      const prev = data ? data.prevClose : null;
      const hoverPct = hovered && prev ? ((hovered.price - prev) / prev) * 100 : null;

      // 读数取「光标那天」或「最新一个点」，别让均价只在悬停时才有数
      const last = points.length ? points[points.length - 1] : null;
      const readAt = hovered || last;
      const readPct = readAt && prev ? ((readAt.price - prev) / prev) * 100 : null;

      return h('div', { className: 'dst-kline', ref: wrapRef },
        h('div', { className: 'dst-kline-head' },
          h('span', { className: 'dst-kline-title' }, title || '分时'),
          hovered
            ? h('span', { className: dirClass(hoverPct) },
                `${trendStamp(hovered.time, multiDay)}  ${fmtPrice(hovered.price)}  ${fmtPct(hoverPct)}  均${fmtPrice(hovered.avg)}`)
            : h('span', { className: 'dst-muted' },
                prev ? `昨收 ${fmtPrice(prev)}　${data.days > 1 ? `${data.days}日` : '今日'}` : ''),
          h('span', { className: 'dst-spacer' }),
          data && data.provider ? h('span', { className: 'dst-muted' }, data.provider) : null,
        ),
        // 画布 + 浮在左上角的价格/均价读数（跟 K 线均线读数一个位置、一套样式）
        h('div', { className: 'dst-kline-plot' },
          h('canvas', {
            ref: canvasRef,
            style: { height: `${height}px` },
            onMouseMove: handleMove,
            onMouseLeave: () => setHover(null),
          }),
          h('div', { className: 'dst-legend dst-legend-float' },
            h('span', { className: 'dst-legend-item',
              title: `现价${hovered ? `（${trendStamp(hovered.time, multiDay)}）` : '（最新）'}` },
              h('i', { style: { background: readPct != null && readPct < 0 ? 'var(--dst-down)' : 'var(--dst-up)' } }),
              '价格',
              h('b', { className: `dst-legend-val ${readPct != null ? dirClass(readPct) : ''}` },
                readAt ? fmtPrice(readAt.price) : '--')),
            h('span', { className: 'dst-legend-item',
              title: `均价${hovered ? `（${trendStamp(hovered.time, multiDay)}）` : '（最新）'}` },
              h('i', { style: { background: '#e8b339' } }),
              '均价',
              h('b', { className: 'dst-legend-val', style: { color: '#e8b339' } },
                readAt ? fmtPrice(readAt.avg) : '--')),
            hovered ? h('span', { className: 'dst-muted dst-legend-when' }, `← ${trendStamp(hovered.time, multiDay)}`) : null,
          ),
        ),
        points.length ? null : h('div', { className: 'dst-empty' }, '暂无分时数据'),
      );
    }

    function drawTrend(canvas, data, opts) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { width, height, dpr, hover, stateRef, cost = null, shares = 0, code = '', name = '', symbol = '' } = opts;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const points = (data && data.points) || [];
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(canvas) : null;
      const cssVar = (name, fallback) => {
        const v = style ? style.getPropertyValue(name) : '';
        return (v && v.trim()) || fallback;
      };
      const UP = cssVar('--dst-up', '#e5484d');
      const DOWN = cssVar('--dst-down', '#0f9d6e');
      const FG = cssVar('--dst-flat', '#8b949e');
      const GRID = cssVar('--dst-grid', 'rgba(128,138,152,.16)');
      const COST = cssVar('--dst-cost', '#6b5ce7');

      const padL = 8;
      const padR = 58;
      // 顶部留出「价格/均价」浮层的高度，曲线不会从读数条底下穿出来
      const padT = 26;
      const gapV = 10;
      const volH = Math.max(30, Math.round((height - padT) * 0.2));
      const priceH = height - padT - volH - gapV;
      const plotW = Math.max(10, width - padL - padR);

      if (!points.length) {
        ctx.fillStyle = FG;
        ctx.font = '12px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('暂无分时数据', width / 2, height / 2);
        stateRef.current.layout = null;
        return;
      }

      const prev = Number(data.prevClose) || Number(points[0].price) || 1;
      let hi = prev;
      let lo = prev;
      for (const p of points) {
        hi = Math.max(hi, p.price, p.avg || p.price);
        lo = Math.min(lo, p.price, p.avg || p.price);
      }
      // 以昨收为中心做对称区间 —— 分时图的惯例，0% 线在正中间。
      // 纵轴一律按当日实际波幅自适应（东财 App 同款）：涨多少跌多少，曲线就占大头。
      // 曾经两版极端都不对——写死 ±100% 时小波动看不见，锚定 ±10% 涨跌停后
      // 小涨小跌的日子（±1% 级别）整条曲线又被压成一条横线，同样看不出趋势。
      // 指数、港美股、多日分时本来就自适应；现在个股/ETF 当日也统一自适应。
      // 幅度先留 20% 余量再吸附到好看档位（东财同款：顶格刻度永远在当日最高价上方，
      // 「价格没到也要把最高这格显示出来」——当日偏离 7.46% 时轴缘是 ±10.00%）。
      // 底 0.2% 防止一字板时轴窄到除零。成本价落在附近（≤1.3 倍当日波幅）时把区间
      // 撑开，好让成本线看得见；再远的陈年成本贴边显示，不为它把曲线压扁。
      const costNum = Number(cost) > 0 ? Number(cost) : 0;
      let spanPct = Math.max(hi - prev, prev - lo, prev * 0.002) / prev * 100;
      let costClamped = null;
      if (costNum) {
        const dPct = Math.abs(costNum - prev) / prev * 100;
        if (dPct <= spanPct * 1.3) spanPct = Math.max(spanPct, dPct * 1.06);
        else costClamped = costNum > prev ? 'above' : 'below';
      }
      const span = niceTrendStep(spanPct * 1.2 / 4) * 4 * prev / 100;
      const top = prev + span;
      const bot = prev - span;
      const yOf = (v) => padT + ((top - v) / (top - bot)) * priceH;

      // 网格 + 右侧刻度：第一行是「这个位置对应的价格」，下面一行小字标涨跌幅
      // （用户反馈：光标指到哪儿，直接看到对应今天的什么价，比只写百分比直观）。
      // 按 1/4 步画 9 条线（东财同款密度），波幅小时趋势一眼能看出来
      ctx.textAlign = 'left';
      for (const frac of [1, 0.75, 0.5, 0.25, 0, -0.25, -0.5, -0.75, -1]) {
        const v = prev + span * frac;
        const y = yOf(v);
        ctx.strokeStyle = frac === 0 ? 'rgba(128,138,152,.42)' : GRID;
        ctx.setLineDash(frac === 0 ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        // 价格（主）：0% 那行是昨收，边缘是当日最高/最低方向上的对称价
        ctx.font = '11px system-ui, -apple-system, sans-serif';
        ctx.fillStyle = v > prev ? UP : v < prev ? DOWN : FG;
        ctx.fillText(fmtPrice(v), padL + plotW + 4, y + 3);
        // 涨跌幅（辅）：随当日实际波幅走（如 ±2.58%）
        ctx.font = '9px system-ui, -apple-system, sans-serif';
        ctx.fillStyle = FG;
        ctx.fillText(fmtPct(((v - prev) / prev) * 100, false), padL + plotW + 4, y + 13);
      }

      // 持仓成本线
      if (costNum) {
        const y = costClamped === 'above' ? padT + 1
          : costClamped === 'below' ? padT + priceH - 1
            : yOf(costNum);
        if (y >= padT - 1 && y <= padT + priceH + 1) {
          ctx.save();
          ctx.strokeStyle = COST;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(padL, Math.round(y) + 0.5);
          ctx.lineTo(padL + plotW, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          const arrow = costClamped === 'above' ? ' ↑' : costClamped === 'below' ? ' ↓' : '';
          const label = `成本 ${fmtPrice(costNum)}${arrow}`;
          ctx.font = '11px system-ui, -apple-system, sans-serif';
          const lw = ctx.measureText(label).width + 8;
          ctx.fillStyle = COST;
          // 出轴（贴边）时贴左端画：右端上下角是涨跌停/极值刻度，黑块会压在刻度上；
          // 轴内时贴右端画，避开左上角的「价格/均价」读数浮层
          const lx = costClamped ? padL + 4 : padL + plotW - lw - 6;
          const ly = costClamped === 'above' ? y + 4 : costClamped === 'below' ? y - 2 : y;
          ctx.fillRect(lx, ly - 8, lw, 15);
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(label, lx + 4, ly + 4);
          ctx.restore();
        }
      }

      /* ---- 横轴：按交易分钟定位，而不是按「第几个点」均分 ----
       * 时间解析不出来（老数据/别的市场）就退回「按点序均分」，不让图变成一条竖线。
       */
      const axis = trendLayout(points);
      const axisOk = points.length > 1 && axis.slots[axis.slots.length - 1] > axis.slots[0];
      const plotSlots = axisOk ? axis.slots : points.map((_, i) => i);
      const plotTotal = axisOk ? axis.total : Math.max(1, points.length - 1);
      const xOf = (i) => padL + (plotW * plotSlots[i]) / plotTotal;

      // 分时段竖向网格：单日在 10:30 / 11:30|13:00 / 14:00，多日在每天的午休折点
      {
        const marks = [];
        if (axisOk && axis.dayCount > 1) {
          for (let d = 0; d < axis.dayCount; d++) marks.push(d * TREND_SLOTS + TREND_SLOTS / 2);
        } else if (axisOk) {
          marks.push(60, 120, 180);
        }
        if (marks.length) {
          ctx.save();
          ctx.strokeStyle = GRID;
          ctx.setLineDash([]);
          ctx.beginPath();
          for (const m of marks) {
            const x = Math.round(padL + (plotW * m) / plotTotal) + 0.5;
            ctx.moveTo(x, padT);
            ctx.lineTo(x, padT + priceH + volH);
          }
          ctx.stroke();
          ctx.restore();
        }
      }

      // 成交量（柱子的 x 和价格线同一个映射，收盘前右边就是空的）
      let maxVol = 0;
      for (const p of points) maxVol = Math.max(maxVol, p.volume || 0);
      const volTop = padT + priceH + gapV;
      const barW = Math.max(0.6, axisOk ? Math.min(14, (plotW / plotTotal) * 0.9) : plotW / Math.max(1, points.length) - 0.6);
      const last = points[points.length - 1].price;
      const line = last >= prev ? UP : DOWN;

      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const x = xOf(i);
        const hh = maxVol > 0 ? ((p.volume || 0) / maxVol) * (volH - 4) : 0;
        const up = p.price >= prev;
        ctx.fillStyle = up ? UP : DOWN;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x - barW / 2, volTop + (volH - hh), barW, hh);
      }
      ctx.globalAlpha = 1;

      // 价格线 + 面积
      const grad = ctx.createLinearGradient(0, padT, 0, padT + priceH);
      grad.addColorStop(0, line === UP ? 'rgba(229,72,77,.24)' : 'rgba(15,157,110,.24)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(points[0].price));
      for (let i = 1; i < points.length; i++) ctx.lineTo(xOf(i), yOf(points[i].price));
      ctx.lineTo(xOf(points.length - 1), padT + priceH);
      ctx.lineTo(xOf(0), padT + priceH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(points[0].price));
      for (let i = 1; i < points.length; i++) ctx.lineTo(xOf(i), yOf(points[i].price));
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // 均价线
      if (points.some((p) => p.avg)) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < points.length; i++) {
          if (!points[i].avg) continue;
          const x = xOf(i);
          const y = yOf(points[i].avg);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#e8b339';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 现价小圆点：收盘前线头停在「现在」，收盘后贴在 15:00 那条线上
      {
        const xe = xOf(points.length - 1);
        const ye = yOf(last);
        ctx.beginPath();
        ctx.arc(xe, ye, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = line;
        ctx.fill();
      }

      // 时间轴：固定刻度。单日就是 9:30 / 10:30 / 11:30|13:00 / 14:00 / 15:00
      // （午休折掉，所以 11:30 和 13:00 是同一个位置）；多日每天标一个日期。
      ctx.fillStyle = FG;
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      const axisY = padT + priceH + 12;
      if (axisOk && axis.dayCount > 1) {
        ctx.textAlign = 'left';
        for (let d = 0; d < axis.dayCount; d++) {
          const label = (axis.days[d] && axis.days[d].label) || '';
          if (!label) continue;
          ctx.fillText(label, padL + (plotW * (d * TREND_SLOTS)) / plotTotal + 2, axisY);
        }
      } else if (axisOk) {
        for (let k = 0; k < TREND_TICKS.length; k++) {
          const slot = (TREND_SLOTS * k) / (TREND_TICKS.length - 1);
          ctx.textAlign = k === 0 ? 'left' : k === TREND_TICKS.length - 1 ? 'right' : 'center';
          ctx.fillText(TREND_TICKS[k], padL + (plotW * slot) / plotTotal, axisY);
        }
      } else {
        ctx.textAlign = 'center';
        const step = Math.max(1, Math.floor(points.length / 4));
        for (let i = 0; i < points.length; i += step) {
          ctx.fillText(trendHm(points[i].time), xOf(i), axisY);
        }
      }

      // 十字光标
      if (hover && points[hover.i]) {
        const p = points[hover.i];
        const x = xOf(hover.i);
        const y = yOf(p.price);
        ctx.strokeStyle = 'rgba(128,138,152,.7)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + priceH + volH);
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = line;
        ctx.fill();
        ctx.fillStyle = 'rgba(128,138,152,.9)';
        ctx.fillRect(padL + plotW + 1, y - 7, padR - 3, 14);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(fmtPrice(p.price), padL + plotW + 5, y + 4);

        // 该价位的持仓盈亏
        if (costNum && Number(shares) > 0) {
          const pnl = (p.price - costNum) * Number(shares);
          const pct = ((p.price - costNum) / costNum) * 100;
          const txt = `${pnl >= 0 ? '+' : '-'}${fmtMoney(Math.abs(pnl))} ${pct >= 0 ? '+' : ''}${nf(pct, 2)}%`;
          ctx.font = '10px system-ui, sans-serif';
          const tw = ctx.measureText(txt).width + 8;
          const by = y + 18 < padT + priceH ? y + 18 : y - 18;
          ctx.fillStyle = pnl >= 0 ? UP : DOWN;
          ctx.fillRect(padL + 4, by - 8, tw, 15);
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(txt, padL + 8, by);
        }
      }

      stateRef.current.layout = { padL, plotW, priceH, padT, top, bot, slots: plotSlots, total: plotTotal };
    }

    /* ============================================================ *
     * 五档盘口
     * ============================================================ */

    function OrderBookCard({ symbol, height }) {
      const [book, setBook] = useState(null);
      const [error, setError] = useState(null);

      useEffect(() => {
        if (!symbol) return undefined;
        let alive = true;
        const tick = async () => {
          if (typeof document !== 'undefined' && document.hidden) return;
          try {
            const d = await api(`/orderbook?symbol=${encodeURIComponent(symbol)}`);
            if (alive) { setBook(d); setError(null); }
          } catch (err) {
            if (alive) setError(err && err.message ? err.message : String(err));
          }
        };
        tick();
        const id = setInterval(tick, 4000);
        return () => { alive = false; clearInterval(id); };
      }, [symbol]);

      if (error) return h('div', { className: 'dst-book' }, h('div', { className: 'dst-empty' }, error));
      if (!book) return h('div', { className: 'dst-book' }, h('div', { className: 'dst-empty' }, '盘口加载中…'));

      // 宿主返回的 asks[0] 是卖1（最低卖价），bids[0] 是买1（最高买价）。
      // 盘口惯例是「卖5 在最上、卖1 贴近现价」，所以卖盘要倒过来显示。
      const asks = (book.asks || []).slice().reverse();
      const bids = (book.bids || []).slice();
      const maxVol = Math.max(1, ...asks.map((a) => a.volume || 0), ...bids.map((b) => b.volume || 0));
      void height;

      const row = (lvl, kind, i) => h('div', { className: `dst-book-row dst-book-${kind}`, key: `${kind}${i}` },
        h('span', { className: 'dst-book-lv' }, kind === 'ask' ? `卖${asks.length - i}` : `买${i + 1}`),
        h('span', { className: 'dst-book-px' }, fmtPrice(lvl.price)),
        h('span', { className: 'dst-book-vol' }, fmtVol(lvl.volume)),
        h('i', { className: 'dst-book-bar', style: { width: `${Math.min(100, ((lvl.volume || 0) / maxVol) * 100)}%` } }),
      );

      // 委比已经是百分数（宿主 providers.js 里就乘过 100 了），这里不能再乘一次。
      // 旧代码写成 `(x * 100).toFixed(2)`，真实 -19.53% 会显示成 -1952.59%。
      const bookRatio = Number.isFinite(Number(book.commissionRatio))
        ? Math.max(-100, Math.min(100, Number(book.commissionRatio)))
        : null;
      const ratioText = bookRatio == null ? '--' : `${bookRatio.toFixed(2)}%`;
      const diff = Number(book.commissionDiff);
      const diffText = Number.isFinite(diff)
        ? `${diff >= 0 ? '+' : '-'}${fmtVol(Math.abs(diff))}`
        : '--';
      const ratioTitle = bookRatio == null
        ? '没有盘口数据，算不出委比'
        : `委比 =（买盘总量 − 卖盘总量）÷ 买卖总量 × 100%\n`
          + `买盘 ${fmtVol(book.bidVolume)} · 卖盘 ${fmtVol(book.askVolume)} · 委差 ${diffText}\n`
          + '正值买盘强（想买的挂单多），负值卖盘强；±100% 只在一边完全没挂单时出现。';

      return h('div', { className: 'dst-book' },
        h('div', { className: 'dst-book-head' },
          h('span', null, '五档盘口'),
          h('span', { className: 'dst-spacer' }),
          h('span', { className: 'dst-muted', title: ratioTitle }, `委比 ${ratioText}`),
        ),
        h('div', { className: 'dst-book-sides' },
          h('div', { className: 'dst-book-col' },
            asks.map((l, i) => row(l, 'ask', i)),
          ),
          h('div', { className: 'dst-book-col' },
            bids.map((l, i) => row(l, 'bid', i)),
          ),
        ),
        h('div', { className: 'dst-book-foot' },
          h('span', null, `现价 ${fmtPrice(book.price)}`),
          h('span', { className: 'dst-spacer' }),
          h('span', { className: 'dst-muted' }, `买量 ${fmtVol(book.bidVolume)}　卖量 ${fmtVol(book.askVolume)}`),
        ),
      );
    }

    /* ============================================================ *
     * 预警提示浮层
     * ============================================================ */

    /* 自动跟踪完成通知的"已读"游标：模块级，顶栏/侧边栏复用同一份，避免重复弹 */
    const autoNoticeSeen = { ready: false, id: null, ids: new Set() };

    function Toasts({ toasts, onDismiss, notices, onOpenNotice, onDismissNotice }) {
      const alerts = toasts || [];
      const notes = notices || [];
      if (!alerts.length && !notes.length) return null;
      return h('div', { className: 'dst-toasts' },
        notes.map((n) => h('div', {
          className: 'dst-toast dst-notice',
          key: `n:${n.id}`,
          onClick: () => onOpenNotice(n),
        },
          h('span', { className: 'dst-toast-icon' }, '🤖'),
          h('span', { className: 'dst-toast-body' },
            h('b', null, `${n.trigger === 'preplan' ? '盘前计划' : '自动跟踪'} · ${n.trigger === 'preplan' ? '开盘前' : (n.trigger || '收盘')}`),
            h('div', null, n.name || n.symbol),
            h('span', { className: 'dst-muted' }, n.snippet || ''),
            h('div', { className: 'dst-notice-hint' }, '点击查看全文'),
          ),
          h('button', {
            className: 'dst-toast-x',
            onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); onDismissNotice(n.id); },
            title: '知道了',
          }, '✕'),
        )),
        alerts.map((a) => {
          const key = `${a.id}:${a.firedAt || 0}`;
          const isPct = a.kind === 'pct';
          const sign = a.op === '>=' ? '↑' : '↓';
          // 触发时给一句动作建议：优先用预警自带的 advice，没有就按方向兜底
          const advice = a.advice || (isPct ? '' : (a.op === '>='
            ? `站上 ${a.value}：放量再确认，冲高不追`
            : `跌破 ${a.value}：先看量能，放量才减，缩量等收盘`));
          return h('div', { className: 'dst-toast', key },
            h('span', { className: 'dst-toast-icon' }, '🔔'),
            h('span', { className: 'dst-toast-body' },
              h('b', null, a.name || a.symbol),
              h('span', null, ` ${isPct ? '涨跌幅' : '价格'} ${sign} ${a.value}${isPct ? '%' : ''}`),
              h('span', { className: 'dst-muted' }, `　现价 ${fmtPrice(a.current)}${
                a.volRatio != null && Number.isFinite(Number(a.volRatio))
                  ? ` · 量比 ${Number(a.volRatio).toFixed(2)}` : ''}`),
              advice ? h('div', { className: 'dst-toast-advice' }, `⤷ ${advice}`) : null,
            ),
            h('button', {
              className: 'dst-toast-x',
              onClick: () => onDismiss(key),
              title: '知道了',
            }, '✕'),
          );
        }),
      );
    }

    /* ============================================================ *
     * 顶部条
     * ============================================================ */

    /** 价格变动闪烁 */
    function useFlash(symbol, price, enabled) {
      const prev = useRef(price);
      const [flash, setFlash] = useState(null);
      useEffect(() => {
        if (!enabled || price === null || price === undefined) {
          prev.current = price;
          return undefined;
        }
        const before = prev.current;
        prev.current = price;
        if (before === null || before === undefined || before === price) return undefined;
        setFlash(price > before ? 'up' : 'down');
        const id = setTimeout(() => setFlash(null), 700);
        return () => clearTimeout(id);
      }, [price, enabled, symbol]);
      return flash;
    }

    /**
     * 条内横向滚动。
     * 触摸板本来就能横向滑，但鼠标滚轮只产生 deltaY，而轨道是 overflow-x，
     * 所以以前只有触摸板能滑 —— 这里把纵向滚轮换算成横向，并支持按住拖动。
     * enabled 时再叠加匀速自动滚动（类似歌词条），鼠标悬停/拖动时暂停。
     */
    function useMarquee(ref, enabled, deps) {
      useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        let raf = 0;
        let last = 0;
        let pos = 0;
        let paused = false;
        let drag = null;
        let dragMoved = false;
        let swallowClick = false;
        const maxScroll = () => Math.max(0, el.scrollWidth - el.clientWidth);

        const onEnter = () => { paused = true; };
        const onLeave = () => { paused = false; };
        const onWheel = (e) => {
          const max = maxScroll();
          if (max <= 2) return; // 没溢出就不拦滚轮，交给页面
          // 横向滚轮优先，否则用纵向（普通鼠标只有纵向）
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!d) return;
          paused = true;
          el.scrollLeft = Math.min(max, Math.max(0, el.scrollLeft + d));
          pos = el.scrollLeft;
          if (e.cancelable !== false) e.preventDefault();
        };
        const onDown = (e) => {
          if (e.button !== 0 || maxScroll() <= 2) return;
          drag = { x: e.clientX, left: el.scrollLeft };
          dragMoved = false;
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        };
        const onMove = (e) => {
          if (!drag) return;
          const dx = e.clientX - drag.x;
          if (!dragMoved && Math.abs(dx) < 4) return; // 抖动阈值：小抖动仍算点击
          dragMoved = true;
          paused = true;
          el.scrollLeft = Math.min(maxScroll(), Math.max(0, drag.left - dx));
          pos = el.scrollLeft;
          if (e.cancelable !== false) e.preventDefault();
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          drag = null;
          if (dragMoved) {
            // 拖动结束浏览器还会补一次 click，别让它变成「选中这只」
            swallowClick = true;
            setTimeout(() => { swallowClick = false; }, 0);
          }
        };
        const onClickCapture = (e) => {
          if (!swallowClick) return;
          swallowClick = false;
          e.stopPropagation();
          if (e.cancelable !== false) e.preventDefault();
        };
        const tick = (t) => {
          raf = requestAnimationFrame(tick);
          if (paused) { last = t; return; }
          if (!last) { last = t; return; }
          const dt = Math.min(64, t - last);
          last = t;
          const max = maxScroll();
          if (max <= 2) { if (pos !== 0) { pos = 0; el.scrollLeft = 0; } return; }
          pos += dt * 0.04;
          if (pos >= max) pos = 0;
          el.scrollLeft = pos;
        };
        el.addEventListener('mouseenter', onEnter);
        el.addEventListener('mouseleave', onLeave);
        el.addEventListener('wheel', onWheel, { passive: false });
        el.addEventListener('mousedown', onDown);
        el.addEventListener('click', onClickCapture, true);
        if (enabled) raf = requestAnimationFrame(tick);
        return () => {
          cancelAnimationFrame(raf);
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          el.removeEventListener('mouseenter', onEnter);
          el.removeEventListener('mouseleave', onLeave);
          el.removeEventListener('wheel', onWheel);
          el.removeEventListener('mousedown', onDown);
          el.removeEventListener('click', onClickCapture, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [enabled, deps]);
    }

    function Chip({ pos, selected, onSelect, flash, dragHandlers }) {
      const q = pos.quote;
      // pos.changePct 是宿主 computePosition 拍平出来的字段，比嵌套的 quote 更可靠
      const changePct = pos.changePct != null ? pos.changePct : q ? q.changePct : null;
      const cls = useFlash(pos.symbol, pos.price, flash);
      const title = q
        ? `${q.name || pos.name} ${pos.code}\n现价 ${fmtPrice(q.price)}  涨跌 ${fmtSigned(q.change)} (${fmtPct(q.changePct)})\n` +
          `今开 ${fmtPrice(q.open)}  昨收 ${fmtPrice(q.prevClose)}\n最高 ${fmtPrice(q.high)}  最低 ${fmtPrice(q.low)}\n` +
          `成交 ${fmtVol(q.volume)}  额 ${fmtMoney(q.amount)}\n换手 ${q.turnover != null ? nf(q.turnover, 2) + '%' : '--'}  量比 ${q.volRatio != null ? nf(q.volRatio, 2) : '--'}\n` +
          (pos.held
            ? `持股 ${pos.shares}  成本 ${fmtPrice(pos.cost)}\n市值 ${fmtMoney(pos.marketValue)}  盈亏 ${fmtSigned(pos.pnl)} (${fmtPct(pos.pnlPct)})`
            : '未持仓')
        : `${pos.name} ${pos.code}`;

      const children = [
        h('span', { key: 'n', className: 'dst-chip-name' }, pos.name || pos.code),
        h('span', { key: 'p', className: `dst-chip-price ${dirClass(changePct)} ${cls ? 'dst-flash-' + cls : ''}` },
          fmtPrice(pos.price)),
        h('span', { key: 'c', className: dirClass(changePct) }, fmtPct(changePct)),
      ];
      const lim = limitState(pos);
      if (lim) {
        children.push(h('span', { key: 'l', className: `dst-limit dst-limit-${lim}` }, LIMIT_TEXT[lim]));
      }
      if (pos.held) {
        children.push(h('span', { key: 'h', className: 'dst-chip-code' }, `持${pos.shares}`));
      }

      return h('div', {
        className: `dst-chip ${selected ? 'dst-active' : ''}${lim ? ' dst-chip-' + lim : ''}`,
        title,
        onClick: () => onSelect(pos.symbol),
        // 拖动排序（可选能力：宿主没带 reorder 时 dragHandlers 为空，行为不变）
        draggable: !!(dragHandlers && dragHandlers.onDrop),
        onDragStart: dragHandlers && dragHandlers.onDragStart,
        onDragOver: dragHandlers && dragHandlers.onDragOver,
        onDragLeave: dragHandlers && dragHandlers.onDragLeave,
        onDrop: dragHandlers && dragHandlers.onDrop,
        onDragEnd: dragHandlers && dragHandlers.onDragEnd,
      }, children);
    }

    function TotalsBadge({ totals, currency, onClick }) {
      const sign = CURRENCY_SIGN[currency] || '';
      if (!totals || !totals.hasPosition) {
        return h('div', { className: 'dst-total', onClick, title: '还没有录入持仓（在面板「添加」里填写股数和成本价）' },
          h('span', { className: 'dst-total-label' }, '未持仓'));
      }
      return h('div', { className: 'dst-total', onClick, title: '点击查看持仓明细' },
        h('span', { className: 'dst-total-label' }, '总盈亏'),
        h('span', { className: dirClass(totals.pnl) }, `${sign}${fmtSigned(totals.pnl)}`),
        h('span', { className: dirClass(totals.pnlPct) }, fmtPct(totals.pnlPct)),
        h('span', { className: 'dst-total-label' }, `市值 ${sign}${fmtMoney(totals.marketValue)}`),
      );
    }

    /* ============================================================ *
     * 可编辑数字单元格
     * ============================================================ */

    function NumCell({ value, onCommit, placeholder, title }) {
      const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
      const [editing, setEditing] = useState(false);
      useEffect(() => {
        if (!editing) setDraft(value === null || value === undefined ? '' : String(value));
      }, [value, editing]);

      const commit = () => {
        setEditing(false);
        const next = draft.trim() === '' ? 0 : Number(draft);
        if (!Number.isFinite(next) || next < 0) {
          setDraft(value === null || value === undefined ? '' : String(value));
          return;
        }
        if (next !== Number(value)) onCommit(next);
      };

      return h('input', {
        className: 'dst-input dst-num',
        title: title || '双击输入，回车或失焦保存',
        value: draft,
        placeholder: placeholder || '0',
        onFocus: () => setEditing(true),
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.currentTarget.blur(); }
          else if (e.key === 'Escape') {
            setDraft(value === null || value === undefined ? '' : String(value));
            setEditing(false);
            e.currentTarget.blur();
          }
        },
        onClick: (e) => e.stopPropagation(),
      });
    }

    /* ============================================================ *
     * 添加 / 搜索表单
     * ============================================================ */

    function AddForm({ onSave, onSaved }) {
      const [q, setQ] = useState('');
      const [hits, setHits] = useState([]);
      const [showHits, setShowHits] = useState(false);
      const [picked, setPicked] = useState(null);
      const [shares, setShares] = useState('');
      const [cost, setCost] = useState('');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const [notice, setNotice] = useState(null);
      const boxRef = useRef(null);

      useEffect(() => {
        const term = q.trim();
        if (picked || term.length < 1) { setHits([]); return undefined; }
        let alive = true;
        const id = setTimeout(async () => {
          try {
            const d = await api(`/search?q=${encodeURIComponent(term)}`);
            if (alive) { setHits(d.hits || []); setShowHits(true); }
          } catch {
            if (alive) setHits([]);
          }
        }, 200);
        return () => { alive = false; clearTimeout(id); };
      }, [q, picked]);

      useEffect(() => {
        const onDoc = (e) => {
          if (boxRef.current && !boxRef.current.contains(e.target)) setShowHits(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
      }, []);

      const submit = async () => {
        const term = q.trim();
        if (!picked && !term) { setErr('请输入股票代码或名称'); return; }
        setBusy(true);
        setErr(null);
        setNotice(null);
        try {
          const item = await onSave({
            symbol: picked ? picked.symbol : undefined,
            input: picked ? undefined : term,
            code: picked ? picked.code : undefined,
            market: picked ? picked.market : undefined,
            name: picked ? picked.name : undefined,
            shares: shares === '' ? undefined : Number(shares),
            cost: cost === '' ? undefined : Number(cost),
            watch: true,
          });
          setNotice(`已加入：${item.name || item.code}${item.shares ? `  持股 ${item.shares}` : ''}${item.cost ? `  成本 ${fmtPrice(item.cost)}` : ''}`);
          setQ('');
          setPicked(null);
          setShares('');
          setCost('');
          setShowHits(false);
          if (onSaved) onSaved(item.symbol);
        } catch (e) {
          setErr(e && e.message ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'dst-form', ref: boxRef, style: { position: 'relative' } },
        h('div', { style: { position: 'relative' } },
          h('input', {
            className: 'dst-input dst-search',
            placeholder: '代码 / 名称 / 拼音，如 600519 或 茅台 或 gzmt',
            value: picked ? `${picked.name} (${picked.code})` : q,
            onChange: (e) => { setPicked(null); setQ(e.target.value); },
            onFocus: () => { if (hits.length) setShowHits(true); },
            onKeyDown: (e) => {
              if (e.key === 'Enter') { e.preventDefault(); if (hits.length && !picked) { setPicked(hits[0]); setShowHits(false); } else submit(); }
              if (e.key === 'Escape') setShowHits(false);
            },
          }),
          showHits && hits.length
            ? h('div', { className: 'dst-hits' },
                hits.map((hit) => h('div', {
                  key: hit.symbol,
                  className: 'dst-hit',
                  onClick: () => { setPicked(hit); setShowHits(false); },
                },
                  h('span', { className: 'dst-hit-code' }, hit.code),
                  h('span', { className: 'dst-name' }, hit.name),
                  h('span', { className: 'dst-sub' }, hit.marketName || ''),
                )),
              )
            : null,
        ),
        h('label', { className: 'dst-field' }, '持股',
          h('input', {
            className: 'dst-input dst-num', placeholder: '0', value: shares,
            onChange: (e) => setShares(e.target.value.replace(/[^\d.]/g, '')),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
          })),
        h('label', { className: 'dst-field' }, '成本价',
          h('input', {
            className: 'dst-input dst-num', placeholder: '0.00', value: cost,
            onChange: (e) => setCost(e.target.value.replace(/[^\d.]/g, '')),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
          })),
        h('button', { className: 'dst-btn-primary', disabled: busy, onClick: submit },
          busy ? '添加中…' : '加入自选'),
        err ? h('span', { className: 'dst-err' }, err) : null,
        notice ? h('span', { className: 'dst-flat' }, notice) : null,
        h('div', { className: 'dst-note', style: { flexBasis: '100%' } },
          '提示：只填代码点「加入自选」也能加；股数和成本价可以之后在「持仓」里直接改。'),
      );
    }

    /* ============================================================ *
     * 行情表
     * ============================================================ */

    /** 涨跌幅底下的小量级条：宽度按 |pct| 相对 10% 封顶（颜色继承单元格的涨跌色） */
    function PctBar({ pct, children }) {
      const v = Number(pct);
      const w = Number.isFinite(v) ? Math.min(Math.abs(v) / 10, 1) * 100 : 0;
      return h('span', { className: 'dst-pctbar' },
        w > 1 ? h('i', { style: { width: `${w.toFixed(1)}%` } }) : null,
        h('span', null, children),
      );
    }

    /** 表格排序取值：名称按字符串比较，其余取数字；缺失值统一排到最后 */
    function sortValue(p, key) {
      if (key === 'name') return p.name || p.code || '';
      const q = p.quote || {};
      const map = {
        price: p.price, changePct: p.changePct,
        shares: p.shares, cost: p.cost, marketValue: p.marketValue,
        pnl: p.pnl, pnlPct: p.pnlPct, dayPnl: p.dayPnl,
        open: q.open, high: q.high, low: q.low, turnover: q.turnover, volRatio: q.volRatio,
      };
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    }

    const HOLD_COLS = [
      ['name', '名称'], ['price', '现价'], ['changePct', '涨跌幅'],
      ['shares', '持股'], ['cost', '成本价'], ['marketValue', '市值'],
      ['pnl', '盈亏'], ['pnlPct', '盈亏%'], ['dayPnl', '当日'],
    ];
    const WATCH_COLS = [
      ['name', '名称'], ['price', '现价'], ['changePct', '涨跌幅'],
      ['open', '今开'], ['high', '最高'], ['low', '最低'],
      ['turnover', '换手'], ['volRatio', '量比'],
    ];

    function QuoteTable({ rows, mode, selected, onSelect, onSave, onRemove, currency }) {
      const isHold = mode === 'holdings';
      const [q, setQ] = useState('');
      const [sort, setSort] = useState({ key: isHold ? 'pnlPct' : 'changePct', dir: -1 });
      // 切换「持仓 / 自选」时重置搜索和排序，免得把上一张表的列名当成排序键
      const modeRef = useRef(mode);
      useEffect(() => {
        if (modeRef.current === mode) return;
        modeRef.current = mode;
        setQ('');
        setSort({ key: mode === 'holdings' ? 'pnlPct' : 'changePct', dir: -1 });
      }, [mode]);

      const cols = isHold ? HOLD_COLS : WATCH_COLS;
      const kw = q.trim().toLowerCase();
      const view = useMemo(() => {
        const list = kw
          ? rows.filter((p) => `${p.name || ''}${p.code || ''}`.toLowerCase().includes(kw))
          : rows.slice();
        if (!sort.key) return list;
        const dir = sort.dir;
        list.sort((a, b) => {
          const va = sortValue(a, sort.key);
          const vb = sortValue(b, sort.key);
          const na = typeof va === 'number' && Number.isFinite(va);
          const nb = typeof vb === 'number' && Number.isFinite(vb);
          if (na && nb) return (va - vb) * dir;
          // 有数值的永远排在没有数值的前面，避免停牌/缺数据的行打乱价格顺序
          if (na) return -1;
          if (nb) return 1;
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return String(va).localeCompare(String(vb), 'zh-CN') * dir;
        });
        return list;
      }, [rows, kw, sort.key, sort.dir]);

      const onSort = useCallback((key) => {
        setSort((cur) => (cur.key === key
          ? { key, dir: -cur.dir }
          : { key, dir: key === 'name' ? 1 : -1 }));
      }, []);

      const sign = CURRENCY_SIGN[currency] || '';

      if (!rows.length) {
        return h('div', { className: 'dst-empty' },
          h('span', { className: 'dst-empty-ico' }, isHold ? '📊' : '⭐'),
          isHold
            ? '还没有持仓。切到「添加」录入股票代码、股数和成本价。'
            : '自选列表是空的，切到「添加」加几只股票。');
      }

      const sum = (f) => view.reduce((acc, p) => {
        const v = f(p);
        return Number.isFinite(Number(v)) && v !== null && v !== undefined ? acc + Number(v) : acc;
      }, 0);
      const upN = view.filter((p) => Number(p.changePct) > 0).length;
      const downN = view.filter((p) => Number(p.changePct) < 0).length;
      const flatN = Math.max(0, view.length - upN - downN);

      const th = (key, label) => h('th', {
        key,
        className: `dst-th-sort${sort.key === key ? ' dst-th-on' : ''}`,
        onClick: () => onSort(key),
        title: `按${label}排序`,
      }, label, sort.key === key
        ? h('span', { className: 'dst-th-arrow' }, sort.dir < 0 ? '▼' : '▲')
        : null);

      const nameCell = (p) => h('td', { key: 'name' },
        h('span', { className: 'dst-name' }, p.name || p.code),
        h('span', { className: 'dst-tag' }, p.code),
        p.index ? h('span', { className: 'dst-tag' }, '指数') : null,
        p.held ? h('span', { className: 'dst-tag' }, '持仓') : null,
      );

      const changeCell = (p) => {
        const lim = limitState(p);
        return h('td', { key: 'changePct', className: dirClass(p.changePct) },
          h(PctBar, { pct: p.changePct },
            h('span', {
              className: lim ? `dst-cell-limit dst-cell-limit-${lim}` : '',
              title: lim ? LIMIT_TEXT[lim] : null,
            }, fmtPct(p.changePct)),
            lim
              ? h('span', { className: `dst-limit dst-limit-${lim}`, style: { marginLeft: '4px' } }, LIMIT_TEXT[lim])
              : null,
          ),
        );
      };

      const cellOf = (p, key) => {
        switch (key) {
          case 'name': return nameCell(p);
          case 'price': return h('td', { key, className: dirClass(p.changePct) }, fmtPrice(p.price));
          case 'changePct': return changeCell(p);
          case 'shares': return h('td', { key }, h(NumCell, {
            value: p.shares, title: '持股数（股）',
            onCommit: (v) => onSave({ symbol: p.symbol, shares: v }),
          }));
          case 'cost': return h('td', { key }, h(NumCell, {
            value: p.cost, title: '成本价（元/股，记买卖流水会自动更新，也可手改）',
            onCommit: (v) => onSave({ symbol: p.symbol, cost: v }),
          }));
          case 'marketValue':
            return h('td', { key }, p.marketValue != null ? sign + fmtMoney(p.marketValue) : '--');
          case 'pnl': return h('td', { key, className: dirClass(p.pnl) }, p.pnl != null ? fmtSigned(p.pnl) : '--');
          case 'pnlPct': return h('td', { key, className: dirClass(p.pnlPct) }, fmtPct(p.pnlPct));
          case 'dayPnl': return h('td', { key, className: dirClass(p.dayPnl) }, p.dayPnl != null ? fmtSigned(p.dayPnl) : '--');
          case 'open': return h('td', { key }, fmtPrice(p.quote && p.quote.open));
          case 'high': return h('td', { key }, fmtPrice(p.quote && p.quote.high));
          case 'low': return h('td', { key }, fmtPrice(p.quote && p.quote.low));
          case 'turnover':
            return h('td', { key }, p.quote && p.quote.turnover != null ? nf(p.quote.turnover, 2) + '%' : '--');
          case 'volRatio':
            return h('td', { key }, p.quote && p.quote.volRatio != null ? nf(p.quote.volRatio, 2) : '--');
          default: return null;
        }
      };

      const toolbar = h('div', { className: 'dst-tablebar' },
        h('label', { className: 'dst-search' },
          h('span', { 'aria-hidden': 'true' }, '🔍'),
          h('input', {
            placeholder: isHold ? '搜持仓代码 / 名称' : '搜自选代码 / 名称',
            value: q,
            onChange: (e) => setQ(e.target.value),
          }),
          q
            ? h('span', {
                className: 'dst-search-x', title: '清空搜索',
                onClick: () => setQ(''),
              }, '✕')
            : null,
        ),
        h('span', { className: 'dst-spacer' }),
        h('span', { className: 'dst-count' },
          kw ? `${view.length} / ${rows.length} 只` : `${rows.length} 只`),
      );

      // 汇总行：持仓只有一行（或搜索后只剩一行）时，合计就是把上面那行抄一遍，
      // 纯重复——这时直接不画汇总条，多行时才值得合计。
      const foot = isHold
        ? (view.length > 1
          ? [
              h('span', { key: 'n' }, '持仓 ', h('b', null, String(view.length)), ' 只'),
              h('span', { key: 'mv' }, '市值 ', h('b', null, sign + fmtMoney(sum((p) => p.marketValue)))),
              h('span', { key: 'pn', className: dirClass(sum((p) => p.pnl)) },
                '盈亏 ', h('b', null, fmtSigned(sum((p) => p.pnl)))),
              h('span', { key: 'dp', className: dirClass(sum((p) => p.dayPnl)) },
                '当日 ', h('b', null, fmtSigned(sum((p) => p.dayPnl)))),
            ]
          : [])
        : [
            h('span', { key: 'n' }, '共 ', h('b', null, String(view.length)), ' 只'),
            h('span', { key: 'u', className: 'dst-up' }, '涨 ', h('b', null, String(upN))),
            h('span', { key: 'd', className: 'dst-down' }, '跌 ', h('b', null, String(downN))),
            h('span', { key: 'f' }, '平 ', h('b', null, String(flatN))),
          ];

      return h('div', { className: 'dst-quote' },
        toolbar,
        h('div', { className: 'dst-tablewrap' },
          h('table', { className: 'dst-table' },
            h('thead', null, h('tr', null,
              cols.map(([key, label]) => th(key, label)),
              h('th', { key: 'x' }, ''),
            )),
            h('tbody', null,
              view.length
                ? view.map((p) => h('tr', {
                    key: p.symbol,
                    className: selected === p.symbol ? 'dst-rowsel' : '',
                    onClick: () => onSelect(p.symbol),
                  },
                    cols.map(([key]) => cellOf(p, key)),
                    h('td', { key: 'x' },
                      h('button', {
                        className: 'dst-btn',
                        title: isHold ? '从持仓里移除' : '移出自选',
                        onClick: (e) => { e.stopPropagation(); onRemove(p.symbol); },
                      }, '✕'),
                    ),
                  ))
                : h('tr', null, h('td', { colSpan: cols.length + 1 },
                    h('div', { className: 'dst-empty' }, `没有匹配「${q}」的股票`))),
            ),
          ),
        ),
        foot.length ? h('div', { className: 'dst-tablefoot' }, foot) : null,
      );
    }

    /* ============================================================ *
     * 设置
     * ============================================================ */

    function SettingsTab({ settings, patchSettings, state, error, onNudge, onNudgeLeft }) {
      const set = (patch) => patchSettings(patch);
      const nudgeLeft = typeof onNudgeLeft === 'function' ? onNudgeLeft : (d) => set({
        leftOffset: Math.max(0, (Number(settings.leftOffset) || 0) + d), leftPct: null,
      });
      const toggle = (key) => () => set({ [key]: !settings[key] });

      const row = (label, control, hint) =>
        h('div', { className: 'dst-row' },
          h('span', { className: 'dst-field', style: { minWidth: '110px' } }, label),
          control,
          hint ? h('span', { className: 'dst-note' }, hint) : null,
        );

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        row('刷新间隔',
          h('select', {
            className: 'dst-input', value: String(settings.refreshMs),
            onChange: (e) => set({ refreshMs: Number(e.target.value) }),
          },
            [2000, 3000, 5000, 10000, 15000, 30000, 60000].map((ms) =>
              h('option', { key: ms, value: String(ms) }, ms < 1000 ? ms + 'ms' : ms / 1000 + ' 秒')),
          ),
          '越短越实时，也越频繁请求行情接口'),

        row('AI 自动跟踪',
          h('button', {
            className: `dst-btn ${settings.autoTrackEnabled !== false ? 'dst-on' : ''}`,
            onClick: () => set({ autoTrackEnabled: settings.autoTrackEnabled === false }),
          }, settings.autoTrackEnabled !== false ? '已开启' : '已关闭'),
          '只跟持仓；15:05 完整复盘并更新预警，其余时间点是简报'),

        row('跟踪时间点',
          h('input', {
            className: 'dst-input',
            value: settings.autoTrackTimes || '',
            placeholder: '09:35,10:30,11:30,13:35,14:30,15:05',
            style: { width: '280px' },
            onChange: (e) => set({ autoTrackTimes: e.target.value }),
          }),
          '逗号分隔，格式 HH:MM；改动下一轮 20 秒内生效'),

        row('盘前计划',
          h('button', {
            className: `dst-btn ${settings.autoPlanEnabled ? 'dst-on' : ''}`,
            onClick: () => set({ autoPlanEnabled: settings.autoPlanEnabled !== true }),
          }, settings.autoPlanEnabled ? '已开启' : '已关闭'),
          '开盘前把持仓跑一遍深度分析，计划里的关键价位自动设成价格预警'),

        row('盘前时间',
          h('input', {
            className: 'dst-input',
            value: settings.autoPlanTime || '09:20',
            placeholder: '09:20',
            style: { width: '120px' },
            onChange: (e) => set({ autoPlanTime: e.target.value }),
          }),
          '格式 HH:MM；只跑持仓，结果进 AI 历史并弹通知'),

        row('状态栏位置',
          h('div', { className: 'dst-row' },
            h('button', { className: 'dst-btn-ghost', onClick: () => onNudge(-24) }, '↑ 上移'),
            h('button', { className: 'dst-btn-ghost', onClick: () => onNudge(24) }, '↓ 下移'),
            h('button', { className: 'dst-btn-ghost', onClick: () => nudgeLeft(-24) }, '← 左移'),
            h('button', { className: 'dst-btn-ghost', onClick: () => nudgeLeft(24) }, '→ 右移'),
            h('button', { className: 'dst-btn-ghost', onClick: () => set({ topOffset: 0, leftOffset: 10, topPct: null, leftPct: null }) }, '复位'),
            h('span', { className: 'dst-field' },
              (settings.leftPct != null || settings.topPct != null)
                ? `按窗口比例 左${settings.leftPct == null ? 0 : settings.leftPct}% 上${settings.topPct == null ? 0 : settings.topPct}%`
                : `偏移 上${settings.topOffset || 0}px 左${settings.leftOffset == null ? 10 : settings.leftOffset}px`),
          ),
          '也可以直接按住行情条左侧的 ⋮⋮ 把手拖；双击把手复位。拖动后位置按窗口百分比记住，换显示器/改窗口宽度相对位置不变'),

        row('跑马灯',
          h('button', { className: `dst-btn ${settings.scroll ? 'dst-on' : ''}`, onClick: toggle('scroll') },
            settings.scroll ? '已开启' : '已关闭'),
          '自选多了以后横向匀速滚动，鼠标移上去暂停'),

        row('价格闪烁',
          h('button', { className: `dst-btn ${settings.flash ? 'dst-on' : ''}`, onClick: toggle('flash') },
            settings.flash ? '已开启' : '已关闭'),
          '价格变动时短暂高亮'),

        row('显示大盘指数',
          h('button', { className: `dst-btn ${settings.showIndex ? 'dst-on' : ''}`, onClick: toggle('showIndex') },
            settings.showIndex ? '显示' : '隐藏')),

        row('显示自选',
          h('button', { className: `dst-btn ${settings.showWatch ? 'dst-on' : ''}`, onClick: toggle('showWatch') },
            settings.showWatch ? '显示' : '隐藏')),

        row('显示持仓',
          h('button', { className: `dst-btn ${settings.showHoldings ? 'dst-on' : ''}`, onClick: toggle('showHoldings') },
            settings.showHoldings ? '显示' : '隐藏')),

        h('div', { className: 'dst-group-title' }, '组件开关（关掉的就不渲染）'),

        row('持仓汇总',
          h('button', { className: `dst-btn ${settings.showTotals ? 'dst-on' : ''}`, onClick: toggle('showTotals') },
            settings.showTotals ? '显示' : '隐藏'),
          '行情条右侧的总盈亏 + 市值徽标'),

        row('分时图',
          h('button', { className: `dst-btn ${settings.showTrend ? 'dst-on' : ''}`, onClick: toggle('showTrend') },
            settings.showTrend ? '显示' : '隐藏'),
          '展开面板后图表区的当日走势'),

        row('K线图',
          h('button', { className: `dst-btn ${settings.showKline ? 'dst-on' : ''}`, onClick: toggle('showKline') },
            settings.showKline ? '显示' : '隐藏'),
          '分时和K线都关掉，图表区就整块不出现'),

        row('默认K线',
          h('div', { className: 'dst-row' },
            h('select', {
              className: 'dst-input', value: settings.period,
              onChange: (e) => set({ period: e.target.value }),
            }, PERIODS.map(([v, l]) => h('option', { key: v, value: v }, l))),
            h('select', {
              className: 'dst-input', value: settings.adjust,
              onChange: (e) => set({ adjust: e.target.value }),
            }, ADJUSTS.map(([v, l]) => h('option', { key: v, value: v }, l))),
          )),

        row('K线根数',
          h('select', {
            className: 'dst-input', value: String(settings.klineCount),
            onChange: (e) => set({ klineCount: Number(e.target.value) }),
          }, [60, 120, 250, 500, 800].map((n) => h('option', { key: n, value: String(n) }, String(n) + ' 根')))),

        row('默认图型',
          h('div', { className: 'dst-row' },
            h('div', { className: 'dst-seg' },
              [['trend', '分时'], ['kline', 'K线']].map(([v, l]) =>
                h('button', {
                  key: v,
                  className: settings.chart === v ? 'dst-on' : '',
                  onClick: () => set({ chart: v }),
                }, l)),
            ),
            settings.chart === 'trend'
              ? h('div', { className: 'dst-seg' },
                  [1, 3, 5].map((d) =>
                    h('button', {
                      key: d,
                      className: Number(settings.trendDays) === d ? 'dst-on' : '',
                      onClick: () => set({ trendDays: d }),
                    }, `${d}日`)),
                )
              : null,
          ),
          '分时看当日走势，K线看历史形态。两种都开着才出现切换按钮'),

        row('显示五档盘口',
          h('button', { className: `dst-btn ${settings.showOrderBook ? 'dst-on' : ''}`, onClick: toggle('showOrderBook') },
            settings.showOrderBook ? '显示' : '隐藏'),
          'K线/分时下方显示买卖五档'),

        h('div', { className: 'dst-group-title' }, '标签页开关（关掉就藏起来）'),

        row('流水标签页',
          h('button', { className: `dst-btn ${settings.showTrades ? 'dst-on' : ''}`, onClick: toggle('showTrades') },
            settings.showTrades ? '显示' : '隐藏'),
          '交易流水只用来算已实现盈亏，不影响持仓'),

        row('预警标签页',
          h('button', { className: `dst-btn ${settings.showAlerts ? 'dst-on' : ''}`, onClick: toggle('showAlerts') },
            settings.showAlerts ? '显示' : '隐藏'),
          '价格/涨跌幅到线就在这里管理和查看'),

        row('AI 分析标签页',
          h('button', { className: `dst-btn ${settings.showAi ? 'dst-on' : ''}`, onClick: toggle('showAi') },
            settings.showAi ? '显示' : '隐藏'),
          '用 DSH 里配置好的模型做复盘，消耗你自己的额度'),

        row('预警弹窗提示',
          h('button', { className: `dst-btn ${settings.alertToast ? 'dst-on' : ''}`, onClick: toggle('alertToast') },
            settings.alertToast ? '已开启' : '已关闭'),
          '价格触及预警线时在右下角弹出提示'),

        h('div', { style: { height: '1px', background: 'var(--dst-border)', margin: '4px 0' } }),
        error ? h('div', { className: 'dst-note dst-err' },
          `⚠ ${error}`,
          h('br'),
          '改完宿主代码（lib/index.js / lib/providers.js）需要重启 DSH 才会生效，只刷新页面不够。',
        ) : null,
        h('div', { className: 'dst-note' },
          `数据源：东方财富（主）/ 腾讯（备）　行情状态：${state && state.market ? state.market.label : '--'}`,
          h('br'),
          `存储文件：${state && state.storePath ? state.storePath : '--'}`,
          h('br'),
          `更新时间：${state && state.serverTime ? fmtTime(state.serverTime) : '--'}${state && state.quotesStale ? '（行情可能已过期）' : ''}`,
        ),
      );
    }

    /* ============================================================ *
     * 交易流水（加权平均成本法）
     * ============================================================ */

    function TradesTab({ trades, onReload, onApply }) {
      const [side, setSide] = useState('buy');
      const [symbol, setSymbol] = useState('');
      const [price, setPrice] = useState('');
      const [shares, setShares] = useState('');
      const [fee, setFee] = useState('');
      const [date, setDate] = useState('');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const [notice, setNotice] = useState(null);

      const data = trades.data;
      const list = (data && data.trades) || [];
      const real = (data && data.realized) || { total: 0, fees: 0, tradeCount: 0 };
      const bySymbol = (data && data.bySymbol) || {};
      const quotes = (data && data.quotes) || {};

      const submit = async () => {
        setErr(null);
        setNotice(null);
        if (!symbol.trim()) { setErr('请填写股票代码或名称'); return; }
        if (!(Number(price) > 0)) { setErr('成交价必须大于 0'); return; }
        if (!(Number(shares) > 0)) { setErr('股数必须大于 0'); return; }
        setBusy(true);
        try {
          await trades.addTrade({
            symbol: symbol.trim(),
            side,
            price: Number(price),
            shares: Number(shares),
            fee: fee === '' ? 0 : Number(fee),
            date: date || undefined,
          });
          setNotice(`已记一笔${side === 'buy' ? '买入' : '卖出'}：${symbol.trim()}`);
          setPrice('');
          setShares('');
          setFee('');
        } catch (e) {
          setErr(e && e.message ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      const apply = async () => {
        setErr(null);
        try {
          const r = await onApply();
          setNotice(`已按流水同步持仓，更新了 ${r && r.changed != null ? r.changed : 0} 只`);
        } catch (e) {
          setErr(e && e.message ? e.message : String(e));
        }
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { className: 'dst-sum' },
          h('span', null, '已实现盈亏 ', h('b', { className: dirClass(real.total) }, fmtSigned(real.total))),
          h('span', null, '手续费 ', h('b', null, nf(real.fees))),
          h('span', null, '流水 ', h('b', null, `${real.tradeCount} 笔`)),
        ),

        h('div', { className: 'dst-form' },
          h('div', { className: 'dst-seg' },
            [['buy', '买入'], ['sell', '卖出']].map(([v, l]) =>
              h('button', { key: v, className: side === v ? 'dst-on' : '', onClick: () => setSide(v) }, l)),
          ),
          h('input', {
            className: 'dst-input dst-search', placeholder: '代码 / 名称 / 拼音',
            value: symbol, onChange: (e) => setSymbol(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
          }),
          h('input', {
            className: 'dst-input dst-num', placeholder: '成交价', value: price,
            onChange: (e) => setPrice(e.target.value),
          }),
          h('input', {
            className: 'dst-input dst-num', placeholder: '股数', value: shares,
            onChange: (e) => setShares(e.target.value),
          }),
          h('input', {
            className: 'dst-input dst-num', placeholder: '手续费', value: fee,
            onChange: (e) => setFee(e.target.value),
          }),
          h('input', {
            className: 'dst-input', type: 'date', value: date, title: '成交日期，留空为今天',
            onChange: (e) => setDate(e.target.value),
          }),
          h('button', { className: 'dst-btn-primary', onClick: submit, disabled: busy }, busy ? '记录中…' : '记一笔'),
        ),

        err ? h('div', { className: 'dst-err' }, err) : null,
        notice ? h('div', { className: 'dst-note' }, notice) : null,

        h('div', { className: 'dst-row' },
          h('button', {
            className: 'dst-btn-ghost', onClick: apply,
            title: '把每只票的流水整本重放一遍，覆盖清单里的股数与成本价。流水没记全的票别点——会把手输的持仓覆盖成流水推出来的数。',
          }, '按流水重算持仓'),
          h('button', {
            className: 'dst-btn-ghost',
            onClick: async () => {
              if (typeof confirm === 'function' && !confirm('确定清空全部交易流水？')) return;
              await trades.clearTrades();
            },
          }, '清空流水'),
          h('span', { className: 'dst-spacer' }),
          h('button', { className: 'dst-btn-ghost', onClick: () => trades.reload() },
            trades.busy ? '刷新中…' : '刷新'),
        ),

        trades.error ? h('div', { className: 'dst-err' }, trades.error) : null,

        !list.length
          ? h('div', { className: 'dst-empty' }, '还没有交易流水。记一笔买入试试。')
          : h('table', { className: 'dst-table' },
              h('thead', null, h('tr', null,
                ['日期', '方向', '名称', '价格', '股数', '费用', '金额', '现价', ''].map((t, i) =>
                  h('th', { key: i }, t)),
              )),
              h('tbody', null,
                list.map((t) => {
                  const q = quotes[t.symbol];
                  return h('tr', { key: t.id },
                    h('td', null, t.date),
                    h('td', { className: t.side === 'buy' ? 'dst-up' : 'dst-down' },
                      t.side === 'buy' ? '买入' : '卖出'),
                    h('td', null, t.name || t.symbol),
                    h('td', { className: 'dst-num' }, fmtPrice(t.price)),
                    h('td', { className: 'dst-num' }, nf(t.shares, 0)),
                    h('td', { className: 'dst-num' }, t.fee ? nf(t.fee) : '—'),
                    h('td', { className: 'dst-num' }, fmtMoney(t.price * t.shares)),
                    h('td', { className: 'dst-num' }, q ? fmtPrice(q.price) : '—'),
                    h('td', null,
                      h('button', {
                        className: 'dst-btn', title: '删除这笔',
                        onClick: () => trades.removeTrade(t.id),
                      }, '✕'),
                    ),
                  );
                }),
              ),
            ),

        Object.keys(bySymbol).length
          ? h('div', { className: 'dst-sub' },
              '按标的：',
              Object.keys(bySymbol).map((sym) => {
                const s = bySymbol[sym];
                return h('span', { key: sym, className: 'dst-pill' },
                  `${s.name || sym} ${nf(s.qty, 0)}股 均价${fmtPrice(s.avgCost)} 已实现${fmtSigned(s.realized)}`);
              }),
            )
          : null,

        h('div', { className: 'dst-note' },
          '已实现盈亏按加权平均成本法算：卖出时用「卖出价 − 当时均价」× 股数，并扣掉手续费。',
          h('br'),
          '记一笔买卖，清单里的持股数和成本价就自动跟着变（买入=加权均价，卖出的盈亏摊到剩下的股上）；成本价也可以直接在表格里手改。',
        ),
      );
    }

    /* ============================================================ *
     * 价格预警
     * ============================================================ */

    function AlertsTab({ ticker }) {
      const state = ticker.state || {};
      const alerts = state.alerts || [];
      const items = (state.items || []).filter((i) => !i.index);

      const [symbol, setSymbol] = useState('');
      const [kind, setKind] = useState('price');
      const [op, setOp] = useState('>=');
      const [value, setValue] = useState('');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const [showHistory, setShowHistory] = useState(false);

      // 清空触发历史：清完立刻重拉一次 state，别等下一轮轮询
      const clearHistory = async () => {
        setErr(null);
        try {
          await post('/alerts/history/clear', {});
          await ticker.load(true);
        } catch (e) {
          setErr(e && e.message ? e.message : String(e));
        }
      };

      const submit = async () => {
        setErr(null);
        if (!symbol.trim()) { setErr('请填写股票代码或名称'); return; }
        if (!Number.isFinite(Number(value))) { setErr('预警阈值必须是数字'); return; }
        setBusy(true);
        try {
          await ticker.saveAlert({ symbol: symbol.trim(), kind, op, value: Number(value) });
          setValue('');
        } catch (e) {
          setErr(e && e.message ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { className: 'dst-form' },
          h('input', {
            className: 'dst-input dst-search', placeholder: '代码 / 名称 / 拼音', value: symbol,
            onChange: (e) => setSymbol(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
            list: 'dst-alert-symbols',
          }),
          items.length
            ? h('datalist', { id: 'dst-alert-symbols' },
                items.map((i) => h('option', { key: i.symbol, value: i.symbol }, `${i.name} ${i.symbol}`)))
            : null,
          h('div', { className: 'dst-seg' },
            [['price', '价格'], ['pct', '涨跌幅']].map(([v, l]) =>
              h('button', { key: v, className: kind === v ? 'dst-on' : '', onClick: () => setKind(v) }, l)),
          ),
          h('div', { className: 'dst-seg' },
            [['>=', '≥'], ['<=', '≤']].map(([v, l]) =>
              h('button', { key: v, className: op === v ? 'dst-on' : '', onClick: () => setOp(v) }, l)),
          ),
          h('input', {
            className: 'dst-input dst-num', placeholder: kind === 'pct' ? '阈值 %' : '阈值',
            value, onChange: (e) => setValue(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
          }),
          h('button', { className: 'dst-btn-primary', onClick: submit, disabled: busy },
            busy ? '保存中…' : '加预警'),
        ),

        err ? h('div', { className: 'dst-err' }, err) : null,
        ticker.error ? h('div', { className: 'dst-err' }, ticker.error) : null,

        !alerts.length
          ? h('div', { className: 'dst-empty' }, '还没有预警。比如：贵州茅台 价格 ≥ 1400，或 涨跌幅 ≤ -3 提醒抄底。')
          : h('table', { className: 'dst-table' },
              h('thead', null, h('tr', null,
                ['名称', '条件', '当前', '状态', ''].map((t, i) => h('th', { key: i }, t)),
              )),
              h('tbody', null,
                alerts.map((a) => h('tr', {
                  key: a.id,
                  className: a.hit ? 'dst-hit-row' : '',
                },
                  h('td', null, a.name || a.symbol),
                  h('td', null, `${a.kind === 'pct' ? '涨跌幅' : '价格'} ${a.op} ${a.value}${a.kind === 'pct' ? '%' : ''}`),
                  h('td', { className: 'dst-num' }, a.current == null ? '—' : a.kind === 'pct' ? fmtPct(a.current) : fmtPrice(a.current)),
                  h('td', null,
                    h('span', { className: `dst-pill ${a.hit ? 'dst-hit' : a.enabled === false ? '' : 'dst-on'}` },
                      a.hit ? '已触发' : a.enabled === false ? '已停用' : '监控中'),
                  ),
                  h('td', null,
                    a.hit
                      ? h('button', { className: 'dst-btn', title: '知道了，重新监控', onClick: () => ticker.ackAlert(a.id) }, '✓')
                      : null,
                    h('button', {
                      className: 'dst-btn',
                      title: a.enabled === false ? '启用' : '停用',
                      onClick: () => ticker.saveAlert({ id: a.id, enabled: a.enabled === false }),
                    }, a.enabled === false ? '○' : '●'),
                    h('button', { className: 'dst-btn', title: '删除', onClick: () => ticker.removeAlert(a.id) }, '✕'),
                  ),
                )),
              ),
            ),

        h('div', { className: 'dst-note' },
          '预警在后台每轮行情刷新时判定；触发后右下角弹提示，点「✓」重新武装。',
        ),

        // 触发历史：只记「什么时候、哪只、什么条件、当时价」，落盘保存，重启不丢
        (() => {
          const events = state.alertEvents || [];
          return h('div', { className: 'dst-history' },
            h('div', { className: 'dst-history-head' },
              h('button', {
                className: 'dst-btn',
                title: '展开/收起触发记录',
                onClick: () => setShowHistory((v) => !v),
              }, `${showHistory ? '收起历史' : '触发历史'}${events.length ? ` (${events.length})` : ''}`),
              showHistory && events.length
                ? h('button', { className: 'dst-btn', title: '清空所有触发记录', onClick: clearHistory }, '清空')
                : null,
            ),
            showHistory
              ? events.length
                ? h('table', { className: 'dst-table dst-history-table' },
                    h('thead', null, h('tr', null,
                      ['时间', '名称', '条件', '触发价'].map((t, i) => h('th', { key: i }, t)),
                    )),
                    h('tbody', null,
                      events.map((ev) => h('tr', { key: ev.id || `${ev.symbol}-${ev.at}` },
                        h('td', { className: 'dst-dim' }, fmtWhen(ev.at) || '—'),
                        h('td', null, ev.name || ev.symbol),
                        h('td', null,
                          `${ev.kind === 'pct' ? '涨跌幅' : '价格'} ${ev.op} ${ev.value}${ev.kind === 'pct' ? '%' : ''}`),
                        h('td', { className: 'dst-num' },
                          ev.current == null ? '—' : ev.kind === 'pct' ? fmtPct(ev.current) : fmtPrice(ev.current)),
                      )),
                    ),
                  )
                : h('div', { className: 'dst-empty' }, '还没有触发记录。')
              : null,
          );
        })(),
      );
    }

    /* ============================================================ *
     * 主组件
     * ============================================================ */

    /* ---------------- AI 分析 ----------------
     * 数据包在宿主侧组装（那边拿到的都是现算的数字），这里只负责：选模型、发起、
     * 把 NDJSON 增量拼成正文。模型调用走 DSH 自己的模型服务，插件不碰密钥。
     */

    const AI_KLINE_TOGGLES = [
      ['aiKline', '日K'],
      ['aiDay3', '3日K'],
      ['aiDay5', '5日K'],
      ['aiWeek', '周K'],
      ['aiMonth', '月K'],
    ];
    const AI_EXTRA_TOGGLES = [
      ['aiBook', '盘口'],
      ['aiTrades', '流水'],
      ['aiIndex', '大盘'],
      ['aiFlow', '资金流'],
      ['aiHoldings', '成分股'],
      ['aiShare', '份额'],
    ];
    /** 日K/分时/盘口这些默认开；后面补的周期（3/5日、周、月）显式 true 才喂 */
    const AI_OPT_IN = ['aiDay3', 'aiDay5', 'aiWeek', 'aiMonth'];
    const aiToggleOn = (key, settings) =>
      AI_OPT_IN.includes(key) ? settings[key] === true : settings[key] !== false;

    /** 读取模型目录（宿主把 dsh-llm 的提供方与模型转发出来） */
    function useModels(active) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(false);
      const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
          const res = await fetch(`${API}/ai/models`, { redirect: 'error' });
          if (!res.ok) throw new Error(`宿主返回 HTTP ${res.status}`);
          const json = await res.json();
          if (!json || json.ok === false) throw new Error((json && json.error) || '读不到模型目录');
          setData(json);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      }, []);
      useEffect(() => { if (active && data === null && !loading) load(); }, [active, data, loading, load]);
      return { data, error, loading, reload: load };
    }

    /* 分析状态放在模块级单例里：切走标签/侧栏重挂组件时，正文和进行中的流都还在。
       组件卸载只退订、不 abort —— 以前切到「持仓」再回来会打断并丢掉分析，就是因为这一步。 */
    const analysisStore = (() => {
      const empty = () => ({
        phase: 'idle', text: '', reasoning: '', meta: null, usage: null,
        elapsed: 0, error: null, symbol: null, provider: '', model: '', finish: null,
        code: null, cancelled: false, at: null, historyId: null,
        plan: null, pack: '', alertCount: 0, promptVersion: '',
      });
      let st = empty();
      const listeners = new Set();
      let ctrl = null;
      const emit = () => {
        for (const fn of [...listeners]) {
          try { fn(st); } catch { /* 单个订阅者出错不影响其他订阅者 */ }
        }
      };
      const patch = (next) => {
        st = typeof next === 'function' ? next(st) : { ...st, ...next };
        emit();
      };
      const cancel = () => { if (ctrl) ctrl.abort(); };
      const reset = () => { patch(empty()); };
      /** 回看一条历史记录：只换展示，不调模型 */
      const showHistory = (rec) => {
        if (!rec) return;
        patch({
          ...empty(),
          phase: 'done',
          text: String(rec.text || ''),
          meta: { chars: rec.chars || 0, has: Array.isArray(rec.has) ? rec.has : [] },
          usage: rec.usage || null,
          elapsed: rec.elapsedMs || 0,
          symbol: rec.symbol || null,
          provider: rec.provider || '',
          model: rec.model || '',
          finish: rec.finish || 'stop',
          at: rec.at || null,
          historyId: rec.id || null,
          plan: rec.plan || null,
          pack: rec.pack || '',
          alertCount: Array.isArray(rec.alerts) ? rec.alerts.length : (Number(rec.alertCount) || 0),
          promptVersion: rec.promptVersion || '',
          chats: Array.isArray(rec.chats) ? rec.chats : [],
        });
      };
      const run = async (body) => {
        if (ctrl) ctrl.abort();
        const c = new AbortController();
        ctrl = c;
        const t0 = Date.now();
        patch({ ...empty(), phase: 'running', symbol: body.symbol, provider: body.provider, model: body.model });
        try {
          await streamAnalyze(body, (evt) => {
            if (evt.type === 'meta') {
              patch((s) => ({ ...s, meta: evt.meta || null, provider: evt.provider || s.provider, model: evt.model || s.model }));
            } else if (evt.type === 'delta') {
              patch((s) => ({ ...s, text: s.text + (evt.text || '') }));
            } else if (evt.type === 'reasoning') {
              patch((s) => ({ ...s, reasoning: s.reasoning + (evt.text || '') }));
            } else if (evt.type === 'done') {
              patch((s) => ({
                ...s,
                phase: 'done',
                text: typeof evt.text === 'string' && evt.text ? evt.text : s.text,
                usage: evt.usage || null,
                elapsed: evt.elapsedMs || (Date.now() - t0),
                finish: evt.finish || null,
                code: evt.code || null,
                error: evt.error || null,
                at: evt.at || Date.now(),
                historyId: evt.recordId || null,
                plan: evt.plan || null,
                alertCount: Number(evt.alerts) || 0,
                promptVersion: evt.promptVersion || '',
              }));
            } else if (evt.type === 'error') {
              patch((s) => ({ ...s, phase: 'error', error: evt.error || '分析失败' }));
            }
          }, c.signal);
          patch((s) => (s.phase === 'running'
            ? { ...s, phase: s.text ? 'done' : 'error', error: s.text ? null : (s.error || '连接中断') }
            : s));
        } catch (err) {
          if (err && err.name === 'AbortError') {
            // 用户主动取消：保留半截结论并说明，不当作错误
            patch((s) => ({ ...s, phase: s.text ? 'done' : 'idle', elapsed: Date.now() - t0, cancelled: true }));
            return;
          }
          patch((s) => ({ ...s, phase: 'error', error: (err && err.message) || String(err) }));
        } finally {
          if (ctrl === c) ctrl = null;
        }
      };
      return {
        get state() { return st; },
        subscribe(fn) {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        },
        run, cancel, reset, showHistory,
      };
    })();

    /** 订阅模块级分析状态；卸载只退订，不打断正在跑的流 */
    function useAnalysis() {
      const [st, setSt] = useState(analysisStore.state);
      useEffect(() => analysisStore.subscribe(setSt), []);
      return {
        st,
        run: analysisStore.run,
        cancel: analysisStore.cancel,
        reset: analysisStore.reset,
        showHistory: analysisStore.showHistory,
      };
    }

    /** 模块级追问状态：切标签/切栏不丢。挂 analysisId，历史回看时用 chats 回填 */
    const chatStore = (() => {
      const fresh = () => ({
        open: false, analysisId: null, quote: '', messages: [],
        phase: 'idle', error: null, streaming: '', usage: null,
      });
      let st = fresh();
      const listeners = new Set();
      let ctrl = null;
      const emit = () => { for (const fn of listeners) { try { fn(st); } catch { /* ignore */ } } };
      const set = (patch) => {
        st = Object.assign({}, st, typeof patch === 'function' ? patch(st) : patch);
        emit();
      };
      const reset = () => {
        if (ctrl) { try { ctrl.abort(); } catch { /* ignore */ } ctrl = null; }
        st = fresh();
        emit();
      };
      const open = (quote) => set({ open: true, quote: String(quote || '').slice(0, 600) });
      const close = () => set({ open: false });
      const bind = (analysisId, chats) => {
        const msgs = Array.isArray(chats)
          ? chats.map((m) => ({ role: m.role, content: String(m.content || ''), quote: String(m.quote || '') }))
          : [];
        set({ analysisId: analysisId || null, messages: msgs, streaming: '', phase: 'idle', error: null, quote: '' });
      };
      const clearQuote = () => set({ quote: '' });
      const cancel = () => {
        if (ctrl) { try { ctrl.abort(); } catch { /* ignore */ } }
        ctrl = null;
        set({ phase: 'idle', streaming: '' });
      };
      const send = async (question, opts = {}) => {
        const q = String(question || '').trim();
        if (!q) return;
        if (!st.analysisId) {
          set({ open: true, error: '这次分析还没存进历史，等复盘跑完再追问' });
          return;
        }
        if (st.phase === 'running') return;
        const analysisId = st.analysisId;
        const quote = st.quote;
        const history = st.messages.map((m) => ({ role: m.role, content: m.content }));
        set((cur) => ({
          open: true, phase: 'running', error: null, streaming: '',
          messages: [...cur.messages, { role: 'user', content: q, quote: cur.quote }],
        }));
        ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        try {
          await streamChat(
            { analysisId, question: q, quote, history, provider: opts.provider, model: opts.model },
            (evt) => {
              if (!evt || !evt.type) return;
              if (evt.type === 'delta') set((cur) => ({ streaming: cur.streaming + (evt.text || '') }));
              else if (evt.type === 'error') set({ error: evt.error || '追问失败' });
              else if (evt.type === 'done') {
                set((cur) => {
                  const text = String(evt.text || cur.streaming || '');
                  const msgs = cur.messages.slice();
                  if (text.trim()) msgs.push({ role: 'assistant', content: text, quote: '' });
                  return {
                    phase: 'idle', streaming: '', error: evt.error || null, messages: msgs,
                    usage: evt.usage || cur.usage, quote: '',
                  };
                });
              }
            },
            ctrl ? ctrl.signal : undefined,
          );
        } catch (err) {
          if (err && err.name === 'AbortError') set({ phase: 'idle', streaming: '' });
          else set({ phase: 'idle', streaming: '', error: err && err.message ? err.message : String(err) });
        } finally {
          ctrl = null;
        }
      };
      const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
      return {
        get state() { return st; },
        subscribe, reset, open, close, bind, send, cancel, clearQuote,
      };
    })();

    function useChat() {
      const [st, setSt] = useState(chatStore.state);
      useEffect(() => chatStore.subscribe(setSt), []);
      return {
        st,
        open: chatStore.open,
        close: chatStore.close,
        bind: chatStore.bind,
        send: chatStore.send,
        cancel: chatStore.cancel,
        reset: chatStore.reset,
        clearQuote: chatStore.clearQuote,
      };
    }

    /** 历史分析列表（摘要）。reload() 用于分析完成后、删除记录后刷新 */
    function useHistory(active) {
      const [items, setItems] = useState([]);
      const [error, setError] = useState(null);
      const [tick, setTick] = useState(0);
      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/ai/history?limit=20`, { redirect: 'error' });
          if (!res.ok) throw new Error(`宿主返回 HTTP ${res.status}`);
          const json = await res.json();
          if (!json || json.ok === false) throw new Error((json && json.error) || '读不到历史记录');
          setItems(Array.isArray(json.items) ? json.items : []);
          setError(null);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        }
      }, []);
      useEffect(() => { if (active) load(); }, [active, tick, load]);
      const reload = useCallback(() => setTick((n) => n + 1), []);
      return { items, error, reload, load };
    }

    /** 逐行读 NDJSON 的接口（分析 / 追问共用） */
    async function streamNdjson(path, body, onEvent, signal) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`宿主返回 HTTP ${res.status}`);
      const ctype = res.headers.get('Content-Type') || '';
      if (!/ndjson/.test(ctype)) {
        // 宿主在流开始前就拒绝了（缺参数、没挂模型服务等），这里是结构化 JSON
        const data = await res.json().catch(() => null);
        throw new Error((data && data.error) || '宿主没有返回分析流');
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        // 不支持流式读取时退化成一次性解析
        const raw = await res.text();
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try { onEvent(JSON.parse(t)); } catch { /* 忽略半行 */ }
        }
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line)); } catch { /* 忽略半行 */ }
        }
      }
      buf += decoder.decode();
      const tail = buf.trim();
      if (tail) { try { onEvent(JSON.parse(tail)); } catch { /* 忽略 */ } }
    }

    function streamAnalyze(body, onEvent, signal) {
      return streamNdjson('/ai/analyze', body, onEvent, signal);
    }

    function streamChat(body, onEvent, signal) {
      return streamNdjson('/ai/chat', body, onEvent, signal);
    }

    /** 行内 **加粗** -> span（不引第三方 Markdown 库） */
    function inlineRich(text, keyBase) {
      const out = [];
      const re = /\*\*([^*]+)\*\*/g;
      let last = 0;
      let m;
      let i = 0;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        out.push(h('span', { key: `${keyBase}-b${i++}`, className: 'dst-ai-strong' }, m[1]));
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }

    /** 去掉正文末尾给机器看的 json 代码块；结构化数据已经渲染成卡片 */
    function stripPlan(text) {
      return String(text || '')
        .replace(/```(?:json)?\s*\{[\s\S]*?"(?:levels|stance)"[\s\S]*?```/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    /** 极简 Markdown 渲染：### 小标题 / - 列表 / **加粗** / 空行分段 */
    function renderRich(text) {
      const nodes = [];
      let listBuf = [];
      let listKey = 0;
      const flush = (k) => {
        if (!listBuf.length) return;
        const items = listBuf;
        listBuf = [];
        nodes.push(h('ul', { key: `ul-${k}`, className: 'dst-ai-ul' },
          items.map((li, i) => h('li', { key: i }, inlineRich(li, `li-${k}-${i}`)))));
      };
      String(text || '').split('\n').forEach((raw, i) => {
        const line = raw.replace(/\s+$/, '');
        const head = /^#{1,6}\s*(.+)$/.exec(line);
        if (head) {
          flush(`${listKey++}`);
          nodes.push(h('div', { key: `h-${i}`, className: 'dst-ai-h' }, inlineRich(head[1], `h-${i}`)));
          return;
        }
        const item = /^\s*(?:[-*·]|\d+[.、)])\s+(.+)$/.exec(line);
        if (item) { listBuf.push(item[1]); return; }
        flush(`${listKey++}`);
        if (!line.trim()) return;
        nodes.push(h('p', { key: `p-${i}`, className: 'dst-ai-p' }, inlineRich(line, `p-${i}`)));
      });
      flush(`${listKey++}`);
      return nodes;
    }

    function AiTab({ ticker, selected }) {
      const state = ticker.state || null;
      const settings = (state && state.settings) || {};
      const patchSettings = ticker.patchSettings;
      const items = (state && state.items) || [];
      const target = selected || (items[0] && items[0].symbol) || null;
      const targetItem = items.find((it) => it.symbol === target) || null;

      const models = useModels(true);
      const analysis = useAnalysis();
      const history = useHistory(true);
      const chat = useChat();
      const [extra, setExtra] = useState('');
      const [ask, setAsk] = useState('');
      const [bubble, setBubble] = useState(null);
      const [wide, setWide] = useState(false);
      const [split, setSplit] = useState(() => {
        const v = Number(settings.aiChatSplit);
        return v >= 0.25 && v <= 0.75 ? v : 0.5;
      });
      const outRef = useRef(null);
      const boxRef = useRef(null);
      const [copied, setCopied] = useState(false);
      const [viewErr, setViewErr] = useState(null);
      // 一轮分析结束时宿主已经落了历史记录，这里刷新一下列表
      const finishedAt = analysis.st.at;
      useEffect(() => { if (finishedAt) history.reload(); }, [finishedAt]);
      // 切换自选/标的时，如果面板里还是上一只的分析，直接清掉（历史记录里仍能找回）
      useEffect(() => {
        const cur = analysis.st;
        if (cur.symbol && target && cur.symbol !== target) { analysis.reset(); chat.reset(); }
      }, [target]);
      // 复盘落库后，把追问挂到这条记录上（历史回看时 openHistory 里会 bind 对话）
      useEffect(() => {
        const id = analysis.st.historyId;
        if (id && chat.st.analysisId !== id) chat.bind(id, analysis.st.chats || []);
      }, [analysis.st.historyId]);
      // 宽度够就右栏常驻，窄了就在面板里叠成抽屉（侧边栏 tab 通常走抽屉）
      // 注意量的是外层容器：量正文列的话，一拖分隔条/一开对话列宽就变，会宽窄反复横跳
      useEffect(() => {
        const el = boxRef.current;
        if (!el || typeof el.clientWidth !== 'number') return undefined;
        const read = () => {
          try {
            const w = el.clientWidth;
            // 留 60px 回差：滚动条出现/消失那几像素不会让宽窄来回切换
            setWide((cur) => (cur ? w >= 560 : w >= 620));
          } catch { /* ignore */ }
        };
        read();
        if (typeof ResizeObserver === 'function') {
          const ro = new ResizeObserver(read);
          try { ro.observe(el); } catch { /* ignore */ }
          return () => { try { ro.disconnect(); } catch { /* ignore */ } };
        }
        return undefined;
      }, [analysis.st.text, analysis.st.phase]);
      // 设置里拖过的比例落地后同步回来（重载/别处改设置时以 settings 为准）
      useEffect(() => {
        const v = Number(settings.aiChatSplit);
        if (v >= 0.25 && v <= 0.75) setSplit(v);
      }, [settings.aiChatSplit]);
      // 拖动中间分隔条调整左右比例；松手才写回设置，避免拖动过程刷爆 storage
      const startDrag = (e) => {
        try { e.preventDefault(); } catch { /* ignore */ }
        const el = boxRef.current;
        if (!el || typeof el.getBoundingClientRect !== 'function') return;
        let rect;
        try { rect = el.getBoundingClientRect(); } catch { return; }
        if (!rect || !rect.width) return;
        const latest = { v: split };
        const move = (ev) => {
          const x = ev && typeof ev.clientX === 'number' ? ev.clientX : 0;
          const r = Math.min(0.75, Math.max(0.25, (x - rect.left) / rect.width));
          latest.v = r;
          setSplit(r);
        };
        const up = () => {
          try {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.body.style.userSelect = '';
          } catch { /* ignore */ }
          try { patchSettings({ aiChatSplit: Math.round(latest.v * 1000) / 1000 }); } catch { /* ignore */ }
        };
        try {
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
          document.body.style.userSelect = 'none';
        } catch { /* ignore */ }
      };

      const list = (models.data && models.data.models) || [];
      const providerMeta = (models.data && models.data.providers) || [];
      const providerName = (id) => {
        const hit = providerMeta.find((p) => p.id === id);
        return (hit && hit.name) || id || '未知提供方';
      };
      // 父子两级：父 = 供应商，子 = 该供应商下的模型（DSH 自己的模型选择器就是这个层级）
      const groups = [];
      for (const m of list) {
        let g = groups.find((x) => x.provider === m.provider);
        if (!g) { g = { provider: m.provider, name: providerName(m.provider), models: [] }; groups.push(g); }
        g.models.push(m);
      }
      const fallback = (models.data && models.data.current) || null;
      const wantProvider = settings.aiProvider || (fallback && fallback.provider) || '';
      const wantModel = settings.aiModel || (fallback && fallback.model) || '';
      const knownGroup = groups.find(
        (g) => g.provider === wantProvider && g.models.some((m) => m.id === wantModel),
      );
      const gEff = knownGroup || groups[0] || null;
      const effProvider = gEff ? gEff.provider : wantProvider;
      const children = gEff ? gEff.models : [];
      const effModel = children.some((m) => m.id === wantModel)
        ? wantModel
        : (children[0] ? children[0].id : wantModel);
      const activeModel = children.find((m) => m.id === effModel) || null;
      const style = settings.aiStyle === 'detail' ? 'detail' : 'short';

      const pickProvider = (id) => {
        const g = groups.find((x) => x.provider === id);
        if (!g || !g.models.length) return;
        // 换供应商时：如果它也有同 id 的模型就沿用，否则落到它的第一个模型
        const same = g.models.find((m) => m.id === effModel);
        patchSettings({ aiProvider: g.provider, aiModel: (same || g.models[0]).id });
      };
      const pickModel = (id) => {
        const hit = children.find((m) => m.id === id);
        if (!hit) return;
        patchSettings({ aiProvider: effProvider, aiModel: hit.id });
      };

      const running = analysis.st.phase === 'running';
      const st = analysis.st;
      // 正文去掉机器可读的 json 块；结构化数据走下面的卡片
      const displayText = stripPlan(st.text);

      const start = () => {
        if (!target) return;
        const periods = [];
        if (settings.aiKline !== false) periods.push('day');
        if (settings.aiDay3 === true) periods.push('day3');
        if (settings.aiDay5 === true) periods.push('day5');
        if (settings.aiWeek === true) periods.push('week');
        if (settings.aiMonth === true) periods.push('month');
        if (!periods.length) periods.push('day');
        analysis.run({
          symbol: target,
          provider: effProvider,
          model: effModel,
          style,
          extra,
          periods,
          trendDays: Number(settings.aiTrendDays) || 1,
          count: 120,
          include: {
            kline: periods.length > 0,
            trend: settings.aiTrend !== false,
            book: settings.aiBook !== false,
            trades: settings.aiTrades !== false,
            indexes: settings.aiIndex !== false,
            flow: settings.aiFlow !== false,
            holdings: settings.aiHoldings !== false,
            share: settings.aiShare !== false,
          },
        });
      };

      const openHistory = async (id) => {
        setViewErr(null);
        try {
          const res = await fetch(`${API}/ai/history/get?id=${encodeURIComponent(id)}`, { redirect: 'error' });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json || json.ok === false) {
            throw new Error((json && json.error) || `宿主返回 HTTP ${res.status}`);
          }
          analysis.showHistory(json.item);
          chat.bind(json.item.id, json.item.chats);
        } catch (err) {
          setViewErr(`打开历史记录失败：${err && err.message ? err.message : err}`);
        }
      };

      const removeHistory = async (id) => {
        try {
          const res = await fetch(`${API}/ai/history/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
            redirect: 'error',
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json || json.ok === false) {
            throw new Error((json && json.error) || `宿主返回 HTTP ${res.status}`);
          }
          if (analysis.st.historyId === id) analysis.reset();
          history.reload();
        } catch (err) {
          setViewErr(`删除历史记录失败：${err && err.message ? err.message : err}`);
        }
      };

      const copy = () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(displayText);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }
        } catch { /* 剪贴板不可用就算了 */ }
      };

      const usage = st.usage
        ? `输入 ${st.usage.inputTokens || 0} / 输出 ${st.usage.outputTokens || 0} tokens`
        : '';

      const fmtWhen = (ts) => {
        if (!ts) return '';
        try {
          return new Date(ts).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai', hour12: false,
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
          });
        } catch { return ''; }
      };

      // 划选正文：记下选中的那段字，浮出「问 AI」条
      const onSelect = () => {
        try {
          const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
          const txt = sel ? String(sel).replace(/\s+/g, ' ').trim() : '';
          const root = outRef.current;
          const node = sel && sel.anchorNode ? sel.anchorNode : null;
          if (!txt || !root || !node || (root.contains && !root.contains(node))) { setBubble(null); return; }
          setBubble(txt.slice(0, 600));
        } catch { setBubble(null); }
      };
      const clearSelection = () => {
        try {
          const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
          if (sel && typeof sel.removeAllRanges === 'function') sel.removeAllRanges();
        } catch { /* ignore */ }
      };
      const askSelected = () => {
        if (!bubble) return;
        chat.open(bubble);
        setBubble(null);
        clearSelection();
      };
      const sendAsk = () => {
        const q = ask.trim();
        if (!q) return;
        setAsk('');
        chat.send(q, { provider: effProvider, model: effModel });
      };

      const chatPanel = chat.st.open
        ? h('div', { className: 'dst-ai-chat' },
            h('div', { className: 'dst-ai-chathead' },
              h('b', null, '追问'),
              h('span', { className: 'dst-muted' },
                chat.st.analysisId
                  ? (wide ? '右栏 · 基于这次分析的数据包' : '基于这次分析的数据包')
                  : '等复盘完成'),
              h('button', { className: 'dst-pill dst-on', onClick: () => chat.close() }, '收起')),
            chat.st.quote
              ? h('div', { className: 'dst-ai-quote' },
                  h('span', null, chat.st.quote),
                  h('button', { className: 'dst-pill', onClick: () => chat.clearQuote() }, '✕'))
              : null,
            h('div', { className: 'dst-ai-msgs' },
              ...chat.st.messages.map((m, i) => h('div', {
                key: i,
                className: `dst-ai-msg ${m.role === 'user' ? 'dst-ai-msg-user' : 'dst-ai-msg-ai'}`,
              },
                m.quote ? h('div', { className: 'dst-ai-msgquote' }, m.quote) : null,
                h('div', null, m.content))),
              chat.st.streaming
                ? h('div', { className: 'dst-ai-msg dst-ai-msg-ai' },
                    chat.st.streaming, h('span', { className: 'dst-ai-cursor' }))
                : null,
              chat.st.phase === 'running' && !chat.st.streaming
                ? h('div', { className: 'dst-ai-empty' }, '正在查数据包…')
                : null,
              !chat.st.messages.length && !chat.st.streaming && chat.st.phase !== 'running'
                ? h('div', { className: 'dst-ai-empty' },
                    chat.st.analysisId
                      ? '在左边正文里划一段，点「问 AI」，或在下面直接提问。'
                      : '复盘跑完后就能就其中的段落追问。')
                : null),
            chat.st.error ? h('div', { className: 'dst-ai-warn' }, chat.st.error) : null,
            h('div', { className: 'dst-ai-chatbar' },
              h('input', {
                className: 'dst-ai-extra',
                placeholder: chat.st.analysisId ? '追问这句（Enter 发送）' : '等复盘完成后再追问',
                value: ask,
                disabled: !chat.st.analysisId || chat.st.phase === 'running',
                onChange: (e) => setAsk(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && chat.st.phase !== 'running') sendAsk(); },
              }),
              chat.st.phase === 'running'
                ? h('button', { className: 'dst-btn', onClick: () => chat.cancel() }, '停止')
                : h('button', {
                    className: 'dst-btn dst-btn-primary',
                    disabled: !chat.st.analysisId || !ask.trim(),
                    onClick: sendAsk,
                  }, '发送')),
          )
        : null;

      if (!models.data && models.error) {
        return h('div', null,
          h('div', { className: 'dst-ai-err' },
            `读不到模型目录：${models.error}`,
            h('div', { className: 'dst-ai-warn' },
              '如果刚更新过宿主代码，需要完全退出 DSH 再打开（只刷新页面不够）。')),
          h('div', { style: { marginTop: '8px' } },
            h('button', { className: 'dst-btn', onClick: () => models.reload() }, '重试')));
      }
      if (!models.data) {
        return h('div', { className: 'dst-ai-empty' }, models.loading ? '正在读取可用模型…' : '准备中…');
      }
      if (!list.length) {
        return h('div', null,
          h('div', { className: 'dst-ai-empty' }, '宿主里没有任何可用的模型。'),
          (models.data.failures || []).length
            ? h('div', { className: 'dst-ai-warn' },
                ...models.data.failures.map((f, i) => h('div', { key: i }, `${f.provider}: ${f.error}`)))
            : null);
      }

      return h('div', null,
        h('div', { className: 'dst-ai-bar' },
          h('span', { className: 'dst-muted' }, '分析对象'),
          h('b', null, targetItem ? `${targetItem.name}(${targetItem.code})` : '—— 先在表格里点一只'),
          h('span', { className: 'dst-muted' }, '供应商'),
          h('select', {
            value: effProvider,
            disabled: running || !groups.length,
            onChange: (e) => pickProvider(e.target.value),
          }, groups.map((g) => h('option', { key: g.provider, value: g.provider },
            `${g.name}（${g.models.length} 个模型）`))),
          h('span', { className: 'dst-muted' }, '模型'),
          h('select', {
            value: effModel,
            disabled: running || !children.length,
            onChange: (e) => pickModel(e.target.value),
          }, children.map((m) => h('option', { key: m.id, value: m.id },
            `${m.name || m.id}${m.description ? ` — ${m.description}` : ''}`))),
          activeModel && activeModel.description
            ? h('span', { className: 'dst-muted dst-ai-mdesc', title: activeModel.description }, activeModel.id)
            : null,
          h('span', { className: 'dst-muted' }, '风格'),
          h('span', { className: 'dst-seg' },
            h('button', {
              className: style === 'short' ? 'dst-on' : '',
              disabled: running,
              onClick: () => patchSettings({ aiStyle: 'short' }),
            }, '简版'),
            h('button', {
              className: style === 'detail' ? 'dst-on' : '',
              disabled: running,
              onClick: () => patchSettings({ aiStyle: 'detail' }),
            }, '详细')),
        ),

        h('div', { className: 'dst-ai-bar' },
          h('span', { className: 'dst-muted' }, '喂给模型'),
          ...AI_KLINE_TOGGLES.map(([key, label]) => h('label', { key, className: 'dst-ai-toggle' },
            h('input', {
              type: 'checkbox',
              checked: aiToggleOn(key, settings),
              disabled: running,
              onChange: (e) => patchSettings({ [key]: e.target.checked }),
            }),
            label)),
          h('label', { key: 'aiTrend', className: 'dst-ai-toggle' },
            h('input', {
              type: 'checkbox',
              checked: settings.aiTrend !== false,
              disabled: running,
              onChange: (e) => patchSettings({ aiTrend: e.target.checked }),
            }),
            '分时'),
          h('select', {
            className: 'dst-ai-days',
            value: String(settings.aiTrendDays || 1),
            disabled: running || settings.aiTrend === false,
            title: '分时数据取几天',
            onChange: (e) => patchSettings({ aiTrendDays: Number(e.target.value) }),
          }, [1, 3, 5].map((d) => h('option', { key: d, value: String(d) }, `${d}日`))),
          ...AI_EXTRA_TOGGLES.map(([key, label]) => h('label', { key, className: 'dst-ai-toggle' },
            h('input', {
              type: 'checkbox',
              checked: settings[key] !== false,
              disabled: running,
              onChange: (e) => patchSettings({ [key]: e.target.checked }),
            }),
            label)),
          h('label', {
            key: 'aiAutoAlert',
            className: 'dst-ai-toggle',
            title: '把 AI 给的关键价位自动设成价格预警（支撑/失效=跌破提醒，压力=涨到提醒）',
          },
            h('input', {
              type: 'checkbox',
              checked: settings.aiAutoAlert !== false,
              disabled: running,
              onChange: (e) => patchSettings({ aiAutoAlert: e.target.checked }),
            }),
            '自动设预警'),
        ),

        h('div', { className: 'dst-ai-bar' },
          h('input', {
            type: 'text',
            className: 'dst-ai-extra',
            placeholder: '额外要求（可选），例如：只看量能，别谈基本面',
            value: extra,
            disabled: running,
            onChange: (e) => setExtra(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && !running) start(); },
          }),
          running
            ? h('button', { className: 'dst-btn', onClick: () => analysis.cancel() }, '停止')
            : h('button', {
                className: 'dst-btn dst-btn-primary',
                disabled: !target,
                onClick: start,
              }, st.text || st.error ? '重新分析' : '开始分析'),
        ),

        st.phase === 'idle' && !st.text
          ? h('div', { className: 'dst-ai-empty' },
              '用本地行情数据 + 你自己的持仓成本，让模型做一次复盘。',
              h('br'),
              '数据包在宿主侧现算（日K/3日K/5日K/周K/月K指标、分时 1/3/5 日、盘口、流水），模型只看到这些数字。')
          : null,

        (st.text || running)
          ? h('div', {
              className: `dst-ai-out${chat.st.open ? ' dst-ai-chatopen' : ''}${wide ? ' dst-ai-wide' : ''}`,
              ref: boxRef,
            },
              h('div', {
                className: 'dst-ai-read',
                ref: outRef,
                onMouseUp: onSelect,
                style: wide && chat.st.open
                  ? { flexBasis: `${(split * 100).toFixed(1)}%`, flexGrow: 0, flexShrink: 1 }
                  : undefined,
              },
              bubble
                ? h('div', { className: 'dst-ai-selbubble' },
                    h('span', null, `选中 ${bubble.length} 字：${bubble.slice(0, 40)}${bubble.length > 40 ? '…' : ''}`),
                    h('button', { className: 'dst-btn dst-btn-primary', onClick: askSelected }, '问 AI'),
                    h('button', { className: 'dst-btn', onClick: () => setBubble(null) }, '取消'))
                : null,
              h('div', { className: 'dst-ai-meta' },
                st.model ? h('span', { className: 'dst-pill' }, `${st.model}`) : null,
                st.historyId ? h('span', { className: 'dst-pill' }, '历史记录') : null,
                st.meta && st.meta.chars ? h('span', null, `数据 ${st.meta.chars} 字`) : null,
                st.elapsed ? h('span', null, `${(st.elapsed / 1000).toFixed(1)}s`) : null,
                usage ? h('span', null, usage) : null,
                st.finish && st.finish !== 'stop' ? h('span', { className: 'dst-pill dst-hit' }, st.finish) : null,
                st.cancelled ? h('span', { className: 'dst-pill' }, '已停止（以下是半截结果）') : null,
                st.text ? h('span', {
                  className: 'dst-pill dst-on',
                  style: { cursor: 'pointer' },
                  title: settings.aiCollapsed ? '展开分析正文' : '收起分析正文',
                  onClick: () => patchSettings({ aiCollapsed: !settings.aiCollapsed }),
                }, settings.aiCollapsed ? '展开' : '收起') : null,
                st.text ? h('span', {
                  className: 'dst-pill dst-on',
                  style: { cursor: 'pointer', marginLeft: 'auto' },
                  onClick: copy,
                }, copied ? '已复制' : '复制') : null,
              ),
              ...(st.meta && st.meta.has && st.meta.has.length
                ? [h('div', { key: 'has', className: 'dst-ai-meta' },
                    h('span', null, '已喂：'),
                    ...st.meta.has.map((x, i) => h('span', { key: i, className: 'dst-pill' }, x)))]
                : []),
              st.plan
                ? h('div', { key: 'plan', className: 'dst-ai-plan' },
                    h('div', { className: 'dst-ai-planhead' },
                      st.plan.stance
                        ? h('span', {
                            className: `dst-pill ${/多/.test(st.plan.stance) ? 'dst-up' : /空/.test(st.plan.stance) ? 'dst-down' : ''}`,
                          }, st.plan.stance)
                        : null,
                      st.plan.confidence != null
                        ? h('span', { className: 'dst-muted' }, `置信度 ${st.plan.confidence}`)
                        : null,
                      st.plan.action ? h('b', null, st.plan.action) : null,
                      st.plan.positionPct != null
                        ? h('span', { className: 'dst-muted' }, `仓位 ${st.plan.positionPct}%`)
                        : null,
                    ),
                    st.plan.levels && st.plan.levels.length
                      ? h('div', { className: 'dst-ai-levels' },
                          st.plan.levels.map((lv, i) => h('div', { key: i, className: 'dst-ai-level' },
                            h('span', null, lv.label),
                            h('b', null, `¥${Number(lv.price).toFixed(2)}`),
                            h('span', { className: 'dst-muted' }, lv.op === '>=' ? '涨到提醒' : '跌破提醒'),
                          )))
                      : null,
                    h('div', { className: 'dst-ai-planfoot' },
                      st.alertCount
                        ? `${st.historyId ? '当时' : ''}自动设置了 ${st.alertCount} 条价格预警（可在「预警」页调整）`
                        : '未新建预警（价位与已有预警重复，或自动设预警已关闭）'),
                  )
                : null,
              st.phase === 'done' && st.text && !st.plan && !st.cancelled && !st.historyId && settings.aiAutoAlert !== false
                ? h('div', { key: 'noplan', className: 'dst-ai-warn' },
                    '模型这次没给出结构化价位，没有自动设预警；可以再分析一次，或到「预警」页手动加。')
                : null,
              h('div', { className: `dst-ai-body${settings.aiCollapsed ? ' dst-ai-bodyfold' : ''}` },
                h('div', { className: 'dst-ai-bodyinner' },
                  renderRich(displayText),
                  running ? h('span', { className: 'dst-ai-cursor' }) : null)),
              settings.aiCollapsed && st.text
                ? h('div', { className: 'dst-ai-foldhint' },
                    `正文已收起 · ${displayText.replace(/\s+/g, ' ').slice(0, 60)}…`)
                : null,
              st.pack
                ? h('details', { key: 'snap', className: 'dst-ai-snap' },
                    h('summary', null, `当时给模型的数据（${st.pack.length} 字）${st.promptVersion ? ` · ${st.promptVersion}` : ''}`),
                    h('pre', null, st.pack))
                : null,
              !chat.st.open && st.text
                ? h('button', {
                    key: 'askentry',
                    className: 'dst-ai-askentry',
                    onClick: () => chat.open(''),
                  },
                    h('span', null, '💬 就这次分析继续问…'),
                    h('span', { style: { marginLeft: 'auto', opacity: 0.7 } }, '划选正文可以直接问这段'))
                : null,
              ),
              wide && chat.st.open
                ? h('div', { key: 'split', className: 'dst-ai-splitbar', title: '拖动调整左右宽度', onMouseDown: startDrag })
                : null,
              chatPanel,
            )
          : null,

        st.error
          ? h('div', { className: 'dst-ai-err' },
              `分析失败：${st.error}`,
              st.code ? h('div', { className: 'dst-ai-warn' }, `错误码 ${st.code}`) : null,
              /401|403|宿主/.test(st.error)
                ? h('div', { className: 'dst-ai-warn' }, '如果刚更新过宿主代码，需要完全退出 DSH 再打开。')
                : null)
          : null,

        st.reasoning
          ? h('details', { className: 'dst-ai-think' },
              h('summary', null, `模型的思考过程（${st.reasoning.length} 字）`),
              h('div', null, st.reasoning))
          : null,

        h('details', { className: 'dst-ai-hist' },
          h('summary', null, `历史分析（${history.items.length}）`),
          history.error
            ? h('div', { className: 'dst-ai-warn' }, `读不到历史记录：${history.error}`)
            : null,
          viewErr ? h('div', { className: 'dst-ai-warn' }, viewErr) : null,
          history.items.length
            ? history.items.map((it) => h('div', { key: it.id, className: 'dst-ai-histrow' },
                h('div', {
                  className: 'dst-ai-histmain',
                  title: '点击回看这条分析',
                  onClick: () => openHistory(it.id),
                },
                  h('span', { className: 'dst-ai-histwhen' }, fmtWhen(it.at)),
                  it.kind === 'auto'
                    ? h('span', {
                      className: 'dst-pill',
                      title: it.trigger === 'preplan' ? '盘前计划生成' : '自动跟踪生成',
                    }, it.trigger === 'preplan' ? '盘前计划' : `自动 ${it.trigger || ''}`)
                    : null,
                  h('b', null, `${it.name || it.symbol}`),
                  h('span', { className: 'dst-muted' }, it.model || ''),
                  it.stance
                    ? h('span', { className: 'dst-pill' },
                        `${it.stance}${it.confidence != null ? ` ${it.confidence}` : ''}`)
                    : null,
                  h('span', { className: 'dst-pill' }, `数据 ${it.chars || 0} 字`),
                  h('div', { className: 'dst-ai-histsnip' }, it.snippet || ''),
                ),
                h('button', {
                  className: 'dst-btn',
                  title: '删除这条记录',
                  onClick: () => removeHistory(it.id),
                }, '✕'),
              ))
            : h('div', { className: 'dst-ai-empty' },
                '还没有历史记录。每次分析完成后会自动存一条（最多保留 50 条）。'),
          history.items.length
            ? h('div', { className: 'dst-ai-histfoot' },
                h('button', {
                  className: 'dst-btn',
                  onClick: async () => {
                    try {
                      await fetch(`${API}/ai/history/clear`, { method: 'POST', redirect: 'error' });
                      if (analysis.st.historyId) analysis.reset();
                      history.reload();
                    } catch (err) {
                      setViewErr(`清空历史失败：${err && err.message ? err.message : err}`);
                    }
                  },
                }, '清空历史'))
            : null,
        ),

        h('div', { className: 'dst-ai-warn' },
          'AI 拿到的只有你这份行情数据包的副本；结论不构成投资建议，请自己核对价位。'),
      );
    }

    const ALL_TABS = [
      ['holdings', '持仓'],
      ['watch', '自选'],
      ['add', '添加'],
      ['ai', 'AI 分析'],
      ['trades', '流水'],
      ['alerts', '预警'],
      ['settings', '设置'],
    ];

    /** 标签页/组件开关都放在 settings 里，用户在「设置 → 显示」里勾 */
    function visibleTabs(settings) {
      const s = settings || {};
      return ALL_TABS.filter(([key]) => {
        if (key === 'holdings') return s.showHoldings !== false;
        if (key === 'watch') return s.showWatch !== false;
        if (key === 'ai') return s.showAi !== false;
        if (key === 'trades') return s.showTrades !== false;
        if (key === 'alerts') return s.showAlerts !== false;
        return true; // 添加 / 设置 始终在，否则用户没法把别的开关打开
      });
    }

    function StockTicker(props) {
      // variant='sidebar' 是 dsh-better-sidebar 侧边栏 tab 里的整页版本；默认是顶部行情条
      const variant = props && props.variant === 'sidebar' ? 'sidebar' : 'bar';
      const visible = !(props && props.visible === false);
      // 侧边栏 tab 不可见时暂停轮询；顶栏常驻，一直轮询
      const tickerActive = variant === 'sidebar' ? visible : undefined;
      const { state, error, toasts, dismissToast, load, save, remove, reorder, patchSettings,
        saveAlert, removeAlert, ackAlert } = useTicker(tickerActive);
      const [open, setOpen] = useState(false);
      // 面板是否展开：侧边栏版本一直展开，顶栏版本跟着 open 走
      const showPanel = variant === 'sidebar' ? true : open;
      const [tab, setTab] = useState('holdings');
      const [selected, setSelected] = useState(null);
      const [chromeTop, setChromeTop] = useState(0);
      const [period, setPeriod] = useState('day');
      const [adjust, setAdjust] = useState('pre');
      const [count, setCount] = useState(120);
      const [klineNonce, setKlineNonce] = useState(0);
      const [chart, setChart] = useState('trend');
      const [trendDays, setTrendDays] = useState(1);
      // K线副图指标（none/macd/kdj/rsi）：界面状态跟设置同步，改了顺手存回去
      const [subIndicator, setSubIndicator] = useState('macd');
      const trackRef = useRef(null);
      // 行情条 chip 拖动排序：dragging 中的 symbol 存这里（渲染参数不进 state）
      const chipDrag = useRef(null);
      // 拖的过程中直接改 DOM 的 transform（GPU 合成，不触发 React 重渲染），
      // 否则每个 pointermove 都要重画整棵树，快拖就是一顿一顿的。
      const [dragPos, setDragPos] = useState(null);
      const [dragging, setDragging] = useState(false);
      const dragRef = useRef(null);
      const dragRafRef = useRef(0);
      const barElRef = useRef(null);
      const panelElRef = useRef(null);

      // 交易流水（只在打开该标签页时拉取）
      const trades = useTrades(showPanel && (tab === 'trades' || tab === 'alerts'));

      const settings = (state && state.settings) || {
        refreshMs: 5000, topOffset: 0, leftOffset: 10, opacity: 0.96, scroll: true, flash: true,
        showIndex: true, showWatch: true, showHoldings: true, showTotals: true,
        period: 'day', adjust: 'pre', subIndicator: 'macd', klineCount: 120,
        chart: 'trend', trendDays: 1, showTrend: true, showKline: true,
        showOrderBook: true, showTrades: true, showAlerts: true, showAi: true,
        alertToast: true,
      };
      const tabs = visibleTabs(settings);

      // 跟随开启后从设置同步一次默认值
      const syncedRef = useRef(false);
      useEffect(() => {
        if (syncedRef.current || !state || !state.settings) return;
        syncedRef.current = true;
        setPeriod(state.settings.period || 'day');
        setAdjust(state.settings.adjust || 'pre');
        setCount(state.settings.klineCount || 120);
        setChart(state.settings.chart === 'kline' ? 'kline' : 'trend');
        setTrendDays(Number(state.settings.trendDays) || 1);
        setSubIndicator(SUB_DEFS[state.settings.subIndicator] ? state.settings.subIndicator : 'macd');
      }, [state]);

      // 测量窗口 chrome 高度，避免压住标题栏 / macOS 上的窗口按钮
      useEffect(() => {
        if (variant !== 'bar') return undefined;
        const measure = () => {
          if (typeof document === 'undefined') return;
          const rootEl = document.documentElement;
          const cs = getComputedStyle(rootEl);
          let top = 0;
          const clearance = parseFloat(cs.getPropertyValue('--dsh-frame-top-clearance')) || 0;
          if (clearance > 0) top = Math.max(top, clearance);
          const winBar =
            rootEl.hasAttribute('data-windows-titlebar') ||
            (typeof document.body !== 'undefined' && document.body.hasAttribute('data-windows-titlebar'));
          const captionH = parseFloat(cs.getPropertyValue('--dsh-windows-titlebar-height')) || 0;
          if (winBar) {
            top = Math.max(top, captionH);
          }
          setChromeTop(top);
          // 折叠胶囊的落点不再在这里算：它已经注册进共享顶栏停靠栈
          // （#dsh-topbar-dock，见文件顶部 acquireTopbarDock），位置由 flex 队列决定。
        };
        measure();
        const id = setInterval(measure, 1500);
        return () => clearInterval(id);
      }, []);

      // Esc 收起面板：面板是浮窗，鼠标不用先移回条上也能关掉
      useEffect(() => {
        if (variant !== 'bar' || !open) return undefined;
        if (typeof window === 'undefined') return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [variant, open]);

      const rows = (state && state.items) || [];
      const strip = (state && state.strip) || [];
      const totals = state && state.totals;

      useMarquee(trackRef, variant === 'bar' && !!settings.scroll && !open, strip.length);

      const positions = useMemo(
        () => rows.filter((r) => !r.index),
        [rows],
      );
      const holdings = useMemo(
        () => positions.filter((r) => r.held || r.shares > 0),
        [positions],
      );

      const selectedPos = useMemo(
        () => rows.find((r) => r.symbol === selected) || null,
        [rows, selected],
      );

      // K 线数据
      const [kline, setKline] = useState(null);
      const [klineErr, setKlineErr] = useState(null);
      useEffect(() => {
        if (!showPanel || !selected) { setKline(null); return undefined; }
        let alive = true;
        api(`/kline?symbol=${encodeURIComponent(selected)}&period=${period}&adjust=${adjust}&count=${count}`)
          .then((d) => { if (alive) { setKline(d); setKlineErr(null); } })
          .catch((e) => { if (alive) { setKlineErr(e && e.message ? e.message : String(e)); } });
        return () => { alive = false; };
      }, [showPanel, selected, period, adjust, count, klineNonce]);

      // 盘中每 30 秒刷新一次 K 线最后一根
      useEffect(() => {
        if (!showPanel || !selected) return undefined;
        const id = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          setKlineNonce((n) => n + 1);
        }, 30000);
        return () => clearInterval(id);
      }, [showPanel, selected]);

      // 自动跟踪完成提醒：轮询历史（15 秒），发现新的 kind==='auto' 记录就弹右下角通知
      const [notices, setNotices] = useState([]);
      useEffect(() => {
        if (tickerActive === false) return undefined;
        let alive = true;
        const poll = () => {
          api('/ai/history?limit=8').then((d) => {
            if (!alive || !d || !Array.isArray(d.items)) return;
            if (!autoNoticeSeen.ready) {
              autoNoticeSeen.ready = true;
              autoNoticeSeen.id = d.items[0] ? d.items[0].id : null;
              return;
            }
            const fresh = [];
            for (const it of d.items) {
              if (it.id === autoNoticeSeen.id) break;
              if (it.kind === 'auto' && !autoNoticeSeen.ids.has(it.id)) fresh.push(it);
            }
            if (!fresh.length) return;
            if (d.items[0]) autoNoticeSeen.id = d.items[0].id;
            for (const it of fresh) autoNoticeSeen.ids.add(it.id);
            setNotices((cur) => [...fresh.map((it) => ({
              id: it.id, at: it.at, trigger: it.trigger, symbol: it.symbol,
              name: it.name, snippet: it.snippet,
            })), ...cur].slice(0, 3));
          }).catch(() => {});
        };
        poll();
        const id = setInterval(poll, 15000);
        return () => { alive = false; clearInterval(id); };
      }, [tickerActive]);

      const dismissNotice = (id) => setNotices((cur) => cur.filter((n) => n.id !== id));
      const openNotice = async (n) => {
        dismissNotice(n.id);
        setTab('ai');
        if (variant === 'bar') setOpen(true);
        try {
          const d = await api(`/ai/history/get?id=${encodeURIComponent(n.id)}`);
          const item = d && d.item;
          if (!item) return;
          if (item.symbol) setSelected(item.symbol);
          analysisStore.showHistory(item);
          chatStore.bind(item.id, Array.isArray(item.chats) ? item.chats : []);
        } catch { /* 点开失败就留在当前页，历史里还能找到 */ }
      };

      // 组件开关：分时图 / K线图 可以分别关掉；两个都关就整块不渲染
      const showTrend = settings.showTrend !== false;      const showKline = settings.showKline !== false;
      const showChart = showTrend || showKline;
      const chartMode = showTrend && (!showKline || chart === 'trend') ? 'trend' : 'kline';

      // 分时数据（仅分时图模式拉取）
      const [trend, setTrend] = useState(null);
      const [trendErr, setTrendErr] = useState(null);
      const wantTrend = showChart && chartMode === 'trend';
      useEffect(() => {
        if (!showPanel || !selected || !wantTrend) { setTrend(null); return undefined; }
        let alive = true;
        api(`/trends?symbol=${encodeURIComponent(selected)}&days=${trendDays}`)
          .then((d) => { if (alive) { setTrend(d); setTrendErr(null); } })
          .catch((e) => { if (alive) { setTrendErr(e && e.message ? e.message : String(e)); } });
        return () => { alive = false; };
      }, [showPanel, selected, wantTrend, trendDays, klineNonce]);

      // 当前标签页被设置关掉时，退回一个还开着的
      useEffect(() => {
        if (!tabs.some(([key]) => key === tab)) setTab(tabs[0] ? tabs[0][0] : 'settings');
      }, [tabs.map(([k]) => k).join(','), tab]);

      const onSelect = useCallback((symbol) => {
        // 再点一次同一只就收起详情（切换式选中）
        setSelected((cur) => (cur === symbol ? null : symbol));
        setOpen(true);
      }, []);

      const onSave = useCallback(async (patch) => {
        const item = await save(patch);
        return item;
      }, [save]);

      const onRowSave = useCallback(async (patch) => {
        try {
          await save(patch);
        } catch (e) {
          // 单元格保存失败时给出可见反馈
          // eslint-disable-next-line no-console
          console.warn('[stock-bar] 保存失败', e);
        }
      }, [save]);

      /** 面板正文：顶栏展开时和侧边栏页共用同一份 JSX */
      const buildPanelBody = () => ([

                tab === 'add'
                  ? h(AddForm, { onSave, onSaved: (sym) => { setSelected(sym); setTab('holdings'); } })
                  : null,

                tab === 'ai'
                  ? h(AiTab, { ticker: { state, patchSettings }, selected })
                  : null,

                tab === 'settings'
                  ? h(SettingsTab, {
                      settings, patchSettings, state, error,
                      // 微调走像素（更符合「按一下挪一点」的手感），顺手清掉百分比：
                      // 一旦手动微调，就回到像素模式，免得下次改窗口又被比例拽回去
                      onNudge: (d) => patchSettings({ topOffset: (Number(settings.topOffset) || 0) + d, topPct: null }),
                      onNudgeLeft: (d) => patchSettings({
                        leftOffset: Math.max(0, (Number(settings.leftOffset) || 0) + d), leftPct: null,
                      }),
                    })
                  : null,

                tab === 'holdings'
                  ? h(EquityCard, { key: 'equity', refreshKey: (state && state.serverTime) || 0 })
                  : null,

                tab === 'holdings' || tab === 'watch'
                  ? h(QuoteTable, {
                      rows: tab === 'holdings' ? holdings : positions,
                      mode: tab === 'holdings' ? 'holdings' : 'watch',
                      selected, onSelect,
                      onSave: onRowSave,
                      onRemove: (sym) => remove(sym),
                      currency: totals && totals.currency,
                    })
                  : null,

                selectedPos && (tab === 'holdings' || tab === 'watch')
                  ? h('div', null,
                      // 控制行：左边是成本摘要（有持仓才有），右边是图表切换。
                      // 名称/现价/市值/盈亏这些表格行里已经有的信息不再重复；图表标题也不再带股票名。
                      h('div', {
                        className: (selectedPos.held && selectedPos.cost > 0) ? 'dst-cost-line' : 'dst-row',
                        style: { margin: '2px 0 6px' },
                      },
                        selectedPos.held && selectedPos.cost > 0
                          ? [
                              h('span', { className: 'dst-cost-k' }, '成本'),
                              h('b', { className: 'dst-cost-val' }, fmtPrice(selectedPos.cost)),
                              h('span', { className: 'dst-cost-k' }, `${selectedPos.shares} 股`),
                              // 浮动盈亏不在这重复——表格那一行和底部汇总条里已经有了
                            ]
                          : null,
                        h('span', { className: 'dst-spacer' }),
                        // 两种图都开着才给切换按钮；只开一种就没得选
                        showTrend && showKline
                          ? h('div', { className: 'dst-seg' },
                              [['trend', '分时'], ['kline', 'K线']].map(([v, l]) => h('button', {
                                key: v, className: chartMode === v ? 'dst-on' : '',
                                onClick: () => setChart(v),
                              }, l)),
                            )
                          : h('span', { className: 'dst-sub' }, showTrend ? '分时' : showKline ? 'K线' : '图表已关闭'),
                        // 一张图都没开时，周期/天数/复权这些按钮点了也没有意义，干脆不显示
                        showChart
                          ? (chartMode === 'kline'
                              ? h('div', { className: 'dst-seg' },
                                  PERIODS.map(([v, l]) => h('button', {
                                    key: v, className: period === v ? 'dst-on' : '',
                                    onClick: () => setPeriod(v),
                                  }, l)),
                                )
                              : h('div', { className: 'dst-seg' },
                                  [1, 3, 5].map((d) => h('button', {
                                    key: d, className: Number(trendDays) === d ? 'dst-on' : '',
                                    onClick: () => setTrendDays(d),
                                  }, `${d}日`)),
                                ))
                          : null,
                        showChart && chartMode === 'kline'
                          ? h('div', { className: 'dst-seg' },
                              ADJUSTS.map(([v, l]) => h('button', {
                                key: v,
                                className: period === '1m' || period === '5m' ? '' : (adjust === v ? 'dst-on' : ''),
                                onClick: () => setAdjust(v),
                              }, l)),
                            )
                          : null,
                        // 副图指标：只有 K 线模式才有意义（分时图没有副图）
                        showChart && chartMode === 'kline'
                          ? h('label', { className: 'dst-sub-pick', title: 'K线副图指标' },
                              h('span', null, '副图'),
                              h('select', {
                                className: 'dst-input',
                                value: subIndicator,
                                onChange: (e) => {
                                  const v = e.target.value;
                                  setSubIndicator(SUB_DEFS[v] ? v : 'none');
                                  patchSettings({ subIndicator: SUB_DEFS[v] ? v : 'none' });
                                },
                              }, SUB_OPTIONS.map(([v, l]) => h('option', { key: v, value: v }, l))),
                            )
                          : null,
                      ),
                      showChart
                        ? h('div', null,
                            chartMode === 'trend'
                              ? (trendErr
                                  ? h('div', { className: 'dst-empty dst-err' }, `分时加载失败：${trendErr}`)
                                  : h(TrendChart, {
                                      data: trend,
                                      height: 320,
                                      cost: selectedPos.held ? selectedPos.cost : null,
                                      shares: selectedPos.held ? selectedPos.shares : 0,
                                      code: selectedPos.code,
                                      name: selectedPos.name,
                                      symbol: selectedPos.symbol,
                                      title: `分时${Number(trendDays) > 1 ? `（${trendDays}日）` : ' · 今日'}`,
                                    }))
                              : (klineErr
                                  ? h('div', { className: 'dst-empty dst-err' }, `K线加载失败：${klineErr}`)
                                  : h(KLineChart, {
                                      candles: (kline && kline.candles) || [],
                                      height: 320,
                                      sub: subIndicator,
                                      cost: selectedPos.held ? selectedPos.cost : null,
                                      shares: selectedPos.held ? selectedPos.shares : 0,
                                      title: `K线 · ${(PERIODS.find((p) => p[0] === period) || [, period])[1]}`,
                                      onNeedMore: count < 800 ? () => setCount((c) => Math.min(800, c + 120)) : null,
                                    })),
                          )
                        : h('div', { className: 'dst-empty' }, '分时图和 K 线图都在「设置 → 显示」里关掉了。'),
                      settings.showOrderBook === false
                        ? null
                        : h('div', { style: { marginTop: '8px' } },
                            h(OrderBookCard, { symbol: selected, height: 158 })),
                    )
                  : null,

                (tab === 'holdings' || tab === 'watch') && !selected
                  ? h('div', { className: 'dst-note' }, '点击表格中的任意一行看走势，再点一次收起。')
                  : null,

                tab === 'trades'
                  ? h(TradesTab, {
                      trades,
                      onReload: () => trades.reload(),
                      onApply: () => trades.applyTrades(),
                    })
                  : null,

                tab === 'alerts'
                  ? h(AlertsTab, {
                      ticker: { state, error, saveAlert, removeAlert, ackAlert },
                    })
                  : null,
      ]);

      const topPx = chromeTop + (Number(settings.topOffset) || 0);

      // 拖动行情条：按住左侧把手拖，松手写回 settings；双击把手复位。
      //
      // 坑（用户 2026-11-17 踩到）：原来用 setPointerCapture 挂在把手上收事件。
      // 指针一滑进窗口标题栏（Electron 的原生拖窗区）或者移出窗口，元素就再也
      // 收不到 pointerup —— 拖动态永远留在那儿（grabbing 光标 + 内部按钮全
      // pointer-events:none），看起来就是「鼠标控制不了了」。
      // 现在改成：事件同时挂到 window 上兜底、不要 pointer capture、并且
      // 一旦发现按键已经松开（e.buttons === 0）立刻收尾。任何一条路走到就还原。
      const viewW = () => (typeof document !== 'undefined' && document.documentElement
        ? document.documentElement.clientWidth : 0) || (typeof window !== 'undefined' ? window.innerWidth : 0) || 1600;
      const viewH = () => (typeof window !== 'undefined' && Number(window.innerHeight)) || 900;

      // 窗口尺寸：位置按百分比存，换显示器 / 改窗口宽度时相对位置不变。
      // （分辨率一变，固定像素位置就会跑到奇奇怪怪的地方去）
      const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
      useEffect(() => {
        if (variant !== 'bar') return undefined;
        if (typeof window === 'undefined' || !window.addEventListener) return undefined;
        const onResize = () => setViewSize({ w: viewW(), h: viewH() });
        onResize();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [variant]);

      const winW = viewSize.w || viewW();
      const usableH = Math.max(1, (viewSize.h || viewH()) - chromeTop);
      // 老存档只有像素（leftOffset/topOffset）；新存档优先用百分比（leftPct/topPct）
      const savedLeft = settings.leftPct == null
        ? (settings.leftOffset == null ? 10 : Number(settings.leftOffset) || 0)
        : Math.round(winW * (Number(settings.leftPct) || 0) / 100);
      const savedTop = settings.topPct == null
        ? Math.max(0, Number(settings.topOffset) || 0)
        : Math.round(usableH * (Number(settings.topPct) || 0) / 100);
      const barW = barElRef.current && typeof barElRef.current.getBoundingClientRect === 'function'
        ? barElRef.current.getBoundingClientRect().width : 0;
      const barMaxLeft = Math.max(0, winW - Math.max(barW || 0, 240) - 20);
      const barMaxTop = Math.max(0, usableH - 48);
      const barLeftPx = dragPos ? dragPos.left : Math.max(0, Math.min(barMaxLeft, savedLeft));
      const barTopPx = chromeTop + (dragPos ? dragPos.top : Math.max(0, Math.min(barMaxTop, savedTop)));

      // 拖动态的事件解绑器（window 级监听全在这里注销）
      const dragTeardownRef = useRef(null);

      // 拖动中的画面：只动 transform，不动 state。条和面板一起平移（面板开着时也跟着走）
      const paintDrag = () => {
        dragRafRef.current = 0;
        const d = dragRef.current;
        if (!d) return;
        const dx = d.last.left - d.baseLeft;
        const dy = d.last.top - d.baseTop;
        const el = barElRef.current;
        if (el && el.style) {
          el.style.transform = dx || dy ? `translate3d(${dx}px, ${dy}px, 0)` : '';
        }
        const pn = panelElRef.current;
        if (pn && pn.style) {
          // 面板本身用 translateX(-50%) 居中，平移要叠加在它上面
          pn.style.transform = dx || dy
            ? `translate(calc(-50% + ${dx}px), ${dy}px)`
            : '';
        }
      };

      const clearDragPaint = () => {
        const el = barElRef.current;
        if (el && el.style) el.style.transform = '';
        const pn = panelElRef.current;
        if (pn && pn.style) pn.style.transform = '';
      };

      // 收尾：save=true 时把最后位置写进设置。可重入，重复调用是安全的。
      // 存百分比为主，同时把像素也写一份：老宿主不认识新键会丢掉，还能靠像素落位。
      const finishDrag = (save) => {
        const d = dragRef.current;
        dragRef.current = null;
        if (dragRafRef.current && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(dragRafRef.current);
        }
        dragRafRef.current = 0;
        if (dragTeardownRef.current) {
          try { dragTeardownRef.current(); } catch { /* ignore */ }
          dragTeardownRef.current = null;
        }
        setDragging(false);
        if (!save || !d || !d.moved) {
          clearDragPaint();
          setDragPos(null);
          return;
        }
        const left = Math.max(0, Math.round(d.last.left));
        const top = Math.max(0, Math.round(d.last.top));
        clearDragPaint();
        // 先把条定在落点上：设置存回来还要几十毫秒，这期间不能闪回旧位置
        setDragPos({ left, top });
        const w = Math.max(1, viewW());
        const usable = Math.max(1, viewH() - chromeTop);
        const pctPatch = {
          leftOffset: left, topOffset: top,
          leftPct: Math.round((left / w) * 1000) / 10,
          topPct: Math.round((top / usable) * 1000) / 10,
        };
        const done = patchSettings(pctPatch);
        if (done && typeof done.then === 'function') {
          // 存成功 → 设置里已经是新位置，这时才把临时位置摘掉（同一批渲染，不会跳）
          done.then((ok) => { if (ok) setDragPos(null); });
        } else {
          setDragPos(null);
        }
      };

      const moveDrag = (e) => {
        const d = dragRef.current;
        if (!d || !e) return;
        // 收不到 pointerup 时的兜底：按键已经松开就直接收尾并保存
        if (e.buttons === 0) { finishDrag(true); return; }
        const dx = (Number(e.clientX) || 0) - d.x;
        const dy = (Number(e.clientY) || 0) - d.y;
        // 手抖 3px 以内不算拖，免得点一下就被当成拖
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        if (!d.moved) { d.moved = true; setDragging(true); }
        d.last = {
          left: Math.round(Math.max(0, Math.min(d.maxLeft, d.baseLeft + dx))),
          // 上界 0：不许拖进标题栏（那是原生拖窗区，进去就抓不到鼠标了）
          top: Math.round(Math.max(0, Math.min(d.maxTop, d.baseTop + dy))),
        };
        if (typeof requestAnimationFrame === 'function') {
          if (!dragRafRef.current) dragRafRef.current = requestAnimationFrame(paintDrag);
        } else {
          paintDrag();
        }
        if (e.preventDefault) e.preventDefault();
      };

      const onDragDown = (e) => {
        if (!e || (e.button != null && e.button !== 0)) return;
        const left = Math.max(0, Math.min(barMaxLeft, savedLeft));
        const top = Math.max(0, Math.min(barMaxTop, savedTop));
        // 量一下条有多大：拖到右边/下边时让边缘也别出去（量不到就按兜底值算）
        const el = barElRef.current;
        const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        const w = (rect && rect.width) || 0;
        const maxLeft = Math.max(0, viewW() - Math.max(w || 0, 240) - 20);
        const maxTop = Math.max(0, viewH() - chromeTop - 48);
        if (dragTeardownRef.current) {
          try { dragTeardownRef.current(); } catch { /* ignore */ }
          dragTeardownRef.current = null;
        }
        clearDragPaint();
        dragRef.current = {
          x: e.clientX, y: e.clientY,
          baseLeft: left, baseTop: top,
          maxLeft, maxTop, moved: false, last: { left, top },
        };
        // window 级监听：指针跑到条外面（含标题栏、窗口外）也能收到移动和松手
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          const onMove = (ev) => moveDrag(ev);
          const onUp = () => finishDrag(true);
          const onCancel = () => finishDrag(false);
          const onBlur = () => finishDrag(true);
          const onDown = () => finishDrag(true);
          const onKey = (ev) => {
            if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) finishDrag(false);
          };
          window.addEventListener('pointermove', onMove, true);
          window.addEventListener('pointerup', onUp, true);
          window.addEventListener('mouseup', onUp, true);
          // 又按了一下（说明上一次的 up 丢了）→ 先把上一次收尾
          window.addEventListener('pointerdown', onDown, true);
          window.addEventListener('pointercancel', onCancel, true);
          window.addEventListener('blur', onBlur, true);
          window.addEventListener('keydown', onKey, true);
          dragTeardownRef.current = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('mouseup', onUp, true);
            window.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('pointercancel', onCancel, true);
            window.removeEventListener('blur', onBlur, true);
            window.removeEventListener('keydown', onKey, true);
          };
        }
        if (e.preventDefault) e.preventDefault();
      };

      // 组件被卸载（比如面板开合把条换掉）时把拖动态收干净，别留监听和 grabbing 光标
      useEffect(() => () => {
        if (dragRafRef.current && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(dragRafRef.current);
        }
        dragRafRef.current = 0;
        if (dragTeardownRef.current) {
          try { dragTeardownRef.current(); } catch { /* ignore */ }
          dragTeardownRef.current = null;
        }
        dragRef.current = null;
      }, []);

      const resetBarPos = () => {
        setDragPos(null);
        patchSettings({ leftOffset: 10, topOffset: 0, leftPct: null, topPct: null });
      };
      // 折叠态 = 只在顶栏停靠栈里留一颗小胶囊，点它才展开（不做悬停自动展开：
      // 悬停展开会让「鼠标移开」把已打开的面板一起卸载掉，点开面板后一移动就消失）。
      // 面板开着时也一律不回到折叠分支，免得设置保存的往返把面板闪没。
      const collapsed = variant === 'bar' && !!settings.collapsed && !open;

      // 折叠态：只留一个小胶囊，点一下展开
      if (collapsed) {
        // 关键：胶囊注册进共享顶栏停靠栈（#dsh-topbar-dock），
        // 与「每日一关」等其它顶栏组件自动排队，不再自己 fixed 抢坐标
        return h('div', { className: 'dst-root dst-theme', style: { top: 0 } },
          h(TopbarSlot, null,
            h('div', {
              className: 'dst-dock',
              title: '点一下展开行情条',
              onClick: () => patchSettings({ collapsed: false }),
            },
              h('span', { className: 'dst-dock-icon' }, '📈'),
              totals && totals.hasPosition
                ? h('span', { className: dirClass(totals.pnl) }, `${fmtSigned(totals.pnl)} ${fmtPct(totals.pnlPct)}`)
                : h('span', { className: 'dst-flat' }, '行情'),
              h('span', { className: 'dst-dock-x' }, '▾'),
            ),
          ),
          h(Toasts, { key: 'toasts', toasts: settings.alertToast === false ? [] : toasts, onDismiss: dismissToast,
            notices, onOpenNotice: openNotice, onDismissNotice: dismissNotice }),
        );
      }

      const barChildren = [
        // 拖动把手：按住左右上下拖行情条，松手记住位置；双击复位
        // 元素上的这几个回调只是「正常路径」，真正保底的是 window 上的监听
        // （见 onDragDown），所以这里松手一律走 finishDrag(保存)。
        h('div', {
          key: 'drag',
          className: 'dst-drag',
          title: '拖动移动行情条；双击复位',
          onPointerDown: onDragDown,
          onPointerMove: moveDrag,
          onPointerUp: () => finishDrag(true),
          onPointerCancel: () => finishDrag(false),
          onDoubleClick: resetBarPos,
        }, '⋮⋮'),
        h('div', {
          key: 'brand',
          className: 'dst-brand',
          title: open ? '收起面板' : '展开面板（持仓 / 自选 / K线 / 设置）',
          onClick: () => setOpen((v) => !v),
        },
          h('span', null, '📈'),
          h('span', null, '行情'),
          h('span', { className: `dst-dot ${state && state.market && state.market.open ? 'dst-live' : ''}` }),
        ),
        state && state.market
          ? h('span', {
              key: 'se',
              className: 'dst-session',
              title: `上海时间 ${state.market.shanghai}`,
            }, `${state.market.label} ${state.market.shanghai}`)
          : null,
        h('div', { key: 'track', className: 'dst-track', ref: trackRef },
          strip.length
            ? strip.map((p) => h(Chip, {
                key: p.symbol, pos: p, selected: selected === p.symbol,
                onSelect, flash: settings.flash,
                dragHandlers: reorder ? {
                  onDragStart: (e) => {
                    chipDrag.current = { from: p.symbol, dragEl: e.currentTarget, indEl: null };
                    e.currentTarget.classList.add('dst-dragging');
                    try {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', p.symbol);
                    } catch { /* 老 Electron 不带 dataTransfer 也得能拖 */ }
                  },
                  onDragOver: (e) => {
                    if (!chipDrag.current || chipDrag.current.from === p.symbol) return;
                    e.preventDefault();
                    try { e.dataTransfer.dropEffect = 'move'; } catch { /* 忽略 */ }
                    // 插入位置指示条：落点会插到目标哪一侧，就在哪一侧亮一条竖线
                    const r = e.currentTarget.getBoundingClientRect();
                    const side = e.clientX < r.left + r.width / 2 ? 'dst-drop-before' : 'dst-drop-after';
                    const el = e.currentTarget;
                    if (chipDrag.current.indEl && chipDrag.current.indEl !== el) {
                      chipDrag.current.indEl.classList.remove('dst-drop-before', 'dst-drop-after');
                    }
                    if (el.classList.contains('dst-drop-before') && side !== 'dst-drop-before') {
                      el.classList.remove('dst-drop-before');
                    }
                    if (el.classList.contains('dst-drop-after') && side !== 'dst-drop-after') {
                      el.classList.remove('dst-drop-after');
                    }
                    el.classList.add(side);
                    chipDrag.current.indEl = el;
                  },
                  onDragLeave: (e) => {
                    if (chipDrag.current && chipDrag.current.indEl === e.currentTarget) {
                      e.currentTarget.classList.remove('dst-drop-before', 'dst-drop-after');
                      chipDrag.current.indEl = null;
                    }
                  },
                  onDrop: (e) => {
                    e.preventDefault();
                    const drag = chipDrag.current;
                    const from = drag && drag.from;
                    chipDrag.current = null;
                    if (drag) {
                      if (drag.indEl) drag.indEl.classList.remove('dst-drop-before', 'dst-drop-after');
                      if (drag.dragEl) drag.dragEl.classList.remove('dst-dragging');
                    }
                    if (e.currentTarget.classList) e.currentTarget.classList.remove('dst-dragging');
                    if (!from || from === p.symbol) return;
                    // 落点在目标中点左侧 → 插到它前面；否则插到后面
                    const r = e.currentTarget.getBoundingClientRect();
                    const before = e.clientX < r.left + r.width / 2;
                    const syms = strip.map((x) => x.symbol).filter((s) => s !== from);
                    const at = syms.indexOf(p.symbol);
                    syms.splice(at < 0 ? syms.length : at + (before ? 0 : 1), 0, from);
                    reorder(syms);
                  },
                  onDragEnd: (e) => {
                    const drag = chipDrag.current;
                    chipDrag.current = null;
                    if (drag) {
                      if (drag.indEl) drag.indEl.classList.remove('dst-drop-before', 'dst-drop-after');
                      if (drag.dragEl) drag.dragEl.classList.remove('dst-dragging');
                    }
                    if (e.currentTarget.classList) e.currentTarget.classList.remove('dst-dragging');
                  },
                } : null,
              }))
            : h('span', { className: 'dst-flat' },
                error ? `行情不可用：${error}` : '加载行情中…'),
        ),
        settings.showTotals === false
          ? null
          : h(TotalsBadge, { key: 'tot', totals, currency: totals && totals.currency, onClick: () => { setTab('holdings'); setOpen(true); } }),
        // 有错就必须让用户看见：只在轨道为空时提示的话，一旦拿到过数据，
        // 之后每次轮询失败都会静默地继续显示旧价格。点一下直接跳到设置页看完整原因。
        error ? h('span', {
          key: 'errbadge',
          className: 'dst-err-badge',
          title: error,
          onClick: (e) => { e.stopPropagation(); setTab('settings'); setOpen(true); },
        }, String(error).includes('重启 DSH') ? '⚠ 宿主待重启' : '⚠ 行情异常') : null,
        h('div', { key: 'act', className: 'dst-actions' },
          h('button', {
            className: 'dst-btn', title: '立即刷新行情',
            onClick: () => load(true),
          }, '⟳'),
          h('button', {
            className: `dst-btn ${open ? 'dst-on' : ''}`, title: open ? '收起面板' : '展开面板',
            onClick: () => setOpen((v) => !v),
          }, open ? '▲' : '▼'),
          h('button', {
            className: 'dst-btn', title: '折叠成小胶囊',
            // 折叠时顺手把面板关上：面板开着就不该再渲染整条，否则「—」按了没反应
            onClick: () => { setOpen(false); patchSettings({ collapsed: true }); },
          }, '—'),
        ),
      ];

      // 面板跟着条走：条被拖到哪里，面板就在它下面 46px 展开
      const panelTop = barTopPx + 46;

      // 侧边栏版本：没有 fixed 顶栏，整个 tab 内容区就是我们的页面
      if (variant === 'sidebar') {
        return h('div', { className: 'dst-side dst-theme' },
          h('div', { className: 'dst-side-head' },
            h('span', { className: 'dst-side-title' }, '📈 股票'),
            state && state.market
              ? h('span', { className: 'dst-session', title: `上海时间 ${state.market.shanghai}` },
                  `${state.market.label} ${state.market.shanghai}`)
              : null,
            h('span', { className: 'dst-spacer' }),
            settings.showTotals === false
              ? null
              : h(TotalsBadge, { totals, currency: totals && totals.currency, onClick: () => setTab('holdings') }),
            error
              ? h('span', {
                  className: 'dst-err-badge',
                  title: error,
                  onClick: (e) => { e.stopPropagation(); setTab('settings'); },
                }, String(error).includes('重启 DSH') ? '⚠ 宿主待重启' : '⚠ 行情异常')
              : null,
            h('button', { className: 'dst-btn', title: '立即刷新行情', onClick: () => load(true) }, '⟳'),
          ),
          h('div', { className: 'dst-tabs' },
            tabs.map(([key, label]) => h('button', {
              key, className: `dst-tab ${tab === key ? 'dst-on' : ''}`,
              onClick: () => setTab(key),
            }, label)),
            h('span', { className: 'dst-spacer' }),
            h('span', { className: 'dst-note' }, `${strip.length} 只在看　${holdings.length} 只持仓`),
          ),
          h('div', { className: 'dst-body dst-side-body' }, buildPanelBody()),
          h(Toasts, { key: 'toasts', toasts: settings.alertToast === false ? [] : toasts, onDismiss: dismissToast,
            notices, onOpenNotice: openNotice, onDismissNotice: dismissNotice }),
        );
      }

      return h('div', { className: 'dst-root dst-theme', style: { top: `${barTopPx}px` } },
        // 透明度只作用在「条」上：面板是给人读数字的地方，永远实心
        h('div', {
          ref: barElRef,
          className: `dst-bar${dragging ? ' dst-dragging' : ''}`,
          style: {
            opacity: settings.opacity,
            marginLeft: `${barLeftPx}px`,
            // 拖的时候交给 GPU 合成，别在每一帧里重排
            willChange: dragging ? 'transform' : undefined,
          },
        }, barChildren),
        open
          ? h(React.Fragment, null,
              // 点面板以外的地方收起：只在面板展开时装一层透明挡板，
              // 不压暗、不拦截滚轮，只是把「点外面」变成关闭手势
              h('div', {
                key: 'scrim',
                style: {
                  position: 'fixed', inset: 0, zIndex: 1199,
                  background: 'transparent', pointerEvents: 'auto',
                },
                onClick: () => setOpen(false),
              }),
              h('div', { ref: panelElRef, className: 'dst-panel', style: { top: `${panelTop}px` } },
                h('div', { className: 'dst-panel-head' },
                  h('span', { className: 'dst-panel-title' },
                    h('span', null, '📈'), h('span', null, '股票行情')),
                  h('span', { className: 'dst-note' }, state && state.market
                    ? `${state.market.label} ${state.market.shanghai}`
                    : ''),
                  h('span', { className: 'dst-spacer' }),
                  h('span', { className: 'dst-note' },
                    `${strip.length} 只在看　${holdings.length} 只持仓`),
                  h('button', {
                    className: 'dst-btn dst-panel-close',
                    title: '收起面板（Esc）',
                    onClick: () => setOpen(false),
                  }, '✕'),
                ),
                h('div', { className: 'dst-tabs' },
                  tabs.map(([key, label]) => h('button', {
                    key, className: `dst-tab ${tab === key ? 'dst-on' : ''}`,
                    onClick: () => setTab(key),
                  }, label)),
                  h('span', { className: 'dst-spacer' }),
                  h('button', {
                    className: 'dst-btn',
                    title: '立即刷新行情',
                    onClick: () => load(true),
                  }, '⟳'),
                ),
                h('div', { className: 'dst-body' }, buildPanelBody()),
              ),
            )
          : null,
        h(Toasts, { key: 'toasts', toasts: settings.alertToast === false ? [] : toasts, onDismiss: dismissToast,
            notices, onOpenNotice: openNotice, onDismissNotice: dismissNotice }),
      );
    }


    /** dsh-better-sidebar 的侧边栏 tab：id 必须带插件前缀，避免和内置 tab 撞名 */
    const SIDEBAR_TAB_ID = 'dsh-stock-bar:portfolio';

    /** 侧边栏 tab 图标：一根折线，和行情条功能对得上 */
    function sidebarTabIcon(size) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size || 14,
        height: size || 14,
        'aria-hidden': 'true',
        fill: 'currentColor',
      },
        h('path', { d: 'M1.4 12.2 5.1 8.1l2.7 2.3 4.6-5.6 1.2 1-5.7 6.9-2.8-2.4-3.1 3.5z' }),
        h('path', { d: 'M1 14.2h14v1.2H1z', opacity: '.45' }),
      );
    }

    /**
     * dsh-better-sidebar 的侧边栏页：复用顶栏那套组件，只把布局换成整页。
     * 该插件是可选的——没装时这段代码根本不会执行（见 apply 里的软依赖注册）。
     */
    function StockSidebarPage(props) {
      const visible = !(props && props.visible === false);
      return h(StockTicker, { variant: 'sidebar', visible });
    }

    const inject = ['slots'];

    function apply(ctx) {
      // 样式只在 apply 内注入，并用 data-plugin-css 去重（HMR 重复执行也不会叠加）
      const tagId = 'dsh-stock-bar/ticker.css';
      if (
        typeof document !== 'undefined' &&
        document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null
      ) {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-stock-bar';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'stock-bar', order: 40 },
          StockTicker,
        ),
      );

      // 可选接入 dsh-better-sidebar：装了它就把股票页注册成侧边栏 tab。
      // 它是软依赖——用 ctx.inject 等这个服务出现；没装插件的机器上回调永远不会执行，
      // 顶栏行情条照旧工作。不能写进静态 inject，否则没装的机器上整个插件会挂起。
      if (typeof ctx.inject === 'function') {
        ctx.effect(() => {
          const seat = ctx.inject(['betterSidebar'], (owner) => {
            const service = (owner && owner.betterSidebar)
              || (owner && typeof owner.get === 'function' ? owner.get('betterSidebar') : undefined);
            if (!service || typeof service.registerTab !== 'function') return;
            owner.effect(
              () =>
                service.registerTab({
                  id: SIDEBAR_TAB_ID,
                  title: '股票',
                  description: '自选与持仓行情、分时/K 线、五档盘口、交易流水与 AI 复盘',
                  icon: sidebarTabIcon,
                  order: 60,
                  single: true,
                  component: StockSidebarPage,
                }),
              'dsh-stock-bar/sidebar-tab',
            );
          });
          // cordis 的 ctx.inject 返回带 dispose() 的 fiber；也兼容直接返回函数的形式
          if (seat && typeof seat.dispose === 'function') return () => seat.dispose();
          if (typeof seat === 'function') return seat;
          return undefined;
        }, 'dsh-stock-bar/sidebar');
      }
    }

    return { inject, apply };
  },
});
