/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`（拿不到就退到自己的依赖）
 * ============================================================================
 * 🔴 为什么要有它：`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools` 是 optional peer，
 *    桌面版 profile（`autoInstallPeers: false`）**永远不装它们** ⇒ 裸 import 会让
 *    **整条插件不激活**，DSH 只留一句 `warning: 1 entry did not activate … failed to import`。
 *    web profile 上之所以一直没事，是因为 profile 树里恰好有别的插件把它们 hoist 上来了 —— 运气。
 *
 * ⭐ 策略（三条一起走）：
 *   ① 优先从**正在运行的那个宿主**里解析（桌面版 = `<exe>\resources\app.asar\dsh\node_modules`）
 *      —— 拿到的是同一个模块实例，行为跟宿主完全一致；其次才是 profile 树、
 *      全局 npm 里可能遗留的**旧版本**安装、最后才是我们自己依赖里那份
 *   ② 解析不到就 bare import（靠我们自己 dependencies 装一份保底）
 *   ③ `schemastery` 彻底拿不到 ⇒ 返回 null，**插件照常加载**（只是没有 Config、设置页降级）
 *      —— 绝不因为一个 import 让整条插件不激活
 *
 * ⚠️ 为什么不能按"先找到先用"：机器上常同时存在多套 `@deepseek-ai/*`（全局 npm 装的老
 *    CLI、profile 树里被别的插件 hoist 上来的、桌面版 app.asar 里的）。按目录顺序撞运气
 *    会捡到最旧的那套，`defineTool` / `Schema` 就不是宿主那一个实例了。
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件自己那棵树（dependencies 装出来的那份）—— 用模块位置算，别依赖 cwd */
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/**
 * 正在运行的那个宿主自己的那棵树。
 * 桌面版把 dsh 打进 `app.asar`：Windows/Linux 在 `<exeDir>/resources`，macOS 在 `.app/Contents/Resources`。
 * 在普通 node 里这些路径读不到（asar 是 Electron 的 fs 补丁）—— existsSync 直接 false，跳过即可。
 */
export function runningAppRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  try {
    const exeDir = dirname(process.execPath)
    for (const res of [join(exeDir, 'resources'), join(exeDir, '..', 'Resources')]) {
      for (const bundle of ['app.asar', 'app']) {
        push(join(res, bundle, 'dsh', 'node_modules', '@deepseek-ai'))
        push(join(res, bundle, 'node_modules', '@deepseek-ai'))
      }
    }
  } catch { /* ignore */ }
  return out
}

/** 比版本号：够用的 semver 子集（`x.y.z[-pre]`），返回 1 / 0 / -1 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '0').trim().replace(/^v/, '')
    const dash = s.indexOf('-')
    const core = dash === -1 ? s : s.slice(0, dash)
    const pre = dash === -1 ? '' : s.slice(dash + 1)
    const nums = core.split('.').map((x) => parseInt(x, 10) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, pre: pre ? pre.split('.') : [] }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1
  }
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1   // 正式版 > 预发布
  if (!pb.pre.length) return -1
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1  // 前缀相同、短的更小
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = parseInt(x, 10) - parseInt(y, 10)
      if (d) return d > 0 ? 1 : -1
    } else if (xn !== yn) {
      return xn ? -1 : 1           // 数字段 < 字母段
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

/** 可能藏着宿主 `@deepseek-ai` 包的地方（不写死某一台机器，按"离运行中宿主有多近"排序） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  // ① 运行中的宿主本体（桌面版 app.asar）
  for (const r of runningAppRoots()) push(r)

  // ② 应用安装目录
  const appDir = process.env.DSH_APP_DIR
  if (appDir) push(join(appDir, 'node_modules', '@deepseek-ai'))

  // ③ profile 树：有些机器上这些包是被别的插件 hoist 到 profile 根上的
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // ④ 全局 npm 安装（可能是另一套更老的 CLI —— 只在前面都没有时才用）
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // ⑤ 兜底：自己 dependencies 里那份
  push(SELF_MODULES)
  return out
}

/** 按包的 exports['.'] 找入口文件，返回 { url, version } */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    if (!existsSync(file)) return null
    return { url: pathToFileURL(file).href, version: String(pkg.version || '0.0.0') }
  } catch { return null }
}

async function fromHostTree(name, log) {
  const override = process.env.DSH_HOST_MODULES
  const cands = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const hit = entryUrlFor(root, name)
    if (hit) cands.push({ ...hit, root, boost: root === override ? 1 : 0 })
  }
  // 显式指定的 DSH_HOST_MODULES 优先；其余按版本从高到低 ——
  // 宿主自带的那份永远比 APPDATA 里遗留的老 CLI 新
  cands.sort((a, b) => (b.boost - a.boost) || compareVersions(b.version, a.version))

  const fails = []
  for (const c of cands) {
    try {
      const mod = await import(c.url)
      log(`${name}@${c.version}：从宿主树取到（${c.url.replace(/^file:\/\/\//, '')}）`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${c.root}`) }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

/**
 * 兜底：拿不到宿主的 dsh-tools 时用的等价实现。
 * 只补一条同样是宿主会做的校验（object 必须写 additionalProperties），别的原样返回。
 */
function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上了（工具 ${options.name}）`)
  return options
}

/**
 * @returns {Promise<{z:any, defineTool:Function, notes:string[]}>}
 */
export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try {
      zMod = await import('@deepseek-ai/schemastery')
      log('schemastery：宿主树里没有，用自己依赖里那份')
    } catch (e) {
      log(`⚠️ schemastery 彻底拿不到（${e?.code || ''} ${String(e?.message || '').slice(0, 120)}）—— 这一份插件没有 Config，设置页会降级（插件本体照常跑）`)
    }
  }
  const z = zMod?.default ?? zMod ?? null

  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try {
      dtMod = await import('@deepseek-ai/dsh-tools')
      log('dsh-tools：宿主树里没有，用自己依赖里那份')
    } catch (e) {
      log(`dsh-tools 拿不到（${e?.code || ''}）—— 用本地等价实现顶上`)
      dtMod = null
    }
  }
  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))

  return { z, defineTool, notes }
}
