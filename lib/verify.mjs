/**
 * lib/verify.mjs —— 「评论发出后复核」
 * ============================================================================
 * 为什么要有它：**接口回「发送成功」≠ 公开可见**。新号 / 风控会让评论进审核，
 * 你自己看不见，而那一轮以为发出去了 ⇒ 下一轮不再发 ⇒ 一条都没到人。
 * 更坏的一层：**不公开时连通知都不推**，于是"@ 了但没人收到"。
 *
 * 复核靠两条只读接口：
 *   ① 顶层评论 `/x/v2/reply/main?type=1&oid=<aid>&mode=2&next=0&ps=20`（按时间，刚发的在第一页）
 *   ② 楼中楼 `/x/v2/reply/reply?type=1&oid=<aid>&root=<root>&ps=20`
 *   ⚠️ **看不到 ≠ 没发出**（翻页 / 热度排序都会漏）⇒ 结论一律写「没查到」，
 *      绝不写「没发出去」。这条是硬约定。
 *   ✗ `/x/v2/reply/detail` 走不通（回 -400），别无谓地换它。
 *
 * rpid 从哪来：Python 侧发评论时会把回执记进 `<家目录>/comments.md`（语感闸门的台账），
 * 行格式 `- 2026-11-02 18:00 BV1xx rpid=123 · 正文`。宿主只认这个文件，不猜。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { dayKey } from './clock.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 台账里一行 → `{bv, rpid, root, text}`；认不出来的行跳过，不猜 */
export function parseLedger(text) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const bv = /BV[0-9A-Za-z]{10}/.exec(line)
    if (!bv) continue
    const rpidM = /rpid=(\d+)/.exec(line)
    const row = { bv: bv[0], rpid: rpidM ? Number(rpidM[1]) : 0, root: 0, text: '' }
    // 可选：`root=<rpid>` 表示这是楼中楼
    const rootM = /root=(\d+)/.exec(line)
    if (rootM) row.root = Number(rootM[1])
    const after = line.split('·').slice(1).join('·').trim()
    if (after) row.text = after.slice(0, 200)
    rows.push(row)
  }
  return rows
}

function headersFor(cred) {
  return {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
  }
}

async function jget(url, headers) {
  try {
    const r = await fetch(url, { headers })
    const t = await r.text()
    try { return JSON.parse(t) } catch { return { code: -999, message: 'not json' } }
  } catch (e) { return { code: -998, message: String(e?.message ?? e) } }
}

/**
 * 复核一条。`visible` 三态：true 公开可见 / false 明确不可见 / null 没查到。
 * @returns {{bv:string, rpid:number, visible:boolean|null, likes:number|null, how:string, note:string}}
 */
export async function verifyOne(record, { aidCache = new Map(), headers } = {}) {
  const out = { bv: record.bv, rpid: record.rpid, visible: null, likes: null, how: '', note: '' }

  // 没 rpid 就别查了 —— 写「未取到 rpid」，不许编一个
  if (!record.rpid) {
    out.how = '缺 rpid'
    out.note = '未取到 rpid，这条没法核（不猜）'
    return out
  }

  if (!aidCache.has(record.bv)) {
    const v = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${record.bv}`, headers)
    aidCache.set(record.bv, v?.code === 0 ? { aid: v.data.aid, mid: v.data.owner?.mid } : null)
    await sleep(300)
  }
  const meta = aidCache.get(record.bv)
  if (!meta) {
    out.how = '取视频信息失败'
    out.note = '这条跳过（视频可能已删 / 不可见）'
    return out
  }

  // ① 顶层：按时间第一页
  if (!record.root) {
    const d = await jget(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${meta.aid}&mode=2&next=0&ps=20`, headers)
    const list = d?.data?.replies || []
    const hit = list.find((r) => r.rpid === record.rpid)
    out.how = '顶层·最新一页'
    if (hit) {
      out.visible = hit.invisible ? false : true
      out.likes = Number(hit.like) || 0
      out.note = hit.invisible ? '（接口标了 invisible）' : ''
      return out
    }
    out.note = '最新一页里没找到 —— 可能还在审核，也可能只是翻页看不到（**不等于没发出去**）'
    return out
  }

  // ② 楼中楼
  const d = await jget(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${meta.aid}&root=${record.root}&ps=20&pn=1`, headers)
  const subs = d?.data?.replies || []
  const hit = subs.find((r) => r.rpid === record.rpid)
  out.how = `楼中楼·root=${record.root}`
  if (hit) {
    out.visible = hit.invisible ? false : true
    out.likes = Number(hit.like) || 0
    out.note = hit.invisible ? '（接口标了 invisible）' : ''
    return out
  }
  out.note = subs.length
    ? `那一串里有 ${subs.length} 条，但没有我们这条 —— 可能还在审核（**不等于没发出去**）`
    : '那一串暂时拉不到内容 —— 可能还在审核（**不等于没发出去**）'
  return out
}

/**
 * 复核最近的一批（默认最多 6 条、7 天内确认过的跳过）。
 * @returns {Promise<{checked:Array, skipped:number, text:string}>}
 */
export async function verifyRecent(layout, credential, opts = {}) {
  const log = opts.log || (() => {})
  const max = Math.max(1, Math.min(20, Number(opts.max) || 6))

  if (!credential?.sessdata) {
    return { checked: [], skipped: 0, text: '还没扫码登录，没法复核（复核要用你自己的登录态）' }
  }
  const ledgerFile = join(layout.home, 'comments.md')
  if (!existsSync(ledgerFile)) {
    return { checked: [], skipped: 0, text: '还没发过评论，没什么可核的' }
  }
  const rows = parseLedger(readFileSync(ledgerFile, 'utf8')).filter((r) => r.rpid || r.bv)
  if (!rows.length) return { checked: [], skipped: 0, text: '还没发过评论，没什么可核的' }

  // 账本：已确认真见过的，7 天内不重复查
  const stateFile = join(layout.home, 'verify-state.json')
  let state = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { /* 头一次 */ }
  const now = Date.now()
  const fresh = []
  let skipped = 0
  for (const r of rows.slice().reverse()) {
    const prev = state[String(r.rpid || r.bv)]
    if (prev?.visible === true && now - (prev.at || 0) < 7 * 864e5) { skipped++; continue }
    fresh.push(r)
    if (fresh.length >= max) break
  }
  if (!fresh.length) return { checked: [], skipped, text: `都复核过了（跳过 ${skipped} 条）` }

  const headers = headersFor(credential)
  const aidCache = new Map()
  const checked = []
  for (const r of fresh) {
    const res = await verifyOne(r, { aidCache, headers })
    checked.push(res)
    state[String(r.rpid || r.bv)] = { visible: res.visible, at: now, how: res.how, bv: r.bv, likes: res.likes }
    log(`复核 ${r.bv} rpid=${r.rpid || '—'} → ${res.visible === true ? '公开可见' : '没查到'}（${res.how}）`)
    await sleep(700)
  }
  try { writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8') } catch { /* 写不了也不该让复核失败 */ }

  const lines = ['', '## 评论复核（宿主自动跑的，不是那一轮自己说的）', '']
  for (const c of checked) {
    const t = c.visible === true ? `公开可见（赞 ${c.likes ?? 0}）` : '没查到'
    const rpidText = c.rpid ? String(c.rpid) : '未取到 rpid'
    lines.push(`- \`${c.bv}\` rpid **${rpidText}** —— ${t} · 依据：${c.how}${c.note ? ' · ' + c.note : ''}`)
  }
  if (skipped) lines.push(`- （另外 ${skipped} 条最近已复核过，没重复查）`)
  return { checked, skipped, text: lines.join('\n') }
}

/** 把复核结果追加到当天日报末尾（报告不存在就别硬造一份） */
export function appendVerifyToReport(layout, text) {
  try {
    const f = join(layout.out, `${dayKey()}.md`)
    if (!existsSync(f)) return null
    let cur = readFileSync(f, 'utf8')
    // 一轮里可能被触发两次（收尾自动核 + 手动点）—— 先切掉旧的那段再写，避免出现两遍
    const at = cur.indexOf('## 评论复核')
    if (at >= 0) cur = cur.slice(0, at).replace(/\s*$/, '') + '\n'
    writeFileSync(f, cur.replace(/\s*$/, '') + '\n' + text + '\n', 'utf8')
    return f
  } catch { return null }
}
