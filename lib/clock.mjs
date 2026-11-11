/**
 * lib/clock.mjs —— 时间口径（纯函数，不碰磁盘、不碰 ctx）
 * ============================================================================
 * 两条不同的"现在几点"，别混：
 *   · **谷时/窗口判定**必须用北京时间 —— 官方定价口径是北京时间，部署在 UTC 的机器上
 *     直接用 `now.getHours()` 会整整差 8 小时，窗口全部错位。中国不实行夏令时，
 *     UTC+8 是固定偏移，直接按偏移算，不依赖 Intl 时区数据库（精简构建里可能缺）。
 *   · **今天哪一份日报**用**本机日期** —— 它跟着使用者的日历翻页。
 * ============================================================================
 */

/** 'HH:MM' → 当天的分钟数；认不出来返回 null */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1]); const mi = Number(m[2])
  if (h > 24 || mi > 59) return null
  return h * 60 + mi
}

/** 分钟数 → 'HH:MM'（24:00 保留原样） */
export function hhmmOf(minutes) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(Number(minutes) || 0)))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(m / 60))}:${p(m % 60)}`
}

const BEIJING_OFFSET_MINUTES = 8 * 60

/** 把一个时刻换算成北京时间墙上时间 { minutes, weekday } */
export function beijingClock(now = new Date()) {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MINUTES * 60 * 1000)
  return {
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  }
}

/** 'HH:MM-HH:MM' → { start, end }；认不出来返回 null */
export function parseWindow(spec) {
  const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(String(spec ?? ''))
  if (!m) return null
  const start = minutesOf(m[1]); const end = minutesOf(m[2])
  if (start === null || end === null) return null
  return { start, end, spec: `${hhmmOf(start)}-${hhmmOf(end)}` }
}

/**
 * 现在在不在这个窗口里。支持跨零点（`18:00-09:00`）。
 * @param {{start:number,end:number}} win
 */
export function inWindow(now, win) {
  if (!win || typeof win.start !== 'number' || typeof win.end !== 'number') return false
  const { minutes: cur } = beijingClock(now)
  return win.start <= win.end ? (cur >= win.start && cur < win.end) : (cur >= win.start || cur < win.end)
}

/** 谷时窗口（想改就改这一处）—— 官方口径：工作日 9-12、14-18 是高峰，其余全便宜 */
export const VALLEY = {
  noon: { key: 'noon', label: '中午谷时', start: 12 * 60, end: 14 * 60, spec: '12:00-14:00' },
  night: { key: 'night', label: '晚上谷时', start: 18 * 60, end: 24 * 60 + 9 * 60, spec: '18:00-09:00' },
}

/**
 * 这一轮该不该自动跑。
 * 两道与门：① 现在落在使用者设的 `windows` 里；② 若开了 `peakValley`，还必须落在选中的谷时窗里。
 * @param {Date} now
 * @param {{windows?:string[], peakValley?:boolean, noon?:boolean, night?:boolean}} cfg
 * @returns {{ok:boolean, why:string, window?:string}}
 */
export function autoWindowState(now, cfg = {}) {
  const specs = (Array.isArray(cfg.windows) ? cfg.windows : []).map(parseWindow).filter(Boolean)
  const hit = specs.find((w) => inWindow(now, w))
  if (specs.length && !hit) {
    return { ok: false, why: '不在允许的时间窗里' }
  }
  if (!cfg.peakValley) {
    return { ok: true, why: '任意时间', window: hit?.spec ?? '全天' }
  }
  const weekend = (() => { const { weekday } = beijingClock(now); return weekday === 0 || weekday === 6 })()
  if (weekend) return { ok: true, why: '周末全天谷时', window: hit?.spec ?? '周末' }
  const picked = []
  if (cfg.noon && inWindow(now, VALLEY.noon)) picked.push(VALLEY.noon)
  if (cfg.night && inWindow(now, VALLEY.night)) picked.push(VALLEY.night)
  if (!picked.length) return { ok: false, why: '开了谷时限制，但现在不是谷时' }
  return { ok: true, why: picked[0].label, window: picked[0].spec }
}

/**
 * 今天所有能自动跑的时段，切成「不跨零点的一截一截」，带上过了没有。
 * 给人看「今天几点到几点会自己跑」——不然只写「3 轮」谁也看不出是几点。
 * @returns {{spec:string,start:number,end:number,state:'passed'|'active'|'todo'}[]}
 */
export function dayWindows(now = new Date(), cfg = {}) {
  const seg = (start, end) => ({ start, end, spec: `${hhmmOf(start)}-${hhmmOf(end)}` })
  // 先按使用者设的时间窗切（跨零点拆两段），默认 00:00-24:00 就是整段
  const base = []
  const specs = (Array.isArray(cfg.windows) ? cfg.windows : []).map(parseWindow).filter(Boolean)
  for (const w of specs) {
    if (w.start <= w.end) base.push(seg(w.start, w.end))
    else { base.push(seg(w.start, 24 * 60)); base.push(seg(0, w.end)) }
  }
  // 没设窗口 = 全天
  if (!base.length) base.push(seg(0, 24 * 60))
  // 开了谷时限制，再与选中的谷时窗求交
  const valley = []
  if (cfg.peakValley) {
    if (cfg.noon) valley.push(seg(VALLEY.noon.start, VALLEY.noon.end))
    if (cfg.night) { valley.push(seg(VALLEY.night.start, 24 * 60)); valley.push(seg(0, 9 * 60)) }
  }
  const cuts = []
  if (!valley.length) cuts.push(...base)
  else {
    for (const a of base) for (const b of valley) {
      const s = Math.max(a.start, b.start); const e = Math.min(a.end, b.end)
      if (e > s) cuts.push(seg(s, e))
    }
  }
  if (!cuts.length) return []
  cuts.sort((x, y) => x.start - y.start)
  const { minutes: cur } = beijingClock(now)
  return cuts.map((c) => ({ ...c, state: c.end <= cur ? 'passed' : (c.start <= cur ? 'active' : 'todo') }))
}

/** 本机日期 YYYY-MM-DD（「今天哪一份日报」用它，不跟谷时口径混） */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * 下一次可能在什么时候开跑（给人看的「下次 14:00」）。
 * 只看窗口起点，不考虑额度与锁 —— 那是调用方的事。
 * @returns {{label:string, at:number|null}}
 */
export function nextWindowLabel(now, cfg = {}) {
  const specs = (Array.isArray(cfg.windows) ? cfg.windows : []).map(parseWindow).filter(Boolean)
  const useValley = Boolean(cfg.peakValley)
  const sources = []
  for (const w of specs) sources.push(w)
  if (useValley) {
    if (cfg.noon) sources.push(VALLEY.noon)
    if (cfg.night) sources.push(VALLEY.night)
  }
  if (!sources.length) return { label: '不限', at: null }
  const { minutes: cur } = beijingClock(now)
  let best = null
  for (const w of sources) {
    const delta = w.start > cur ? w.start - cur : 24 * 60 - cur + w.start
    if (best === null || delta < best.delta) best = { delta, spec: w.spec ?? `${hhmmOf(w.start)}-${hhmmOf(w.end)}`, start: w.start }
  }
  return { label: hhmmOf(best.start), at: best.delta }
}
