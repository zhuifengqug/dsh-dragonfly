/**
 * lib/state.mjs —— 家目录的读写、日志、锁、章程铺设、今日计数（会碰磁盘，但不碰 ctx 逻辑）
 * ============================================================================
 * 这一层只做「跟文件打交道」这一件事。调度、额度判断、跑一轮都在别的模块里，
 * 这样这一层可以用临时目录整份测，不需要假 ctx。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** 锁十分钟过期：那一轮崩了也不能永远把自动跑锁死 */
export const LOCK_TTL_MS = 10 * 60 * 1000
/** 日志最多留这么多字节，超了就滚一份 .1 */
export const LOG_MAX_BYTES = 512 * 1024

/** 读 JSON，坏了/不在就返回 fallback（绝不抛） */
export function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8').trim()
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch { return fallback }
}

/** 写 JSON（先写临时文件再改名，断电也不会留半份） */
export function writeJson(file, value) {
  const tmp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 读文本，不在就返回 '' */
export function readText(file) {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return '' }
}

/** 写文本（同样先临时后改名） */
export function writeText(file, text) {
  const tmp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, String(text ?? ''), 'utf8')
  renameSync(tmp, file)
}

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  // 本机时间，日志给人看，不用 UTC
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 往 duty.log 追加一行。
 * 🔴 写日志**永远不能**把调用方搞崩 —— 整段 try/catch，失败就当没写。
 */
export function appendLog(layout, line) {
  try {
    const file = layout.log
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) {
        renameSync(file, `${file}.1`)
      }
    } catch { /* 滚不动就算了 */ }
    writeFileSync(file, `[${stamp()}] ${String(line).replace(/\r?\n/g, ' ⏎ ')}\n`, { encoding: 'utf8', flag: 'a' })
  } catch { /* 日志写不进去不该影响任何事 */ }
}

/** 读日志尾巴（模型那一轮可能吐 GBK，给它一次回退解码的机会） */
export function readLogTail(layout, maxChars = 4000) {
  try {
    if (!existsSync(layout.log)) return ''
    const buf = readFileSync(layout.log)
    const slice = buf.subarray(Math.max(0, buf.length - maxChars * 4))
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(slice) }
    catch { text = new TextDecoder('gbk').decode(slice) }
    return text.slice(-maxChars)
  } catch { return '' }
}

/**
 * 抢运行锁。跨进程（宿主的定时器和手动点两处可能同时想跑）。
 * 语义是 **fail-open**：读不懂锁就当作没锁 —— 宁可多跑一次，也不要永远不跑。
 */
export function acquireLock(layout, who = 'auto') {
  const now = Date.now()
  const cur = readJson(layout.lock, null)
  if (cur && typeof cur.pid === 'number' && Number(cur.ts) > now - LOCK_TTL_MS && cur.pid !== process.pid) {
    // 那个进程还在吗？在就老实等着
    try {
      process.kill(cur.pid, 0)
      return { ok: false, holder: cur }
    } catch { /* 进程没了 ⇒ 锁是僵尸，抢过来 */ }
  }
  const lock = { pid: process.pid, ts: now, who }
  try {
    writeJson(layout.lock, lock)
    return { ok: true, lock }
  } catch (e) {
    // 锁文件写不进去也不该挡住跑一轮
    return { ok: true, lock, warning: `锁文件写不进去（${e?.code || e?.message}），这次没上锁` }
  }
}

/** 放锁：只放自己那把 */
export function releaseLock(layout) {
  try {
    const cur = readJson(layout.lock, null)
    if (cur && cur.pid === process.pid) unlinkSync(layout.lock)
  } catch { /* 放不掉就算了，反正十分钟会过期 */ }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * 把章程从插件目录铺到家里。
 * 三种情形：
 *   · 家里没有 ⇒ 直接铺
 *   · 家里那份 === 上次铺的那份（用户没动过）⇒ 覆盖升级
 *   · 家里那份被用户改过 ⇒ **一个字都不动**，新版另存 `duty.md.new`，日志留一句
 * @returns {{state:'ok'|'kept'|'failed', detail:string}}
 */
export function ensureCharter(pluginCharter, layout, log = () => {}) {
  try {
    if (!existsSync(pluginCharter)) return { state: 'failed', detail: '插件里没找到章程文件' }
    const src = readFileSync(pluginCharter, 'utf8')
    const srcSha = sha256(src)
    if (!existsSync(layout.duty)) {
      writeText(layout.duty, src)
      writeText(layout.charterSha, srcSha)
      log('章程：第一次铺到家里')
      return { state: 'ok', detail: '已铺章程' }
    }
    const localSha = sha256(readFileSync(layout.duty, 'utf8'))
    const lastSha = readText(layout.charterSha).trim()
    if (localSha === srcSha) {
      writeText(layout.charterSha, srcSha)
      return { state: 'ok', detail: '章程已是最新' }
    }
    if (lastSha && localSha === lastSha) {
      writeText(layout.duty, src)
      writeText(layout.charterSha, srcSha)
      log('章程：插件里那份更新了，覆盖家里的')
      return { state: 'ok', detail: '章程已升级' }
    }
    // 用户改过 —— 不碰
    writeText(`${layout.duty}.new`, src)
    log('章程：家里那份被你改过，没覆盖，新版另存 duty.md.new')
    return { state: 'kept', detail: '你改过章程，没覆盖（新版在 duty.md.new）' }
  } catch (e) {
    log(`章程铺设失败：${e?.message || e}`)
    return { state: 'failed', detail: String(e?.message || e) }
  }
}

/** 把随包的文件铺到家里（用 `.shipped-<名>.sha` 记账；改过也覆盖，但先备份） */
export function ensureHomeFile(srcFile, destFile, layout, log = () => {}) {
  try {
    if (!existsSync(srcFile)) return { state: 'missing' }
    const src = readFileSync(srcFile)
    const srcSha = sha256(src)
    const ledger = join(dirname(destFile), `.shipped-${destFile.split(/[\\/]/).pop()}.sha`)
    if (!existsSync(destFile)) {
      mkdirSync(dirname(destFile), { recursive: true })
      copyFileSync(srcFile, destFile)
      writeText(ledger, srcSha)
      return { state: 'ok' }
    }
    const localSha = sha256(readFileSync(destFile))
    if (localSha === srcSha) { writeText(ledger, srcSha); return { state: 'ok' } }
    // 家里那份变了（用户改过 or 旧版本）—— 备份再覆盖
    const bak = `${destFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try { copyFileSync(destFile, bak) } catch { /* 备份不了也继续 */ }
    copyFileSync(srcFile, destFile)
    writeText(ledger, srcSha)
    log(`铺文件：${destFile.split(/[\\/]/).pop()} 覆盖了一次（旧的在 ${bak.split(/[\\/]/).pop()}）`)
    return { state: 'ok', backup: bak }
  } catch (e) {
    log(`铺文件失败：${e?.message || e}`)
    return { state: 'failed', detail: String(e?.message || e) }
  }
}

/** 今日计数（额度、抖音分钟数、手动次数都记这儿） */
export function emptyDaily(day) {
  return {
    day,
    picked: { bili: 0, douyin: 0, aihot: 0 },
    autoRuns: 0,
    manualRuns: 0,
    dySeconds: 0,
    lastManualAt: 0,
    windowsDone: [],
    // 每个窗口试过几次（失败不再白吃窗口：成功了才进 windowsDone）
    windowTries: {},
  }
}

/** 读今日计数；跨天了就重置（顺手返回上一份，给"昨天"的展示留个余地） */
export function loadDaily(layout, day) {
  const cur = readJson(layout.state, null)
  if (!cur || cur.day !== day) return { daily: emptyDaily(day), fresh: true }
  return { daily: { ...emptyDaily(day), ...cur }, fresh: false }
}

/** 存今日计数 */
export function saveDaily(layout, daily) {
  writeJson(layout.state, daily)
}

/** 今天自动跑过几次（真跑起来的，不是"到点了但因为额度没跑"） */
export function autoPickedToday(daily) {
  const p = pickedBySource(daily)
  return p.bili + p.douyin
}

/** 今天每个源各收了几条（日报是当天累积的，所以这也是当天已用额度） */
export function pickedBySource(daily) {
  const p = daily?.picked || {}
  return {
    bili: Number(p.bili) || 0,
    douyin: Number(p.douyin) || 0,
    aihot: Number(p.aihot) || 0,
  }
}
