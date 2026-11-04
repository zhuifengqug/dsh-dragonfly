/**
 * lib/workspace-link.mjs —— 让值班轮那一轮的会话，一落盘就挂进工作区
 * ============================================================================
 * 为什么要这一层：
 *   会话的「工作区归属」= `workspace.json` 里那个工作区的 `sessionIds` 数组，
 *   而唯一的官方写法是 `workspaceRegistry` 上的 `WorkspaceEntity.attachSession()`。
 *
 *   它**没有**在启动时补齐的机制：
 *     - `dsh-workspace` 的 `bootstrap()` 只在 `state.initialized === false` 时跑一次，
 *       之后启动只刷 header 索引，不会把「cwd 相符但没记账」的会话补进工作区；
 *     - `attachSession()` 的全仓调用点只有 `dsh-api-session-controller` 的
 *       `SessionService.create()` / 子会话创建 —— 都是"从某个工作区发起"的会话。
 *
 *   而值班轮是 `spawn(dsh … '--profile' 'caifeng-duty' prompt)` 起的独立进程：
 *   它只带 cwd、不带 workspaceId，所以永远走不到那个 attach。
 *   ⇒ 只能由宿主这一侧在会话出现时补一次记账。
 *
 * 为什么用「盯着目录 + attachSession」而不是自己写 workspace.json：
 *   `dsh-storage-json` 的写入是整文件 tmp+rename、**以内存态为准**。
 *   应用在跑的时候，任何外部对 `workspace.json` 的修改都会被下一次工作区操作覆盖回内存里的样子
 *   （本会话真机上翻过一次车）。走 `attachSession()` 才会同时改内存与磁盘。
 *
 * 为什么不自己拼 session 文件、再用 `--session-id` 让那一轮接管：
 *   - 手拼 zstd 多帧会话日志出过一次事故（16 个会话只剩头部），不再碰字节；
 *   - headless 的 `assertAdoptable()` 还会拦住带 `agent-preset/selected` 的会话。
 *   ⇒ 让它自己建会话，我们只负责"建完立刻认领"。
 * ============================================================================
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 会话目录名的编码规则（与宿主 `dsh-session-persistence-jsonl` 的 `projectKey()` 逐字对齐）。
 *
 * `/ \ :` 连续折叠成一个 `-`；`~` 与所有非 `[A-Za-z0-9._-]` 字符 → `~` + 4 位大写十六进制；
 * 外包 `--…--`，去掉前导 `-`，截断 251 字符。
 *
 * 例：`D:\dsh-workspaces\采风值班` → `--D-dsh-workspaces-~91C7~98CE~503C~73ED--`
 */
export function projectKey(cwd) {
  const text = String(cwd ?? '')
  if (!text) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 会话根目录：`<DSH_HOME>/sessions`。拿不到就返回空串（调用方据此跳过） */
export function sessionsRoot(ctx, fallbackHome) {
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('sessions')
      if (v) return String(v)
    } else if (typeof p === 'string' && p) {
      return join(p, 'sessions')
    }
  } catch { /* 落到下面 */ }
  const home = String(fallbackHome || process.env.DSH_HOME || '').trim()
  return home ? join(home, 'sessions') : ''
}

/** 某个 cwd 名下现有的会话 id（目录名去掉 `session-` 前缀的那一截由调用方拼回） */
export function listSessionIds(root, cwd) {
  if (!root) return []
  let dir
  try { dir = join(root, projectKey(cwd)) } catch { return [] }
  let names
  try { names = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const ent of names) {
    if (!ent.isDirectory()) continue
    const full = join(dir, ent.name)
    try { if (!statSync(join(full, 'session.v4.jsonl.zstd')).isFile()) continue } catch { continue }
    out.push(ent.name)
  }
  return out
}

/**
 * 盯着会话目录，出现「平时没有的」会话就交给 `onAppear(id)`。
 *
 * 只做一次认领（认领成功即停），失败也继续试到超时 —— 因为会话文件是
 * headless 进程那边异步落盘的，早几毫秒还读不到 header 属正常。
 *
 * @returns {{stop:Function, done:Promise<string|null>}}
 */
export function watchNewSession({ root, cwd, before = [], onAppear, pollMs = 400, timeoutMs = 60_000, unref = true, log = () => {} }) {
  const known = new Set(before)
  let timer = null
  let deadlineTimer = null
  let settled = false
  let resolveDone
  const done = new Promise((r) => { resolveDone = r })

  const finish = (id) => {
    if (settled) return
    settled = true
    if (timer) clearInterval(timer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    timer = null
    deadlineTimer = null
    resolveDone(id ?? null)
  }

  const tick = async () => {
    if (settled) return
    const now = listSessionIds(root, cwd)
    const fresh = now.filter((id) => !known.has(id))
    if (!fresh.length) return
    // 一个会话目录 = 一轮；多出来的（理论上没有）取第一个能认领的
    for (const id of fresh) {
      try {
        const ok = await onAppear?.(id)
        if (ok !== false) return finish(id)
      } catch (e) {
        log(`认领会话 ${id} 没成：${e?.message || e}`)
      }
    }
  }

  if (!root) { finish(null); return { stop: () => finish(null), done } }
  timer = setInterval(() => { tick().catch(() => {}) }, pollMs)
  if (unref) timer.unref?.()
  deadlineTimer = setTimeout(() => finish(null), timeoutMs)
  if (unref) deadlineTimer.unref?.()
  tick().catch(() => {})
  return { stop: () => finish(null), done }
}

/**
 * 把某个会话挂进「path 等于 cwd」的那个工作区。
 *
 * `attachSession()` 自己会把关：读会话头部、要求 `header.cwd` 与工作区 path 严格相等，
 * 不符就抛错。所以这里不需要重复校验，只要把错误说清楚。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function attachToWorkspace(ctx, cwd, sessionId, log = () => {}) {
  let registry = ctx?.get?.('workspaceRegistry')
  // 宿主里这个服务可能刚起来（strict 只认 active 的实现）—— 退一步再取一次，
  // 拿到就用；还是拿不到才当作"这个宿主没有工作区"。
  if (!registry) { try { registry = ctx?.get?.('workspaceRegistry', false) } catch { /* ignore */ } }
  if (!registry || typeof registry.resolveByPath !== 'function') {
    return { ok: false, reason: 'no-registry' }
  }
  let ws
  try { ws = await registry.resolveByPath(cwd) } catch (e) {
    return { ok: false, reason: `resolve-failed: ${e?.message || e}` }
  }
  if (!ws) return { ok: false, reason: 'no-workspace' }
  try {
    if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) return { ok: true, reason: 'already' }
    await ws.attachSession(sessionId)
    log(`会话 ${sessionId} 已挂进工作区「${ws.record?.title ?? cwd}」`)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) }
  }
}
