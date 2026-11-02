/**
 * lib/seen.mjs —— 判重表（纯函数，不碰磁盘）
 * ============================================================================
 * 表格长这样，`## B站` / `## 抖音` 两节：
 *
 *   ## B站
 *   | 日期 | BV | 标题 | UP | 状态 |
 *   | ---- | -- | ---- | -- | ---- |
 *   | 2026-11-01 | BV1xx411c7mD | 标题带 \| 竖线也不会坏 | UP名 | 收 |
 *
 * ⚠️ 解析**不认列位**：模型把列顺序写反、少写一列、多写空格都发生过 ⇒
 *    一律按"扫一遍找 id 在哪一格"定位，日期取 id 左边最近的那一格。
 * ⚠️ 日期宽容认（`10-23` / `2026/10/23` / 带时间），没写年份按今年补，补出来比今天晚算去年。
 * ============================================================================
 */

export const SECTIONS = [
  { key: 'bili', title: 'B站', idPattern: /^BV[0-9A-Za-z]{10}$/ },
  { key: 'douyin', title: '抖音', idPattern: /^\d{15,25}$/ },
]

const DATE_RE = /^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/

const p2 = (n) => String(n).padStart(2, '0')

/** 本机日期 */
export function dayKey(now = new Date()) {
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
}

/** 日期格 → YYYY-MM-DD；认不出来返回 null */
export function seenDay(raw, now = new Date()) {
  const m = DATE_RE.exec(String(raw ?? '').trim())
  if (!m) return null
  const mo = Number(m[2]); const d = Number(m[3])
  let y = m[1] ? Number(m[1]) : now.getFullYear()
  const valid = (yy) => {
    const t = new Date(yy, mo - 1, d)
    return t.getFullYear() === yy && t.getMonth() === mo - 1 && t.getDate() === d
  }
  if (!valid(y)) return null
  if (!m[1] && `${y}-${p2(mo)}-${p2(d)}` > dayKey(now)) {
    y -= 1
    if (!valid(y)) return null
  }
  return `${y}-${p2(mo)}-${p2(d)}`
}

/** 这一节的 id 长什么样 */
export function idPatternOf(section) {
  return (SECTIONS.find((s) => s.key === section) || SECTIONS[0]).idPattern
}

/** 认出一条 id 属于哪一节（有重叠时先认 B站） */
export function sectionOfId(id) {
  const s = String(id ?? '').trim()
  for (const sec of SECTIONS) if (sec.idPattern.test(s)) return sec.key
  return ''
}

const splitCells = (line) => {
  const body = String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let cur = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') { cur += '|'; i += 1; continue }
    if (ch === '|') { cells.push(cur); cur = ''; continue }
    cur += ch
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

/**
 * 解析整份见闻录。
 * @returns {{rows: Array<{section:string,day:string,id:string,title:string,up:string,status:string,picked:boolean}>, malformed:number}}
 */
export function parseSeen(text, now = new Date()) {
  const rows = []
  let malformed = 0
  let section = 'bili'
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const head = /^##\s*(.+?)\s*$/.exec(line)
    if (head) {
      const t = head[1]
      const hit = SECTIONS.find((s) => t.includes(s.title))
      section = hit ? hit.key : section
      continue
    }
    if (!line.startsWith('|')) continue
    if (/^\|[\s:|-]+\|?$/.test(line)) continue          // 分隔行
    const cells = splitCells(line)
    if (!cells.length) continue
    const pattern = idPatternOf(section)

    // ① 扫一遍找 id 落在哪一格（不认列位）
    let idIndex = -1
    for (let i = 0; i < cells.length; i += 1) {
      if (pattern.test(cells[i])) { idIndex = i; break }
    }
    if (idIndex < 0) {
      // 表头行（"日期 | BV | 标题..."）不算坏行
      if (!/日期|BV|标题|UP|状态|id/i.test(line)) malformed += 1
      continue
    }

    // ② 日期：id 左边最近的那一格能认出日期就用它；左边没有就往右边找
    //    （列顺序被写反过，所以两边都看 —— 只要认得出，就别丢这一行的日期）
    let day = ''
    let dayIndex = -1
    for (let i = idIndex - 1; i >= 0; i -= 1) {
      const d = seenDay(cells[i], now)
      if (d) { day = d; dayIndex = i; break }
    }
    if (!day) {
      for (let i = idIndex + 1; i < cells.length; i += 1) {
        const d = seenDay(cells[i], now)
        if (d) { day = d; dayIndex = i; break }
      }
    }

    // ③ 状态：任何一格写着 收/弃 都算（列顺序可能被写反），优先最后一格
    let statusIndex = -1
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      if (/^[收弃]$/.test(cells[i])) { statusIndex = i; break }
    }
    if (statusIndex < 0) {
      for (let i = 0; i < cells.length; i += 1) {
        if (/收|弃/.test(cells[i])) { statusIndex = i; break }
      }
    }
    const status = statusIndex >= 0 ? cells[statusIndex].replace(/[^收弃]/g, '') : ''

    // ④ 标题 / UP：剩下那些没被认走的格子里按顺序取（id 右边优先，右边没了再看全局）
    const used = new Set([idIndex, dayIndex, statusIndex])
    const rest = cells.filter((_, i) => !used.has(i))
    const title = rest[0] ?? ''
    const up = rest[1] ?? ''

    rows.push({ section, day, id: cells[idIndex], title, up, status, picked: status.includes('收') })
  }
  return { rows, malformed }
}

/** 本机哪一天收过这个 id（判重就靠它） */
export function seenToday(parsed, id, now = new Date()) {
  const today = dayKey(now)
  return (parsed?.rows ?? []).some((r) => r.id === id && r.day === today)
}

/** 见过（任意一天）就返回那一行 */
export function findSeen(parsed, id) {
  return (parsed?.rows ?? []).find((r) => r.id === id) ?? null
}

const cell = (s, limit = 60) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, limit)

/** 一行记录 → Markdown 表格行 */
export function formatRow({ day, id, title, up, status }) {
  return `| ${cell(day, 10)} | ${cell(id, 24)} | ${cell(title, 60)} | ${cell(up, 30)} | ${cell(status, 4)} |`
}

/** 这两节的表头 */
export function sectionHeader(section) {
  const s = SECTIONS.find((x) => x.key === section) || SECTIONS[0]
  return `## ${s.title}`
}

export const TABLE_HEAD = [
  '| 日期 | id | 标题 | UP | 状态 |',
  '| ---- | -- | ---- | -- | ---- |',
].join('\n')

/**
 * 往一份见闻录文本里追加一行（幂等：同 section + 同 id + 同一天只留一行，新的覆盖旧的）。
 * @returns {string} 新的全文
 */
export function appendRow(text, row, now = new Date()) {
  const section = row.section || sectionOfId(row.id) || 'bili'
  const day = row.day || dayKey(now)
  const line = formatRow({ ...row, day })
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  let current = ''
  let inserted = false

  const flushInsert = () => {
    if (inserted) return
    // 找到这一节的最后一行表格，插它后面
    let lastTable = -1
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].trim().startsWith('|')) { lastTable = i; break }
      if (/^##\s/.test(out[i])) break
    }
    if (lastTable >= 0) out.splice(lastTable + 1, 0, line)
    else {
      // 这一节连表头都没有 ⇒ 补一节
      if (out.length && out[out.length - 1].trim()) out.push('')
      out.push(sectionHeader(section), '', TABLE_HEAD, line)
    }
    inserted = true
  }

  const matches = (l) => {
    if (!l.trim().startsWith('|')) return false
    const cells = splitCells(l)
    return cells.includes(row.id)
  }

  for (const raw of lines) {
    const head = /^##\s/.exec(raw)
    if (head) {
      if (current === section) flushInsert()
      current = ''
      const t = raw.replace(/^##\s*/, '')
      const hit = SECTIONS.find((s) => t.includes(s.title))
      current = hit ? hit.key : ''
      out.push(raw)
      continue
    }
    if (current === section && matches(raw)) {
      const cells = splitCells(raw)
      const sameDay = cells.some((c) => seenDay(c, now) === day)
      if (sameDay) {
        // 同一天同一条：用新行替换旧行（状态可能从「弃」变「收」）
        out.push(line)
        inserted = true
        continue
      }
    }
    out.push(raw)
  }
  if (current === section) flushInsert()
  if (!inserted) {
    // 整份里没有这一节
    if (out.length && out[out.length - 1].trim()) out.push('')
    out.push(sectionHeader(section), '', TABLE_HEAD, line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** 一份新的见闻录（两节都带表头） */
export function emptySeen() {
  return [
    '# 见闻录',
    '',
    '> 看过什么、收没收。一天一条，同一节同一 id 同一天只留一行。',
    '',
    '## B站',
    '',
    TABLE_HEAD,
    '',
    '## 抖音',
    '',
    TABLE_HEAD,
    '',
  ].join('\n')
}

/**
 * 把超过 keepDays 天的行摘出来（给滚动归档用）。
 * @returns {{keep:string, moved:Array<object>}}
 */
export function splitOld(text, keepDays = 30, now = new Date()) {
  const cutoff = dayKey(new Date(now.getTime() - keepDays * 24 * 3600 * 1000))
  const { rows } = parseSeen(text, now)
  const moved = rows.filter((r) => r.day && r.day < cutoff)
  if (!moved.length) return { keep: text, moved }
  const movedKeys = new Set(moved.map((r) => `${r.section}|${r.id}|${r.day}`))
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim().startsWith('|')) { out.push(raw); continue }
    const cells = splitCells(raw)
    const day = cells.map((c) => seenDay(c, now)).find(Boolean) || ''
    const id = cells.find((c) => sectionOfId(c))
    if (id && day && movedKeys.has(`${sectionOfId(id)}|${id}|${day}`)) continue
    out.push(raw)
  }
  return { keep: out.join('\n').replace(/\n{3,}/g, '\n\n'), moved }
}
