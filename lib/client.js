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
  --dst-bg:var(--dsw-alias-bg-layer-2,#1c1f24);--dst-fg:var(--dsw-alias-label-primary,#e6e6e6);
  --dst-border:var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  --dst-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));
  --dst-sel:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12))}
.dst-root *{box-sizing:border-box}
/* 折叠态：钉在标题栏右侧的空白区（原生窗口按钮左边），不占正文、不压工具栏。
   默认半透明，鼠标凑近才变实——不用它的时候几乎看不见，也就不挡任何东西。 */
.dst-dock{position:fixed;display:flex;align-items:center;gap:6px;height:28px;
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
.dst-bar{pointer-events:auto;display:flex;align-items:center;gap:6px;height:30px;
  padding:0 8px;background:var(--dst-bg);border-bottom:1px solid var(--dst-border);
  box-shadow:0 1px 6px rgba(0,0,0,.10);overflow:hidden}
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
.dst-panel{pointer-events:auto;position:fixed;left:8px;right:8px;
  max-height:min(78vh,720px);display:flex;flex-direction:column;
  background:var(--dst-bg);border:1px solid var(--dst-border);border-radius:10px;
  box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden}
.dst-tabs{display:flex;align-items:center;gap:4px;padding:6px 8px;
  border-bottom:1px solid var(--dst-border);flex:none}
.dst-tab{cursor:pointer;border:none;background:none;color:var(--dst-dim);font:inherit;
  font-size:12px;padding:4px 10px;border-radius:6px}
.dst-tab:hover{background:var(--dst-hover)}
.dst-tab.dst-on{color:var(--dst-fg);background:var(--dst-sel);font-weight:600}
.dst-spacer{flex:1}
.dst-body{overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px}

/* ---------- 表格 ---------- */
.dst-table{width:100%;border-collapse:collapse;font-size:12px}
.dst-table th{text-align:right;color:var(--dst-dim);font-weight:500;font-size:11px;
  padding:4px 8px;border-bottom:1px solid var(--dst-border);position:sticky;top:0;
  background:var(--dst-bg);white-space:nowrap}
.dst-table th:first-child,.dst-table td:first-child{text-align:left}
.dst-table td{padding:5px 8px;border-bottom:1px solid var(--dst-border);text-align:right;
  white-space:nowrap}
.dst-table tbody tr{cursor:pointer}
.dst-table tbody tr:hover{background:var(--dst-hover)}
.dst-table tbody tr.dst-rowsel{background:var(--dst-sel)}
.dst-name{font-weight:500}
.dst-sub{color:var(--dst-dim);font-size:11px;margin-left:5px}
.dst-empty{color:var(--dst-dim);text-align:center;padding:28px 12px;font-size:12px}

/* ---------- K线 ---------- */
.dst-kline{position:relative;border:1px solid var(--dst-border);border-radius:8px;
  overflow:hidden;background:var(--dsw-alias-bg-base,transparent);flex:none}
.dst-kline canvas{display:block;width:100%;cursor:crosshair}
.dst-kline-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:6px 8px;border-bottom:1px solid var(--dst-border)}
.dst-kline-title{font-weight:600}
.dst-seg{display:flex;gap:2px;flex-wrap:wrap}
.dst-seg button{cursor:pointer;border:1px solid transparent;background:none;color:var(--dst-dim);
  font:inherit;font-size:11px;padding:2px 7px;border-radius:5px}
.dst-seg button:hover{background:var(--dst-hover)}
.dst-seg button.dst-on{color:var(--dst-fg);background:var(--dst-sel);border-color:var(--dst-border);font-weight:600}
.dst-tip{position:absolute;pointer-events:none;background:var(--dsw-alias-tooltip-bg,rgba(20,22,26,.92));
  color:var(--dsw-alias-toast-label,#f5f5f5);border-radius:6px;padding:5px 8px;font-size:11px;
  line-height:1.5;white-space:nowrap;z-index:5;box-shadow:0 4px 14px rgba(0,0,0,.3)}
.dst-legend{display:flex;gap:10px;font-size:11px;color:var(--dst-dim);flex-wrap:wrap;padding:4px 8px}
.dst-legend i{display:inline-block;width:8px;height:2px;vertical-align:middle;margin-right:3px}

/* ---------- 表单 ---------- */
.dst-form{display:flex;gap:6px;align-items:center;flex-wrap:wrap;
  padding:8px;border:1px solid var(--dst-border);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dst-input{color:var(--dst-fg);background:var(--dsw-alias-bg-base,transparent);
  border:1px solid var(--dst-border);border-radius:6px;padding:4px 8px;font:inherit;font-size:12px;min-width:0}
.dst-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b82f6)}
.dst-input.dst-num{width:88px;text-align:right}
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
  max-height:52vh;overflow:auto;white-space:normal}
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
.dst-ai-warn{margin-top:6px;font-size:10px;color:var(--dst-dim);line-height:1.5}
.dst-ai-err{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.6;
  color:var(--dsw-alias-state-error-primary,#c0392b);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary,#c0392b) 40%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#c0392b) 8%, transparent)}
.dst-ai-think{margin-top:6px;font-size:11px;color:var(--dst-dim)}
.dst-ai-think summary{cursor:pointer}
.dst-ai-think div{margin-top:4px;white-space:pre-wrap;opacity:.85;max-height:120px;overflow:auto}
.dst-ai-empty{padding:18px 4px;font-size:12px;color:var(--dst-dim);text-align:center;line-height:1.8}

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

    const dirClass = (v) => (v > 0 ? 'dst-up' : v < 0 ? 'dst-down' : 'dst-flat');

    /**
     * 涨跌停幅度：主板 10%，创业板/科创板 20%，北交所 30%，ST 5%。
     */
    function limitPctOf(code, name) {
      const c = String(code || '');
      if (/ST/i.test(String(name || ''))) return 5;
      if (/^(30[0-9]|301|302)/.test(c)) return 20;
      if (/^68[89]/.test(c)) return 20;
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
        load, save, remove, patchSettings, applyState,
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

    const MA_DEFS = [
      { n: 5, color: '#e8b339' },
      { n: 10, color: '#3b9dff' },
      { n: 20, color: '#c264e0' },
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

    function KLineChart({ candles, height = 300, title, onNeedMore, cost = null, shares = 0 }) {
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

      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        canvas.width = Math.max(1, Math.floor(width * dpr));
        canvas.height = Math.max(1, Math.floor(height * dpr));
        drawChart(canvas, candles, { width, height, dpr, hover, stateRef, cost, shares });
      }, [candles, width, height, hover, cost, shares]);

      const handleMove = (e) => {
        const layout = stateRef.current.layout;
        if (!layout || !candles.length) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        let i = Math.floor((x - layout.padL) / layout.cw);
        if (i < 0 || i >= candles.length) {
          setHover(null);
          return;
        }
        setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
      };

      const hovered = hover && candles[hover.i] ? candles[hover.i] : null;

      return h('div', { className: 'dst-kline', ref: wrapRef },
        h('div', { className: 'dst-kline-head' },
          h('span', { className: 'dst-kline-title' }, title || 'K线'),
          hovered
            ? h('span', { className: dirClass(hovered.changePct) },
                `${hovered.date}  开${fmtPrice(hovered.open)} 高${fmtPrice(hovered.high)} ` +
                `低${fmtPrice(hovered.low)} 收${fmtPrice(hovered.close)} ${fmtPct(hovered.changePct)}`)
            : null,
          h('span', { className: 'dst-spacer' }),
          onNeedMore
            ? h('button', { className: 'dst-btn', onClick: onNeedMore, title: '加载更多历史' }, '更多历史')
            : null,
        ),
        h('canvas', {
          ref: canvasRef,
          style: { height: `${height}px` },
          onMouseMove: handleMove,
          onMouseLeave: () => setHover(null),
        }),
        hovered ? null : h('div', { className: 'dst-legend' },
          MA_DEFS.map((m) => h('span', { key: m.n },
            h('i', { style: { background: m.color } }), `MA${m.n}`)),
        ),
        !candles.length
          ? h('div', { className: 'dst-empty' }, '暂无K线数据')
          : null,
      );
    }

    function drawChart(canvas, candles, opts) {
      const { width, height, dpr, hover, cost = null, shares = 0 } = opts;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const padL = 8;
      const padR = 52;
      const padT = 8;
      const volH = Math.round(height * 0.2);
      const axisH = 16;
      const priceH = height - padT - volH - axisH - 6;
      const plotW = Math.max(10, width - padL - padR);

      if (!candles.length) {
        opts.stateRef.current.layout = null;
        return;
      }

      const cs = getComputedStyle(canvas);
      const up = (cs.getPropertyValue('--dst-up') || '#e5484d').trim();
      const down = (cs.getPropertyValue('--dst-down') || '#0f9d6e').trim();
      const grid = 'rgba(128,138,152,.22)';
      const dim = 'rgba(128,138,152,.9)';
      const costColor = (cs.getPropertyValue('--dst-cost') || '#6b5ce7').trim();

      let hi = -Infinity;
      let lo = Infinity;
      for (const c of candles) {
        if (c.high > hi) hi = c.high;
        if (c.low < lo) lo = c.low;
      }
      const mas = MA_DEFS.map((m) => ({ ...m, data: computeMA(candles, m.n) }));
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
      const cw = plotW / candles.length;

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
        ctx.fillStyle = dim;
        ctx.fillText(fmtPrice(hi - ((hi - lo) * g) / 4), padL + plotW + 5, y);
      }

      // 成交量
      let maxVol = 0;
      for (const c of candles) if (c.volume > maxVol) maxVol = c.volume;
      const volTop = padT + priceH + 6;
      if (maxVol > 0) {
        for (let i = 0; i < candles.length; i++) {
          const c = candles[i];
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

      // K 线
      const bw = Math.max(1, Math.min(cw * 0.72, 22));
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
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
          ctx.fillRect(padL + 4, y - 8, lw, 15);
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(label, padL + 8, y);
          ctx.restore();
        }
      }

      // 日期轴
      ctx.fillStyle = dim;
      ctx.textAlign = 'center';
      const ticks = Math.max(2, Math.min(6, Math.floor(plotW / 90)));
      for (let t = 0; t <= ticks; t++) {
        const i = Math.round(((candles.length - 1) * t) / ticks);
        const c = candles[i];
        if (!c) continue;
        const x = padL + i * cw + cw / 2;
        ctx.fillText(String(c.date).slice(5), Math.min(width - 26, Math.max(26, x)), height - axisH / 2 - 2);
      }

      // 十字光标
      if (hover && candles[hover.i]) {
        const i = hover.i;
        const x = padL + i * cw + cw / 2;
        const c = candles[i];
        ctx.save();
        ctx.strokeStyle = 'rgba(128,138,152,.75)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + priceH);
        ctx.stroke();
        if (hover.y > padT && hover.y < padT + priceH) {
          const p = hi - ((hover.y - padT) / priceH) * (hi - lo);
          ctx.beginPath();
          ctx.moveTo(padL, hover.y);
          ctx.lineTo(padL + plotW, hover.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(128,138,152,.9)';
          ctx.fillRect(padL + plotW + 1, hover.y - 7, padR - 3, 14);
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(fmtPrice(p), padL + plotW + 5, hover.y);

          // 光标价位对应的持仓盈亏——"如果在这个价位，我是赚还是亏"
          if (costNum && Number(shares) > 0) {
            const pnl = (p - costNum) * Number(shares);
            const pct = costNum > 0 ? ((p - costNum) / costNum) * 100 : 0;
            const txt = `${pnl >= 0 ? '+' : '-'}${fmtMoney(Math.abs(pnl))} ${pct >= 0 ? '+' : ''}${nf(pct, 2)}%`;
            ctx.font = '10px system-ui,sans-serif';
            const tw = ctx.measureText(txt).width + 8;
            const by = hover.y + 18 < padT + priceH ? hover.y + 18 : hover.y - 18;
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

      opts.stateRef.current.layout = { padL, cw, priceH, padT, hi, lo };
    }

    /* ============================================================ *
     * 分时图（canvas 手绘）
     * ============================================================ */

    function TrendChart({ data, height = 300, title, cost = null, shares = 0 }) {
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
        drawTrend(canvas, data, { width, height, dpr, hover, stateRef, cost, shares });
      }, [data, width, height, hover, cost, shares]);

      const handleMove = (e) => {
        const layout = stateRef.current.layout;
        if (!layout || !points.length) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        let i = Math.round(((x - layout.padL) / layout.plotW) * (points.length - 1));
        i = Math.max(0, Math.min(points.length - 1, i));
        setHover({ i, x, y: e.clientY - rect.top });
      };

      const hovered = hover && points[hover.i] ? points[hover.i] : null;
      const prev = data ? data.prevClose : null;
      const hoverPct = hovered && prev ? ((hovered.price - prev) / prev) * 100 : null;

      return h('div', { className: 'dst-kline', ref: wrapRef },
        h('div', { className: 'dst-kline-head' },
          h('span', { className: 'dst-kline-title' }, title || '分时'),
          hovered
            ? h('span', { className: dirClass(hoverPct) },
                `${hovered.time}  ${fmtPrice(hovered.price)}  ${fmtPct(hoverPct)}  均${fmtPrice(hovered.avg)}`)
            : h('span', { className: 'dst-muted' },
                prev ? `昨收 ${fmtPrice(prev)}　${data.days > 1 ? `${data.days}日` : '今日'}` : ''),
          h('span', { className: 'dst-spacer' }),
          data && data.provider ? h('span', { className: 'dst-muted' }, data.provider) : null,
        ),
        h('canvas', {
          ref: canvasRef,
          style: { height: `${height}px` },
          onMouseMove: handleMove,
          onMouseLeave: () => setHover(null),
        }),
        hovered ? null : h('div', { className: 'dst-legend' },
          h('span', null, h('i', { style: { background: 'var(--dst-up)' } }), '价格'),
          h('span', null, h('i', { style: { background: '#e8b339' } }), '均价'),
        ),
        points.length ? null : h('div', { className: 'dst-empty' }, '暂无分时数据'),
      );
    }

    function drawTrend(canvas, data, opts) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { width, height, dpr, hover, stateRef, cost = null, shares = 0 } = opts;
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
      const padT = 14;
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
      // 成本价落在附近（±30% 幅度内）时把区间撑开，好让成本线看得见。
      const costNum = Number(cost) > 0 ? Number(cost) : 0;
      let span = Math.max(hi - prev, prev - lo, prev * 0.002);
      let costClamped = null;
      if (costNum) {
        const d = Math.abs(costNum - prev);
        if (d <= span * 1.3) span = Math.max(span, d * 1.06);
        else costClamped = costNum > prev ? 'above' : 'below';
      }
      const top = prev + span;
      const bot = prev - span;
      const yOf = (v) => padT + ((top - v) / (top - bot)) * priceH;

      // 网格 + 右侧百分比刻度
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'left';
      for (const frac of [1, 0.5, 0, -0.5, -1]) {
        const v = prev + span * frac;
        const y = yOf(v);
        ctx.strokeStyle = frac === 0 ? 'rgba(128,138,152,.42)' : GRID;
        ctx.setLineDash(frac === 0 ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        const pct = (frac * 100).toFixed(2);
        ctx.fillStyle = v > prev ? UP : v < prev ? DOWN : FG;
        ctx.fillText(`${pct}%`, padL + plotW + 4, y + 4);
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
          ctx.fillRect(padL + 4, y - 8, lw, 15);
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'left';
          ctx.fillText(label, padL + 8, y + 4);
          ctx.restore();
        }
      }

      // 成交量
      let maxVol = 0;
      for (const p of points) maxVol = Math.max(maxVol, p.volume || 0);
      const volTop = padT + priceH + gapV;
      const bw = Math.max(0.6, plotW / points.length - 0.6);
      const last = points[points.length - 1].price;
      const line = last >= prev ? UP : DOWN;

      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const x = padL + (plotW * i) / Math.max(1, points.length - 1);
        const hh = maxVol > 0 ? ((p.volume || 0) / maxVol) * (volH - 4) : 0;
        const up = p.price >= prev;
        ctx.fillStyle = up ? UP : DOWN;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x - bw / 2, volTop + (volH - hh), bw, hh);
      }
      ctx.globalAlpha = 1;

      // 价格线 + 面积
      const xOf = (i) => padL + (plotW * i) / Math.max(1, points.length - 1);
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

      // 时间轴
      ctx.fillStyle = FG;
      ctx.textAlign = 'center';
      const step = Math.max(1, Math.floor(points.length / 4));
      for (let i = 0; i < points.length; i += step) {
        ctx.fillText(points[i].time, xOf(i), padT + priceH + 12);
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

      stateRef.current.layout = { padL, plotW, priceH, padT, top, bot };
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

      return h('div', { className: 'dst-book' },
        h('div', { className: 'dst-book-head' },
          h('span', null, '五档盘口'),
          h('span', { className: 'dst-spacer' }),
          h('span', { className: 'dst-muted' },
            `委比 ${book.commissionRatio == null ? '--' : `${(book.commissionRatio * 100).toFixed(2)}%`}`),
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

    function Toasts({ toasts, onDismiss }) {
      if (!toasts || !toasts.length) return null;
      return h('div', { className: 'dst-toasts' },
        toasts.map((a) => {
          const key = `${a.id}:${a.firedAt || 0}`;
          const isPct = a.kind === 'pct';
          const sign = a.op === '>=' ? '↑' : '↓';
          return h('div', { className: 'dst-toast', key },
            h('span', { className: 'dst-toast-icon' }, '🔔'),
            h('span', { className: 'dst-toast-body' },
              h('b', null, a.name || a.symbol),
              h('span', null, ` ${isPct ? '涨跌幅' : '价格'} ${sign} ${a.value}${isPct ? '%' : ''}`),
              h('span', { className: 'dst-muted' }, `　现价 ${fmtPrice(a.current)}`),
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

    function Chip({ pos, selected, onSelect, flash }) {
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

    function QuoteTable({ rows, mode, selected, onSelect, onSave, onRemove, currency }) {
      if (!rows.length) {
        return h('div', { className: 'dst-empty' },
          mode === 'holdings'
            ? '还没有持仓。切到「添加」录入股票代码、股数和成本价。'
            : '自选列表是空的，切到「添加」加几只股票。');
      }
      const sign = CURRENCY_SIGN[currency] || '';
      const cols = mode === 'holdings'
        ? ['名称', '现价', '涨跌幅', '持股', '成本价', '市值', '盈亏', '盈亏%', '当日', '']
        : ['名称', '现价', '涨跌幅', '今开', '最高', '最低', '换手', '量比', ''];

      return h('table', { className: 'dst-table' },
        h('thead', null, h('tr', null,
          cols.map((c, i) => h('th', { key: i }, c)),
        )),
        h('tbody', null, rows.map((p) => h('tr', {
          key: p.symbol,
          className: selected === p.symbol ? 'dst-rowsel' : '',
          onClick: () => onSelect(p.symbol),
        },
          h('td', null,
            h('span', { className: 'dst-name' }, p.name || p.code),
            h('span', { className: 'dst-sub' }, p.code),
            p.index ? h('span', { className: 'dst-sub' }, '指数') : null,
            p.held ? h('span', { className: 'dst-sub' }, '持仓') : null,
          ),
          h('td', { className: dirClass(p.changePct) }, fmtPrice(p.price)),
          (() => {
            const lim = limitState(p);
            return h('td', { className: dirClass(p.changePct) },
              h('span', {
                className: lim ? `dst-cell-limit dst-cell-limit-${lim}` : '',
                title: lim ? LIMIT_TEXT[lim] : null,
              }, fmtPct(p.changePct)),
              lim ? h('span', { className: `dst-limit dst-limit-${lim}`, style: { marginLeft: '4px' } }, LIMIT_TEXT[lim]) : null,
            );
          })(),
          mode === 'holdings' ? [
            h('td', { key: 'sh' }, h(NumCell, {
              value: p.shares, title: '持股数（股）',
              onCommit: (v) => onSave({ symbol: p.symbol, shares: v }),
            })),
            h('td', { key: 'ct' }, h(NumCell, {
              value: p.cost, title: '成本价（元/股）',
              onCommit: (v) => onSave({ symbol: p.symbol, cost: v }),
            })),
            h('td', { key: 'mv' }, p.marketValue != null ? sign + fmtMoney(p.marketValue) : '--'),
            h('td', { key: 'pn', className: dirClass(p.pnl) }, p.pnl != null ? fmtSigned(p.pnl) : '--'),
            h('td', { key: 'pp', className: dirClass(p.pnlPct) }, fmtPct(p.pnlPct)),
            h('td', { key: 'dp', className: dirClass(p.dayPnl) }, p.dayPnl != null ? fmtSigned(p.dayPnl) : '--'),
          ] : [
            h('td', { key: 'o' }, fmtPrice(p.quote && p.quote.open)),
            h('td', { key: 'h' }, fmtPrice(p.quote && p.quote.high)),
            h('td', { key: 'l' }, fmtPrice(p.quote && p.quote.low)),
            h('td', { key: 't' }, p.quote && p.quote.turnover != null ? nf(p.quote.turnover, 2) + '%' : '--'),
            h('td', { key: 'v' }, p.quote && p.quote.volRatio != null ? nf(p.quote.volRatio, 2) : '--'),
          ],
          h('td', null,
            h('button', {
              className: 'dst-btn',
              title: '移出自选',
              onClick: (e) => { e.stopPropagation(); onRemove(p.symbol); },
            }, '✕'),
          ),
        ))),
      );
    }

    /* ============================================================ *
     * 设置
     * ============================================================ */

    function SettingsTab({ settings, patchSettings, state, error, onNudge }) {
      const set = (patch) => patchSettings(patch);
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

        row('状态栏位置',
          h('div', { className: 'dst-row' },
            h('button', { className: 'dst-btn-ghost', onClick: () => onNudge(-24) }, '↑ 上移'),
            h('button', { className: 'dst-btn-ghost', onClick: () => onNudge(24) }, '↓ 下移'),
            h('button', { className: 'dst-btn-ghost', onClick: () => set({ topOffset: 0 }) }, '复位'),
            h('span', { className: 'dst-field' }, `偏移 ${settings.topOffset || 0}px`),
          ),
          '如果行情条压住了窗口标题栏，就往下挪一点'),

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
          h('button', { className: 'dst-btn-ghost', onClick: apply },
            '按流水同步持仓（覆盖股数与成本价）'),
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
          '流水和持仓是两本账：记流水不会自动改持仓，需要时点上面的「按流水同步持仓」。',
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
      );
    }

    /* ============================================================ *
     * 主组件
     * ============================================================ */

    /* ---------------- AI 分析 ----------------
     * 数据包在宿主侧组装（那边拿到的都是现算的数字），这里只负责：选模型、发起、
     * 把 NDJSON 增量拼成正文。模型调用走 DSH 自己的模型服务，插件不碰密钥。
     */

    const AI_INCLUDE = [
      ['aiKline', '日K'],
      ['aiTrend', '分时'],
      ['aiBook', '盘口'],
      ['aiTrades', '流水'],
      ['aiIndex', '大盘'],
    ];

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

    /** 边收边拼的分析状态机。取消时保留已经生成的部分。 */
    function useAnalysis() {
      const empty = {
        phase: 'idle', text: '', reasoning: '', meta: null, usage: null,
        elapsed: 0, error: null, symbol: null, provider: '', model: '', finish: null, code: null,
      };
      const [st, setSt] = useState(empty);
      const ctrlRef = useRef(null);
      const aliveRef = useRef(true);
      useEffect(() => () => {
        aliveRef.current = false;
        if (ctrlRef.current) ctrlRef.current.abort();
      }, []);

      const cancel = useCallback(() => {
        if (ctrlRef.current) ctrlRef.current.abort();
      }, []);

      const run = useCallback(async (body) => {
        if (ctrlRef.current) ctrlRef.current.abort();
        const ctrl = new AbortController();
        ctrlRef.current = ctrl;
        const t0 = Date.now();
        setSt({ ...empty, phase: 'running', symbol: body.symbol, provider: body.provider, model: body.model });
        try {
          await streamAnalyze(body, (evt) => {
            if (!aliveRef.current) return;
            if (evt.type === 'meta') {
              setSt((s) => ({ ...s, meta: evt.meta || null, provider: evt.provider || s.provider, model: evt.model || s.model }));
            } else if (evt.type === 'delta') {
              setSt((s) => ({ ...s, text: s.text + (evt.text || '') }));
            } else if (evt.type === 'reasoning') {
              setSt((s) => ({ ...s, reasoning: s.reasoning + (evt.text || '') }));
            } else if (evt.type === 'done') {
              setSt((s) => ({
                ...s,
                phase: 'done',
                text: typeof evt.text === 'string' && evt.text ? evt.text : s.text,
                usage: evt.usage || null,
                elapsed: evt.elapsedMs || (Date.now() - t0),
                finish: evt.finish || null,
                code: evt.code || null,
                error: evt.error || null,
              }));
            } else if (evt.type === 'error') {
              setSt((s) => ({ ...s, phase: 'error', error: evt.error || '分析失败' }));
            }
          }, ctrl.signal);
          setSt((s) => (s.phase === 'running'
            ? { ...s, phase: s.text ? 'done' : 'error', error: s.text ? null : (s.error || '连接中断') }
            : s));
        } catch (err) {
          if (err && err.name === 'AbortError') {
            // 用户主动取消：保留半截结论并说明，不当作错误
            setSt((s) => ({ ...s, phase: s.text ? 'done' : 'idle', elapsed: Date.now() - t0, cancelled: true }));
            return;
          }
          setSt((s) => ({ ...s, phase: 'error', error: (err && err.message) || String(err) }));
        } finally {
          if (ctrlRef.current === ctrl) ctrlRef.current = null;
        }
      }, []);

      const reset = useCallback(() => setSt(empty), []);
      return { st, run, cancel, reset };
    }

    /** 逐行读 NDJSON 的分析接口 */
    async function streamAnalyze(body, onEvent, signal) {
      const res = await fetch(`${API}/ai/analyze`, {
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
      const [extra, setExtra] = useState('');
      const [copied, setCopied] = useState(false);

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

      const start = () => {
        if (!target) return;
        const include = {};
        for (const [key] of AI_INCLUDE) include[key.replace(/^ai/, '').toLowerCase()] = settings[key] !== false;
        analysis.run({
          symbol: target,
          provider: effProvider,
          model: effModel,
          style,
          extra,
          include: {
            kline: include.kline,
            trend: include.trend,
            book: include.book,
            trades: include.trades,
            indexes: include.index,
          },
        });
      };

      const copy = () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(st.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }
        } catch { /* 剪贴板不可用就算了 */ }
      };

      const usage = st.usage
        ? `输入 ${st.usage.inputTokens || 0} / 输出 ${st.usage.outputTokens || 0} tokens`
        : '';

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
          ...AI_INCLUDE.map(([key, label]) => h('label', { key, className: 'dst-ai-toggle' },
            h('input', {
              type: 'checkbox',
              checked: settings[key] !== false,
              disabled: running,
              onChange: (e) => patchSettings({ [key]: e.target.checked }),
            }),
            label)),
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
              '数据包在宿主侧现算（日K指标、分时、盘口、流水），模型只看到这些数字。')
          : null,

        (st.text || running)
          ? h('div', { className: 'dst-ai-out' },
              h('div', { className: 'dst-ai-meta' },
                st.model ? h('span', { className: 'dst-pill' }, `${st.model}`) : null,
                st.meta && st.meta.chars ? h('span', null, `数据 ${st.meta.chars} 字`) : null,
                st.elapsed ? h('span', null, `${(st.elapsed / 1000).toFixed(1)}s`) : null,
                usage ? h('span', null, usage) : null,
                st.finish && st.finish !== 'stop' ? h('span', { className: 'dst-pill dst-hit' }, st.finish) : null,
                st.cancelled ? h('span', { className: 'dst-pill' }, '已停止（以下是半截结果）') : null,
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
              renderRich(st.text),
              running ? h('span', { className: 'dst-ai-cursor' }) : null,
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
      const { state, error, toasts, dismissToast, load, save, remove, patchSettings,
        saveAlert, removeAlert, ackAlert } = useTicker(tickerActive);
      const [open, setOpen] = useState(false);
      // 面板是否展开：侧边栏版本一直展开，顶栏版本跟着 open 走
      const showPanel = variant === 'sidebar' ? true : open;
      const [tab, setTab] = useState('holdings');
      const [selected, setSelected] = useState(null);
      const [chromeTop, setChromeTop] = useState(0);
      // 折叠胶囊的落点：优先钉进标题栏右侧的空白区（原生窗口按钮左边）
      const [dock, setDock] = useState({ top: 4, right: 10, inCaption: false });
      const [period, setPeriod] = useState('day');
      const [adjust, setAdjust] = useState('pre');
      const [count, setCount] = useState(120);
      const [klineNonce, setKlineNonce] = useState(0);
      const [chart, setChart] = useState('trend');
      const [trendDays, setTrendDays] = useState(1);
      const trackRef = useRef(null);

      // 交易流水（只在打开该标签页时拉取）
      const trades = useTrades(showPanel && (tab === 'trades' || tab === 'alerts'));

      const settings = (state && state.settings) || {
        refreshMs: 5000, topOffset: 0, opacity: 0.96, scroll: true, flash: true,
        showIndex: true, showWatch: true, showHoldings: true, showTotals: true,
        period: 'day', adjust: 'pre', klineCount: 120,
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

          // 折叠胶囊：标题栏那条 40px 里除了左边的菜单和右边的三个窗口按钮，
          // 中间全是空的，钉在这儿谁也挡不着。
          // 窗口按钮的宽度用 Electron 的 Window Controls Overlay 精确量，
          // 量不到就按 Windows 三个按钮约 138px 兜底。
          const DOCK_H = 28;
          const band = winBar ? captionH || 40 : 0;
          if (band >= DOCK_H) {
            let right = 148;
            const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null;
            if (wco && wco.visible && typeof wco.getTitlebarAreaRect === 'function') {
              try {
                const r = wco.getTitlebarAreaRect();
                const controls = (window.innerWidth || 0) - (r.x + r.width);
                if (controls > 0) right = Math.round(controls + 8);
              } catch { /* 量不到就用兜底值 */ }
            }
            setDock({ top: Math.max(2, Math.round((band - DOCK_H) / 2)), right, inCaption: true });
          } else {
            // 没有标题栏可借（比如普通浏览器里打开）：退到右下角。
            // 这一块参考了 dsh-ths-holdings 的做法——右下角在 DSH 布局里是空的，
            // 不会像顶部那样压住工具栏。
            setDock({ top: null, right: 14, inCaption: false });
          }
        };
        measure();
        const id = setInterval(measure, 1500);
        return () => clearInterval(id);
      }, []);

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

      // 组件开关：分时图 / K线图 可以分别关掉；两个都关就整块不渲染
      const showTrend = settings.showTrend !== false;
      const showKline = settings.showKline !== false;
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
                      onNudge: (d) => patchSettings({ topOffset: (Number(settings.topOffset) || 0) + d }),
                    })
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
                      h('div', { className: 'dst-row', style: { margin: '2px 0 6px' } },
                        h('span', { className: 'dst-kline-title' }, selectedPos.name || selectedPos.code),
                        h('span', { className: 'dst-sub' }, selectedPos.code),
                        h('span', { className: dirClass(selectedPos.changePct) },
                          `${fmtPrice(selectedPos.price)} ${fmtPct(selectedPos.changePct)}`),
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
                      ),
                      // 持仓成本摘要：图表上方常驻一行。
                      // 成本线本身在离得太远时会贴边显示，这一行保证数字永远看得到。
                      selectedPos.held && selectedPos.cost > 0
                        ? h('div', { className: 'dst-cost-line' },
                            h('span', { className: 'dst-cost-k' }, '成本'),
                            h('b', { className: 'dst-cost-val' }, fmtPrice(selectedPos.cost)),
                            h('span', { className: 'dst-cost-k' }, `${selectedPos.shares} 股`),
                            h('span', { className: 'dst-cost-k' }, `市值 ${fmtMoney(selectedPos.marketValue)}`),
                            h('span', { className: dirClass(selectedPos.pnl) },
                              `浮动盈亏 ${fmtSigned(selectedPos.pnl)} (${fmtPct(selectedPos.pnlPct)})`),
                          )
                        : null,
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
                                      title: `${selectedPos.name || selectedPos.code} · 分时${Number(trendDays) > 1 ? `（${trendDays}日）` : ''}`,
                                    }))
                              : (klineErr
                                  ? h('div', { className: 'dst-empty dst-err' }, `K线加载失败：${klineErr}`)
                                  : h(KLineChart, {
                                      candles: (kline && kline.candles) || [],
                                      height: 320,
                                      cost: selectedPos.held ? selectedPos.cost : null,
                                      shares: selectedPos.held ? selectedPos.shares : 0,
                                      title: `${selectedPos.name || selectedPos.code} · ${(PERIODS.find((p) => p[0] === period) || [, period])[1]}`,
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
      const collapsed = variant === 'bar' && !!settings.collapsed;

      // 折叠态：只留一个小胶囊，点一下展开
      if (collapsed) {
        // 关键：不再 fixed 在正文顶部，而是钉进标题栏右侧的空白区（见 dock 的测量逻辑），
        // 所以不会压住下面的工具栏按钮
        return h('div', { className: 'dst-root dst-theme', style: { top: 0 } },
          h('div', {
            className: 'dst-dock',
            style: dock.inCaption
              ? { top: `${dock.top}px`, right: `${dock.right}px` }
              : { bottom: '14px', right: '14px' },
            title: dock.inCaption ? '展开行情条（已收进标题栏）' : '展开行情条',
            onClick: () => patchSettings({ collapsed: false }),
          },
            h('span', { className: 'dst-dock-icon' }, '📈'),
            totals && totals.hasPosition
              ? h('span', { className: dirClass(totals.pnl) }, `${fmtSigned(totals.pnl)} ${fmtPct(totals.pnlPct)}`)
              : h('span', { className: 'dst-flat' }, '行情'),
            h('span', { className: 'dst-dock-x' }, '▾'),
          ),
          h(Toasts, { key: 'toasts', toasts: settings.alertToast === false ? [] : toasts, onDismiss: dismissToast }),
        );
      }

      const barChildren = [
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
            onClick: () => patchSettings({ collapsed: true }),
          }, '—'),
        ),
      ];

      const panelTop = topPx + 34;

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
          h(Toasts, { key: 'toasts', toasts: settings.alertToast === false ? [] : toasts, onDismiss: dismissToast }),
        );
      }

      return h('div', { className: 'dst-root dst-theme', style: { top: `${topPx}px`, opacity: settings.opacity } },
        h('div', { className: 'dst-bar' }, barChildren),
        open
          ? h('div', { className: 'dst-panel', style: { top: `${panelTop}px` } },
              h('div', { className: 'dst-tabs' },
                tabs.map(([key, label]) => h('button', {
                  key, className: `dst-tab ${tab === key ? 'dst-on' : ''}`,
                  onClick: () => setTab(key),
                }, label)),
                h('span', { className: 'dst-spacer' }),
                h('span', { className: 'dst-note' },
                  `${strip.length} 只在看　${holdings.length} 只持仓`),
                h('button', { className: 'dst-btn', onClick: () => setOpen(false) }, '收起'),
              ),
              h('div', { className: 'dst-body' }, buildPanelBody()),
            )
          : null,
        h(Toasts, { key: 'toasts', toasts: settings.alertToast === false ? [] : toasts, onDismiss: dismissToast }),
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
