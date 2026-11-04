/**
 * lib/duty-session.mjs —— 值班轮的会话「两天一条」
 * ============================================================================
 * 要的是什么：
 *   工作区里不要每轮冒一条新会话。每一条用两天 —— 第一天所有轮次写进它，
 *   第二天继续写同一条，第三天开新的。所以工作区里会一条条攒着，一条都不删。
 *
 * 怎么做到的：
 *   headless 支持 `--session-id <id>` 接管一条已有会话接着跑，硬拦只有四条
 *   （`@deepseek-ai/dsh-headless` 的 `assertAdoptable`）：
 *     · 不能带 agent preset
 *     · 不能是 subagent / fork 出来的
 *     · `header.cwd` 必须有、且必须等于当轮 cwd
 *     · 会话不能正被别的进程占着
 *   我们这条会话是自己 spawn 出来的，四条都过。
 *
 * 为什么还要校验一遍 cwd / 文件在不在：
 *   换了工作区目录、或手工删过会话文件，`--session-id` 就会整轮失败。
 *   与其让那一轮白跑，不如在这里先判掉、当它过期，另起一条。
 *
 * 计数用的「天」是北京时间的日历天（`lib/clock.mjs` 的 `dayKey()`），
 * 和日报、判重表是同一个日子口径。
 * ============================================================================
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectKey } from './workspace-link.mjs'

/** 一条会话用几天（改了这里就是改策略） */
export const SESSION_LIFESPAN_DAYS = 2

const DAY_MS = 24 * 60 * 60 * 1000

/** 读当前那条会话的记录；读不出来 / 格式不对都当没有 */
export function loadDutySession(layout, log = () => {}) {
  const file = layout?.dutySession
  if (!file) return null
  try {
    if (!existsSync(file)) return null
    const rec = JSON.parse(readFileSync(file, 'utf8'))
    if (!rec || typeof rec.id !== 'string' || !rec.id) return null
    return { id: rec.id, startedOn: typeof rec.startedOn === 'string' ? rec.startedOn : '' }
  } catch (e) {
    log(`值班会话记录读不出来（不影响这一轮）：${e?.message || e}`)
    return null
  }
}

/** 记下「当前用的是哪条、从哪天开始」；写不进去只记日志 */
export function saveDutySession(layout, rec, log = () => {}) {
  const file = layout?.dutySession
  if (!file) return false
  try {
    writeFileSync(file, JSON.stringify({ id: String(rec.id), startedOn: String(rec.startedOn || '') }, null, 2) + '\n', 'utf8')
    return true
  } catch (e) {
    log(`值班会话记录写不进去（不影响这一轮）：${e?.message || e}`)
    return false
  }
}

/** 会话文件在不在（`<sessions>/<projectKey(cwd)>/<id>/session.v4.jsonl.zstd`） */
export function dutySessionFileExists(sessionsRoot, cwd, sessionId) {
  if (!sessionsRoot || !cwd || !sessionId) return false
  try {
    const file = join(sessionsRoot, projectKey(cwd), String(sessionId), 'session.v4.jsonl.zstd')
    return existsSync(file) && statSync(file).size > 0
  } catch {
    return false
  }
}

/**
 * 这一轮该接着写哪条会话？
 *
 * @returns {{id:string, why:string}|null} `null` = 该新建一条
 */
export function pickDutySession({ layout, sessionsRoot, cwd, today, log = () => {} }) {
  const rec = loadDutySession(layout, log)
  if (!rec) return null
  if (!dutySessionFileExists(sessionsRoot, cwd, rec.id)) {
    log(`上一条值班会话（${rec.id}）的文件不在了，另起一条`)
    return null
  }
  const started = Date.parse(rec.startedOn ? `${rec.startedOn}T00:00:00+08:00` : '')
  if (!Number.isFinite(started)) {
    // 记录里没有起始日：当作今天刚开始用，接着写，并补上起始日
    return { id: rec.id, why: 'no-start-date' }
  }
  const now = Date.parse(`${today}T00:00:00+08:00`)
  const days = Math.floor((now - started) / DAY_MS)
  if (!Number.isFinite(days) || days < 0) return { id: rec.id, why: 'clock-back' }
  if (days >= SESSION_LIFESPAN_DAYS) {
    log(`上一条值班会话用了 ${days} 天（上限 ${SESSION_LIFESPAN_DAYS} 天），另起一条`)
    return null
  }
  return { id: rec.id, why: `day ${days + 1}/${SESSION_LIFESPAN_DAYS}` }
}
