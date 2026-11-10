/**
 * lib/aihot.mjs —— 把 AIHOT（https://aihot.news）的日报/精选取回来
 * ============================================================================
 * 只做三件事：
 *   ① 请求（匿名只读，不需要 Key；UA 按 AIHOT 要求写 aihot-api/2.0.0）
 *   ② 把返回的 JSON 抹平成一组条目 {id, title, summary, source, aihotUrl, originalUrl}
 *   ③ 按天缓存到 `<家目录>/cache/aihot-<日期>.json` —— 同一天只请求一次，
 *      重跑一轮不会重复打人家接口（AIHOT 限流约 60 次/分钟/IP）
 *
 * **失败了不算错**：任何异常都返回 `{ ok: false, reason }`，由调用方在日报里写一行
 * "今天没取到"，绝不能让一个外站的问题把整轮搞挂。
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AIHOT_MODES } from './config.mjs'

export const AIHOT_UA = 'aihot-api/2.0.0'
export const AIHOT_BASE = 'https://aihot.news/api/v1'
// 取哪一种（daily = 当天的 AIHOT 日报；selected = 最近 24h 的编辑精选条目）
// 名单放在 lib/config.mjs —— 那里是配置项的唯一名单，别在这儿再写一份
export { AIHOT_MODES }

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

/** AIHOT 条目 id 的真身：26 位左右小写字母数字 */
const ID_SHAPE = /^[0-9a-z]{20,32}$/

/**
 * 兜底 id：接口没给 id、或 links.aihot 里抠不出条目 id 时，
 * 用标题+来源+原文链接算一个稳定的 20 位小写串。
 * 必须是稳定的 —— 日报按 id 整条覆盖，id 一变同一天就会堆出重复条目。
 */
function stableId(seed) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const s = String(seed || '')
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c, 2246822519) >>> 0
  }
  return `${h1.toString(36)}${h2.toString(36)}`.padEnd(20, '0').slice(0, 20)
}

/** 从一条原始记录里取 id：优先显式 id，其次 links.aihot 尾巴，最后算一个 */
function idOf(raw, fallbackSeed) {
  const explicit = clean(raw?.id)
  if (ID_SHAPE.test(explicit)) return explicit
  const tail = String(raw?.links?.aihot || '').split('/').filter(Boolean).pop() || ''
  if (ID_SHAPE.test(tail)) return tail
  return stableId(fallbackSeed)
}

/** 日报 JSON（/dailies/latest）→ 统一条目 */
export function normalizeDaily(json, limit = 5) {
  const report = json?.report
  if (!report || typeof report !== 'object') return { ok: false, reason: '返回里没有 report' }
  const highlights = Array.isArray(report.highlights) ? report.highlights : []
  const items = highlights.slice(0, Math.max(0, limit)).map((h) => ({
    id: idOf(h, `${h?.title}|${h?.source?.name}|${h?.links?.original}`),
    title: clean(h?.title),
    summary: clean(h?.summary),
    source: clean(h?.source?.name),
    aihotUrl: String(h?.links?.aihot || ''),
    originalUrl: String(h?.links?.original || ''),
  })).filter((it) => it.id && it.title)
  const lead = report.lead && (report.lead.title || report.lead.leadParagraph)
    ? { title: clean(report.lead.title), text: clean(report.lead.leadParagraph) }
    : null
  return { ok: true, date: clean(report.date), lead, items }
}

/** 精选 JSON（/items）→ 统一条目 */
export function normalizeSelected(json, limit = 5) {
  const list = Array.isArray(json?.items) ? json.items : []
  const items = list.slice(0, Math.max(0, limit)).map((it) => ({
    id: idOf(it, `${it?.title}|${it?.source?.name}|${it?.links?.original}`),
    title: clean(it?.title),
    summary: clean(it?.summary),
    source: clean(it?.source?.name),
    aihotUrl: String(it?.links?.aihot || ''),
    originalUrl: String(it?.links?.original || ''),
  })).filter((it) => it.id && it.title)
  return { ok: true, date: '', lead: null, items }
}

const urlOf = (mode, limit) => (mode === 'selected'
  ? `${AIHOT_BASE}/items?mode=selected&window=24h&limit=${Math.max(1, Math.min(30, limit))}`
  : `${AIHOT_BASE}/dailies/latest`)

/**
 * 请求一次（不落盘）。任何失败都折成 `{ ok:false, reason }`。
 * @param {{mode?:string, limit?:number, timeoutMs?:number, fetcher?:Function, log?:Function}} o
 */
export async function fetchAihot({ mode = 'daily', limit = 5, timeoutMs = 8000, fetcher, log } = {}) {
  const m = AIHOT_MODES.includes(mode) ? mode : 'daily'
  const f = fetcher || globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: '这个 Node 没有 fetch' }
  const url = urlOf(m, limit)
  let json
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    const res = await f(url, {
      headers: { 'user-agent': AIHOT_UA, accept: 'application/json' },
      signal,
    })
    if (!res?.ok) return { ok: false, reason: `HTTP ${res?.status ?? '?'}` }
    json = await res.json()
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? `超时（${timeoutMs}ms）` : String(e?.message || e)
    log?.(`AIHOT 没取到：${reason}`)
    return { ok: false, reason }
  }
  const out = m === 'selected' ? normalizeSelected(json, limit) : normalizeDaily(json, limit)
  if (!out.ok) log?.(`AIHOT 返回的形状不对：${out.reason}`)
  if (out.ok && !out.items.length) log?.('AIHOT 这一期没有条目')
  return { ...out, mode: m, fetchedAt: Date.now() }
}

export const aihotCachePath = (home, day) => join(home, 'cache', `aihot-${day}.json`)

/**
 * 按天取（先看缓存）。缓存里存的是**整份**条目，limit 在渲染时才切，
 * 所以同一天改「每天取几条」不用再请求一次。
 */
export async function aihotForDay({ home, day, mode = 'daily', limit = 5, fetcher, log, refresh = false } = {}) {
  const file = aihotCachePath(home, day)
  if (!refresh && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8'))
      if (cached && cached.ok && cached.mode === mode) {
        return { ...cached, cached: true, items: (cached.items || []).slice(0, Math.max(0, limit)) }
      }
    } catch { /* 缓存坏了就当没有 */ }
  }
  const got = await fetchAihot({ mode, limit: 30, fetcher, log })
  if (got.ok) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ ...got, items: got.items }), 'utf8')
    } catch { /* 缓存写不进去不影响这一轮 */ }
  }
  return { ...got, items: (got.items || []).slice(0, Math.max(0, limit)) }
}

/**
 * 给这一轮的章程用：把 AI 圈那几条的标题列成清单。
 * 总结是整份日报的收束，负责写总结的那一轮得先看见 AI 圈有什么。
 */
export function aihotPromptNote(got) {
  if (!got || got.ok === false) {
    return `（今天 AI 圈没取到${got?.reason ? `：${got.reason}` : ''}）`
  }
  const items = got.items || []
  if (!items.length) return '（今天 AI 圈没有内容）'
  return items
    .map((it) => `- ${it.title}${it.source ? `（${it.source}）` : ''}`)
    .join('\n')
}

/**
 * 渲染成日报里的一个小节（Markdown）。
 * 条目用 `### [AIHOT] <id> / 标题`，跟视频条目同一个形状 —— 合并按 id 去重，
 * 但**不带档位**：这是转述别人的日报，不参与"值得看/不值当"的判断。
 */
export function aihotMarkdown(got, { day } = {}) {
  const out = []
  if (!got?.ok) {
    out.push(`AIHOT 今天没取到（${got?.reason || '原因不明'}）。`)
    return out
  }
  if (got.lead?.title) {
    out.push(`> ${got.lead.title}${got.lead.text && got.lead.text !== got.lead.title ? ` —— ${got.lead.text}` : ''}`)
    out.push('')
  }
  if (!got.items?.length) {
    out.push(`AIHOT${day ? ` ${day}` : ''} 这一期没有条目。`)
    return out
  }
  for (const it of got.items) {
    out.push(`### [AIHOT] ${it.id} / ${it.title}`)
    if (it.summary) out.push(`**说了什么**：${it.summary}`)
    const links = [`[AIHOT 阅读](${it.aihotUrl || `https://aihot.news/items/${it.id}`})`]
    if (it.originalUrl) links.push(`[原文](${it.originalUrl})`)
    out.push(`**来源**：${it.source || 'AIHOT'} · ${links.join(' · ')}`)
    out.push('')
  }
  return out
}
