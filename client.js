/**
 * client.js —— 浏览器半端（主区整页 + 设置页里的一页，同一份数据）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是**自注册脚本**：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 *
 * ⭐ 两个入口一起注册，缺一个就进不去：
 *     · `sidebar.panellist`（id `caifeng`）—— 侧栏那个按钮，没它就**没有入口**
 *     · `main`（keyed `caifeng`）—— 主区整页，key 必须跟侧栏那个 id 对上
 *     · `settings.section`（id `caifeng`）—— 设置页里的一页
 *
 * 数据全走 fetch(`/api/caifeng/*`)，跟宿主半端同一份 config.json / out/<日期>.md。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: '@zhuifengqug/dsh-tianshu-caifeng',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback } = React

    const API = '/api/caifeng'

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
[data-cf-days]{display:flex;gap:8px;flex-wrap:wrap;}
[data-cf-day]{appearance:none;border:0;background:transparent;cursor:pointer;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#8b9199);padding:2px 0;}
[data-cf-day][data-on]{color:var(--dsw-alias-brand-primary,#4c7dff);font-weight:600;}
[data-cf-warn]{font-size:11px;line-height:16px;color:#b2453e;}
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

    // ── 「今天」页签（主区与设置页共用，设置页里是精简版） ────────────────────
    function TodayPanel({ compact }) {
      const [day, setDay] = useState('')
      const [days, setDays] = useState([])
      const [data, setData] = useState(null)
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
      const entries = view ? view.sections.flatMap((s) => s.entries.map((e) => ({ ...e, section: s.title }))) : []

      return h('div', { 'data-cf-page': '', 'data-cf-wide': compact ? undefined : '' },
        h(StyleTag, null),

        days.length > 1 ? h('div', { 'data-cf-days': '' },
          days.map((d) => h('button', {
            key: d, type: 'button', 'data-cf-day': '', 'data-on': (day || data?.day) === d ? '' : undefined,
            onClick: () => setDay(d),
          }, d.slice(5)))) : null,

        !data ? h('div', { 'data-cf-empty': '' }, '正在读…')
          : !data.exists ? h('div', { 'data-cf-empty': '' },
            h('div', null, '还没采过。'),
            h('div', { 'data-cf-note': '' }, '到点会自动跑一轮，也可以在上面点「现在就跑」。'))
            : entries.length === 0
              ? h('div', { 'data-cf-empty': '' }, '这一天的日报是空的。')
              : h('div', null, entries.map((e) => h('div', { key: e.id || e.title, 'data-cf-entry': '' },
                h(Row, null,
                  h('div', { 'data-cf-entry-h': '', 'data-cf-grow': '' }, e.title),
                  e.tier ? h('span', {
                    'data-cf-tier': '',
                    'data-good': e.tier === '值得看' ? '' : undefined,
                    'data-bad': e.tier === '不值当' ? '' : undefined,
                  }, e.tier) : null),
                h('div', { 'data-cf-body': '' }, e.body)))),
      )
    }

    // ── 「设置」页签 ──────────────────────────────────────────────────────────
    function SettingsPanel({ status, onSaved }) {
      const [cfg, setCfg] = useState(null)
      const [labels, setLabels] = useState({})
      const [dirty, setDirty] = useState({})
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')

      useEffect(() => {
        jget('/config').then((r) => { setCfg(r.config || {}); setLabels(r.labels || {}) })
          .catch((e) => setErr(String(e.message || e)))
      }, [])

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
          onSaved?.()
        } catch (e) { setErr(String(e.message || e)) }
      }

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
        ),

        // ③ 运行环境（含模型与存放位置）
        h(Sec, { title: '运行环境' },
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, '用哪个模型'),
            h('input', {
              'data-cf-input': '', placeholder: 'provider', style: { width: '120px' },
              value: val('model')?.provider || '',
              onChange: (e) => set('model', { ...val('model'), provider: e.target.value }),
            }),
            h('input', {
              'data-cf-input': '', placeholder: 'model', style: { width: '150px' },
              value: val('model')?.model || '',
              onChange: (e) => set('model', { ...val('model'), model: e.target.value }),
            })),
          h(Note, null, '两个都留空就跟宿主的当前默认模型走。'),
          h(Row, null,
            h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, labels.outputDir || '存放位置'),
            h('input', {
              'data-cf-input': '', placeholder: status?.home || '', style: { width: '280px' },
              value: val('outputDir') || '',
              onChange: (e) => set('outputDir', e.target.value),
            })),
          h(Note, null, '留空就是默认位置。填绝对路径会搬过去（只搬配置、判重、登录凭证）。'),
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

      return h('div', { 'data-cf-page': '', 'data-cf-wide': '' },
        h(StyleTag, null),
        h(StatusBar, { status, onRun: run, busy }),
        msg ? h('div', { 'data-cf-note': '' }, msg) : null,
        h('div', { 'data-cf-tabs': '' },
          h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'today' ? '' : undefined, onClick: () => setTab('today') }, '今天'),
          h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'settings' ? '' : undefined, onClick: () => setTab('settings') }, '设置')),
        tab === 'today'
          ? h(TodayPanel, { compact: false })
          : h(SettingsPanel, { status, onSaved: refresh }),
      )
    }

    // ── 设置页里的一页（同样的两个页签，精简） ─────────────────────────────────
    function SettingsSection() {
      const [tab, setTab] = useState('today')
      return h('div', { 'data-cf-page': '' },
        h(StyleTag, null),
        h('div', { 'data-cf-tabs': '' },
          h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'today' ? '' : undefined, onClick: () => setTab('today') }, '今天'),
          h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'settings' ? '' : undefined, onClick: () => setTab('settings') }, '设置')),
        tab === 'today' ? h(TodayPanel, { compact: true }) : h(SettingsPanel, { status: null }),
      )
    }

    // 侧栏按钮：一个字符，跟蜂群那边一样
    function SidebarEntry() {
      return h('span', { title: '采风', 'aria-label': '采风', role: 'img' }, '🧭')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

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

        // ① 侧栏入口（没有它就没有进主区页的按钮）
        reg('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: 'caifeng', order: 100, label: '采风',
        }, SidebarEntry))

        // ② 主区整页（key 必须跟侧栏那个 id 对上）
        reg('main', () => slots.register({
          name: 'main', key: 'caifeng', label: '采风',
        }, MainPanel))

        // ③ 设置页里的一页
        reg('settings.section', () => slots.register({
          name: 'settings.section', id: 'caifeng', order: 60, label: '采风',
        }, SettingsSection))

        // 卸载时反序清理
        ctx.effect?.(() => () => {
          for (const fn of [...cleanups].reverse()) {
            try { fn?.() } catch { /* ignore */ }
          }
        }, 'caifeng: slots')
      },
    }
  },
})
