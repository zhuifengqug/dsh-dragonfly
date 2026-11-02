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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BrowserController } from '../dy/core.mjs'
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
 * @param {{layout: object | (() => object), origin: () => string|undefined, log?: Function}} opts
 *   `layout` 可以传函数 —— 家目录是能改的，改完这里得跟着走。
 */
export function createDyHost({ layout, origin, log = () => {} }) {
  const lay = typeof layout === 'function' ? layout : () => layout
  let controller = null
  let token = ''

  /** 有浏览器就复用；没有就造一个（构造本身不连浏览器，connection 是惰性的） */
  function getController() {
    if (controller) return controller
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

  /** `/api/caifeng/dy/<action>` 的实际处理：查表 → 交给 dy/tools.mjs */
  async function handle(action, body = {}) {
    const fn = DY_ACTIONS[action]
    if (typeof fn !== 'function') {
      return { ok: false, reason: 'unknown-action', hint: `不认识的抖音动作：${action}` }
    }
    return fn({ ...body, controller: getController() })
  }

  /** 关掉 CDP 连接（**不关浏览器**，登录态要留着） */
  async function close() {
    if (!controller) return { ok: true, closed: false }
    try { return await controller.close() } catch { return { ok: true, closed: false } }
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

  return { publish, checkToken, handle, close, status, getController }
}

/** 读宿主地址文件（也用作排障：桥那边读不到时，看看宿主到底写没写） */
export function readHostRecord(layout) {
  try {
    const raw = JSON.parse(readFileSync(hostRecordFile(layout), 'utf8'))
    return { baseUrl: String(raw?.baseUrl || ''), token: String(raw?.token || '') }
  } catch { return null }
}
