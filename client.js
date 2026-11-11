/**
 * client.js —— 浏览器半端（主区整页 + 设置页里的一页，同一份数据）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是**自注册脚本**：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 *
 * ⭐ 两个入口一起注册，缺一个就进不去：
 *     · `sidebar.panellist`（id `dragonfly`）—— 侧栏那个按钮，没它就**没有入口**
 *     · `main`（keyed `dragonfly`）—— 主区整页，key 必须跟侧栏那个 id 对上
 *     · `settings.section`（id `dragonfly`）—— 设置页里的一页
 *
 * 数据全走 fetch(`/api/dragonfly/*`)，跟宿主半端同一份 config.json / out/<日期>.md。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: '@zhuifengqug/dsh-dragonfly',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const API = '/api/dragonfly'

    /* ⚠️ 必须看 res.ok：直接把 500 的 {ok:false} 当成功，绿色提示会把故障盖掉 */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 403 ? '（被宿主拦了）' : res.status === 404 ? '（宿主还没起这个口子）' : ''
      throw new Error(`HTTP ${res.status}${why}`)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    // ── 样式：只用两种字号（13 正文 / 11 小节标题），分组 + 分隔线，不做卡片墙 ──
    const CSS = `[data-cf-page]{display:flex;flex-direction:column;gap:20px;padding:2px 2px 10px;max-width:640px;
  font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#1f2328);}
[data-cf-page][data-cf-wide]{max-width:900px;}
[data-cf-sec]{display:flex;flex-direction:column;gap:8px;}
[data-cf-sec]+[data-cf-sec]{border-top:1px solid var(--dsw-alias-border-secondary,#e6e8eb);padding-top:16px;}
[data-cf-h]{font-size:11px;font-weight:600;letter-spacing:.04em;
  color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cf-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-cf-grow]{flex:1;min-width:0;}
[data-cf-label]{font-size:13px;}
[data-cf-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cf-status]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;
  border-bottom:1px solid var(--dsw-alias-border-secondary,#e6e8eb);}
[data-cf-tabs]{display:flex;gap:16px;border-bottom:1px solid var(--dsw-alias-border-secondary,#e6e8eb);}
[data-cf-tab]{appearance:none;border:0;background:transparent;padding:8px 0;cursor:pointer;font-size:13px;
  color:var(--dsw-alias-label-tertiary,#8b9199);border-bottom:2px solid transparent;margin-bottom:-1px;}
[data-cf-tab][data-on]{color:var(--dsw-alias-label-primary,#1f2328);
  border-bottom-color:var(--dsw-alias-brand-primary,#4c7dff);font-weight:600;}
[data-cf-btn]{appearance:none;border:1px solid var(--dsw-alias-border-secondary,#d9dde2);
  background:var(--dsw-alias-bg-elevated,#fff);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:13px;
  color:inherit;}
[data-cf-btn]:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4c7dff);}
[data-cf-btn]:disabled{opacity:.5;cursor:default;}
[data-cf-btn][data-primary]{background:var(--dsw-alias-brand-primary,#4c7dff);border-color:transparent;color:#fff;}
[data-cf-input]{border:1px solid var(--dsw-alias-border-secondary,#d9dde2);border-radius:8px;
  padding:5px 9px;font-size:13px;font-family:inherit;background:var(--dsw-alias-bg-elevated,#fff);
  color:inherit;min-width:0;}
[data-cf-num]{width:76px;}
[data-cf-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-border-secondary,#d9dde2);transition:background .15s;}
[data-cf-sw][data-on]{background:var(--dsw-alias-brand-primary,#4c7dff);}
[data-cf-sw]::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:9px;
  background:#fff;transition:transform .15s;}
[data-cf-sw][data-on]::after{transform:translateX(16px);}
[data-cf-entry]{display:flex;flex-direction:column;gap:4px;padding:12px 0;
  border-bottom:1px solid var(--dsw-alias-border-secondary,#eef0f2);}
[data-cf-entry]:last-child{border-bottom:0;}
[data-cf-entry-h]{font-size:13px;font-weight:600;}
[data-cf-tier]{font-size:11px;padding:1px 6px;border-radius:6px;
  background:var(--dsw-alias-bg-secondary,#f2f4f6);color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-tier][data-good]{background:#e6f5ee;color:#1a7f52;}
[data-cf-tier][data-bad]{background:#fdeeee;color:#b2453e;}
[data-cf-body]{font-size:13px;line-height:21px;white-space:pre-wrap;}
[data-cf-empty]{padding:28px 0;text-align:center;font-size:13px;
  color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cf-run]{appearance:none;border:1px solid var(--dsw-alias-border-secondary,#d9dde2);margin:8px 0 6px;
  background:var(--dsw-alias-bg-elevated,#fff);border-radius:8px;padding:5px 14px;cursor:pointer;
  font-size:13px;font-family:inherit;color:inherit;}
[data-cf-run]:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4c7dff);
  color:var(--dsw-alias-brand-primary,#4c7dff);}
[data-cf-run]:disabled{opacity:.5;cursor:default;}
[data-cf-days]{display:flex;gap:8px;flex-wrap:wrap;}
[data-cf-day]{appearance:none;border:0;background:transparent;cursor:pointer;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#8b9199);padding:2px 0;}
[data-cf-day][data-on]{color:var(--dsw-alias-brand-primary,#4c7dff);font-weight:600;}
[data-cf-warn]{font-size:11px;line-height:16px;color:#b2453e;}
[data-cf-fold]{appearance:none;border:0;background:transparent;padding:0;cursor:pointer;
  font-family:inherit;text-align:left;color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cf-fold]:hover{color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-qr]{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:4px 0;}
[data-cf-log]{margin:6px 0 0;padding:8px 10px;max-height:220px;overflow:auto;font-size:11px;line-height:16px;
  background:var(--dsw-alias-bg-secondary,#f2f4f6);border-radius:8px;white-space:pre-wrap;word-break:break-all;
  color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-checks]{margin:6px 0 0;padding:0;list-style:none;font-size:11px;line-height:18px;}
[data-cf-checks] li{display:flex;gap:6px;flex-wrap:wrap;}
[data-cf-checks] li[data-ok="0"]{color:var(--dsw-alias-state-error-primary,#c0392b);}
[data-cf-checks] em{font-style:normal;color:var(--dsw-alias-label-secondary,#5b6068);}

/* ── 外壳：主区页要能自己滚，不能整页顶出去 ───────────────────────────── */
[data-cf-shell]{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;}
[data-cf-head]{flex:none;padding:2px 2px 0;}
[data-cf-head] [data-cf-page]{padding-bottom:0;}
[data-cf-body]{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 2px 18px;}
[data-cf-body] [data-cf-page]{padding-top:0;}
/* 主区那一页（点侧栏「蜻蛉」进来的）要跟顶栏一样铺满：不压宽度、左右留 16px。
   「设置」页不在此列 —— 它是表单，仍旧压到 640 的窄栏，拉满全宽反而难读。 */
[data-cf-main] [data-cf-page]{padding-left:16px;padding-right:16px;}
[data-cf-main] [data-cf-page][data-cf-wide]{max-width:none;}
/* 会话顶部那一块要铺满，跟「轨迹」那个上游视图一样：占满 viewArea、自己滚。
   难点在宿主这层 —— 那个 viewArea 在 data-phase=active 时是
   flex:1 0 auto + min-height:auto，也就是「高度跟着内容长」，子元素写
   height:100% 等于循环依赖，撑不起来（试过，整列算成 3611px，滚条跑到
   宿主的列表滚动层上）。
   所以反过来改父级：用结构选择器（不认宿主那几个哈希类名，升级换了哈希
   也还命中）把 viewArea 改成 flex:1 1 0 + min-height:0，让它吃满
   scrollBody，再让外壳在里头 flex:1 铺满。 */
[data-slot="conversation.session"] > div:has(> [data-slot="conversation.view"] > [data-cf-conv]){
  flex:1 1 0;min-height:0;overflow:hidden;}
[data-cf-conv]{flex:1 1 0;min-height:0;height:auto;max-height:none;
  display:flex;flex-direction:column;
  border-top:1px solid var(--dsw-alias-border-secondary,#eceff3);}
[data-cf-conv] [data-cf-body]{flex:1;min-height:0;overflow-y:auto;padding-bottom:4px;}
/* 会话区本来就有一千多像素，别再按主区那个 900 压窄 */
[data-cf-conv] [data-cf-page]{max-width:none;padding:0 16px 2px;}

/* ── 筛选：先信源，再档位，最后日期 ───────────────────────────────────── */
/* 档位 chip 和日期条都挤在今天页顶部那一行里，会话顶部本来就矮 */
[data-cf-spacer]{flex:1;min-width:0;}
[data-cf-day]{flex:none;font-size:11px;line-height:18px;padding:2px 4px;border-radius:6px;min-width:0;
  border:1px solid var(--dsw-alias-border-secondary,#d9dde2);background:transparent;
  color:var(--dsw-alias-label-secondary,#5b6068);font-family:inherit;cursor:pointer;}
/* 会话顶部那一块矮，chip 得钉住，不然翻两条就滚没了 */
[data-cf-conv] [data-cf-sticky]{position:sticky;top:0;z-index:2;
  background:var(--dsw-alias-bg-elevated,#fff);padding:6px 0 4px;}
[data-cf-chips]{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
[data-cf-chip]{appearance:none;border:1px solid var(--dsw-alias-border-secondary,#d9dde2);background:transparent;
  border-radius:999px;padding:2px 10px;cursor:pointer;font-size:11px;line-height:18px;font-family:inherit;
  color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-chip]:hover{border-color:var(--dsw-alias-brand-primary,#4c7dff);}
[data-cf-chip][data-on]{background:var(--dsw-alias-brand-primary,#4c7dff);border-color:transparent;color:#fff;}
[data-cf-chip-gap]{width:8px;}
/* 档位那一排：跟信源那排长得不一样，一眼能看出是两种筛子 */
[data-cf-tier-chip]{border-style:dashed;}
[data-cf-tier-chip][data-tier="值得看"][data-on]{background:#1a7f52;border-color:transparent;}
[data-cf-tier-chip][data-tier="可以看"][data-on]{background:#8a6100;border-color:transparent;}
[data-cf-tier-chip][data-tier="不值当"][data-on]{background:#b2453e;border-color:transparent;}

/* ── 条目：封面 + 标题 + 档位 + 为什么值得 + 引文 ───────────────────────── */
[data-cf-entry]{display:grid;grid-template-columns:112px 1fr;gap:12px;padding:14px 0;
  border-bottom:1px solid var(--dsw-alias-border-secondary,#eef0f2);}
[data-cf-entry][data-cf-flat]{grid-template-columns:1fr;}
[data-cf-cover]{width:112px;height:63px;border-radius:6px;object-fit:cover;display:block;
  background:var(--dsw-alias-bg-secondary,#f2f4f6);}
[data-cf-cover-link]{display:block;line-height:0;}
[data-cf-cover-ph]{width:112px;height:63px;border-radius:6px;
  background:var(--dsw-alias-bg-secondary,#f2f4f6);}
[data-cf-entry-main]{min-width:0;display:flex;flex-direction:column;gap:5px;}
[data-cf-entry-h]{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;}
[data-cf-title]{font-size:14px;line-height:20px;font-weight:600;color:inherit;text-decoration:none;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
a[data-cf-title]:hover{color:var(--dsw-alias-brand-primary,#4c7dff);}
[data-cf-tier]{flex:none;font-size:11px;line-height:18px;padding:0 6px;border-radius:5px;
  background:var(--dsw-alias-bg-secondary,#f2f4f6);color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-tier][data-good]{background:#e6f5ee;color:#1a7f52;}
[data-cf-tier][data-bad]{background:#fdeeee;color:#b2453e;}
[data-cf-why]{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-quote]{margin:2px 0 0;padding-left:9px;border-left:2px solid var(--dsw-alias-brand-primary,#4c7dff);
  font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-meta]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cf-line]{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#5b6068);
  padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-secondary,#f2f4f6);}
[data-cf-line]:last-child{border-bottom:0;}

/* ── 今天页：分节标题与「扫过没收的」清单 ─────────────────────────────────
   长清单默认折起来，标题右侧带条数；每行 id 单独一列等宽字体，
   理由最多三行，点一下展开 —— 一行一行读，不再是一堵墙。 */
[data-cf-sec]{margin:20px 0 0;}
[data-cf-sec]:first-child{margin-top:14px;}
[data-cf-sec-h]{display:flex;align-items:center;gap:7px;margin:0 0 3px;padding:2px 0;
  font-size:11px;font-weight:600;letter-spacing:.04em;list-style:none;
  color:var(--dsw-alias-label-tertiary,#8b9199);cursor:pointer;}
[data-cf-sec-h]::-webkit-details-marker{display:none;}
[data-cf-sec-h]::marker{content:'';}
[data-cf-sec-h]::before{content:'';flex:none;width:0;height:0;
  border-left:5px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;
  opacity:.55;transition:transform .12s;}
details[data-cf-sec][open] > [data-cf-sec-h]::before{transform:rotate(90deg);}
[data-cf-sec-h][data-cf-plain]{cursor:default;}
[data-cf-sec-h][data-cf-plain]::before{display:none;}
[data-cf-sec-n]{font-weight:500;opacity:.7;}
[data-cf-skip]{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1px 9px;
  padding:7px 0 7px 12px;border-bottom:1px solid var(--dsw-alias-border-secondary,#f2f4f6);cursor:pointer;}
[data-cf-skip]:last-child{border-bottom:0;}
[data-cf-skip]:hover{background:var(--dsw-alias-bg-secondary,#f7f8f9);}
[data-cf-skip-id]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);white-space:nowrap;}
[data-cf-skip-t]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5b6068);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
[data-cf-skip].is-open [data-cf-skip-t]{-webkit-line-clamp:99;display:block;}
[data-cf-sum]{margin:2px 0 0;font-size:13px;line-height:22px;
  color:var(--dsw-alias-label-primary,#2b3038);white-space:pre-wrap;}

/* ── 今天页：正上方日期条 + 左侧栏目（可收起） + 右侧内容 ───────────────── */
[data-cf-page][data-cf-today]{display:flex;flex-direction:column;gap:6px;max-width:none;}
[data-cf-topbar]{display:flex;align-items:center;gap:8px;padding:2px 0 5px;
  border-bottom:1px solid var(--dsw-alias-border-secondary,#f2f4f6);}
[data-cf-grow-l],[data-cf-grow-r]{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:6px;}
[data-cf-grow-r]{justify-content:flex-end;}
[data-cf-fold-btn]{appearance:none;flex:none;width:22px;height:22px;padding:0;line-height:1;
  border:1px solid var(--dsw-alias-border-secondary,#d9dde2);border-radius:6px;background:transparent;
  cursor:pointer;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-fold-btn]:hover{border-color:var(--dsw-alias-brand-primary,#4c7dff);}
[data-cf-datebar]{display:flex;align-items:center;gap:2px;flex:none;}
[data-cf-step]{appearance:none;border:0;background:transparent;cursor:pointer;padding:0 3px;
  font-size:13px;line-height:20px;font-family:inherit;
  color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-step]:hover{color:var(--dsw-alias-brand-primary,#4c7dff);}
[data-cf-step]:disabled{opacity:.22;cursor:default;color:inherit;}
[data-cf-split]{display:flex;flex-direction:row;align-items:flex-start;gap:16px;min-height:0;}
/* 今天页的栏目列比设置页窄：设置页写的是长文案，这边只有两个字的栏目名 */
[data-cf-nav][data-cf-todaynav]{flex:0 0 104px;width:104px;top:0;}
[data-cf-nav][data-cf-todaynav] button{justify-content:space-between;padding:6px 9px;font-size:13px;}
[data-cf-nav-n]{flex:none;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-cf-nav][data-cf-todaynav] button[data-on] [data-cf-nav-n]{color:inherit;font-weight:600;}
[data-cf-split] > [data-cf-pane]{padding-left:16px;gap:0;}
[data-cf-split] > [data-cf-pane]:first-child{border-left:0;padding-left:0;}

/* ── 设置页：左侧分组导航 + 右侧表单 ─────────────────────────────────────
   以后往里加一组，只加一条 nav 项和一个面板，不用再动版式。 */
[data-cf-page][data-cf-set]{display:flex;flex-direction:row;align-items:flex-start;gap:26px;
  max-width:960px;padding:6px 2px 8px;}
[data-cf-nav]{position:sticky;top:4px;flex:0 0 148px;width:148px;display:flex;flex-direction:column;gap:1px;}
[data-cf-nav] button{appearance:none;border:0;background:transparent;text-align:left;cursor:pointer;
  font-family:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#5b6068);
  padding:7px 10px;border-radius:8px;display:flex;align-items:center;gap:7px;width:100%;}
[data-cf-nav] button:hover{background:var(--dsw-alias-bg-secondary,#f2f4f6);}
[data-cf-nav] button[data-on]{background:var(--dsw-alias-bg-secondary,#f2f4f6);
  color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;}
[data-cf-nav] button i{flex:none;width:5px;height:5px;border-radius:3px;
  background:var(--dsw-alias-brand-primary,#4c7dff);opacity:0;}
[data-cf-nav] button[data-dirty] i{opacity:1;}
[data-cf-pane]{flex:1;min-width:0;display:flex;flex-direction:column;gap:14px;
  padding-left:26px;border-left:1px solid var(--dsw-alias-border-secondary,#e6e8eb);}
[data-cf-pane-h]{font-size:14px;font-weight:600;line-height:20px;}
[data-cf-pane-d]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b9199);margin-top:2px;}
[data-cf-cards]{display:grid;grid-template-columns:repeat(auto-fit,minmax(192px,1fr));gap:10px;}
[data-cf-card]{border:1px solid var(--dsw-alias-border-secondary,#e6e8eb);border-radius:10px;
  padding:11px 12px;display:flex;flex-direction:column;gap:9px;min-width:0;
  background:var(--dsw-alias-bg-elevated,#fff);}
[data-cf-card][data-off]{background:var(--dsw-alias-bg-secondary,#f7f8f9);}
[data-cf-card][data-off] [data-cf-card-k]{opacity:.55;}
[data-cf-card-h]{display:flex;align-items:center;gap:8px;}
[data-cf-card-h] b{font-size:13px;font-weight:600;flex:1;min-width:0;}
[data-cf-card-k]{display:flex;flex-direction:column;gap:7px;}
[data-cf-save]{position:sticky;bottom:-6px;z-index:2;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:11px 0 9px;background:linear-gradient(to top,var(--dsw-alias-bg-elevated,#fff) 70%,transparent);}
`

    const StyleTag = () => h('style', { 'data-cf-style': '' }, CSS)

    // ── 小部件 ────────────────────────────────────────────────────────────────
    const Row = ({ children }) => h('div', { 'data-cf-row': '' }, children)
    const Sec = ({ title, children }) => h('section', { 'data-cf-sec': '' },
      title ? h('div', { 'data-cf-h': '' }, title) : null, children)
    const Note = ({ children }) => h('div', { 'data-cf-note': '' }, children)

    const Switch = ({ on, onChange, disabled }) => h('button', {
      type: 'button', 'data-cf-sw': '', 'data-on': on ? '' : undefined,
      'aria-pressed': on ? 'true' : 'false', disabled: Boolean(disabled),
      onClick: () => onChange?.(!on),
    })

    const Num = ({ value, onChange, min, max, step }) => h('input', {
      'data-cf-input': '', 'data-cf-num': '', type: 'number',
      value: value ?? 0, min, max, step,
      onChange: (e) => onChange?.(Number(e.target.value)),
    })

    const Btn = ({ children, onClick, primary, disabled }) => h('button', {
      type: 'button', 'data-cf-btn': '', 'data-primary': primary ? '' : undefined,
      disabled: Boolean(disabled), onClick,
    }, children)

    // ── 状态行 ────────────────────────────────────────────────────────────────
    function StatusBar({ status, onRun, busy }) {
      const s = status || {}
      return h('div', { 'data-cf-status': '' },
        h('div', { 'data-cf-grow': '' }, s.line || '正在看今天的情况…'),
        h(Btn, { onClick: onRun, primary: true, disabled: busy || s.running }, busy || s.running ? '正在跑…' : '现在就跑'),
      )
    }

    // ── 封面 ──────────────────────────────────────────────────────────────────
    //
    // 服务端第一次要现去 B站 取图（几百毫秒到几秒）。慢的时候 `<img>` 会一直挂着不动，
    // 而「挂着」既不触发 `load` 也不触发 `error`，界面上就是一块空白。
    // 所以给它留一条退路：8 秒还没 `complete`，就带个 `r` 参数再要一次 ——
    // 那时文件已经落在服务端缓存里，秒回。两次都不行才把位置让出来。
    function Cover({ bvid, href }) {
      const ref = useRef(null)
      const [attempt, setAttempt] = useState(0)
      const [dead, setDead] = useState(false)

      useEffect(() => {
        if (dead || attempt > 1) return undefined
        const t = setTimeout(() => {
          if (ref.current && !ref.current.complete) setAttempt((n) => n + 1)
        }, 8000)
        return () => clearTimeout(t)
      }, [attempt, dead])

      // 真拿不到就摆一个同尺寸的灰块：留白看着像加载失败，灰块看着像「这条没封面」
      if (dead) return h('div', { 'data-cf-cover-ph': '' })
      const src = `${API}/cover?bvid=${encodeURIComponent(bvid)}` + (attempt ? `&r=${attempt}` : '')
      return h('a', {
        'data-cf-cover-link': '', href: href || '#', target: '_blank', rel: 'noreferrer',
        title: '在 B站 打开',
      }, h('img', {
        ref,
        'data-cf-cover': '', src, alt: '', loading: 'lazy',
        onError: () => {
          if (attempt < 2) setAttempt((n) => n + 1)
          else setDead(true)
        },
      }))
    }

    // ── 「今天」页（主区与设置页共用，设置页里是精简版） ──────────────────────
    //
    // 这一页的两次选择是分开的、有顺序的：**先挑信源，再挑日期**。
    // 信源不选就是「全部」——那是最常看的一种，所以放第一个。
    function TodayPanel({ compact, wide, onRun, busy }) {
      const [day, setDay] = useState('')
      const [days, setDays] = useState([])
      const [data, setData] = useState(null)
      const [tab, setTab] = useState('all')        // 总览 / B站 / 抖音 / AI 圈 / 报告
      const [navOpen, setNavOpen] = useState(true) // 左侧栏目列可以收进去
      const [tier, setTier] = useState('all')
      const [err, setErr] = useState('')

      const load = useCallback(async (d) => {
        try {
          const [rep, ds] = await Promise.all([
            jget(`/report${d ? `?day=${encodeURIComponent(d)}` : ''}`),
            jget('/days'),
          ])
          setData(rep)
          setDays(ds.days || [])
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }, [])

      useEffect(() => { load(day) }, [day, load])

      if (err) return h('div', { 'data-cf-page': '' }, h(StyleTag, null),
        h('div', { 'data-cf-warn': '' }, `读日报出错：${err}`))

      const view = data?.view
      const sections = view?.sections || []
      // 左侧栏目：总览里既有三个信源，也有报告旁注（扫过没收的 / 总结 / 评论复核）
      const src = tab
      const picks = sections.find((s) => s.key === 'picks')?.entries || []
      const shown = (e) => (src === 'all' || e.source === src)
        && (tier === 'all' || e.tier === tier)
      const picked = picks.filter(shown)
      const rest = sections.filter((s) => s.key !== 'picks' && s.key !== 'aihot')
      // AIHOT 是转述来的，不在「今天挑的」里，单独一块、单独数
      const aihotEntries = (sections.find((s) => s.key === 'aihot')?.entries || [])
        .filter((e) => e.source === 'aihot')

      const SRC_LABEL = { bili: 'B站', douyin: '抖音', aihot: 'AIHOT' }
      const countOf = (key) => (key === 'aihot'
        ? aihotEntries.length
        : picks.filter((e) => key === 'all' || e.source === key).length)

      // 档位筛子只列这一天真正出现过的档位 —— 没出现过的摆上去只会让人白点一下
      const tierKeys = ['值得看', '可以看', '不值当']
        .filter((t) => picks.some((e) => e.tier === t))
      const tierCount = (t) => picks.filter((e) => t === 'all' || e.tier === t).length

      // 空态自带一个「现在就跑」：新装的人第一眼看到的就是这里，
      // 让他在原地就能开始，别逼他先去找上面那条状态带。
      const runBtn = (text) => (onRun
        ? h('button', {
          type: 'button', 'data-cf-run': '', disabled: busy ? '' : undefined,
          onClick: onRun,
        }, busy ? '跑着呢…' : text)
        : null)

      // 档位 chip 单独一套：它跟信源是两个正交的筛子，选中态各看各的
      const tierChip = (key, label, n) => h('button', {
        key, type: 'button', 'data-cf-chip': '', 'data-cf-tier-chip': '',
        'data-on': tier === key ? '' : undefined,
        'data-tier': key,
        onClick: () => setTier(key),
      }, n ? `${label} ${n}` : label)

      const tiers = (t) => ({
        'data-cf-tier': '',
        'data-good': t === '值得看' ? '' : undefined,
        'data-bad': t === '不值当' ? '' : undefined,
      })

      const entryCard = (e) => h('div', {
        key: e.id || e.title,
        'data-cf-entry': '',
        'data-cf-flat': e.source === 'bili' ? undefined : '',
      },
      e.source === 'bili' && e.id
        ? h(Cover, { key: 'cover', bvid: e.id, href: e.url })
        : null,
      h('div', { 'data-cf-entry-main': '' },
        h('div', { 'data-cf-entry-h': '' },
          e.url
            ? h('a', { 'data-cf-title': '', href: e.url, target: '_blank', rel: 'noreferrer' }, e.title)
            : h('div', { 'data-cf-title': '' }, e.title),
          e.tier ? h('span', tiers(e.tier), e.tier) : null),
        e.why ? h('p', { 'data-cf-why': '' }, e.why) : null,
        e.quote ? h('div', { 'data-cf-quote': '' }, e.quote) : null,
        h('div', { 'data-cf-meta': '' }, `${SRC_LABEL[e.source] || e.source} · ${e.id || '没有 id'}`)))

      // 「扫过没收的」「评论复核」这类一行一条：id 单独一列，理由最多三行，点开看全
      const skipRow = (raw, key) => {
        const t = String(raw || '').replace(/\\\*/g, '*').replace(/^\s*[-–—·]\s*/, '')
        const m = /^\[(B站|抖音|AIHOT)\]\s*([^\s:：]+)\s*[:：]\s*([\s\S]*)$/.exec(t)
        const tag = m ? `${m[1]} ${m[2]}` : ''
        const text = m ? m[3] : t
        return h('div', {
          key,
          'data-cf-skip': '',
          title: '点一下展开／收起',
          onClick: (ev) => ev.currentTarget.classList.toggle('is-open'),
        },
        h('div', { 'data-cf-skip-id': '' }, tag || '·'),
        h('div', { 'data-cf-skip-t': '' }, text))
      }

      // 一节一块：长清单默认折起来、标题右边给条数；「总结」直接摊开当正文，不当清单
      const secBlock = (s) => {
        const title = s.title || ''
        const keep = (s.entries || []).filter(shown)
        const matchSrc = (l) => (src === 'all' ? true
          : src === 'bili' ? !/\[(抖音|AIHOT)\]/.test(l)
            : src === 'douyin' ? /\[抖音\]/.test(l) : /\[AIHOT\]/.test(l))
        const lines = (s.lines || []).filter(matchSrc)
        if (!keep.length && !lines.length) return null
        const n = keep.length + lines.length
        const head = (plain) => h(plain ? 'div' : 'summary', {
          'data-cf-sec-h': '', 'data-cf-plain': plain ? '' : undefined,
        }, title, h('span', { 'data-cf-sec-n': '' }, n))

        if (/总结/.test(title)) {
          return h('div', { key: s.key || title, 'data-cf-sec': '' }, head(true),
            h('p', { 'data-cf-sum': '' },
              lines.map((l) => l.replace(/^\s*[-–—·]\s*/, '')).join('\n')))
        }

        const body = [
          ...keep.map((e) => skipRow(`${e.title}${e.tier ? ` —— ${e.tier}` : ''}`, e.id || e.title)),
          ...lines.map((l, i) => skipRow(l, `${s.key || title}-${i}`)),
        ]
        if (!/扫过没收|评论复核|跳过|私信/.test(title)) {
          return h('div', { key: s.key || title, 'data-cf-sec': '' }, head(true), ...body)
        }
        return h('details', {
          key: s.key || title,
          'data-cf-sec': '',
          open: /扫过没收|评论复核/.test(title) ? undefined : '',
        }, head(false), ...body)
      }

      const navItems = [
        { key: 'all', label: '总览', n: countOf('all') + aihotEntries.length },
        { key: 'bili', label: 'B站', n: countOf('bili') },
        { key: 'douyin', label: '抖音', n: countOf('douyin') },
        { key: 'aihot', label: 'AI 圈', n: countOf('aihot') },
      ]

      // 总览里按信源分组：每组一个小标题带条数，先一眼看全，再进单栏细看
      const groupCard = (key, list) => (list.length
        ? h('div', { key, 'data-cf-sec': '' },
          h('div', { 'data-cf-sec-h': '', 'data-cf-plain': '' },
            SRC_LABEL[key] || key, h('span', { 'data-cf-sec-n': '' }, list.length)),
          ...list.map(entryCard))
        : null)

      const pane = () => {
        if (tab === 'aihot') {
          return aihotEntries.length
            ? h('div', null, ...aihotEntries.map(entryCard))
            : h('div', { 'data-cf-empty': '' }, '这一天 AI 圈没取到东西。')
        }
        if (tab === 'bili' || tab === 'douyin') {
          const list = picked.filter((e) => e.source === tab)
          return list.length
            ? h('div', null, ...list.map(entryCard))
            : h('div', { 'data-cf-empty': '' }, `这一天没从${SRC_LABEL[tab]}收。`)
        }
        const bili = picked.filter((e) => e.source === 'bili')
        const dy = picked.filter((e) => e.source === 'douyin')
        const notes = rest.map(secBlock)
        if (!bili.length && !dy.length && !aihotEntries.length && !notes.some(Boolean)) {
          return h('div', { 'data-cf-empty': '' }, '这一天一条都没收。')
        }
        // 总览 = 三个信源分组 + 后面的旁注（扫过没收的、总结、评论复核）
        return h('div', null,
          groupCard('bili', bili),
          groupCard('douyin', dy),
          groupCard('aihot', aihotEntries),
          ...notes)
      }

      // 日期条：正上方居中，左右能翻；最左边的按钮把栏目列收进去
      const curDay = day || data?.day || days[0] || ''
      const dayIdx = days.indexOf(curDay)
      const step = (delta) => {
        const j = dayIdx + delta
        if (dayIdx < 0 || j < 0 || j >= days.length) return
        setDay(days[j])
      }

      return h('div', {
        'data-cf-page': '', 'data-cf-today': '',
        'data-cf-wide': compact && !wide ? undefined : '',
      },
      h(StyleTag, null),

      h('div', { 'data-cf-topbar': '' },
        h('div', { 'data-cf-grow-l': '' },
          h('button', {
            type: 'button', 'data-cf-fold-btn': '', 'data-on': navOpen ? '' : undefined,
            title: navOpen ? '收起栏目' : '展开栏目',
            onClick: () => setNavOpen((v) => !v),
          }, navOpen ? '‹' : '≡')),
        h('div', { 'data-cf-datebar': '' },
          h('button', {
            type: 'button', 'data-cf-step': '',
            disabled: dayIdx <= 0 ? '' : undefined,
            title: '前一天', onClick: () => step(1),
          }, '‹'),
          h('select', {
            'data-cf-day': '', title: '换一天看',
            value: curDay,
            onChange: (e) => setDay(e.target.value),
          }, days.map((d) => h('option', { key: d, value: d }, d))),
          h('button', {
            type: 'button', 'data-cf-step': '',
            disabled: dayIdx < 0 || dayIdx >= days.length - 1 ? '' : undefined,
            title: '后一天', onClick: () => step(-1),
          }, '›')),
        h('div', { 'data-cf-grow-r': '' },
          tierKeys.length > 1
            ? h('div', { 'data-cf-chips': '' },
              tierChip('all', '全档', 0),
              tierKeys.map((t) => tierChip(t, t, tierCount(t))))
            : null)),

      h('div', { 'data-cf-split': '' },
        navOpen
          ? h('nav', { 'data-cf-nav': '', 'data-cf-todaynav': '' },
            navItems.map((it) => h('button', {
              key: it.key, type: 'button',
              'data-on': tab === it.key ? '' : undefined,
              onClick: () => setTab(it.key),
            }, it.label, h('span', { 'data-cf-nav-n': '' }, it.n))))
          : null,
        h('div', { 'data-cf-pane': '' },
          !data ? h('div', { 'data-cf-empty': '' }, '正在读…')
            : !data.exists ? h('div', { 'data-cf-empty': '' },
              h('div', null, '还没采过。'),
              runBtn('现在就跑'),
              h('div', { 'data-cf-note': '' }, '到点会自动跑一轮，也可以现在点一下。'))
              : pane())),
      )
    }

    // ── 「设置」页签 ──────────────────────────────────────────────────────────
    function SettingsPanel({ status, onSaved }) {
      const [cfg, setCfg] = useState(null)
      const [labels, setLabels] = useState({})
      const [dirty, setDirty] = useState({})
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')

      const [models, setModels] = useState(null)
      const [py, setPy] = useState(null)
      const [login, setLogin] = useState(null)     // {key, qr, state}
      const [diag, setDiag] = useState(null)
      const [tabKey, setTabKey] = useState('sources')   // 设置页左侧分组导航当前选中项
      const [busy, setBusy] = useState('')
      // 关键词框的本地草稿：输入时原样保留（否则每打一个逗号就被 split→join 吃掉），失焦再收回规范写法
      const [kwText, setKwText] = useState(null)

      useEffect(() => {
        jget('/config').then((r) => { setCfg(r.config || {}); setLabels(r.labels || {}) })
          .catch((e) => setErr(String(e.message || e)))
      }, [])

      // 模型候选与 Python 状态：进设置页就顺手读一次，读不到不算错
      useEffect(() => {
        jget('/models').then(setModels).catch(() => setModels({ ok: false }))
        jget('/python').then(setPy).catch(() => setPy(null))
      }, [])

      // 二维码要一直问，直到扫上或者过期
      useEffect(() => {
        if (!login?.key || login.state === 'ok' || login.state === 'expired') return undefined
        const t = setInterval(async () => {
          try {
            const r = await jpost('/login/poll', { key: login.key })
            setLogin((cur) => (cur?.key === login.key ? { ...cur, state: r.state } : cur))
            if (r.state === 'ok') onSaved?.()
          } catch { /* 一次失败不要紧，下一轮再问 */ }
        }, 2000)
        return () => clearInterval(t)
      }, [login?.key, login?.state, onSaved])

      if (err) return h('div', { 'data-cf-page': '' }, h(StyleTag, null),
        h('div', { 'data-cf-warn': '' }, `读配置出错：${err}`))
      if (!cfg) return h('div', { 'data-cf-page': '' }, h(StyleTag, null),
        h('div', { 'data-cf-empty': '' }, '正在读配置…'))

      const set = (k, v) => { setDirty((d) => ({ ...d, [k]: v })); setMsg('') }
      const val = (k) => (k in dirty ? dirty[k] : cfg[k])

      const save = async () => {
        if (!Object.keys(dirty).length) return setMsg('没什么要改的。')
        try {
          const r = await jpost('/config', { patch: dirty })
          if (!r.ok) { setErr(r.text || '没存上'); return }
          setCfg(r.config || cfg)
          setDirty({})
          setMsg('存好了。')
          onSaved?.(r.config)
        } catch (e) { setErr(String(e.message || e)) }
      }

      // ── 运行环境里的几个动作 ────────────────────────────────────────────
      const installPython = async () => {
        setBusy('python'); setMsg('')
        try {
          const r = await jpost('/python')
          setMsg(r.text || '开始装了。')
        } catch (e) { setMsg(`没装成：${e.message || e}`) }
        finally { setBusy('') }
      }

      const startLogin = async () => {
        setBusy('login'); setMsg('')
        try {
          const r = await jpost('/login/start')
          setLogin({ key: r.key, qr: r.qr, state: 'waiting' })
        } catch (e) { setMsg(`出码失败：${e.message || e}`) }
        finally { setBusy('') }
      }

      const runDiagnose = async () => {
        setBusy('diag')
        try { setDiag(await jget('/diagnose')) } catch (e) { setDiag({ ok: false, verdict: String(e.message || e) }) }
        finally { setBusy('') }
      }

      /**
       * 重置抖音登录态：会真把那个专用 Edge 关掉、把 profile 目录改名留底。
       * 这是个不可逆动作（登录态没了要重新扫码），所以先问一句。
       */
      const resetDy = async () => {
        const ask = typeof window?.confirm === 'function'
        if (ask && !window.confirm('重置会把抖音的登录态清掉（旧的 profile 改名留着），下次跑要重新扫码。确定？')) return
        setBusy('dyreset'); setMsg('')
        try {
          const r = await jpost('/dy-reset')
          setMsg(r.text || '重置好了。')
        } catch (e) { setMsg(`没重置成：${e.message || e}`) }
        finally { setBusy('') }
      }

      const importOld = async () => {
        setBusy('import')
        try {
          const r = await jpost('/import')
          setMsg(r.text || (r.state === 'imported' ? '导入好了。' : '没有可导入的东西。'))
          if (r.state === 'imported') onSaved?.()
        } catch (e) { setMsg(`导入失败：${e.message || e}`) }
        finally { setBusy('') }
      }

      /**
       * 切到 auto 要单独确认一次。
       * 这是唯一一处「选下去就会真的对外说话」的开关，跟 read/draft 不是一个量级：
       * 前者只写在本地，后者会把话发到别人那里，发出去收不回来。
       * 用 window.confirm —— 桌面版和浏览器都有，不必自己搭一个对话框。
       */
      const setDmMode = (v) => {
        if (v === 'auto' && val('dmMode') !== 'auto') {
          const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm('auto 会让它真的替你回私信——发出去就收不回来了。确定要开吗？')
            : false
          if (!ok) return
        }
        set('dmMode', v)
      }

      const modelValue = `${val('model')?.provider || ''}\u0000${val('model')?.model || ''}`
      const modelOptions = (models?.providers || []).flatMap((p) =>
        (p.models || []).map((m) => ({ value: `${p.id}\u0000${m.id}`, label: `${p.id} / ${m.id}` })))

      const runtime = status?.runtime || {}
      const pyOk = Boolean(py?.venv && py?.python)
      const logined = Boolean(runtime.biliLoggedIn)

      // ── 分组：左侧导航一项 = 一个面板 ────────────────────────────────────
      // 这份清单本身就是「使用者能发现什么」：想知道蜻蛉能干什么，看左边那六个词。
      // 以后要加功能，就在这儿加一条 + 下面加一个面板，版式不用动。
      const groups = [
        { key: 'sources', label: '采什么', title: '采什么', desc: '从哪儿采，每个源每天各收几条。关掉的那个源，那一轮就不去。',
          keys: ['sources', 'biliPerDay', 'douyinPerDay', 'aihotPerDay', 'aihotMode', 'dyDailyMinutes', 'favoritesEnabled'] },
        { key: 'pick', label: '怎么挑', title: '怎么挑', desc: '自动跑几轮、手动跑一次收几条、认哪些词、日报写多细。',
          keys: ['autoRuns', 'manualPerRound', 'manualCooldownMin', 'keywords', 'fetchPerRound', 'reportLevel'] },
        { key: 'output', label: '写到哪', title: '写到哪', desc: '日报、单片笔记、值班轮的工作目录。',
          keys: ['outputDir', 'workspaceDir', 'notesEnabled'] },
        { key: 'interact', label: '互动', title: '互动', desc: '要不要在 B站 上说话 —— 评论和私信。',
          keys: ['autoComment', 'commentLength', 'dmEnabled', 'dmMode', 'mentionName'] },
        { key: 'runtime', label: '运行环境', title: '运行环境', desc: '用哪个模型、Python 装没装、哪儿不对。',
          keys: ['model'] },
        { key: 'display', label: '显示', title: '显示', desc: '入口挂不挂。只影响界面，不影响跑不跑。',
          keys: ['showSidebar', 'showConversation'] },
      ]
      const current = groups.find((g) => g.key === tabKey) || groups[0]
      const dirtyIn = (keys) => keys.some((k) => k in dirty)

      // ① 采什么：三个源各一张卡，卡头是开关，卡里是它自己的东西
      const sourceCards = [
        h('div', { key: 'bili', 'data-cf-card': '', 'data-off': val('sources')?.bili ? undefined : '' },
          h('div', { 'data-cf-card-h': '' },
            h('b', null, 'B站'),
            h(Switch, {
              on: Boolean(val('sources')?.bili),
              onChange: (v) => set('sources', { ...val('sources'), bili: v }),
            })),
          h('div', { 'data-cf-card-k': '' },
            h('div', { 'data-cf-note': '' },
              logined ? `已登录 · UID ${runtime.biliUid || '?'}` : '还没登录（扫一次码就行）'),
            h('div', { 'data-cf-row': '' },
              h('span', { 'data-cf-label': '', 'data-cf-grow': '', style: { fontSize: '12px' } }, '每天最多收'),
              h(Num, { value: val('biliPerDay'), min: 0, max: 30, onChange: (v) => set('biliPerDay', v) }),
              h('span', { 'data-cf-note': '' }, '条')),
            h('div', { 'data-cf-row': '' },
              h(Btn, { onClick: startLogin, disabled: busy === 'login' }, logined ? '重新扫码' : '扫码登录')),
            h('div', { 'data-cf-row': '' },
              h('span', { 'data-cf-label': '', 'data-cf-grow': '', style: { fontSize: '12px' } }, '收藏夹的更新也算'),
              h(Switch, { on: Boolean(val('favoritesEnabled')), onChange: (v) => set('favoritesEnabled', v) })))),
        h('div', { key: 'douyin', 'data-cf-card': '', 'data-off': val('sources')?.douyin ? undefined : '' },
          h('div', { 'data-cf-card-h': '' },
            h('b', null, '抖音'),
            h(Switch, {
              on: Boolean(val('sources')?.douyin),
              onChange: (v) => set('sources', { ...val('sources'), douyin: v }),
            })),
          h('div', { 'data-cf-card-k': '' },
            h('div', { 'data-cf-note': '' },
              runtime.dyProfile ? '登录态还留着' : '还没起过（第一次跑会开个专用窗口）'),
            h('div', { 'data-cf-row': '' },
              h('span', { 'data-cf-label': '', 'data-cf-grow': '', style: { fontSize: '12px' } }, '每天最多收'),
              h(Num, { value: val('douyinPerDay'), min: 0, max: 30, onChange: (v) => set('douyinPerDay', v) }),
              h('span', { 'data-cf-note': '' }, '条')),
            h('div', { 'data-cf-row': '' },
              h('span', { 'data-cf-label': '', 'data-cf-grow': '', style: { fontSize: '12px' } }, '每天最多看'),
              h(Num, { value: val('dyDailyMinutes'), min: 0, max: 120, onChange: (v) => set('dyDailyMinutes', v) }),
              h('span', { 'data-cf-note': '' }, '分钟')),
            h('div', { 'data-cf-row': '' },
              h(Btn, { onClick: resetDy, disabled: busy === 'dyreset' }, '重置登录')))),
        h('div', { key: 'aihot', 'data-cf-card': '', 'data-off': val('sources')?.aihot ? undefined : '' },
          h('div', { 'data-cf-card-h': '' },
            h('b', null, 'AI 圈（AIHOT）'),
            h(Switch, {
              on: Boolean(val('sources')?.aihot),
              onChange: (v) => set('sources', { ...val('sources'), aihot: v }),
            })),
          h('div', { 'data-cf-card-k': '' },
            h('div', { 'data-cf-note': '' }, '免登录、只读。转述同行（aihot.news）的 AI 日报，不参与挑选、不算进视频额度。'),
            h('div', { 'data-cf-row': '' },
              h('span', { 'data-cf-label': '', 'data-cf-grow': '', style: { fontSize: '12px' } }, '每天取'),
              h(Num, { value: val('aihotPerDay'), min: 0, max: 20, onChange: (v) => set('aihotPerDay', v) }),
              h('span', { 'data-cf-note': '' }, '条')),
            h('div', { 'data-cf-row': '' },
              h('span', { 'data-cf-label': '', 'data-cf-grow': '', style: { fontSize: '12px' } }, '取哪一种'),
              h('select', {
                'data-cf-input': '', value: val('aihotMode') || 'daily',
                onChange: (e) => set('aihotMode', e.target.value),
              },
                h('option', { value: 'daily' }, '当天日报'),
                h('option', { value: 'selected' }, '24h 精选'))))),
      ]

      // ② 其余五个面板：每块只放它自己的东西，行与行之间靠间距分组
      const panels = {
        sources: [
          h('div', { 'data-cf-cards': '' }, sourceCards),
          login?.qr ? h('div', { 'data-cf-qr': '' },
            h('img', { src: login.qr, alt: '登录二维码', style: { width: '180px', height: '180px' } }),
            h(Note, null, login.state === 'ok' ? '扫上了。'
              : login.state === 'scanned' ? '扫到了，手机上点一下确认。'
                : login.state === 'expired' ? '码过期了，再点一次「扫码登录」。'
                  : '用手机 B站 扫这个码。')) : null,
          h(Note, null, '三个源互不干扰：关掉的那个，那一轮就不去，日报里也不会出现它的节。'),
        ],

        pick: [
          h(Sec, { title: '自动跑' },
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.autoRuns || '自动每天最多跑几轮'),
              h(Num, { value: val('autoRuns'), min: 0, max: 24, onChange: (v) => set('autoRuns', v) })),
            h(Note, null, '一天最多起几轮自动值班。每一轮收多少，看「采什么」里每个源自己的上限 —— 哪天都收满了就不跑了。'),
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.fetchPerRound || '每轮最多细看几条'),
              h(Num, { value: val('fetchPerRound'), min: 1, max: 30, onChange: (v) => set('fetchPerRound', v) })),
            h(Note, null, '细看 = 拉字幕/抽帧那种。这个只限制看的量，不影响收几条。')),
          h(Sec, { title: '手动跑' },
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.manualPerRound || '点一次最多收几条'),
              h(Num, { value: val('manualPerRound'), min: 0, max: 30, onChange: (v) => set('manualPerRound', v) })),
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.manualCooldownMin || '两次手动至少隔几分钟'),
              h(Num, { value: val('manualCooldownMin'), min: 0, max: 240, onChange: (v) => set('manualCooldownMin', v) })),
            h(Note, null, '手动没有每天次数限制，想点几次点几次，只受这里的冷却挡一下。')),
          h(Sec, { title: '看什么' },
            h(Row, null,
              h('span', { 'data-cf-label': '' }, labels.keywords || '关注关键词'),
              h('input', {
                'data-cf-input': '', 'data-cf-grow': '',
                value: kwText === null ? (val('keywords') || []).join(', ') : kwText,
                placeholder: '用逗号分开，例如：deepseek, ai, 插件',
                onChange: (e) => {
                  const raw = e.target.value
                  setKwText(raw)
                  set('keywords', raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean))
                },
                onBlur: () => setKwText(null),
              })),
            h(Note, null, '留空就什么都看；填了就优先往这些词上找。'),
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.reportLevel || '日报详略'),
              h('select', {
                'data-cf-input': '',
                value: val('reportLevel') || 'full',
                onChange: (e) => set('reportLevel', e.target.value),
              },
                h('option', { value: 'full' }, 'full · 写全'),
                h('option', { value: 'brief' }, 'brief · 只写结论')))),
        ],

        output: [
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.outputDir || '存放位置'),
            h('input', {
              'data-cf-input': '', 'data-cf-grow': '', placeholder: status?.home || '',
              value: val('outputDir') || '',
              onChange: (e) => set('outputDir', e.target.value),
            })),
          h(Note, null, '留空就是默认位置。填绝对路径会搬过去（只搬配置、判重、登录凭证，旧日报留在原地）。'),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.workspaceDir || '值班轮的工作区'),
            h('input', {
              'data-cf-input': '', 'data-cf-grow': '', placeholder: '留空=数据目录',
              value: val('workspaceDir') || '',
              onChange: (e) => set('workspaceDir', e.target.value),
            })),
          h(Note, null, '每天那一轮在哪个目录里跑 —— 会话列表按这个目录归到工作区。留空就用数据目录。'),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.notesEnabled || '值得看的另存单片笔记'),
            h(Switch, { on: Boolean(val('notesEnabled')), onChange: (v) => set('notesEnabled', v) })),
          h(Note, null, '开了之后每条「值得看」除了写进日报，还会单独存一份带封面与正文的笔记。'),
        ],

        interact: [
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.autoComment || '挑到值得看就留一句评论并 @ 我'),
            h(Switch, { on: Boolean(val('autoComment')), onChange: (v) => set('autoComment', v) })),
          h(Note, null, `@ 谁：${val('mentionName') || '（没填）'}。一轮最多一条。`),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.commentLength || '评论长度'),
            h('select', {
              'data-cf-input': '', value: val('commentLength') || 'medium',
              onChange: (e) => set('commentLength', e.target.value),
            },
              h('option', { value: 'short' }, 'short · 15 字内'),
              h('option', { value: 'medium' }, 'medium · 40 字内'),
              h('option', { value: 'long' }, 'long · 100 字内'))),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.dmEnabled || '处理收到的私信'),
            h(Switch, { on: Boolean(val('dmEnabled')), onChange: (v) => set('dmEnabled', v) })),
          val('dmEnabled') ? h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.dmMode || '私信怎么处理'),
            h('select', {
              'data-cf-input': '', value: val('dmMode') || 'read',
              onChange: (e) => setDmMode(e.target.value),
            },
              h('option', { value: 'read' }, 'read · 只看，不动'),
              h('option', { value: 'draft' }, 'draft · 起草但不发'),
              h('option', { value: 'auto' }, 'auto · 自动回'))) : null,
          val('dmMode') === 'auto' ? h(Note, null,
            '自动回会真的把话发出去。它会写进日报里留对账，但还是建议你先看一眼 read 攒几天的记录再说。') : null,
        ],

        runtime: [
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, '用哪个模型'),
            modelOptions.length
              ? h('select', {
                'data-cf-input': '', value: modelValue,
                onChange: (e) => {
                  const [provider, model] = e.target.value.split('\u0000')
                  set('model', { provider, model })
                },
              },
                h('option', { value: '\u0000' }, '跟宿主默认走'),
                modelOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)))
              : h('input', {
                'data-cf-input': '', placeholder: models?.note || 'provider / model',
                value: `${val('model')?.provider || ''}${val('model')?.model ? ` / ${val('model')?.model}` : ''}`,
                onChange: (e) => {
                  const [provider, model] = e.target.value.split('/').map((s) => s.trim())
                  set('model', { provider: provider || '', model: model || '' })
                },
              })),
          !modelOptions.length ? h(Note, null, models?.note || '读不到宿主登记的模型名，直接手填 provider 和 model（用 / 隔开）。') : null,
          h(Note, null, '选「跟宿主默认走」就是空着，用 DSH 现在那个模型。'),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, 'B站 那一头要个 Python 环境'),
            h(Btn, { onClick: installPython, disabled: busy === 'python' },
              busy === 'python' ? '正在装…' : (pyOk ? '重装' : '装一下'))),
          h(Note, null, py?.hint || (pyOk ? `好了：${py.python}` : '还没装。装一次就行，几分钟。')),
          h(Row, null,
            h(Btn, { onClick: runDiagnose, disabled: busy === 'diag' }, '看看哪儿不对'),
            h(Btn, { onClick: importOld, disabled: busy === 'import' }, '从旧插件导入')),
          diag ? h('div', { 'data-cf-note': '' },
            h('div', null, diag.verdict || (diag.ok ? '看着没问题。' : '有点问题。')),
            Array.isArray(diag.checks) && diag.checks.length
              ? h('ul', { 'data-cf-checks': '' },
                diag.checks.map((c) => h('li', { key: c.key, 'data-ok': c.ok ? '1' : '0' },
                  h('span', null, `${c.ok ? '✓' : '×'} ${c.label}`),
                  h('span', null, ` — ${c.line}`),
                  c.ok ? null : h('em', null, ` ${c.hint}`))))
              : null,
            diag.detail?.hint ? h('div', null, diag.detail.hint) : null,
            diag.logTail ? h('pre', { 'data-cf-log': '' }, diag.logTail) : null) : null,
        ],

        display: [
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, '侧栏留个入口'),
            h(Switch, { on: Boolean(val('showSidebar')), onChange: (v) => set('showSidebar', v) })),
          h(Note, null, '关掉之后侧栏就没有「蜻蛉」这个按钮了 —— 主区页还能从会话顶部那块进来。'),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, '会话顶部挂「今天」'),
            h(Switch, { on: Boolean(val('showConversation')), onChange: (v) => set('showConversation', v) })),
          h(Note, null, '这是每个会话顶上那一块，显示当天挑出来的几条。嫌占地方就关掉。'),
        ],
      }

      return h('div', { 'data-cf-page': '', 'data-cf-wide': '', 'data-cf-set': '' },
        h(StyleTag, null),
        h('nav', { 'data-cf-nav': '' },
          groups.map((g) => h('button', {
            key: g.key, type: 'button',
            'data-on': current.key === g.key ? '' : undefined,
            'data-dirty': dirtyIn(g.keys) ? '' : undefined,
            onClick: () => setTabKey(g.key),
          }, h('i', null), g.label))),
        h('div', { 'data-cf-pane': '' },
          h('div', null,
            h('div', { 'data-cf-pane-h': '' }, current.title),
            h('div', { 'data-cf-pane-d': '' }, current.desc)),
          panels[current.key] || null,
          h('div', { 'data-cf-save': '' },
            h(Btn, { onClick: save, primary: true }, '保存'),
            msg ? h('span', { 'data-cf-note': '' }, msg) : null,
            Object.keys(dirty).length
              ? h('span', { 'data-cf-note': '' }, `有 ${Object.keys(dirty).length} 处改动没存`)
              : null)))
    }

    // ── 主区整页 ──────────────────────────────────────────────────────────────
    function MainPanel() {
      const [tab, setTab] = useState('today')
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')

      const refresh = useCallback(() => {
        jget('/status').then(setStatus).catch(() => setStatus(null))
      }, [])
      useEffect(() => {
        refresh()
        const t = setInterval(refresh, 4000)
        return () => clearInterval(t)
      }, [refresh])

      const run = async () => {
        setBusy(true); setMsg('')
        try {
          const r = await jpost('/run')
          setMsg(r.ok ? (r.text || '跑完了。') : (r.text || '没跑成。'))
          if (r.ok) setTab('today')
          refresh()
        } catch (e) { setMsg(`没跑成：${e.message || e}`) }
        finally { setBusy(false) }
      }

      // 存完配置要顺手把「显示」那两个开关落到槽位上（真挂/真摘）
      const onSaved = useCallback((cfg) => {
        if (cfg) syncSlots(cfg)
        refresh()
      }, [refresh])

      return h('div', { 'data-cf-shell': '', 'data-cf-main': '' },
        h(StyleTag, null),
        h('div', { 'data-cf-head': '' },
          h('div', { 'data-cf-page': '', 'data-cf-wide': tab === 'today' ? '' : undefined },
            h(StatusBar, { status, onRun: run, busy }),
            msg ? h('div', { 'data-cf-note': '' }, msg) : null,
            h('div', { 'data-cf-tabs': '' },
              h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'today' ? '' : undefined, onClick: () => setTab('today') }, '今天'),
              h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'settings' ? '' : undefined, onClick: () => setTab('settings') }, '设置')))),
        h('div', { 'data-cf-body': '' },
          tab === 'today'
            ? h(TodayPanel, { compact: false, onRun: run, busy })
            : h(SettingsPanel, { status, onSaved: onSaved })),
      )
    }

    // ── 设置页里的一页（同样的两个页签，精简） ─────────────────────────────────
    function SettingsSection() {
      const [tab, setTab] = useState('today')
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')

      // 设置页里没有主区那条状态带，所以这里自己读一次 —— 运行环境那一段要用它
      const refresh = useCallback(() => {
        jget('/status').then(setStatus).catch(() => setStatus(null))
      }, [])
      useEffect(() => { refresh() }, [refresh])

      const run = async () => {
        setBusy(true); setMsg('')
        try {
          const r = await jpost('/run')
          setMsg(r.ok ? (r.text || '跑完了。') : (r.text || '没跑成。'))
          refresh()
        } catch (e) { setMsg(`没跑成：${e.message || e}`) }
        finally { setBusy(false) }
      }

      const onSaved = useCallback((cfg) => {
        if (cfg) syncSlots(cfg)
        refresh()
      }, [refresh])

      return h('div', { 'data-cf-shell': '' },
        h(StyleTag, null),
        h('div', { 'data-cf-head': '' },
          h('div', { 'data-cf-page': '' },
            h('div', { 'data-cf-tabs': '' },
              h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'today' ? '' : undefined, onClick: () => setTab('today') }, '今天'),
              h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'settings' ? '' : undefined, onClick: () => setTab('settings') }, '设置')),
            msg ? h('div', { 'data-cf-note': '' }, msg) : null)),
        h('div', { 'data-cf-body': '' },
          tab === 'today'
            ? h(TodayPanel, { compact: true, onRun: run, busy })
            : h(SettingsPanel, { status, onSaved: onSaved })),
      )
    }

    /**
     * 侧栏图标：内联 SVG，不吃饭的 emoji。
     * 描边 `currentColor`、16px、1.5 —— 跟宿主那几个图标同一套语言。
     */
    function SidebarEntry() {
      return h('span', { title: '蜻蛉', 'aria-label': '蜻蛉', role: 'img', 'data-cf-icon': '' },
        h('svg', {
          viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true',
        },
        h('circle', { cx: 8, cy: 4, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M8 5.1V13.4' }),
        h('ellipse', { cx: 4.7, cy: 6.2, rx: 3, ry: 1, transform: 'rotate(-18 4.7 6.2)' }),
        h('ellipse', { cx: 11.3, cy: 6.2, rx: 3, ry: 1, transform: 'rotate(18 11.3 6.2)' }),
        h('ellipse', { cx: 5, cy: 8.8, rx: 2.3, ry: 0.8, transform: 'rotate(12 5 8.8)' }),
        h('ellipse', { cx: 11, cy: 8.8, rx: 2.3, ry: 0.8, transform: 'rotate(-12 11 8.8)' })))
    }

    // 会话顶部那一块：只读，「今天」的精简版。
    // 这里不压宽度 —— 会话区本来就有一千多像素，压到 640 只会右边空一大片。
    function ConversationPanel() {
      return h('div', { 'data-cf-shell': '', 'data-cf-conv': '' },
        h(StyleTag, null),
        h('div', { 'data-cf-body': '' }, h(TodayPanel, { compact: true, wide: true })))
    }

    /**
     * 槽位开关。
     *
     * ⚠️ 两个开关要**真的挂上/摘掉**，不是渲染个空壳 ——
     * 空壳会留一个点不开的按钮，比没有更糟。
     * `slots.inject` 的回调只在槽位真的存在时触发，所以注册放在它里面；
     * 之后改配置时直接复用同一个 register/dispose 对。
     */
    const prefs = { sidebar: true, conversation: true }
    const slotState = { ready: {}, dispose: {} }
    const mounters = {}

    function mountSlot(name) {
      if (!slotState.ready[name] || slotState.dispose[name]) return
      try { slotState.dispose[name] = mounters[name]?.() || null } catch { slotState.dispose[name] = null }
    }
    function unmountSlot(name) {
      const d = slotState.dispose[name]
      slotState.dispose[name] = null
      try { d?.() } catch { /* 已经没了 */ }
    }
    function syncSlots(cfg) {
      if (cfg) {
        prefs.sidebar = cfg.showSidebar !== false
        prefs.conversation = cfg.showConversation !== false
      }
      const want = { 'sidebar.panellist': prefs.sidebar, 'conversation.view': prefs.conversation }
      for (const name of Object.keys(want)) {
        if (want[name]) mountSlot(name)
        else unmountSlot(name)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // 主区页与设置页一直挂 —— 它们是「怎么进来」的两条腿，不随显示开关消失
        const always = {
          main: () => slots.register({ name: 'main', key: 'dragonfly', label: '蜻蛉' }, MainPanel),
          'settings.section': () => slots.register({
            name: 'settings.section', id: 'dragonfly', order: 60, label: '蜻蛉',
          }, SettingsSection),
        }
        const optional = {
          'sidebar.panellist': () => slots.register({
            name: 'sidebar.panellist', id: 'dragonfly', order: 100, label: '蜻蛉',
          }, SidebarEntry),
          'conversation.view': () => slots.register({
            name: 'conversation.view', id: 'dragonfly-today', order: 20, scope: 'session', label: '蜻蛉',
          }, ConversationPanel),
        }

        const cleanups = []
        const reg = (key, make) => {
          try {
            slots.inject(key, () => {
              const dispose = make()
              cleanups.push(dispose)
              return dispose
            })
          } catch (e) { /* 这个槽位不存在就算了，别把整页带崩 */ }
        }

        for (const [k, make] of Object.entries(always)) reg(k, make)

        for (const [k, make] of Object.entries(optional)) {
          mounters[k] = make
          try {
            slots.inject(k, () => {
              slotState.ready[k] = true
              if (k === 'sidebar.panellist' ? prefs.sidebar : prefs.conversation) mountSlot(k)
              return () => { slotState.ready[k] = false; unmountSlot(k) }
            })
          } catch { /* 这个宿主没有这个槽位 */ }
        }

        // 先按默认（都挂）走，再把真实配置读回来校正一次
        syncSlots(null)
        jget('/config').then((r) => syncSlots(r.config)).catch(() => {})

        ctx.effect?.(() => () => {
          for (const k of Object.keys(slotState.dispose)) unmountSlot(k)
          for (const fn of [...cleanups].reverse()) {
            try { fn?.() } catch { /* ignore */ }
          }
        }, 'dragonfly: slots')
      },
    }
  },
})
