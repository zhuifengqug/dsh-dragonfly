/**
 * 封面图：界面要「看到这个视频」，先给它一张图。
 *
 * 只做 B站：`x/web-interface/view` 是公开接口，拿 `data.pic` 就有封面。
 * 抖音没有可用的公开接口（那正是它要走真浏览器的原因），界面上只能给链接，
 * 这里不做假的占位图。
 *
 * 缓存落在 `<家目录>/covers/<BV号>.jpg` —— 同一条日报反复打开不该反复打接口。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_MS = 8000
const BVID_RE = /^BV[0-9A-Za-z]{10}$/
/** 一张封面最多这么大，超过就当拿错了（避免把一坨东西写进缓存） */
const MAX_BYTES = 4 * 1024 * 1024

/** bilibili 的图地址有时是 `//i2.hdslb.com/...`，补成 https */
export function normalizePicUrl(pic) {
  const s = String(pic || '').trim()
  if (!s) return ''
  if (s.startsWith('//')) return `https:${s}`
  if (s.startsWith('http://')) return `https://${s.slice('http://'.length)}`
  return s
}

async function fetchJson(url, cookie) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return null
  return res.json()
}

async function fetchBytes(url, cookie) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length || buf.length > MAX_BYTES) return null
  return buf
}

/** 已经缓存过就直接给路径，没有就 null（同步，给路由的快路径用） */
export function cachedCover(layout, bvid) {
  if (!BVID_RE.test(String(bvid || ''))) return null
  const file = join(layout.covers, `${bvid}.jpg`)
  try {
    if (existsSync(file) && statSync(file).size > 0) return file
  } catch { /* 读不到当没有 */ }
  return null
}

/**
 * 拿封面文件，必要时去取一次。
 * @returns {Promise<{ok:true,file:string,cached:boolean}|{ok:false,reason:string}>}
 */
export async function ensureCover(layout, bvid, { cookie = '', log = () => {} } = {}) {
  const id = String(bvid || '').trim()
  if (!BVID_RE.test(id)) return { ok: false, reason: 'bad-bvid' }

  const hit = cachedCover(layout, id)
  if (hit) return { ok: true, file: hit, cached: true }

  try {
    const info = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${id}`, cookie)
    const pic = normalizePicUrl(info?.data?.pic)
    if (!pic) {
      log(`封面：${id} 没拿到图地址（code=${info?.code ?? '?'}）`)
      return { ok: false, reason: 'no-pic' }
    }
    const buf = await fetchBytes(pic, cookie)
    if (!buf) return { ok: false, reason: 'download-failed' }
    mkdirSync(layout.covers, { recursive: true })
    const file = join(layout.covers, `${id}.jpg`)
    writeFileSync(file, buf)
    return { ok: true, file, cached: false }
  } catch (e) {
    log(`封面：${id} 取图失败 —— ${e?.message || e}`)
    return { ok: false, reason: 'error' }
  }
}

/** 给路由用：直接给字节（失败 null） */
export function readCover(file) {
  try { return readFileSync(file) } catch { return null }
}
