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
[data-cf-filters]{display:flex;flex-direction:column;gap:6px;padding:10px 0 2px;}
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
[data-cf-sub]{font-size:11px;font-weight:600;letter-spacing:.04em;margin:16px 0 2px;
  color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cf-line]{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#5b6068);
  padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-secondary,#f2f4f6);}
[data-cf-line]:last-child{border-bottom:0;}
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
      const [src, setSrc] = useState('all')
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
      const picks = sections.find((s) => s.key === 'picks')?.entries || []
      const shown = (e) => (src === 'all' || e.source === src)
        && (tier === 'all' || e.tier === tier)
      const picked = picks.filter(shown)
      const rest = sections.filter((s) => s.key !== 'picks')

      const countOf = (key) => picks.filter((e) => key === 'all' || e.source === key).length

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

      const chip = (key, label, n) => h('button', {
        key, type: 'button', 'data-cf-chip': '', 'data-on': src === key ? '' : undefined,
        onClick: () => setSrc(key),
      }, n ? `${label} ${n}` : label)

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
        h('div', { 'data-cf-meta': '' }, `${e.source === 'douyin' ? '抖音' : 'B站'} · ${e.id || '没有 id'}`)))

      // 「扫过没收的」之类：只有一行标题，写成清单就行，别也铺封面
      const flatLine = (text, key) => h('div', { key, 'data-cf-line': '' }, text)

      const secBlock = (s) => {
        const keep = (s.entries || []).filter(shown)
        const lines = (s.lines || []).filter((l) => src === 'all'
          || (src === 'bili' ? !/\[抖音\]/.test(l) : /\[抖音\]/.test(l)))
        if (!keep.length && !lines.length) return null
        return h('div', { key: s.key || s.title },
          h('div', { 'data-cf-sub': '' }, s.title),
          ...keep.map((e) => flatLine(`${e.title}${e.tier ? `　${e.tier}` : ''}`, e.id || e.title)),
          ...lines.map((l, i) => flatLine(l, `${s.key || s.title}-${i}`)))
      }

      return h('div', { 'data-cf-page': '', 'data-cf-wide': compact && !wide ? undefined : '' },
        h(StyleTag, null),

        // 筛子要钉在顶上：会话顶部那块高度只有四百来像素，
        // 往下翻两条 chip 就滚没了，想换档位还得先滚回顶部。
        h('div', { 'data-cf-filters': '', 'data-cf-sticky': '' },
          h('div', { 'data-cf-chips': '' },
            chip('all', '全部', countOf('all')),
            chip('bili', 'B站', countOf('bili')),
            chip('douyin', '抖音', countOf('douyin'))),
          tierKeys.length > 1
            ? h('div', { 'data-cf-chips': '' },
              tierChip('all', '所有档位', 0),
              tierKeys.map((t) => tierChip(t, t, tierCount(t))))
            : null,
          days.length > 1 || day
            ? h('div', { 'data-cf-chips': '' },
              days.map((d) => h('button', {
                key: d, type: 'button', 'data-cf-chip': '',
                'data-on': (day || data?.day) === d ? '' : undefined,
                onClick: () => setDay(d),
              }, d.slice(5))))
            : null),

        !data ? h('div', { 'data-cf-empty': '' }, '正在读…')
          : !data.exists ? h('div', { 'data-cf-empty': '' },
            h('div', null, '还没采过。'),
            runBtn('现在就跑'),
            h('div', { 'data-cf-note': '' }, '到点会自动跑一轮，也可以现在点一下。'))
            : picked.length === 0 && rest.every((s) => !(s.entries || []).length && !(s.lines || []).length)
              ? h('div', { 'data-cf-empty': '' }, '这一天的日报是空的。')
              : h('div', null,
                picked.length
                  ? h('div', null, picked.map(entryCard))
                  : h('div', { 'data-cf-empty': '' },
                    (() => {
                      const bySrc = src === 'all' ? '' : (src === 'douyin' ? '抖音' : 'B站')
                      if (tier !== 'all') {
                        return bySrc
                          ? `这一天没有「${tier}」的${bySrc}条目。`
                          : `这一天没有「${tier}」的条目。`
                      }
                      return bySrc ? `这一天没有${bySrc}的条目。` : '这一天一条都没收。'
                    })()),
                rest.map(secBlock)),
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
      const [more, setMore] = useState('')          // 互动/运行环境是否展开
      const [busy, setBusy] = useState('')

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

      return h('div', { 'data-cf-page': '' },
        h(StyleTag, null),

        // ① 信源与额度
        h(Sec, { title: '信源与额度' },
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, '看 B站'),
            h(Switch, {
              on: Boolean(val('sources')?.bili),
              onChange: (v) => set('sources', { ...val('sources'), bili: v }),
            })),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, '看抖音'),
            h(Switch, {
              on: Boolean(val('sources')?.douyin),
              onChange: (v) => set('sources', { ...val('sources'), douyin: v }),
            })),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.perDay || '每天最多挑几条'),
            h(Num, { value: val('perDay'), min: 0, max: 30, onChange: (v) => set('perDay', v) })),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.dyDailyMinutes || '抖音每天最多看几分钟'),
            h(Num, { value: val('dyDailyMinutes'), min: 0, max: 120, onChange: (v) => set('dyDailyMinutes', v) })),
        ),

        // ② 怎么挑
        h(Sec, { title: '怎么挑' },
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.keywords || '关注关键词'),
            h('input', {
              'data-cf-input': '', value: (val('keywords') || []).join(', '),
              style: { width: '260px' },
              onChange: (e) => set('keywords', e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)),
            })),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.fetchPerRound || '每轮最多细看几条'),
            h(Num, { value: val('fetchPerRound'), min: 1, max: 30, onChange: (v) => set('fetchPerRound', v) })),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.reportLevel || '日报详略'),
            h('select', {
              'data-cf-input': '',
              value: val('reportLevel') || 'full',
              onChange: (e) => set('reportLevel', e.target.value),
            },
              h('option', { value: 'full' }, 'full · 写全'),
              h('option', { value: 'brief' }, 'brief · 只写结论'))),
        ),

        // ③ 互动与产出（默认折起）
        h('section', { 'data-cf-sec': '' },
          h('button', {
            type: 'button', 'data-cf-h': '', 'data-cf-fold': '',
            onClick: () => setMore(more === 'interact' ? '' : 'interact'),
          }, `${more === 'interact' ? '▾' : '▸'} 互动与产出`),
          more !== 'interact' ? null : h('div', { 'data-cf-sec': '' },
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
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.notesEnabled || '值得看的另存单片笔记'),
              h(Switch, { on: Boolean(val('notesEnabled')), onChange: (v) => set('notesEnabled', v) })),
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.favoritesEnabled || '把收藏夹的更新也算进来'),
              h(Switch, { on: Boolean(val('favoritesEnabled')), onChange: (v) => set('favoritesEnabled', v) })),
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
          )),

        // ④ 运行环境（默认折起）
        h('section', { 'data-cf-sec': '' },
          h('button', {
            type: 'button', 'data-cf-h': '', 'data-cf-fold': '',
            onClick: () => setMore(more === 'runtime' ? '' : 'runtime'),
          }, `${more === 'runtime' ? '▾' : '▸'} 运行环境`),
          more !== 'runtime' ? null : h('div', { 'data-cf-sec': '' },

            // 模型
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
                  'data-cf-input': '', placeholder: models?.note || 'provider / model', style: { width: '240px' },
                  value: `${val('model')?.provider || ''}${val('model')?.model ? ` / ${val('model')?.model}` : ''}`,
                  onChange: (e) => {
                    const [provider, model] = e.target.value.split('/').map((s) => s.trim())
                    set('model', { provider: provider || '', model: model || '' })
                  },
                })),
            !modelOptions.length ? h(Note, null, models?.note || '读不到宿主登记的模型名，直接手填 provider 和 model（用 / 隔开）。') : null,
            h(Note, null, '选「跟宿主默认走」就是空着，用 DSH 现在那个模型。'),

            // 存放位置
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.outputDir || '存放位置'),
              h('input', {
                'data-cf-input': '', placeholder: status?.home || '', style: { width: '280px' },
                value: val('outputDir') || '',
                onChange: (e) => set('outputDir', e.target.value),
              })),
            h(Note, null, '留空就是默认位置。填绝对路径会搬过去（只搬配置、判重、登录凭证，旧日报留在原地）。'),

            // 值班轮的工作区（会话的 cwd 就是它的工作区）
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.workspaceDir || '值班轮的工作区'),
              h('input', {
                'data-cf-input': '', placeholder: '留空=数据目录', style: { width: '280px' },
                value: val('workspaceDir') || '',
                onChange: (e) => set('workspaceDir', e.target.value),
              })),
            h(Note, null, '每天那一轮在哪个目录里跑 —— 会话列表按这个目录归到工作区。留空就用数据目录（那里不会显示成工作区）。'),

            // Python
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, 'B站 那一头要个 Python 环境'),
              h(Btn, { onClick: installPython, disabled: busy === 'python' },
                busy === 'python' ? '正在装…' : (pyOk ? '重装' : '装一下'))),
            h(Note, null, py?.hint || (pyOk ? `好了：${py.python}` : '还没装。装一次就行，几分钟。')),

            // B站 登录
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, 'B站 登录'),
              logined ? h('span', { 'data-cf-note': '' }, `已登录（UID ${runtime.biliUid || '?'}）`) : null,
              // 按钮一直在 —— 凭证过期是很平常的事，登录之后把入口藏起来等于逼人删文件
              h(Btn, { onClick: startLogin, disabled: busy === 'login' }, logined ? '重新扫码' : '扫码登录')),
            login?.qr ? h('div', { 'data-cf-qr': '' },
              h('img', { src: login.qr, alt: '登录二维码', style: { width: '180px', height: '180px' } }),
              h(Note, null, login.state === 'ok' ? '扫上了。'
                : login.state === 'scanned' ? '扫到了，手机上点一下确认。'
                  : login.state === 'expired' ? '码过期了，再点一次「扫码登录」。'
                    : '用手机 B站 扫这个码。')) : null,

            // 抖音浏览器
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, '抖音浏览器'),
              h('span', { 'data-cf-note': '' },
                runtime.dyProfile ? '登录态还留着' : '还没起过（第一次跑的时候会开一个专用窗口）'),
              h(Btn, { onClick: resetDy, disabled: busy === 'dyreset' }, '重置登录')),
            h(Note, null, '抖音要一个真浏览器窗口，第一次用得在里面登一次。之后登录态存在自己的 profile 里，跑完不关。'
              + '扫码过期或者被踢下线了，点「重置登录」再跑一轮就会重新要码。'),

            // 诊断 / 导入
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
          )),

        // ── 显示：只决定入口挂不挂，不影响跑不跑 ──────────────────────────
        h(Sec, { title: '显示' },
          h(Row, null,
            h('div', { 'data-cf-grow': '' }, h('div', { 'data-cf-label': '' }, '侧栏留个入口')),
            h(Switch, { on: Boolean(val('showSidebar')), onChange: (v) => set('showSidebar', v) })),
          h(Note, null, '关掉之后侧栏就没有「蜻蛉」这个按钮了 —— 主区页还能从会话顶部那块进来。'),

          h(Row, null,
            h('div', { 'data-cf-grow': '' }, h('div', { 'data-cf-label': '' }, '会话顶部挂「今天」')),
            h(Switch, { on: Boolean(val('showConversation')), onChange: (v) => set('showConversation', v) })),
          h(Note, null, '这是每个会话顶上那一块，显示当天挑出来的几条。嫌占地方就关掉。'),
        ),

        h(Row, null,
          h(Btn, { onClick: save, primary: true }, '保存'),
          msg ? h('span', { 'data-cf-note': '' }, msg) : null,
          Object.keys(dirty).length ? h('span', { 'data-cf-note': '' }, `有 ${Object.keys(dirty).length} 处改动没存`) : null),
      )
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
