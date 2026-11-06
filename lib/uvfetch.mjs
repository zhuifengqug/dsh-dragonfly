/**
 * lib/uvfetch.mjs —— Python 运行时：找 uv、建 venv、装 requirements
 * ============================================================================
 * B站的搜索/字幕/评论/回复走 Python 侧（bilibili-api-python），所以家里必须有一个
 * 能跑的 Python，而且依赖要装齐。这一层只做三件事，都在设置页里由人点一下触发：
 *
 *   1. ensureUv()      —— 找一个 uv（没有就去下，校验 sha256）
 *   2. createVenv()    —— uv venv --seed --python 3.12 <home>/.venv
 *   3. installDeps()   —— uv pip install -i <镜像> -r requirements.txt
 *
 * 为什么用 uv 而不是 pip：uv 建 venv 几秒就完，pip 要几十秒到几分钟；而且 uv
 * 自带独立解释器下载，不依赖本机装过 3.12。
 *
 * 镜像轮换：国内直连 pypi 经常几十 KB/s，所以三个镜像依次试，全失败再退回
 * 本机 `python -m pip`（有人本机配好了公司代理时这条路反而通）。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 三个 pip 镜像，按顺序试 */
export const MIRRORS = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.org/simple',
]

/** 目标 Python 版本（uv 会自己下） */
export const PY_VERSION = '3.12'

/** uv 官方发布地址（Windows 是 zip，其它是 tar.gz） */
const UV_RELEASE = 'https://github.com/astral-sh/uv/releases/latest/download'

/** venv 里的 python 可执行文件（平台差异收在这里，别让调用方判断） */
export function venvPython(layout) {
  return process.platform === 'win32'
    ? join(layout.venv, 'Scripts', 'python.exe')
    : join(layout.venv, 'bin', 'python')
}

/** venv 里有没有能跑的 python */
export function venvReady(layout) {
  return existsSync(venvPython(layout))
}

/** 跑一条命令，收 stdout/stderr，超时可杀。绝不抛。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        windowsHide: true,
        shell: Boolean(opts.shell),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...opts.env },
      })
    } catch (e) {
      return resolve({ ok: false, code: 'spawn_failed', text: String(e?.message || e) })
    }

    const out = []
    const err = []
    const cap = (arr, chunk) => {
      arr.push(String(chunk))
      if (arr.join('').length > 60_000) arr.splice(0, arr.length, arr.join('').slice(-30_000))
    }
    child.stdout?.on('data', (c) => cap(out, c))
    child.stderr?.on('data', (c) => cap(err, c))

    const ms = opts.timeoutMs || 10 * 60 * 1000
    const timer = setTimeout(() => {
      opts.log?.(`命令超时（${Math.round(ms / 1000)} 秒），杀掉：${cmd}`)
      try { child.kill() } catch { /* ignore */ }
    }, ms)
    timer.unref?.()

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: 'spawn_failed', text: String(e?.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = [...out, ...err].join('').trim()
      resolve({ ok: code === 0, code, text })
    })
  })
}

/** 本机有没有 uv（PATH 上找，或家里已经下好一份） */
export function findUv(layout) {
  const bundled = join(layout.home, '.uv', process.platform === 'win32' ? 'uv.exe' : 'uv')
  if (existsSync(bundled)) return bundled
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const file = join(dir, `uv${ext}`)
      if (existsSync(file)) return file
    }
  }
  return null
}

/**
 * 确保有 uv：PATH 上有就用；没有就下到 `<home>/.uv/`。
 * 下载走 uv 官方 GitHub release（不是第三方镜像）——这是唯一一处「从网上取可执行文件」，
 * 所以 sha256 必须校验；拿不到 sha256 就拒绝安装，不冒险。
 */
export async function ensureUv(layout, opts = {}) {
  const log = opts.log || (() => {})
  const found = findUv(layout)
  if (found) return { ok: true, path: found, source: 'path' }

  const isWin = process.platform === 'win32'
  const archive = isWin ? 'uv-x86_64-pc-windows-msvc.zip' : `uv-${process.arch}-unknown-linux-gnu.tar.gz`
  const url = `${UV_RELEASE}/${archive}`
  const shaUrl = `${url}.sha256`
  const dir = join(layout.home, '.uv')
  const file = join(dir, archive)

  try {
    mkdirSync(dir, { recursive: true })
    log('没有 uv，正在下载…')
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) return { ok: false, text: `uv 下载失败（HTTP ${res.status}）` }
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(file, buf)

    // 校验：官方 release 旁边有 .sha256
    let want = ''
    try {
      const s = await fetch(shaUrl, { redirect: 'follow' })
      if (s.ok) want = (await s.text()).trim().split(/\s+/)[0].toLowerCase()
    } catch { /* 拿不到下面统一拒 */ }
    if (!want) {
      rmSync(file, { force: true })
      return { ok: false, text: '拿不到 uv 的 sha256，不敢装。手动装一个 uv 放 PATH 上再试。' }
    }
    const got = createHash('sha256').update(buf).digest('hex')
    if (got !== want) {
      rmSync(file, { force: true })
      return { ok: false, text: `uv 校验不过（期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）` }
    }

    // 解包：Windows 用 Expand-Archive，类 Unix 用 tar
    const unpack = isWin
      ? await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${file}' -DestinationPath '${dir}' -Force`], { timeoutMs: 120_000 })
      : await run('tar', ['-xzf', file, '-C', dir], { timeoutMs: 120_000 })
    if (!unpack.ok) return { ok: false, text: `uv 解包失败：${unpack.text.slice(-500)}` }

    // zip 里通常带一层目录，找一下真正的可执行文件
    const bin = isWin ? join(dir, 'uv.exe') : join(dir, 'uv')
    if (!existsSync(bin)) {
      const nested = isWin ? join(dir, 'uv-x86_64-pc-windows-msvc', 'uv.exe') : join(dir, 'uv-x86_64-unknown-linux-gnu', 'uv')
      if (existsSync(nested)) {
        try { writeFileSync(bin, readFileSync(nested)); } catch { /* 下面统一判 */ }
      }
    }
    if (!existsSync(bin)) return { ok: false, text: 'uv 解包后在预期位置找不到可执行文件。' }
    if (!isWin) { try { chmodSync(bin, 0o755) } catch { /* ignore */ } }
    rmSync(file, { force: true })
    log('uv 装好了')
    return { ok: true, path: bin, source: 'downloaded' }
  } catch (e) {
    return { ok: false, text: `uv 这一步炸了：${e?.message || e}` }
  }
}

/** 建 venv（已经有就跳过）。返回 venv 里的 python 路径。 */
export async function createVenv(layout, uvPath, opts = {}) {
  const log = opts.log || (() => {})
  if (venvReady(layout)) return { ok: true, python: venvPython(layout), existed: true }

  log(`建 venv（Python ${PY_VERSION}）…`)
  const res = await run(uvPath, ['venv', '--seed', '--python', PY_VERSION, layout.venv], {
    timeoutMs: 20 * 60 * 1000, log,
  })
  if (!res.ok) return { ok: false, text: `建 venv 失败：${res.text.slice(-800)}` }
  if (!venvReady(layout)) return { ok: false, text: 'venv 建完了但里面没有 python，装不起来。' }
  return { ok: true, python: venvPython(layout), existed: false }
}

/**
 * 装依赖。requirements.txt 由插件随包提供（`vendor/dragonfly-bili-mcp/requirements.txt`），
 * 调用方传绝对路径。
 */
export async function installDeps(layout, uvPath, requirementsFile, opts = {}) {
  const log = opts.log || (() => {})
  if (!existsSync(requirementsFile)) {
    return { ok: false, text: `requirements 不在：${requirementsFile}` }
  }
  const args = ['pip', 'install', '--python', venvPython(layout), '-r', requirementsFile]

  const tried = []
  for (const mirror of MIRRORS) {
    log(`装依赖（镜像 ${new URL(mirror).host}）…`)
    const res = await run(uvPath, [...args, '-i', mirror], { timeoutMs: 30 * 60 * 1000, log, cwd: layout.home })
    tried.push({ mirror, ok: res.ok })
    if (res.ok) return { ok: true, mirror, text: res.text.slice(-1500) }
    log(`这个镜像不行：${res.text.slice(-300)}`)
  }

  // 全失败：退回本机 python -m pip（有人配了公司代理时这条路能通）
  const py = venvPython(layout)
  if (existsSync(py)) {
    log('镜像都不行，退回本机 pip…')
    for (const mirror of MIRRORS) {
      const res = await run(py, ['-m', 'pip', 'install', '-r', requirementsFile, '-i', mirror], {
        timeoutMs: 30 * 60 * 1000, log, cwd: layout.home,
      })
      tried.push({ mirror: `${mirror} (本机 pip)`, ok: res.ok })
      if (res.ok) return { ok: true, mirror, via: 'local-pip', text: res.text.slice(-1500) }
    }
  }
  return { ok: false, tried, text: '三个镜像加本机 pip 全都不行。检查一下网络，或者手动装一下。' }
}

/** 一步到位：uv + venv + 依赖。给设置页那一个按钮用。 */
export async function setupPython(layout, requirementsFile, opts = {}) {
  const log = opts.log || (() => {})
  const uv = await ensureUv(layout, { log })
  if (!uv.ok) return { ok: false, stage: 'uv', text: uv.text }

  const venv = await createVenv(layout, uv.path, { log })
  if (!venv.ok) return { ok: false, stage: 'venv', text: venv.text }

  const deps = await installDeps(layout, uv.path, requirementsFile, { log })
  if (!deps.ok) return { ok: false, stage: 'deps', python: venv.python, text: deps.text }

  return { ok: true, python: venv.python, uv: uv.path, mirror: deps.mirror, text: 'Python 环境装好了。' }
}

/** 探一下现状（设置页进来时显示"装没装、缺什么"） */
export async function pythonStatus(layout) {
  const uv = findUv(layout)
  const ready = venvReady(layout)
  const py = ready ? venvPython(layout) : null
  let version = ''
  if (py) {
    const res = await run(py, ['-c', 'import sys;print(sys.version.split()[0])'], { timeoutMs: 15_000 })
    if (res.ok) version = res.text.trim().split('\n').pop() || ''
  }
  return {
    uv: Boolean(uv), uvPath: uv, venv: ready, python: py, version,
    hint: !uv && !ready ? '还没装。点"装 Python 环境"，几分钟就好。'
      : !ready ? '有 uv 但没 venv，点一下装。'
        : version ? `Python ${version} 就绪` : 'venv 在，但跑不起来。',
  }
}

/** 家目录在哪不重要，但日志里偶尔要显示 —— 给个短一点的写法 */
export function shortHome(layout) {
  const h = layout.home
  const uh = homedir()
  return h.startsWith(uh) ? `~${h.slice(uh.length)}` : h
}
