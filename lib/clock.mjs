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

/** 默认自己跑的三个时间点（都落在谷时）；使用者可以自己加、也可以去掉 */
export const DEFAULT_RUN_TIMES = ['12:00', '18:00', '23:00']

/** 一个时间点管多久：到点后一小时内都算这一轮，跳表错过几分钟不至于漏掉 */
export const RUN_SLOT_MINUTES = 60

/** cfg.runTimes → 升序去重的分钟数；一条都认不出来就退回默认三个 */
export function runTimesOf(cfg = {}) {
  const list = Array.isArray(cfg.runTimes) ? cfg.runTimes : []
  const mins = list.map(minutesOf).filter((m) => m !== null).sort((a, b) => a - b)
  const uniq = mins.filter((m, i) => i === 0 || m !== mins[i - 1])
  return uniq.length ? uniq : DEFAULT_RUN_TIMES.map(minutesOf)
}

/** 现在这一分钟落在哪个时间点的段里（没有就是 null） */
function activeRunTime(minutes, times) {
  return times.find((t) => minutes >= t && minutes < Math.min(24 * 60, t + RUN_SLOT_MINUTES)) ?? null
}

/** 官方口径：工作日 9-12、14-18 是高峰，其余全便宜 */
function isPeak(weekday, minutes) {
  if (weekday === 0 || weekday === 6) return false
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/** 某个时间点是不是高峰（给界面提示「这个点贵」用） */
export function isPeakTime(hhmm) {
  const m = minutesOf(hhmm)
  return m === null ? false : isPeak(1, m)
}

/**
 * 这一轮该不该自动跑。
 * ① 现在必须落在某个 `runTimes` 时间点的段里（到点后一小时内）；
 * ② 若开了 `peakValley`，这一轮还不能赶上工作日高峰。
 * @param {Date} now
 * @param {{runTimes?:string[], peakValley?:boolean}} cfg
 * @returns {{ok:boolean, why:string, window?:string}}
 */
export function autoWindowState(now, cfg = {}) {
  const times = runTimesOf(cfg)
  const { minutes, weekday } = beijingClock(now)
  const hit = activeRunTime(minutes, times)
  if (hit === null) {
    return { ok: false, why: '现在不在设的时间点上' }
  }
  const window = `${hhmmOf(hit)}-${hhmmOf(Math.min(24 * 60, hit + RUN_SLOT_MINUTES))}`
  if (cfg.peakValley && isPeak(weekday, minutes)) {
    return { ok: false, why: `${hhmmOf(hit)} 这一轮正赶上高峰，只在谷时跑的开关挡住了` }
  }
  return { ok: true, why: `${hhmmOf(hit)} 这一轮`, window }
}

/**
 * 今天设了哪些时间点，各自过了没有。
 * 给人看「今天几点会自己跑」——只写「3 轮」谁也看不出是几点。
 * @returns {{spec:string,start:number,end:number,state:'passed'|'active'|'todo'}[]}
 */
export function dayWindows(now = new Date(), cfg = {}) {
  const times = runTimesOf(cfg)
  const { minutes: cur } = beijingClock(now)
  return times.map((start) => {
    const end = Math.min(24 * 60, start + RUN_SLOT_MINUTES)
    return {
      spec: `${hhmmOf(start)}-${hhmmOf(end)}`,
      start,
      end,
      state: end <= cur ? 'passed' : (start <= cur ? 'active' : 'todo'),
    }
  })
}

/** 本机日期 YYYY-MM-DD（「今天哪一份日报」用它，不跟谷时口径混） */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * 下一次可能在什么时候开跑（给人看的「下次 14:00」）。
 * 只看时间点，不考虑额度与锁 —— 那是调用方的事。
 * @returns {{label:string, at:number|null}}
 */
export function nextWindowLabel(now, cfg = {}) {
  const times = runTimesOf(cfg)
  if (!times.length) return { label: '不限', at: null }
  const { minutes: cur } = beijingClock(now)
  const active = activeRunTime(cur, times)
  if (active !== null) return { label: hhmmOf(active), at: 0 }
  let best = null
  for (const t of times) {
    const delta = t > cur ? t - cur : 24 * 60 - cur + t
    if (best === null || delta < best.delta) best = { delta, start: t }
  }
  return { label: hhmmOf(best.start), at: best.delta }
}
