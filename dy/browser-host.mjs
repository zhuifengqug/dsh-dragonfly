/**
 * dy/browser-host.mjs —— 拉起 / 复用一台专用 Edge（持久化 user-data-dir）
 * ============================================================================
 * 三条硬规矩：
 *   ① **端口不写死**。旧插件把 9227 钉死了，两边同时开就抢端口；这里改成
 *      「读 `<home>/dy/control/port.json` 记的端口，没有就在 9227–9327 之间挑一个
 *      没被占用的，再写回该文件」。
 *   ② **浏览器跑完不关**。登录态活在 user-data-dir 里，每次跑完都关窗口等于让人
 *      重新扫码一次；只有显式 `closeBrowser()` 才真关。
 *   ③ **playwright-core 用动态 import**。宿主那棵树里不一定装它，import 期抛异常
 *      会让整条插件不激活 —— 所以失败一律返回结构化 `{ ok:false, reason, hint }`。
 * ============================================================================
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 端口扫描区间（避开旧插件的固定 9227 只会「优先尝试」，不是独占） */
export const PORT_MIN = 9227
export const PORT_MAX = 9327

/** 只认 Edge：抖音不接受被识别成 headless 的浏览器，退化成 headless 等于直接失败 */
export const EDGE_CHANNEL = 'msedge'

/** 家目录下的固定布局（纯函数，不碰磁盘） */
export function controlPaths(home) {
  const root = path.resolve(String(home))
  const controlDir = path.join(root, 'dy', 'control')
  return {
    home: root,
    controlDir,
    profileDir: path.join(root, 'dy', 'profile'),
    /** 上次用的调试端口 */
    portFile: path.join(controlDir, 'port.json'),
    /** 宿主 HTTP 路由的位置 + 令牌（由宿主写，桥只读） */
    hostFile: path.join(controlDir, 'host.json'),
    /** 这台浏览器归谁（排障用） */
    ownerFile: path.join(controlDir, 'browser.json'),
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 原子写：先写 .tmp 再 rename，别让半个 JSON 留在盘上 */
function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temporary, file)
}

/** 读端口记录；坏了 / 不在区间 / 不存在都返回 null（不抛） */
export function readPortRecord(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    const port = Number(value?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { port, recordedAt: Number(value?.recordedAt) || null }
  } catch {
    return null
  }
}

export function writePortRecord(file, port) {
  writeJson(file, { version: 1, port, recordedAt: Date.now() })
}

/** 端口能不能被我们独占（listen 一下立刻关） */
export function probePort(port) {
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const done = (free) => {
      if (settled) return
      settled = true
      try { server.close() } catch { /* 已经关了 */ }
      resolve(free)
    }
    server.once('error', () => done(false))
    server.once('listening', () => server.close(() => done(true)))
    try {
      server.listen({ port, host: '127.0.0.1', exclusive: true })
    } catch {
      done(false)
    }
  })
}

/**
 * 挑端口：先试上次记录的那个（能续用就续用，标签页里的登录态跟端口无关但省一次折腾），
 * 再按 9227→9327 顺序找第一个空闲的。挑到就写回 port.json。
 */
export async function pickPort({ file, min = PORT_MIN, max = PORT_MAX, probe = probePort } = {}) {
  const candidates = []
  const recorded = file ? readPortRecord(file) : null
  if (recorded) candidates.push(recorded.port)
  for (let port = min; port <= max; port++) if (!candidates.includes(port)) candidates.push(port)
  for (const port of candidates) {
    const free = await probe(port)
    if (!free) continue
    if (file) {
      try { writePortRecord(file, port) } catch { /* 记不下来也能用，只是下次要重挑 */ }
    }
    return port
  }
  return null
}

/**
 * 这个端口上是不是已经有一个能用的 CDP 调试口。
 *
 * 为什么需要它：`probePort` 只回答「这个端口空着吗」。可我们**跑完不关浏览器**，
 * 上一轮那台 Edge 会一直占着 9227。于是 probePort 说「9227 不空」⇒ 挑到 9228 ⇒
 * 拿同一个资料目录再 launchPersistentContext ⇒ Edge 的单例把新进程转发给老进程后
 * 立刻退出 ⇒ `launch-failed`，那一轮抖音就成了 unknown。
 * 正确做法是**先找活着的接管**，实在没有才考虑新开。
 */
export async function probeCdp(port, timeoutMs = 600) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const info = await response.json().catch(() => null)
    return Boolean(info?.webSocketDebuggerUrl)
  } catch {
    return false
  }
}

/**
 * 找一个已经活着的调试端口：先看 port.json 记的那个，再按区间分批并发扫。
 * 找到就返回端口号，找不到返回 null。
 */
export async function findLiveCdp({ file, min = PORT_MIN, max = PORT_MAX, probe = probeCdp } = {}) {
  const recorded = file ? readPortRecord(file) : null
  const candidates = []
  if (recorded) candidates.push(recorded.port)
  for (let port = min; port <= max; port++) if (!candidates.includes(port)) candidates.push(port)

  const CHUNK = 16
  for (let index = 0; index < candidates.length; index += CHUNK) {
    const batch = candidates.slice(index, index + CHUNK)
    const hits = await Promise.all(batch.map(async (port) => ((await probe(port)) ? port : null)))
    const alive = hits.filter((port) => port !== null)
    if (alive.length) return alive[0]
  }
  return null
}

/** 常见 Edge 安装位置（只用来把「没找到 Edge」说清楚，不参与启动） */
export function findEdgeExecutable(env = process.env, exists = existsSync) {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]
    .filter(Boolean)
    .map((root) => String(root))
  for (const root of roots) {
    const file = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    if (exists(file)) return file
  }
  return null
}

/**
 * 动态加载 playwright-core。
 * 拿不到时**不抛** —— 返回结构化失败，让上层把它翻译成一句人话。
 *
 * 为什么不能只写 `import('playwright-core')`：本插件自己不带这个依赖（它 60MB+，
 * 而且得跟宿主 Electron 的 shim 版本对上），宿主那棵树里也未必有。真正装着它的
 * 是**别的 profile**（刷抖音那套靠传递依赖拿到的）。所以按下面的顺序找：
 *   ① 环境变量 CAIFENG_PLAYWRIGHT 指过去（模块目录或入口文件都行）
 *   ② 插件自己 node_modules 里（npm i playwright-core 之后）
 *   ③ 每个 `<DSH_HOME>/profiles/<名>/node_modules/playwright-core`
 *   ④ 宿主 npm 全局树
 * 找到目录就手工解析 package.json 的 exports['.']，用 file URL 导入 —— 这样不依赖
 * Node 的模块解析能爬到兄弟目录。
 */
export function candidatePlaywrightRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  const env = process.env.CAIFENG_PLAYWRIGHT || process.env.PLAYWRIGHT_CORE_PATH
  if (env) push(env)
  // 插件自己
  push(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'node_modules', 'playwright-core'))
  // 每个 profile
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  try {
    for (const name of readdirSync(path.join(home, 'profiles'))) {
      push(path.join(home, 'profiles', name, 'node_modules', 'playwright-core'))
    }
  } catch { /* 没有 profiles 目录就算了 */ }
  // 宿主 npm 全局树
  const appData = process.env.APPDATA || ''
  if (appData) push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'playwright-core'))
  if (appData) push(path.join(appData, 'npm', 'node_modules', 'playwright-core'))
  return out
}

/** 按 package.json 的 exports 手工解出入口文件（找不到就返回 null） */
function entryOfPackage(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const dot = pkg?.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : dot?.import || dot?.default || dot?.require || pkg.module || pkg.main
    if (!rel) return null
    const file = path.resolve(dir, rel)
    return existsSync(file) ? file : null
  } catch { return null }
}

export async function loadPlaywright() {
  const tried = []
  let mod = null
  // ① 先按正常模块解析试（插件自己装了就会命中）
  try {
    mod = await import('playwright-core')
  } catch (error) {
    tried.push(`bare: ${error?.code || error?.message || error}`)
  }
  // ② 再按候选根目录逐个手工导入
  if (!mod) {
    for (const dir of candidatePlaywrightRoots()) {
      const file = entryOfPackage(dir)
      if (!file) { tried.push(`${dir}: 没有可用入口`); continue }
      try {
        mod = await import(pathToFileURL(file).href)
        if (mod) break
      } catch (error) {
        tried.push(`${dir}: ${error?.code || error?.message || error}`)
      }
    }
  }
  if (!mod) {
    return {
      ok: false,
      reason: 'no-playwright',
      hint:
        '没找到 playwright-core，专用 Edge 起不来（所以这一轮读不了抖音）。' +
        '任选一样：① 在插件目录执行 `npm i playwright-core`；' +
        '② 设环境变量 CAIFENG_PLAYWRIGHT=<playwright-core 目录>；' +
        '③ 确保有某个 profile（比如装了刷抖音那个）里带着它。' +
        `（找过：${tried.slice(0, 4).join('；') || '无'}）`,
      tried,
    }
  }
  const chromium = mod?.chromium ?? mod?.default?.chromium
  if (!chromium?.launchPersistentContext || !chromium?.connectOverCDP) {
    return {
      ok: false,
      reason: 'no-playwright',
      hint: 'playwright-core 装上了，但这个版本没有 chromium.launchPersistentContext / connectOverCDP。换一个新一点的 playwright-core。',
    }
  }
  return { ok: true, chromium }
}

/** 这台浏览器归谁 —— 只给排障看，不改任何东西 */
export function writeOwnerRecord(file, value) {
  try {
    writeJson(file, { version: 1, pid: process.pid, updatedAt: Date.now(), ...value })
  } catch { /* 记不下来不影响启动 */ }
}

/** 进程内缓存：同一个 Node 进程只拉一次浏览器 */
let runtime = null

export function browserStatus() {
  if (!runtime) return { launched: false, port: null, profileDir: null }
  return { launched: true, port: runtime.port, profileDir: runtime.profileDir, launchedAt: runtime.launchedAt }
}

/**
 * 确保专用 Edge 已经起来（起来就一直留着）。
 *
 * 返回 `{ ok:true, context, port, profileDir }` 或 `{ ok:false, reason, hint }`。
 * **绝不退化 headless**：找不到 Edge 就是找不到，报清楚让人去装。
 */
export async function ensureBrowser({ home, log = () => {} } = {}) {
  if (runtime?.port) return { ok: true, reused: true, ...runtime }

  const paths = controlPaths(home)
  ensureDir(paths.controlDir)
  ensureDir(paths.profileDir)

  const playwright = await loadPlaywright()
  if (!playwright.ok) return playwright

  // 先看看上一轮那台还活着没有 —— 跑完不关浏览器，它多半就在
  const live = await findLiveCdp({ file: paths.portFile })
  if (live) {
    try { writePortRecord(paths.portFile, live) } catch { /* 记不下来也能用 */ }
    runtime = { context: null, port: live, profileDir: paths.profileDir, launchedAt: Date.now(), adopted: true }
    writeOwnerRecord(paths.ownerFile, { port: live, profileDir: paths.profileDir, ready: true, adopted: true })
    log(`接管上一轮还开着的专用 Edge（端口 ${live}）`)
    return { ok: true, reused: true, adopted: true, ...runtime }
  }

  // 先确认 Edge 在不在：不先确认的话，playwright 抛出来的东西又一堆英文，说不清
  const edge = findEdgeExecutable()
  if (!edge) {
    return {
      ok: false,
      reason: 'no-edge',
      hint:
        '没找到 Microsoft Edge（msedge.exe）。这台专用浏览器只认 Edge —— 抖音不接受 headless 浏览器，' +
        '所以这里不会偷偷换成无界面模式。装一下 Edge（或修好它的安装位置）再跑。',
    }
  }

  const port = await pickPort({ file: paths.portFile })
  if (!port) {
    return {
      ok: false,
      reason: 'no-port',
      hint: `${PORT_MIN}–${PORT_MAX} 之间没有空闲端口，专用 Edge 起不来。看看是不是有别的调试浏览器占着这一段。`,
    }
  }

  try {
    const context = await playwright.chromium.launchPersistentContext(paths.profileDir, {
      channel: EDGE_CHANNEL,
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ['--mute-audio'],
      args: [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
    runtime = { context, port, profileDir: paths.profileDir, launchedAt: Date.now(), edge }
    writeOwnerRecord(paths.ownerFile, { port, profileDir: paths.profileDir, ready: true, edge })
    log(`专用 Edge 已启动（端口 ${port}，资料目录 ${paths.profileDir}）`)
    return { ok: true, reused: false, ...runtime }
  } catch (error) {
    const raw = String(error?.message || error || '')
    const reason = /ENOENT|executable.*(?:does not exist|not found)|not found/i.test(raw)
      ? 'no-edge'
      : /ProcessSingleton|user data directory|profile.*(?:in use|already)/i.test(raw)
        ? 'profile-in-use'
        : /EACCES|EPERM|access is denied|permission denied/i.test(raw)
          ? 'access-denied'
          : 'launch-failed'
    const hints = {
      'no-edge': 'Edge 的启动文件不在了（可能刚升级或卸载）。修好 Edge 再跑；这里不会退化成 headless。',
      'profile-in-use': `专用资料目录正被另一个浏览器占着（${paths.profileDir}）。先把那个窗口正常关掉再跑；别删资料目录，删了就要重新扫码。`,
      'access-denied': '系统权限或安全软件挡住了专用 Edge 启动。检查资料目录权限，别删原资料。',
      'launch-failed': '专用 Edge 启动后退出或没就绪。更新一下 Edge 再试；也可能是资料目录被锁。',
    }
    try { writeOwnerRecord(paths.ownerFile, { port, profileDir: paths.profileDir, ready: false, reason }) } catch { /* ignore */ }
    return { ok: false, reason, hint: hints[reason], detail: raw.slice(0, 800) }
  }
}

/** 唯一会真关浏览器的入口（正常跑完绝不调它） */
export async function closeBrowser() {
  const current = runtime
  runtime = null
  if (!current?.context) return { ok: true, closed: false }
  try {
    await current.context.close()
    return { ok: true, closed: true }
  } catch (error) {
    return { ok: false, closed: false, hint: `关浏览器时出错：${error?.message || error}` }
  }
}

/**
 * 把**真的那台**专用 Edge 关掉（不只是断 CDP）。
 *
 * 重置登录态时才用得上：profile 目录被跑着的浏览器占着时，Windows 不让改名。
 * 接管来的（`adopted`）那台没有本地 context，只能连上去让对面自己关。
 */
export async function shutdownBrowser({ home, log = () => {} } = {}) {
  const paths = controlPaths(home)
  const port = runtime?.port || (await findLiveCdp({ file: paths.portFile }))
  runtime = null
  if (!port) return { ok: true, closed: false }
  const pw = await loadPlaywright()
  if (!pw.ok) return pw
  try {
    const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 })
    await browser.close()
    log(`关掉了专用 Edge（端口 ${port}）`)
    return { ok: true, closed: true, port }
  } catch (error) {
    return {
      ok: false,
      closed: false,
      port,
      reason: 'close-failed',
      hint: `连上了但没关掉：${error?.message || error}。手动关掉那个 Edge 窗口再试。`,
    }
  }
}
