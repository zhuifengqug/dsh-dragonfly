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
[data-cf-fold]{appearance:none;border:0;background:transparent;padding:0;cursor:pointer;
  font-family:inherit;text-align:left;color:var(--dsw-alias-label-tertiary,#8b9199);}
[data-cf-fold]:hover{color:var(--dsw-alias-label-secondary,#5b6068);}
[data-cf-qr]{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:4px 0;}
[data-cf-log]{margin:6px 0 0;padding:8px 10px;max-height:220px;overflow:auto;font-size:11px;line-height:16px;
  background:var(--dsw-alias-bg-secondary,#f2f4f6);border-radius:8px;white-space:pre-wrap;word-break:break-all;
  color:var(--dsw-alias-label-secondary,#5b6068);}
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
          onSaved?.()
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

            // Python
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, 'B站 那一头要个 Python 环境'),
              h(Btn, { onClick: installPython, disabled: busy === 'python' },
                busy === 'python' ? '正在装…' : (pyOk ? '重装' : '装一下'))),
            h(Note, null, py?.hint || (pyOk ? `好了：${py.python}` : '还没装。装一次就行，几分钟。')),

            // B站 登录
            h(Row, null,
              h('span', { 'data-cf-label': '', 'data-cf-grow': '' }, 'B站 登录'),
              logined ? h('span', { 'data-cf-note': '' }, `已登录（UID ${runtime.biliUid || '?'}）`)
                : h(Btn, { onClick: startLogin, disabled: busy === 'login' }, '扫码登录')),
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
                runtime.dyProfile ? '登录态还留着' : '还没起过（第一次跑的时候会开一个专用窗口）')),
            h(Note, null, '抖音要一个真浏览器窗口，第一次用得在里面登一次。之后登录态存在自己的 profile 里，跑完不关。'),

            // 诊断 / 导入
            h(Row, null,
              h(Btn, { onClick: runDiagnose, disabled: busy === 'diag' }, '看看哪儿不对'),
              h(Btn, { onClick: importOld, disabled: busy === 'import' }, '从旧插件导入')),
            diag ? h('div', { 'data-cf-note': '' },
              h('div', null, diag.verdict || (diag.ok ? '看着没问题。' : '有点问题。')),
              diag.detail?.hint ? h('div', null, diag.detail.hint) : null,
              diag.logTail ? h('pre', { 'data-cf-log': '' }, diag.logTail) : null) : null,
          )),

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
      const [status, setStatus] = useState(null)

      // 设置页里没有主区那条状态带，所以这里自己读一次 —— 运行环境那一段要用它
      const refresh = useCallback(() => {
        jget('/status').then(setStatus).catch(() => setStatus(null))
      }, [])
      useEffect(() => { refresh() }, [refresh])

      return h('div', { 'data-cf-page': '' },
        h(StyleTag, null),
        h('div', { 'data-cf-tabs': '' },
          h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'today' ? '' : undefined, onClick: () => setTab('today') }, '今天'),
          h('button', { type: 'button', 'data-cf-tab': '', 'data-on': tab === 'settings' ? '' : undefined, onClick: () => setTab('settings') }, '设置')),
        tab === 'today' ? h(TodayPanel, { compact: true }) : h(SettingsPanel, { status, onSaved: refresh }),
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
