/**
 * lib/duty-session.mjs —— 值班轮的会话「用到快满为止」
 * ============================================================================
 * 要的是什么：
 *   工作区里不要每轮冒一条新会话，也别按日子一刀切。同一条会话一直接着写，
 *   直到它的上下文快装满（看会话文件里最后一条 assistant 的 usage.totalTokens），
 *   这一轮才另起一条新的。所以工作区里一条条攒着，一条都不删。
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
 * 上下文占用的来源：
 *   会话文件 `session.v4.jsonl.zstd` 是**多帧 zstd 拼接**（一帧一条记录），
 *   Node 的 `zstdDecompressSync` 只解第一帧，所以这里按 magic `28 b5 2f fd`
 *   扫出每一帧逐帧解，再挑最后一条带 `usage.totalTokens` 的记录。
 *   那个数字就是模型这一轮看到的上下文大小（含缓存命中），拿它跟软上限比。
 *
 * 为什么还要校验一遍 cwd / 文件在不在：
 *   换了工作区目录、或手工删过会话文件，`--session-id` 就会整轮失败。
 *   与其让那一轮白跑，不如在这里先判掉、当它过期，另起一条。
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { projectKey } from './workspace-link.mjs'

/** 上下文软上限：最后一条 usage.totalTokens 到这儿就另起一条会话 */
export const CONTEXT_LIMIT_TOKENS = 120_000

/** 兜底：测量不出来时，一条会话最多用这么多天（别把一条会话用到天荒地老） */
export const SESSION_MAX_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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

/** 会话文件路径 */
export function dutySessionPath(sessionsRoot, cwd, sessionId) {
  if (!sessionsRoot || !cwd || !sessionId) return ''
  return join(sessionsRoot, projectKey(cwd), String(sessionId), 'session.v4.jsonl.zstd')
}

/**
 * 会话文件是多帧 zstd 拼接的，逐帧解开拼成整段 JSONL。
 * 单个坏帧跳过，不影响后面的帧。
 */
export function decodeSessionText(file) {
  let buf
  try { buf = readFileSync(file) } catch { return '' }
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  if (!starts.length) return ''
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')) } catch { /* 坏帧跳过 */ }
  }
  return parts.join('')
}

/**
 * 这条会话的上下文占用（最后一次模型调用看到的 totalTokens）。
 * 读不出来返回 null —— 调用方就当不知道，不做判断。
 */
export function sessionContextTokens(file) {
  if (!file) return null
  const text = decodeSessionText(file)
  if (!text) return null
  let last = null
  for (const line of text.split('\n')) {
    if (!line || !line.includes('"usage"')) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    const u = findUsage(rec)
    if (!u) continue
    const total = Number(u.totalTokens)
    const input = Number(u.inputTokens)
    const cacheRead = Number(u.cacheReadTokens)
    const cacheWrite = Number(u.cacheWriteTokens)
    const n = Number.isFinite(total) && total > 0
      ? total
      : (Number.isFinite(input) ? input : 0) + (Number.isFinite(cacheRead) ? cacheRead : 0) + (Number.isFinite(cacheWrite) ? cacheWrite : 0)
    if (Number.isFinite(n) && n > 0) last = n
  }
  return last
}

/** 记录里的 usage 可能直接挂在顶层，也可能在 data/result/response 里 */
function findUsage(rec, depth = 0) {
  if (!rec || typeof rec !== 'object' || depth > 4) return null
  if (rec.usage && typeof rec.usage === 'object') return rec.usage
  for (const k of ['data', 'result', 'response', 'message', 'payload', 'record']) {
    if (rec[k] && typeof rec[k] === 'object') {
      const hit = findUsage(rec[k], depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/**
 * 这一轮该接着写哪条会话？
 *
 * 规则：同一条一直接着写，直到上下文快到软上限、或文件没了、或用了太久。
 *
 * @returns {{id:string, why:string}|null} `null` = 该新建一条
 */
export function pickDutySession({ layout, sessionsRoot, cwd, today, limit = CONTEXT_LIMIT_TOKENS, log = () => {} }) {
  const rec = loadDutySession(layout, log)
  if (!rec) {
    // 还没有记录（第一次用、或升级上来的）：**认领目录里最新的那条**，别再新建一条。
    // 否则"第一次跑"就凭空多出一点，用户看到的是"又冒出来一条新会话"。
    const newest = newestSession(sessionsRoot, cwd)
    if (!newest) return null
    log(`还没有值班会话的记录，认领目录里最新那条 ${newest.id}（从 ${newest.startedOn} 算起）`)
    saveDutySession(layout, newest, log)
    return { id: newest.id, why: 'adopted' }
  }
  const file = dutySessionPath(sessionsRoot, cwd, rec.id)
  if (!dutySessionFileExists(sessionsRoot, cwd, rec.id)) {
    log(`上一条值班会话（${rec.id}）的文件不在了，另起一条`)
    return null
  }

  // 1) 上下文快满了没有 —— 这是主要判据
  const tokens = sessionContextTokens(file)
  if (tokens !== null) {
    if (tokens >= limit) {
      log(`上一条值班会话的上下文已经 ${fmtK(tokens)}（软上限 ${fmtK(limit)}），另起一条`)
      return null
    }
    return { id: rec.id, why: `上下文 ${fmtK(tokens)}/${fmtK(limit)}` }
  }

  // 2) 测不出来时只看天数兜底
  const days = daysBetween(rec.startedOn, today)
  if (Number.isFinite(days) && days >= SESSION_MAX_DAYS) {
    log(`上一条值班会话用了 ${days} 天（兜底上限 ${SESSION_MAX_DAYS} 天，上下文读不出来），另起一条`)
    return null
  }
  return { id: rec.id, why: `上下文读不出来，按天数 ${Number.isFinite(days) ? days + 1 : 1}/${SESSION_MAX_DAYS} 接着用` }
}

function fmtK(n) {
  return `${Math.round(Number(n) / 1000)}K`
}

/** 两个日历天之间差几天（都是北京时间的 `YYYY-MM-DD`） */
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00+08:00`)
  const b = Date.parse(`${to}T00:00:00+08:00`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN
  return Math.floor((b - a) / DAY_MS)
}

/**
 * 目录里最新的那条会话（按会话文件 mtime 排），起始日取文件 mtime 那天。
 * 给「还没有记录」时认领用。
 */
export function newestSession(sessionsRoot, cwd) {
  const dir = sessionsRoot && cwd ? join(sessionsRoot, projectKey(cwd)) : ''
  if (!dir || !existsSync(dir)) return null
  let best = null
  let entries = []
  try { entries = readdirSync(dir) } catch { return null }
  for (const id of entries) {
    const file = join(dir, id, 'session.v4.jsonl.zstd')
    try {
      const st = statSync(file)
      if (!st.isFile() || st.size <= 0) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { id, mtimeMs: st.mtimeMs }
    } catch { /* 没有会话文件就不是会话目录 */ }
  }
  if (!best) return null
  const d = new Date(best.mtimeMs)
  // 换成北京时间的日历天（Node 没开 TZ 时本地时区就是系统时区，这里自己算偏移）
  const cn = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const startedOn = cn.toISOString().slice(0, 10)
  return { id: best.id, startedOn }
}
