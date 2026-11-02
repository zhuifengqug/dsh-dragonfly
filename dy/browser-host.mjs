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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

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
 */
export async function loadPlaywright() {
  let mod
  try {
    mod = await import('playwright-core')
  } catch (error) {
    return {
      ok: false,
      reason: 'no-playwright',
      hint:
        '没装 playwright-core，专用 Edge 起不来（所以这一轮读不了抖音）。' +
        '装一下：在插件目录执行 `npm i playwright-core`，或者把宿主那棵树里的 playwright-core 指过来。' +
        `（原始错误：${error?.code || error?.message || error}）`,
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
  if (runtime?.context) return { ok: true, reused: true, ...runtime }

  const paths = controlPaths(home)
  ensureDir(paths.controlDir)
  ensureDir(paths.profileDir)

  const playwright = await loadPlaywright()
  if (!playwright.ok) return playwright

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
