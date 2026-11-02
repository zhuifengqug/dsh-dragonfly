/**
 * lib/login.mjs —— B站 扫码登录（直接在 JS 里走 passport 接口，不依赖 MCP）
 * ============================================================================
 * 为什么不借用上游的 `bili_login`：那个把码存成 PNG 就返回，字段全是空。
 * 这里按实测跑通的那条来：
 *
 *   ① GET /x/passport-login/web/qrcode/generate?source=main-fe-header → data.url + data.qrcode_key
 *   ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
 *      data.code：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
 *   ③ ⭐ **凭证在轮询响应的 `Set-Cookie` 头里** —— 成功时 `data.url` 里没有 SESSDATA
 *      （那是别的域的游戏票，别在 url 里找）
 *   ④ 落成 MCP 认的四个字段：sessdata / bili_jct / buvid3 / dedeuserid
 *
 * 凭证文件路径固定为 `<家目录>/creds/bili-credential.json`（不是插件目录里 —— 那是只读的）。
 * ============================================================================
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key) => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

/** Set-Cookie 列表 → 我们要的那四个字段 */
function pickCookies(list) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

/** 缺 buvid3 时补一张指纹（非致命，失败就当空） */
async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar
  try {
    const r = await fetch(SPI, { headers: { 'User-Agent': UA } })
    const j = await r.json()
    const v = j?.data?.b_3
    if (v) jar.buvid3 = v
  } catch { /* 拿不到就算了 */ }
  return jar
}

/** 第一步：出码 */
export async function loginStart() {
  const r = await fetch(GEN, { headers: { 'User-Agent': UA } })
  const j = await r.json()
  const data = j?.data
  if (!data?.qrcode_key || !data?.url) {
    throw new Error(`生成二维码失败：${j?.message || '返回里没有 qrcode_key'}`)
  }
  return { key: data.qrcode_key, url: data.url }
}

/** 第二步：轮询一次。state: waiting / scanned / ok / expired / unknown */
export async function loginPoll(key) {
  const res = await fetch(pollUrl(key), { headers: { 'User-Agent': UA }, redirect: 'manual' })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  let body = {}
  try { body = await res.json() } catch { /* poll 有时返回空体 */ }
  const code = body?.data?.code
  if (code === 0) {
    const jar = await ensureBuvid3(pickCookies(setCookies))
    if (!jar.sessdata) {
      return { state: 'unknown', code, message: '登录成功了，但响应里没有 SESSDATA —— 把这次的结果记下来再排查' }
    }
    return { state: 'ok', code, credential: jar }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', code, message: body?.message || '' }
}

/**
 * 收紧权限：凭证文件只让当前用户能读。
 * Windows 按 **SID** 授权（不按名字）—— 机器名和用户名一样时，icacls 会把名字解析成
 * **计算机账户**，再加上 /inheritance:r，文件就谁也读不了 ⇒ 扫码成功却一直"未登录"。
 * 收紧后再读一次自检，读不回来就 /reset 恢复继承：宁可宽一点，也不能把凭证锁死。
 */
function currentUserSid() {
  try {
    const whoami = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
    const out = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    const m = /"(S-1-[\d-]+)"/.exec(out)
    return m ? m[1] : null
  } catch { return null }
}

export function hardenPerms(file) {
  try {
    if (process.platform === 'win32') {
      const sid = currentUserSid()
      const who = sid ? '*' + sid : (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + (process.env.USERNAME || '')
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', who + ':F'], { stdio: 'ignore', windowsHide: true })
      try { readFileSync(file) } catch {
        execFileSync('icacls', [file, '/reset'], { stdio: 'ignore', windowsHide: true })
        return false
      }
    } else {
      execFileSync('chmod', ['600', file], { stdio: 'ignore' })
    }
    return true
  } catch { return false }
}

/** 落盘到 `<家目录>/creds/bili-credential.json` */
export function saveCredential(file, credential) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    sessdata: credential.sessdata ?? '',
    bili_jct: credential.bili_jct ?? '',
    buvid3: credential.buvid3 || '',
    dedeuserid: credential.dedeuserid ?? '',
  }, null, 2), 'utf8')
  try { hardenPerms(file) } catch { /* 收紧失败不影响登录 */ }
  return file
}

/** 读回凭证（没有或读不出来返回 null） */
export function readCredential(file) {
  try {
    if (!existsSync(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (!j || typeof j !== 'object' || !j.sessdata) return null
    return j
  } catch { return null }
}

/** 用 Python 的 qrcode 画一张 PNG，返回文件路径（拿不到就 null） */
export function renderQrPng(pythonPath, homeDir, url) {
  return new Promise((resolve) => {
    const png = join(homeDir, 'qrcode_login.png')
    const code = 'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])'
    let child
    try {
      child = spawn(pythonPath || 'python', ['-c', code, url, png], { cwd: homeDir, windowsHide: true })
    } catch { return resolve(null) }
    const done = () => { try { resolve(existsSync(png) ? png : null) } catch { resolve(null) } }
    child.on('exit', (c) => { if (c === 0) done(); else resolve(null) })
    child.on('error', () => resolve(null))
  })
}
