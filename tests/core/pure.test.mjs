import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clampConfig, DEFAULTS, diffKeys, pickKnownKeys } from '../../lib/config.mjs'
import { appendRow, emptySeen, formatRow, parseSeen, seenDay, seenToday, sectionOfId, splitOld } from '../../lib/seen.mjs'
import { countPicks, emptyReport, mergeReport, reportView, tierOf } from '../../lib/report.mjs'
import { autoWindowState, dayKey, dayWindows, inWindow, nextWindowLabel, parseWindow } from '../../lib/clock.mjs'

// ── 判重表 ───────────────────────────────────────────────────────────────────
test('seenDay 认各种日期写法；没写年份按今年补', () => {
  const now = new Date(2026, 10, 2) // 2026-11-02
  assert.equal(seenDay('2026-11-01', now), '2026-11-01')
  assert.equal(seenDay('11-01', now), '2026-11-01')
  assert.equal(seenDay('2026/11/1', now), '2026-11-01')
  assert.equal(seenDay('2026-11-01 13:20', now), '2026-11-01')
  assert.equal(seenDay('瞎写的', now), null)
})

test('seenDay 没写年份但补出来比今天晚 ⇒ 算去年', () => {
  const now = new Date(2026, 0, 5) // 2026-01-05
  assert.equal(seenDay('12-30', now), '2025-12-30')
})

test('parseSeen 不认列位：列顺序乱写也认得出 id 和日期', () => {
  const text = [
    '## B站',
    '| 日期 | BV | 标题 | UP | 状态 |',
    '| 2026-11-01 | BV1xx411c7mD | 标题 | 某UP | 收 |',
    // 列顺序被写反
    '| 弃 | BV1yy411c7mE | 另一个 | 2026-11-02 | 标题 |',
  ].join('\n')
  const { rows } = parseSeen(text, new Date(2026, 10, 2))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'BV1xx411c7mD')
  assert.equal(rows[0].day, '2026-11-01')
  assert.equal(rows[0].status, '收')
  assert.equal(rows[1].id, 'BV1yy411c7mE')
  assert.equal(rows[1].day, '2026-11-02')
  assert.equal(rows[1].status, '弃')
})

test('parseSeen 按节归属：抖音的数字 id 不被当成 B站', () => {
  const text = [
    '## 抖音',
    '| 日期 | id | 标题 | UP | 状态 |',
    '| 2026-11-02 | 7300000000000000001 | 某条 | 某人 | 收 |',
  ].join('\n')
  const { rows } = parseSeen(text, new Date(2026, 10, 2))
  assert.equal(rows[0].section, 'douyin')
  assert.equal(sectionOfId('7300000000000000001'), 'douyin')
  assert.equal(sectionOfId('BV1xx411c7mD'), 'bili')
})

test('appendRow 幂等：同节同 id 同一天只留一行，状态可升级', () => {
  const today = new Date(2026, 10, 2)
  let text = emptySeen()
  text = appendRow(text, { section: 'bili', id: 'BV1xx411c7mD', title: '标题', up: 'UP', status: '弃' }, today)
  text = appendRow(text, { section: 'bili', id: 'BV1xx411c7mD', title: '标题', up: 'UP', status: '收' }, today)
  const { rows } = parseSeen(text, today)
  const hit = rows.filter((r) => r.id === 'BV1xx411c7mD')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].status, '收')
  assert.equal(hit[0].section, 'bili')
})

test('appendRow 没有那一节时补一节并带表头', () => {
  const today = new Date(2026, 10, 2)
  const text = appendRow('# 见闻录\n', { section: 'douyin', id: '7300000000000000001', status: '收' }, today)
  assert.match(text, /## 抖音/)
  assert.match(text, /\| 日期 \| id \| 标题 \| UP \| 状态 \|/)
  assert.equal(parseSeen(text, today).rows.length, 1)
})

test('标题里的竖线会被转义，不会把表格撑破', () => {
  const line = formatRow({ day: '2026-11-02', id: 'BV1xx411c7mD', title: 'a|b', up: 'u', status: '收' })
  assert.match(line, /a\\\|b/)
  const { rows } = parseSeen(`## B站\n| 日期 | id | 标题 | UP | 状态 |\n${line}`, new Date(2026, 10, 2))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'a|b')
})

test('splitOld 把超过 30 天的行摘出来', () => {
  const now = new Date(2026, 10, 2)
  let text = emptySeen()
  text = appendRow(text, { section: 'bili', id: 'BV1old411c7m', status: '收', day: '2026-09-01' }, now)
  text = appendRow(text, { section: 'bili', id: 'BV1new411c7m', status: '收', day: '2026-11-01' }, now)
  const { keep, moved } = splitOld(text, 30, now)
  assert.equal(moved.length, 1)
  assert.equal(moved[0].id, 'BV1old411c7m')
  assert.doesNotMatch(keep, /BV1old411c7m/)
  assert.match(keep, /BV1new411c7m/)
})

// ── 日报合并 ─────────────────────────────────────────────────────────────────
const ENTRY_A = [
  '### [B站] BV1xx411c7mD / 一个标题',
  '**档位**：值得看',
  '**为什么值得**：12 分钟讲完了一件事，播放 3.2 万。',
  '**我的一句话**：可以。',
].join('\n')

test('mergeReport 同 id 整条替换，不追加第二条', () => {
  const day = '2026-11-02'
  const first = mergeReport('', ENTRY_A, day)
  assert.deepEqual(first.added, ['BV1xx411c7mD'])
  const second = mergeReport(first.text, ENTRY_A.replace('可以。', '改了口。'), day)
  assert.deepEqual(second.replaced, ['BV1xx411c7mD'])
  assert.equal((second.text.match(/BV1xx411c7mD/g) || []).length, 1)
  assert.match(second.text, /改了口。/)
})

test('mergeReport 保留已有条目，新增的排进去', () => {
  const day = '2026-11-02'
  const a = mergeReport('', ENTRY_A, day)
  const b = mergeReport(a.text, ENTRY_A.replace('BV1xx411c7mD', 'BV1yy411c7mE'), day)
  assert.deepEqual(b.added, ['BV1yy411c7mE'])
  assert.match(b.text, /BV1xx411c7mD/)
  assert.match(b.text, /BV1yy411c7mE/)
})

// 同一天跑第二轮时，`## 总结` 下面那段必须被这一轮的替换掉。
// 真机上出现过两份互相矛盾的总结同时躺在报告里（上一轮说"没跑成"、这一轮说收了几条）。
test('mergeReport 同一小节里这一轮写的正文替换上一轮的，不叠加', () => {
  const day = '2026-11-02'
  const round1 = ['## 总结', '', '这一轮没跑成，两个入口都塌了。', ''].join('\n')
  const round2 = ['## 总结', '', '收了三条，抖音停在直播页没取到作品。', ''].join('\n')
  const a = mergeReport('', round1, day)
  const b = mergeReport(a.text, round2, day)
  assert.match(b.text, /收了三条/)
  assert.doesNotMatch(b.text, /没跑成/, '上一轮的总结不该还在')
})

test('mergeReport 这一轮没写的小节正文保留上一轮的', () => {
  const day = '2026-11-02'
  const round1 = ['## 扫过没收的', '', '- BV1zz411c7mF：太短', ''].join('\n')
  const round2 = [ENTRY_A, '', '## 总结', '', '收了。', ''].join('\n')
  const a = mergeReport('', round1, day)
  const b = mergeReport(a.text, round2, day)
  assert.match(b.text, /BV1zz411c7mF/, '上一轮列的"扫过没收的"要留着')
  assert.match(b.text, /收了。/)
})

test('countPicks 只数档位=值得看的', () => {
  const text = [
    '### [B站] BV1xx411c7mD / 甲',
    '**档位**：值得看',
    '### [抖音] 7300000000000000001 / 乙',
    '**档位**：可以看',
  ].join('\n')
  const c = countPicks(text)
  assert.equal(c.good, 1)
  assert.equal(c.total, 2)
  assert.equal(c.bySource.bili, 1)
})

test('tierOf 认三种档位，别的一律空', () => {
  assert.equal(tierOf(['**档位**：值得看']), '值得看')
  assert.equal(tierOf(['**档位**：不值当']), '不值当')
  assert.equal(tierOf(['档位：可以看']), '')
})

test('reportView 给出界面要的结构', () => {
  const v = reportView(`# 2026-11-02\n\n## 今天挑的\n\n${ENTRY_A}\n`)
  assert.equal(v.day, '2026-11-02')
  const picks = v.sections.find((s) => s.title === '今天挑的')
  assert.equal(picks.entries.length, 1)
  assert.equal(picks.entries[0].tier, '值得看')
  assert.equal(picks.entries[0].hasNumbers, true)
})

test('reportView 把「为什么值得」与「我的一句话」拆出来，界面不再露原始标记', () => {
  const v = reportView(`# 2026-11-02\n\n${ENTRY_A}\n`)
  const e = v.sections.find((s) => s.title === '今天挑的').entries[0]
  assert.match(e.why, /12 分钟讲完了一件事/)
  assert.doesNotMatch(e.why, /\*\*为什么值得\*\*/)
  assert.match(e.quote, /可以。/)
  assert.doesNotMatch(e.quote, /\*\*我的一句话\*\*/)
})

test('reportView 由 id 推出视频地址，不认日报里没写的链接', () => {
  const bili = reportView(`# 2026-11-02\n\n${ENTRY_A}\n`).sections[0].entries[0]
  assert.equal(bili.url, 'https://www.bilibili.com/video/BV1xx411c7mD')
  const dy = reportView('# 2026-11-02\n\n### [抖音] 7703424057992145849 / 一条抖音\n**档位**：可以看\n')
    .sections[0].entries[0]
  assert.equal(dy.url, 'https://www.douyin.com/video/7703424057992145849')
  const bad = reportView('# 2026-11-02\n\n### [B站] 不是BV号 / 标题\n**档位**：可以看\n').sections[0].entries[0]
  assert.equal(bad.url, '')
})

// ── 配置 ─────────────────────────────────────────────────────────────────────
test('clampConfig 越界值夹住、认不出的退回默认、永不抛', () => {
  const c = clampConfig({ autoPerSource: 999, dyDailyMinutes: -3, searchSort: '乱写', dmMode: '乱写', runTimes: ['瞎写', '25:99', '8:05']   })
  assert.equal(c.autoPerSource, 30)
  assert.equal(c.dyDailyMinutes, 0)
  assert.equal(c.searchSort, DEFAULTS.searchSort)
  assert.equal(c.dmMode, 'read')
  assert.deepEqual(c.runTimes, ['08:05'], '认不出的丢掉，剩下的补零')
  assert.deepEqual(clampConfig({ runTimes: ['9:00', '9:00', '18:00'] }).runTimes, ['09:00', '18:00'], '去重并按先后排')
  assert.deepEqual(clampConfig({ runTimes: [] }).runTimes, DEFAULTS.runTimes, '一条都不剩就退回默认三个')
})

test('clampConfig 在 dmEnabled=false 时把 auto 降回 read（对外发言要单独开）', () => {
  const c = clampConfig({ dmEnabled: false, dmMode: 'auto' })
  assert.equal(c.dmMode, 'read')
})

test('clampConfig 传垃圾也不炸', () => {
  for (const junk of [null, undefined, 'x', 42, [], { model: 'oops', sources: 7 }]) {
    const c = clampConfig(junk)
    assert.equal(typeof c.autoPerSource, 'number')
  }
})

test('diffKeys 只报真变了的键', () => {
  const a = clampConfig({})
  const b = clampConfig({ autoPerSource: 9 })
  assert.deepEqual(diffKeys(a, b), ['autoPerSource'])
})

test('workspaceDir 只认字符串、不校验存在性（目录由起轮前建）', () => {
  assert.equal(clampConfig({}).workspaceDir, '', '默认空 = 用数据目录')
  assert.equal(clampConfig({ workspaceDir: '  D:\\dsh-workspaces\\蜻蛉值班  ' }).workspaceDir, 'D:\\dsh-workspaces\\蜻蛉值班')
  assert.equal(clampConfig({ workspaceDir: null }).workspaceDir, '')
  assert.equal(clampConfig({ workspaceDir: 7 }).workspaceDir, '7')
  const long = 'x'.repeat(900)
  assert.equal(clampConfig({ workspaceDir: long }).workspaceDir.length, 500, '要有长度上限，别把配置撑爆')
})

test('pickKnownKeys 丢掉不认识的键', () => {
  assert.deepEqual(pickKnownKeys({ autoPerSource: 3, 乱写: 1 }), { autoPerSource: 3 })
})

// ── 时间窗 ───────────────────────────────────────────────────────────────────
test('parseWindow / inWindow 支持跨零点', () => {
  const w = parseWindow('18:00-09:00')
  assert.deepEqual([w.start, w.end], [1080, 540])
  // 北京时间 23:00 ⇒ UTC 15:00
  assert.equal(inWindow(new Date(Date.UTC(2026, 10, 2, 15, 0)), w), true)
  // 北京时间 03:00 ⇒ UTC 前一天 19:00
  assert.equal(inWindow(new Date(Date.UTC(2026, 10, 2, 19, 0)), w), true)
  // 北京时间 12:00 ⇒ UTC 04:00
  assert.equal(inWindow(new Date(Date.UTC(2026, 10, 2, 4, 0)), w), false)
})

test('autoWindowState：只在设的时间点那一小时内开跑', () => {
  const utcNoon = new Date(Date.UTC(2026, 10, 2, 4, 0))   // 北京 12:00，工作日
  assert.equal(autoWindowState(utcNoon, { runTimes: ['12:00'] }).ok, true)
  // 12:00 起一小时内都算这一轮（跳到 12:40 也不漏）
  const at = new Date(Date.UTC(2026, 10, 2, 4, 40))
  assert.equal(autoWindowState(at, { runTimes: ['12:00'] }).window, '12:00-13:00')
  // 不在时间点上就不跑
  assert.equal(autoWindowState(utcNoon, { runTimes: ['13:00'] }).ok, false)
  // 谷时开关：10:00 是工作日高峰，挡住；关掉就放行
  const utc10 = new Date(Date.UTC(2026, 10, 2, 2, 0))
  assert.equal(autoWindowState(utc10, { runTimes: ['10:00'], peakValley: true }).ok, false)
  assert.equal(autoWindowState(utc10, { runTimes: ['10:00'], peakValley: false }).ok, true)
})

test('dayWindows 把今天设的时间点列出来，标出过了没有', () => {
  // 北京 10:00（工作日）：三个默认点都还没到
  const beijing10 = new Date(Date.UTC(2026, 10, 2, 2, 0))
  const a = dayWindows(beijing10, { runTimes: ['12:00', '18:00', '23:00'] })
  assert.deepEqual(a.map((x) => `${x.spec}:${x.state}`), ['12:00-13:00:todo', '18:00-19:00:todo', '23:00-24:00:todo'])
  // 北京 12:30：第一个点正在段内
  const beijing1230 = new Date(Date.UTC(2026, 10, 2, 4, 30))
  const b = dayWindows(beijing1230, { runTimes: ['12:00', '18:00'] })
  assert.deepEqual(b.map((x) => x.state), ['active', 'todo'])
  // 不带配置就用出厂三个
  assert.deepEqual(dayWindows(beijing10, {}).map((x) => x.spec), ['12:00-13:00', '18:00-19:00', '23:00-24:00'])
})

test('nextWindowLabel 给一个人能看的下一时刻', () => {
  const beijing10 = new Date(Date.UTC(2026, 10, 2, 2, 0))
  assert.equal(nextWindowLabel(beijing10, { runTimes: ['12:00', '18:00'] }).label, '12:00')
  // 在段内就是现在这个点
  const beijing1220 = new Date(Date.UTC(2026, 10, 2, 4, 20))
  assert.equal(nextWindowLabel(beijing1220, { runTimes: ['12:00'] }).label, '12:00')
})

test('dayKey 用本机日期', () => {
  assert.equal(dayKey(new Date(2026, 10, 2, 23, 30)), '2026-11-02')
})



test('reportView 把「因缺证据跳过」「扫过没收的」「总结」都分开给，界面才不会把它们混成条目', () => {
  const text = [
    '# 2026-11-02',
    '',
    '### [B站] BV1xx411c7mD / 一条',
    '',
    '**档位**：值得看',
    '**为什么值得**：12 分钟讲了三件事',
    '',
    '## 扫过没收的',
    '',
    '- [B站] BV1yy411c7mE / 标题党：字幕全是废话',
    '',
    '## 因缺证据跳过',
    '',
    '- [B站] BV1zz411c7mF / 纯口播，没字幕',
    '',
    '## 总结',
    '',
    '今天就这样。',
  ].join('\n')

  const v = reportView(text)
  assert.equal(v.day, '2026-11-02')
  const byKey = Object.fromEntries(v.sections.map((s) => [s.key || s.title, s]))
  assert.equal(byKey.picks?.entries.length, 1)
  assert.equal(byKey.picks.entries[0].tier, '值得看')
  assert.equal(byKey.picks.entries[0].hasNumbers, true)
  assert.match(byKey['skipped']?.lines.join('\n') ?? '', /标题党/)
  assert.match(byKey['skipped-no-evidence']?.lines.join('\n') ?? '', /纯口播/)
  assert.match(byKey['summary']?.lines.join('\n') ?? '', /今天就这样/)
})

test('薄版日报（只有标题行 + 档位 + 一句话）仍然解析得出档位与条目', () => {
  const text = [
    '# 2026-11-02',
    '',
    '### [B站] BV1xx411c7mD / 一条',
    '',
    '**档位**：值得看',
    '**我的一句话**：12 分钟讲透了三件事，第 8 分钟那张图值得截。',
    '',
    '## 总结',
    '',
    '薄版也完整。',
  ].join('\n')

  const v = reportView(text)
  const picks = v.sections.find((s) => s.key === 'picks')
  assert.ok(picks, '薄版也应该有 picks 节')
  assert.equal(picks.entries.length, 1)
  assert.equal(picks.entries[0].tier, '值得看')
  assert.doesNotMatch(picks.entries[0].body, /为什么值得/, '薄版不写那一段')
  assert.equal(picks.entries[0].hasNumbers, true, '薄版也要有具体数字，只是挪进那句话里')
})

test('mergeReport 不写出空的 `## ` 标题 —— 主节条目直接跟在日期下面', () => {
  const incoming = [
    '### [B站] BV1xx411c7mD / 一条',
    '',
    '**档位**：值得看',
    '**为什么值得**：12 分钟讲了三件事',
    '',
    '## 总结',
    '',
    '今天就这样。',
  ].join('\n')
  const { text } = mergeReport(emptyReport('2026-11-02'), incoming, '2026-11-02')
  assert.doesNotMatch(text, /^##\s*$/m, '不能出现只有 `## ` 没有名字的小标题')
  // 条目必须紧跟 `# 日期`
  assert.match(text, /^# 2026-11-02\n\n### \[B站\]/, '主节条目要紧跟日期，不另起小标题')
  assert.match(text, /^## 总结$/m)
})

test('mergeReport 把 `## 今天挑的` 这种显式写法归到主节，不重复成第二节', () => {
  const incoming = [
    '## 今天挑的',
    '',
    '### [B站] BV1xx411c7mD / 一条',
    '',
    '**档位**：值得看',
  ].join('\n')
  const { text } = mergeReport(emptyReport('2026-11-02'), incoming, '2026-11-02')
  assert.equal((text.match(/BV1xx411c7mD/g) || []).length, 1, '同一条只能出现一次')
})
