/**
 * lib/report.mjs —— 日报的合并规则（纯函数，不碰磁盘）
 * ============================================================================
 * 一天只有一份 `<家目录>/out/<日期>.md`。同一轮里重复写、或者同一天再跑一轮，
 * 都要**按 id 合并**，不能出现两条一样的、也不能把已有内容冲掉。
 *
 * 每条用 `###` 顶格标题起头，格式是：
 *   ### [B站] BV1xx411c7mD / 标题在这里
 *   **档位**：值得看
 *   **为什么值得**：…（要有具体数字）
 *   **我的一句话**：…
 *
 * 三档只有这三个词：值得看 / 可以看 / 不值当。
 * 分节标题固定这五个（写不到正文里就当没有）。
 * ============================================================================
 */

export const TIERS = ['值得看', '可以看', '不值当']
export const GOOD_TIER = '值得看'

/** 分节（顺序即渲染顺序） */
export const SECTIONS = [
  { key: 'picks', title: '今天挑的', lead: true },
  { key: 'skipped', title: '扫过没收的' },
  { key: 'skipped-no-evidence', title: '因缺证据跳过' },
  { key: 'dm', title: '私信' },
  { key: 'seen-diff', title: '判重' },
  { key: 'summary', title: '总结' },
]

const SECTION_BY_TITLE = new Map(SECTIONS.map((s) => [s.title, s]))

/** 一条记录的 id（BV 号或抖音数字 id） */
export const ID_RE = /(BV[0-9A-Za-z]{10}|\b\d{15,25}\b)/

/** 从标题行里取 id 与标题 */
export function parseEntryHeading(line) {
  const t = String(line ?? '').trim()
  if (!t.startsWith('###')) return null
  const body = t.replace(/^###\s*/, '')
  const idm = ID_RE.exec(body)
  if (!idm) return null
  const id = idm[1]
  const src = /\[抖音\]/.test(body) ? 'douyin' : 'bili'
  // 标题：id 后面那个 / 之后的部分；没有就用整行去掉前缀
  const afterId = body.slice(body.indexOf(id) + id.length)
  const slash = afterId.indexOf('/')
  const title = (slash >= 0 ? afterId.slice(slash + 1) : afterId).trim() || id
  return { id, source: src, title }
}

/** 把正文切成「前言 + 各节 + 各条目」 */
export function splitBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const preamble = []
  const sections = []
  let current = null
  let entry = null
  const flushEntry = () => { if (entry && current) { current.entries.push(entry); entry = null } }

  for (const raw of lines) {
    const line = raw
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      flushEntry()
      const title = h2[1].trim()
      if (title.startsWith('#') || line.startsWith('###')) continue
      current = { title, known: SECTION_BY_TITLE.get(title)?.key ?? '', entries: [], free: [] }
      sections.push(current)
      continue
    }
    const h3 = /^###\s+/.exec(line)
    if (h3) {
      flushEntry()
      if (!current) { current = { title: '', known: '', entries: [], free: [] }; sections.push(current) }
      entry = { heading: line.trim(), lines: [] }
      continue
    }
    if (entry) { entry.lines.push(line); continue }
    if (current) { current.free.push(line); continue }
    preamble.push(line)
  }
  flushEntry()
  return { preamble, sections }
}

/** 一条记录里读档位 */
export function tierOf(entryLines) {
  for (const l of entryLines) {
    const m = /\*\*档位\*\*\s*[：:]\s*(值得看|可以看|不值当)/.exec(l)
    if (m) return m[1]
  }
  return ''
}

/** 数一数今天的日报里收了几条（各信源分别多少） */
export function countPicks(text) {
  const { sections } = splitBlocks(text)
  const all = sections.flatMap((s) => s.entries)
  const good = all.filter((e) => tierOf(e.lines) === GOOD_TIER)
  const bySource = { bili: 0, douyin: 0 }
  for (const e of good) {
    const h = parseEntryHeading(e.heading)
    if (h) bySource[h.source] += 1
  }
  return { good: good.length, total: all.length, bySource }
}

/** 一天一份的新日报骨架 */
export function emptyReport(day) {
  return `# ${day}\n`
}

/**
 * 把一段模型写的 Markdown 合并进日报。
 *
 * 规则：
 *   · 以 `###` 条目为最小合并单位，**id 相同的整条替换**（不是追加），其余原样保留
 *   · 认得的 `## 小节` 归位到标准顺序；认不得的 `##` 原样留在末尾
 *   · 前言（`# 日期` 那行）丢了就补回来
 *   · 合并完按「值得看」优先重排**只在同一个小节内**做，不跨节搬动
 *
 * @param {string} existing 现有全文（可为空）
 * @param {string} incoming 这一轮写的内容
 * @param {string} day 'YYYY-MM-DD'
 * @returns {{text:string, added:string[], replaced:string[]}}
 */
export function mergeReport(existing, incoming, day) {
  const prev = splitBlocks(existing || '')
  const next = splitBlocks(incoming || '')

  // ── 收集：节 key（认得的标准节 or 'unknown:<标题>'）→ 条目 Map(id → 块) 与自由文本
  const store = new Map()
  const ensure = (key, title) => {
    if (!store.has(key)) store.set(key, { key, title, entries: new Map(), prev: [], next: [] })
    return store.get(key)
  }
  const keyOf = (sec) => (sec.known ? sec.known : `unknown:${sec.title}`)

  const absorb = (blocks, isNew) => {
    for (const sec of blocks.sections) {
      const bucket = ensure(keyOf(sec), sec.title)
      // ⚠️ 小节的自由文本（`## 总结` 下面那段、`## 扫过没收的` 那串列表）
      // **这一轮写了就用这一轮的**，不能跟上一次拼起来 ——
      // 否则同一天跑第二轮会看到两段互相矛盾的总结（上一轮说"没跑成"、这一轮说跑成了）。
      const mine = isNew ? bucket.next : bucket.prev
      for (const line of sec.free) {
        const s = line.trim()
        if (s && !mine.includes(line)) mine.push(line)
      }
      for (const e of sec.entries) {
        const h = parseEntryHeading(e.heading)
        const key = h ? `id:${h.id}` : `raw:${e.heading}`
        if (bucket.entries.has(key) && !isNew) continue
        bucket.entries.set(key, { heading: e.heading, lines: e.lines, isNew })
      }
    }
  }
  absorb(prev, false)
  absorb(next, true)

  // ── 渲染
  const added = []
  const replaced = []
  const order = [...SECTIONS.map((s) => s.key), ...[...store.keys()].filter((k) => k.startsWith('unknown:'))]
  const out = [`# ${day}`, '']

  const renderEntry = (e) => {
    const lines = [...e.lines]
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    return [e.heading, ...lines].join('\n')
  }

  for (const key of order) {
    const bucket = store.get(key)
    if (!bucket) continue
    const entries = [...bucket.entries.values()]
    const free = bucket.next.filter((l) => l.trim()).length ? bucket.next : bucket.prev
    if (!entries.length && !free.filter((l) => l.trim()).length) continue

    // 同节内：值得看优先，其余保持原顺序
    const sorted = key === 'picks'
      ? [...entries].sort((a, b) => rank(tierOf(a.lines)) - rank(tierOf(b.lines)))
      : entries

    const title = SECTION_BY_TITLE.get(key)?.title ?? bucket.title
    out.push(`## ${title}`, '')
    for (const line of free) if (line.trim()) out.push(line)
    if (free.filter((l) => l.trim()).length) out.push('')
    for (const e of sorted) {
      out.push(renderEntry(e), '')
    }
  }

  // 变了的是哪些（用于回执）
  const prevIds = new Set(prev.sections.flatMap((s) => s.entries.map((e) => parseEntryHeading(e.heading)?.id).filter(Boolean)))
  for (const s of next.sections) {
    for (const e of s.entries) {
      const id = parseEntryHeading(e.heading)?.id
      if (!id) continue
      if (prevIds.has(id)) { if (!replaced.includes(id)) replaced.push(id) }
      else if (!added.includes(id)) added.push(id)
    }
  }

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  return { text, added, replaced }
}

const rank = (tier) => {
  const i = TIERS.indexOf(tier)
  return i < 0 ? TIERS.length : i
}

/**
 * 日报 → 给界面用的结构化视图（主区页和设置页都吃这一份）。
 * 只做展示需要的整理：分节、条目、档位、有没有具体数字（没有就标出来，别装作有）。
 */
export function reportView(text) {
  const { preamble, sections } = splitBlocks(text || '')
  const out = []
  for (const sec of sections) {
    const known = SECTION_BY_TITLE.get(sec.title)
    out.push({
      title: sec.title,
      key: known?.key ?? '',
      lines: sec.free.filter((l) => l.trim()),
      entries: sec.entries.map((e) => {
        const h = parseEntryHeading(e.heading)
        const body = e.lines.join('\n')
        return {
          id: h?.id ?? '',
          source: h?.source ?? '',
          title: h?.title ?? e.heading,
          tier: tierOf(e.lines),
          body,
          hasNumbers: /\d/.test(body),
        }
      }),
    })
  }
  const head = preamble.find((l) => /^#\s/.test(l.trim()))?.replace(/^#\s*/, '').trim() ?? ''
  return { day: head, sections: out }
}
