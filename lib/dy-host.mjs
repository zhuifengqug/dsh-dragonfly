/**
 * lib/dy-host.mjs —— 抖音这一头在**宿主进程**里的样子
 * ============================================================================
 * 分工要说清楚，不然很容易写出两套浏览器：
 *
 *   宿主进程（这里）        持有一个 BrowserController，真起专用 Edge，真截图
 *   duty 子进程             只经 MCP 桥转发到 /api/caifeng/dy/<action>，不碰浏览器
 *
 * 所以这个文件有三个职责，缺一个抖音链路就断：
 *   ① 惰性造一个 BrowserController（同一进程里只能有一台专用 Edge）
 *   ② 把宿主地址 + 令牌写进 `<家>/dy/control/host.json`（桥靠它找回来）
 *   ③ 校验桥带来的令牌（只有本机那次 handshake 写下的令牌能进来）
 * ============================================================================
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { BrowserController } from '../dy/core.mjs'
import { shutdownBrowser } from '../dy/browser-host.mjs'
import { DY_ACTIONS } from '../dy/tools.mjs'

/** 宿主地址文件（桥读它；宿主每次起来都会重写） */
function controlDir(layout) {
  return join(layout.home, 'dy', 'control')
}

export function hostRecordFile(layout) {
  return join(controlDir(layout), 'host.json')
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temporary, file)
}

/**
 * 造一个「抖音这一头」的双面对象。
 * @param {{layout: object | (() => object), origin: () => string|undefined, budget?: () => ({limit:number, used:number, spend:(sec:number)=>void}|null), controller?: () => object, log?: Function}} opts
 *   `layout` 可以传函数 —— 家目录是能改的，改完这里得跟着走。
 *   `budget` 也传函数：每日分钟数是设置页随时能改的，且当天用量每轮都在变。
 *   `controller` 是造浏览器的工厂，测试时换成假的就不用真起 Edge。
 */
export function createDyHost({ layout, origin, budget, controller: makeController, log = () => {} }) {
  const lay = typeof layout === 'function' ? layout : () => layout
  let controller = null
  let token = ''

  /** 真正在「往回看」的动作。`state` 只读一次当前状态，不算看。 */
  const WATCH_ACTIONS = new Set(['open', 'next', 'frames'])

  /** 有浏览器就复用；没有就造一个（构造本身不连浏览器，connection 是惰性的） */
  function getController() {
    if (controller) return controller
    if (typeof makeController === 'function') {
      controller = makeController()
      return controller
    }
    controller = new BrowserController({
      home: lay().home,
      log: (line) => log(`抖音：${line}`),
    })
    return controller
  }

  /**
   * 把宿主地址写下来。
   * 每次（重新）注册路由都调一次 —— 端口可能变，令牌也换新的（旧桥进程会被 MCP 进程退出带走）。
   */
  function publish() {
    const base = String(origin?.() || '').trim()
    if (!base) {
      log('抖音：拿不到宿主监听地址（webServer.getOrigin 没返回），桥会找不到回来的路')
      return { ok: false, reason: 'no-origin' }
    }
    token = randomBytes(16).toString('hex')
    const file = hostRecordFile(lay())
    try {
      writeJsonAtomic(file, { version: 1, baseUrl: base, token, updatedAt: Date.now() })
      log(`抖音：宿主地址已写给桥（${base}）`)
      return { ok: true, file, baseUrl: base }
    } catch (e) {
      log(`抖音：宿主地址写不进去（${e?.message || e}）`)
      return { ok: false, reason: 'write-failed', detail: String(e?.message || e) }
    }
  }

  /** 令牌对不对（没写过令牌 = 还没握手，一律拒） */
  function checkToken(given) {
    if (!token) return false
    return typeof given === 'string' && given.length === token.length && given === token
  }

  /**
   * `/api/caifeng/dy/<action>` 的实际处理：过额度闸 → 查表 → 交给 dy/tools.mjs。
   *
   * 每日分钟数（`dyDailyMinutes`）在这里才真的是闸门 —— 章程里那句"最多看 N 分钟"
   * 只是嘱咐，模型不一定照做；这个数字是宿主自己数的，数到了就回 `daily-limit`，
   * 那一轮拿到失败就收手，不用靠自觉。
   */
  async function handle(action, body = {}) {
    const fn = DY_ACTIONS[action]
    if (typeof fn !== 'function') {
      return { ok: false, reason: 'unknown-action', hint: `不认识的抖音动作：${action}` }
    }

    const watching = WATCH_ACTIONS.has(action)
    let b = null
    if (watching && typeof budget === 'function') {
      try { b = budget() } catch { b = null }
      if (b && b.limit > 0 && b.used >= b.limit * 60) {
        const mins = Math.round(b.limit)
        log(`抖音：今天的 ${mins} 分钟已经看完了，${action} 不再放行`)
        return {
          ok: false,
          reason: 'daily-limit',
          hint: `今天抖音的 ${mins} 分钟已经看完了（已用 ${Math.round(b.used / 60)} 分钟）。这一轮抖音到此为止，去写日报。`,
        }
      }
    }

    const startedAt = Date.now()
    try {
      return await fn({ ...body, controller: getController() })
    } finally {
      // 只有真的"看了"的动作才计时间；读一次 state 不算。
      if (watching && b && typeof b.spend === 'function') {
        try { b.spend(Math.max(0, Date.now() - startedAt) / 1000) } catch { /* 记账失败不该毁掉这一轮 */ }
      }
    }
  }

  /** 关掉 CDP 连接（**不关浏览器**，登录态要留着） */
  async function close() {
    if (!controller) return { ok: true, closed: false }
    try { return await controller.close() } catch { return { ok: true, closed: false } }
  }

  /**
   * 重置登录态：关掉那台 Edge → 把 profile 目录改名留底 → 清掉端口记录。
   * 抖音那边扫码过期、或者账号被踢下线时，这是唯一能自救的按钮（删目录要人手动做太劝退）。
   */
  async function reset() {
    const l = lay()
    controller = null
    const shut = await shutdownBrowser({ home: l.home, log: (line) => log(`抖音：${line}`) })
    if (!shut.ok) return shut
    let renamed = ''
    if (existsSync(l.dyProfile)) {
      const to = `${l.dyProfile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      for (let i = 0; i < 6; i += 1) {
        try { renameSync(l.dyProfile, to); renamed = to; break }
        catch { await new Promise((r) => setTimeout(r, 400)) }
      }
    }
    try { rmSync(join(controlDir(l), 'port.json'), { force: true }) } catch { /* 没有就算了 */ }
    return {
      ok: true,
      closed: Boolean(shut.closed),
      renamed,
      text: renamed
        ? `登录态重置了（旧的留在 ${basename(renamed)}）。下一次跑会重新拉起 Edge，让你在里面扫一次码。`
        : '浏览器关掉了，但 profile 目录没能改名（多半还被占着）。把那个 Edge 窗口关干净再点一次。',
    }
  }

  /** 设置页要看的那几项 */
  function status() {
    const l = lay()
    const file = hostRecordFile(l)
    return {
      profile: existsSync(l.dyProfile),
      published: existsSync(file),
      baseUrl: readHostRecord(l)?.baseUrl || '',
      live: Boolean(controller),
    }
  }

  return { publish, checkToken, handle, close, reset, status, getController }
}

/** 读宿主地址文件（也用作排障：桥那边读不到时，看看宿主到底写没写） */
export function readHostRecord(layout) {
  try {
    const raw = JSON.parse(readFileSync(hostRecordFile(layout), 'utf8'))
    return { baseUrl: String(raw?.baseUrl || ''), token: String(raw?.token || '') }
  } catch { return null }
}
