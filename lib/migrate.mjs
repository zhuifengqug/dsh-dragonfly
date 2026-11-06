/**
 * lib/migrate.mjs —— 从旧的刷B站插件搬东西过来，以及"改存放位置"
 * ============================================================================
 * 三件事，规矩一样：**只复制，绝不删旧目录**（删不删由使用者自己决定）。
 *
 *   · importFromBili()  首次启动时从 `$DSH_HOME/bili-duty/` 一次性幂等导入
 *   · importHistory()   已经用起来之后再补搬：判重表按行合并、笔记复制、
 *                       旧日报与月度归档落 `archive/`（旧格式不塞进"今天"页）
 *   · moveHome()        使用者改了存放位置 —— 只带配置 / 判重 / 凭证，
 *                       日报与笔记留在旧地方（并且告诉他还剩多少份）
 *
 * 为什么日报不搬：那是历史，搬过去会让"今天"的目录看起来有一堆旧文件；
 * 而且旧目录留着，两边都能翻。
 * ============================================================================
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { appendRow, emptySeen, parseSeen } from './seen.mjs'

/** 旧插件的家 */
export function biliHome() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
}

/** 数一数某个目录里有几份日报（给"旧目录还有 N 份日报"用） */
export function countReports(dir) {
  try {
    return readdirSync(join(dir, 'out')).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).length
  } catch { return 0 }
}

/**
 * 从 `bili-duty` 导入。**幂等**：已经有 `migrated-from` 就不再导。
 * 只带三样：config.json / seen.md / bili_credential.json（还有 duty.md 与 charter.sha256 用来判断章程有没有被动过）。
 */
export function importFromBili(layout, log = () => {}) {
  const src = biliHome()
  if (!existsSync(src)) return { ok: true, state: 'no-source', text: '没有找到旧的 bili-duty 目录，跳过导入。' }

  // 已经有痕迹就别再动 —— 这条保证"只导一次"
  const cfgFile = layout.config
  let cfg = {}
  try { cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {} } catch { cfg = {} }
  if (cfg && cfg['migrated-from']) {
    return { ok: true, state: 'already', text: `已经导入过（来源 ${cfg['migrated-from']}），没再动。` }
  }
  // 家里已经用起来了也跳过（别覆盖使用者已经在用的东西）
  if (existsSync(layout.seen) && countReports(layout.home) > 0) {
    return { ok: true, state: 'in-use', text: '这边已经在用了，不覆盖。' }
  }

  const copied = []
  const failed = []
  mkdirSync(layout.home, { recursive: true })

  // config.json 与凭据是「整份搬」；判重表**不整份搬** —— 旧表是多节混排的
  // （`## 评论记录` / `## 看过的视频`，状态写「挑了」），直接拷过来蜻蛉的解析器认不全，
  // 也就等于没搬。所以走一次「读旧表 → 按 id 重排进 `## B站` 那一节」。
  const pairs = [
    [join(src, 'config.json'), layout.config],
    [join(src, 'bili_credential.json'), layout.biliCredential],
    [join(src, 'creds', 'bili-credential.json'), layout.biliCredential],
  ]
  for (const [from, to] of pairs) {
    try {
      if (!existsSync(from)) continue
      if (existsSync(to)) continue          // 已有的不动
      mkdirSync(join(to, '..'), { recursive: true })
      cpSync(from, to)
      copied.push(to.split(/[\\/]/).pop())
    } catch (e) { failed.push(`${from}: ${e?.message || e}`) }
  }

  // 判重表：并进 B站 节
  let seenRows = 0
  try {
    const oldSeen = join(src, 'seen.md')
    if (existsSync(oldSeen) && !existsSync(layout.seen)) {
      const parsed = parseSeen(readFileSync(oldSeen, 'utf8'))
      let text = emptySeen()
      for (const r of parsed.rows) {
        if (!r.id) continue
        text = appendRow(text, {
          section: 'bili',
          day: r.day,
          id: r.id,
          title: r.title,
          up: r.up,
          status: r.status || '收',
        })
        seenRows += 1
      }
      writeFileSync(layout.seen, text, 'utf8')
      if (seenRows) copied.push(`判重表（${seenRows} 条）`)
    } else if (existsSync(join(src, 'seen.md')) && existsSync(layout.seen)) {
      failed.push('判重表：这边已经有 seen.md，没并')
    }
  } catch (e) { failed.push(`判重表: ${e?.message || e}`) }

  // config.json 里盖一个戳（同时把旧配置里只属于旧插件的键丢掉）
  try {
    let next = {}
    try { next = JSON.parse(readFileSync(layout.config, 'utf8')) } catch { next = {} }
    // 旧插件特有的键，蜻蛉不认，删掉免得混进日志
    for (const k of ['headlessProfile', 'overlayMcp', 'asrEnabled', 'dmMode']) {
      if (k === 'dmMode') continue           // dmMode 两边都有，语义变了但键名一样，留着
      delete next[k]
    }
    next['migrated-from'] = 'bili-duty'
    next['migrated-at'] = new Date().toISOString()
    writeFileSync(layout.config, JSON.stringify(next, null, 2), 'utf8')
  } catch (e) { failed.push(`写 config.json: ${e?.message || e}`) }

  const reports = countReports(src)
  log(`从 bili-duty 导入：${copied.join('、') || '没有可导的'}${failed.length ? `；失败 ${failed.length} 条` : ''}`)
  return {
    ok: failed.length === 0,
    state: 'imported',
    copied,
    failed,
    oldReports: reports,
    text: copied.length
      ? `从旧的 bili-duty 导入了：${copied.join('、')}。旧目录原样留着${reports ? `（还有 ${reports} 份日报）` : ''}。`
      : '没找到可导入的东西，从零开始。',
  }
}

/**
 * 把旧插件"已经采过的东西"整批搬过来 —— 判重表、单片笔记、旧日报、月度归档。
 *
 * 跟 `importFromBili()` 的分工：
 *   · `importFromBili` 是**首次启动**用的：只带配置/凭证/判重，而且"目标已经有了就整份跳过"；
 *   · `importHistory` 是**事后补搬**用的：判重按 `日期+id` 逐行合并（已有的不覆盖，新表里的状态更新），
 *     笔记复制不覆盖，旧日报与月度归档落到 `archive/`（格式跟现在不同，不塞进"今天"页）。
 *
 * **幂等**：重复跑只会得到"都搬过了"。**不删任何东西** —— 旧目录留给人自己删。
 */
export function importHistory(layout, opts = {}) {
  const log = opts.log || (() => {})
  const src = biliHome()
  if (!existsSync(src)) {
    return { ok: true, state: 'no-source', text: '没有找到旧的 bili-duty 目录，没有历史可搬。' }
  }

  const now = opts.now || new Date()
  const res = {
    ok: true, state: 'imported',
    seenAdded: 0, seenSkipped: 0,
    reports: 0, reportsSkipped: 0,
    legacy: 0, legacySkipped: 0,
    digest: 0, digestSkipped: 0,
    failed: [],
  }

  // ① 判重表：逐行合并（同一个 日期+id 已经在表里就不动它）
  try {
    const from = join(src, 'seen.md')
    if (existsSync(from)) {
      const rows = parseSeen(readFileSync(from, 'utf8'), now).rows.filter((r) => r.id)
      let text = existsSync(layout.seen) ? readFileSync(layout.seen, 'utf8') : emptySeen()
      const have = new Set(parseSeen(text, now).rows.map((r) => `${r.section}|${r.id}|${r.day}`))
      for (const r of rows) {
        const key = `${r.section}|${r.id}|${r.day}`
        if (have.has(key)) { res.seenSkipped += 1; continue }
        text = appendRow(text, { section: r.section, day: r.day, id: r.id, title: r.title, up: r.up, status: r.status || '收' }, now)
        have.add(key)
        res.seenAdded += 1
      }
      mkdirSync(join(layout.seen, '..'), { recursive: true })
      writeFileSync(layout.seen, text, 'utf8')
    }
  } catch (e) { res.failed.push(`判重表：${e?.message || e}`) }

  // ② 单片笔记：同名不覆盖（现在的笔记是新一轮写的，别拿旧的盖）
  try {
    const from = join(src, 'reports')
    if (existsSync(from)) {
      mkdirSync(layout.reports, { recursive: true })
      for (const name of readdirSync(from)) {
        if (!/\.md$/i.test(name)) continue
        const to = join(layout.reports, name)
        if (existsSync(to)) { res.reportsSkipped += 1; continue }
        try { cpSync(join(from, name), to); res.reports += 1 } catch (e) { res.failed.push(`笔记 ${name}：${e?.message || e}`) }
      }
    }
  } catch (e) { res.failed.push(`笔记：${e?.message || e}`) }

  // ③ 旧日报：整份落 archive（旧格式是「## 日期 · 关键词轮」+「### BV…」，
  //    跟现在的「### [B站] BV… / 标题」不是一回事，硬并进 out/ 会让界面解析出半截）
  res.legacy = copyInto(join(src, 'out'), join(layout.archive, 'legacy-out'), /\.md$/i, res, 'legacySkipped')
  // ④ 月度归档（带"为什么跳过"，比现在的判重表多一层信息，值得留）
  res.digest = copyInto(join(src, 'digest'), join(layout.archive, 'digest'), /\.md$/i, res, 'digestSkipped')

  const moved = res.seenAdded + res.reports + res.legacy + res.digest
  if (res.failed.length) res.ok = false
  res.text = moved
    ? `搬过来了：判重表 ${res.seenAdded} 行、单片笔记 ${res.reports} 份、旧日报 ${res.legacy} 份（archive/legacy-out）、月度归档 ${res.digest} 份（archive/digest）。旧目录原样留着。`
    : `都已经搬过了（判重表跳过 ${res.seenSkipped} 行、笔记 ${res.reportsSkipped} 份、日报 ${res.legacySkipped} 份）。`
  log(`历史补搬：${res.text}`)
  return res
}

/** 把 from 里的文件复制进 to（同名不覆盖）；返回复制了几个 */
function copyInto(from, to, pattern, res, skipKey) {
  let n = 0
  try {
    if (!existsSync(from)) return 0
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      if (!pattern.test(name)) continue
      const dest = join(to, name)
      if (existsSync(dest)) { res[skipKey] += 1; continue }
      try { cpSync(join(from, name), dest); n += 1 } catch (e) { res.failed.push(`${name}：${e?.message || e}`) }
    }
  } catch (e) { res.failed.push(`${from}：${e?.message || e}`) }
  return n
}

/**
 * 改存放位置。只复制配置 / 判重 / 凭证；日报与笔记不搬。
 * **目标非空时要调用方先确认过**（`confirm:true`），不确认就不动。
 */
export function moveHome(fromLayout, toLayout, opts = {}) {
  const log = opts.log || (() => {})
  if (fromLayout.home === toLayout.home) return { ok: false, text: '新位置和现在一样，没搬。' }

  const targetExists = existsSync(toLayout.home)
  const targetEmpty = targetExists ? readdirSync(toLayout.home).length === 0 : true
  if (!targetEmpty && !opts.confirm) {
    return {
      ok: false,
      needConfirm: true,
      text: `目标目录不是空的（${toLayout.home}）。确认要往里面写吗？已有的同名文件不会被覆盖。`,
    }
  }

  mkdirSync(toLayout.home, { recursive: true })
  const copied = []
  const skipped = []
  for (const [from, to, name] of [
    [fromLayout.config, toLayout.config, 'config.json'],
    [fromLayout.seen, toLayout.seen, 'seen.md'],
    [fromLayout.biliCredential, toLayout.biliCredential, 'bili-credential.json'],
  ]) {
    try {
      if (!existsSync(from)) { skipped.push(name); continue }
      if (existsSync(to)) { skipped.push(`${name}（目标已有，没覆盖）`); continue }
      mkdirSync(join(to, '..'), { recursive: true })
      cpSync(from, to)
      copied.push(name)
    } catch (e) { skipped.push(`${name}（${e?.message || e}）`) }
  }

  const oldReports = countReports(fromLayout.home)
  const noDyProfile = !existsSync(toLayout.dyProfile)
  log(`搬家：${copied.join('、') || '没搬东西'} → ${toLayout.home}`)
  return {
    ok: true,
    copied,
    skipped,
    oldReports,
    needDyLogin: noDyProfile,
    text: [
      `搬到 ${toLayout.home} 了。`,
      copied.length ? `带过去的：${copied.join('、')}。` : '',
      oldReports ? `旧目录还有 ${oldReports} 份日报，留在那儿没搬。` : '',
      noDyProfile ? '新目录没有抖音的浏览器登录态 —— 需要重新扫码一次。' : '',
    ].filter(Boolean).join(' '),
  }
}

/** 目录里有没有东西（设置页确认"要不要覆盖"用） */
export function dirState(dir) {
  if (!existsSync(dir)) return { exists: false, empty: true, count: 0 }
  try {
    const names = readdirSync(dir)
    return { exists: true, empty: names.length === 0, count: names.length }
  } catch { return { exists: true, empty: false, count: -1 } }
}

/** 目录最后改时间（给"这个位置好像很久没用"这种提示） */
export function dirMtime(dir) {
  try { return statSync(dir).mtime.toISOString() } catch { return null }
}
