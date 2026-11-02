import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clampConfig, DEFAULTS, diffKeys, pickKnownKeys } from '../../lib/config.mjs'
import { appendRow, emptySeen, formatRow, parseSeen, seenDay, seenToday, sectionOfId, splitOld } from '../../lib/seen.mjs'
import { countPicks, mergeReport, reportView, tierOf } from '../../lib/report.mjs'
import { autoWindowState, dayKey, inWindow, nextWindowLabel, parseWindow } from '../../lib/clock.mjs'

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

// ── 配置 ─────────────────────────────────────────────────────────────────────
test('clampConfig 越界值夹住、认不出的退回默认、永不抛', () => {
  const c = clampConfig({ perDay: 999, dyDailyMinutes: -3, searchSort: '乱写', dmMode: '乱写', windows: ['瞎写'] })
  assert.equal(c.perDay, 30)
  assert.equal(c.dyDailyMinutes, 0)
  assert.equal(c.searchSort, DEFAULTS.searchSort)
  assert.equal(c.dmMode, 'read')
  assert.deepEqual(c.windows, DEFAULTS.windows)
})

test('clampConfig 在 dmEnabled=false 时把 auto 降回 read（对外发言要单独开）', () => {
  const c = clampConfig({ dmEnabled: false, dmMode: 'auto' })
  assert.equal(c.dmMode, 'read')
})

test('clampConfig 传垃圾也不炸', () => {
  for (const junk of [null, undefined, 'x', 42, [], { model: 'oops', sources: 7 }]) {
    const c = clampConfig(junk)
    assert.equal(typeof c.perDay, 'number')
  }
})

test('diffKeys 只报真变了的键', () => {
  const a = clampConfig({})
  const b = clampConfig({ perDay: 9 })
  assert.deepEqual(diffKeys(a, b), ['perDay'])
})

test('pickKnownKeys 丢掉不认识的键', () => {
  assert.deepEqual(pickKnownKeys({ perDay: 3, 乱写: 1 }), { perDay: 3 })
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

test('autoWindowState 两道与门：窗口 + 谷时', () => {
  const utcNoon = new Date(Date.UTC(2026, 10, 2, 4, 0))   // 北京 12:00，工作日
  const cfg = { windows: ['00:00-24:00'], peakValley: true, noon: true, night: true }
  assert.equal(autoWindowState(utcNoon, cfg).ok, true)

  const outside = { ...cfg, windows: ['01:00-02:00'] }
  assert.equal(autoWindowState(utcNoon, outside).ok, false)

  const noPeak = { ...cfg, peakValley: false }
  assert.equal(autoWindowState(utcNoon, noPeak).ok, true)
})

test('nextWindowLabel 给一个人能看的下一时刻', () => {
  const utcNoon = new Date(Date.UTC(2026, 10, 2, 4, 0))
  const n = nextWindowLabel(utcNoon, { windows: ['00:00-24:00'], peakValley: true, noon: true, night: true })
  assert.match(n.label, /^\d{2}:\d{2}$/)
})

test('dayKey 用本机日期', () => {
  assert.equal(dayKey(new Date(2026, 10, 2, 23, 30)), '2026-11-02')
})


