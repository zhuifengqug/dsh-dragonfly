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
 *   而值班轮是 `spawn(dsh … '--profile' 'dragonfly-duty' prompt)` 起的独立进程：
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
 *
 * ⚠️ 拿 registry 必须用「子 fiber」的 ctx：
 *   cordis 的 `ctx.get(name)` 只在**本 fiber inject 过的**服务里查
 *   （`Fiber._store` 按 `Object.keys(this.inject)` 预填，`strict:false` 只放宽激活态校验，
 *   不扩大可见范围）。所以主 ctx 上 `get('workspaceRegistry')` 恒为 undefined。
 *   正确写法是在插件里 `ctx.inject(['workspaceRegistry'], (wc) => …)`，
 *   再把那个子 fiber 的 ctx 交给我们 —— 它的 `wc.workspaceRegistry` 才拿得到。
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
 * 例：`D:\dsh-workspaces\蜻蛉值班` → `--D-dsh-workspaces-~873B~86C9~503C~73ED--`
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

/** 某个 cwd 对应的会话目录（`<root>/<projectKey>`）。编码不合法时返回空串 */
export function sessionDir(root, cwd) {
  if (!root) return ''
  try { return join(root, projectKey(cwd)) } catch { return '' }
}

/** 某个 cwd 名下现有的会话 id（目录名去掉 `session-` 前缀的那一截由调用方拼回） */
export function listSessionIds(root, cwd) {
  if (!root) return []
  const dir = sessionDir(root, cwd)
  if (!dir) return []
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
 * 取工作区服务。
 *
 * 三种取法按顺序试：
 *   1. `ctx.workspaceRegistry` —— 注入过的话 cordis 会把它直接挂成 ctx 的属性；
 *   2. `ctx.get('workspaceRegistry')` —— 老写法，只在 inject 里声明过时才拿得到；
 *   3. `ctx.get('workspaceRegistry', false)` —— 放宽激活态校验（不扩大可见范围）。
 */
export function pickRegistry(ctx) {
  if (!ctx) return null
  try { if (ctx.workspaceRegistry) return ctx.workspaceRegistry } catch { /* ignore */ }
  try { const r = ctx.get?.('workspaceRegistry'); if (r) return r } catch { /* ignore */ }
  try { const r = ctx.get?.('workspaceRegistry', false); if (r) return r } catch { /* ignore */ }
  return null
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
  const registry = pickRegistry(ctx)
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

/**
 * 开机对一次账：目录里有的补进去，记账里已经没文件的摘出来。
 *
 * 为什么需要：会话记账只在两种时机改 —— 用户从工作区发起会话（attach）、
 * 或者我们自己认领（watchNewSession）。这两条都要求"当时插件活着"。
 * 插件重装/应用升级/那一轮异常退出，都会留下"目录里有会话、记账里没有"的空档；
 * 反过来，手工删过会话文件的话，记账里就会留着指向空处的 id。
 *
 * 这一步只碰「cwd 等于这个工作区 path」的那一个工作区，不认识的一律不动。
 * 已经对的 id 不会重复写（attach 里先查、detach 只摘不存在的），所以开机跑不心疼。
 *
 * @returns {Promise<{ok:boolean, attached?:number, detached?:number, reason?:string}>}
 */
export async function reconcileWorkspace(ctx, cwd, live = [], log = () => {}) {
  const registry = pickRegistry(ctx)
  if (!registry || typeof registry.resolveByPath !== 'function') return { ok: false, reason: 'no-registry' }
  let ws
  try { ws = await registry.resolveByPath(cwd) } catch (e) {
    return { ok: false, reason: `resolve-failed: ${e?.message || e}` }
  }
  if (!ws) return { ok: false, reason: 'no-workspace' }

  const alive = new Set(live)
  const current = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
  const missing = [...alive].filter((id) => !current.includes(id))
  const dead = current.filter((id) => !alive.has(id))

  let attached = 0
  let detached = 0
  for (const id of missing) {
    try {
      await ws.attachSession(id)
      attached += 1
    } catch (e) {
      log(`补记会话 ${id} 没成：${e?.message || e}`)
    }
  }
  for (const id of dead) {
    try {
      await ws.detachSession(id)
      detached += 1
    } catch (e) {
      log(`摘掉失效会话 ${id} 没成：${e?.message || e}`)
    }
  }
  // 无论有没有变化都留一行：上一轮出问题就出在「什么都没做」和「做了 0 件事」
  // 在日志里长得一模一样，查了半天不知道它到底跑没跑。
  log(`工作区对账：磁盘 ${alive.size} 个 / 记账 ${current.length} 个 → 补进 ${attached}、摘掉 ${detached}`)
  return { ok: true, attached, detached }
}
