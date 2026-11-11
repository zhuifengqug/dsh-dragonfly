/**
 * AIHOT 这一头：请求、抹平、缓存、渲染，以及"只开 AIHOT 也能跑一轮"。
 *
 * 全部用假 fetcher —— 一条测试都不许打真接口（那是别人的服务，也是测试的不稳定源）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  AIHOT_UA, aihotForDay, aihotMarkdown, aihotPromptNote, fetchAihot, normalizeDaily, normalizeSelected,
} from '../../lib/aihot.mjs'
import { DEFAULTS } from '../../lib/config.mjs'
import { createDragonflyService } from '../../lib/service.mjs'
import { countPicks, mergeReport, parseEntryHeading, urlOf } from '../../lib/report.mjs'

const DAILY = {
  schemaVersion: '2.0.0',
  report: {
    date: '2026-11-10',
    generatedAt: '2026-11-10T01:00:00Z',
    lead: { title: '今天的主线', leadParagraph: '模型又小又快了一点。' },
    highlights: [
      {
        title: '某公司发布新模型',
        summary: '一句话说清它是什么。',
        source: { name: 'Example Blog' },
        links: { aihot: 'https://aihot.news/items/abcdefghij0123456789klmn', original: 'https://example.com/a' },
      },
    ],
  },
}

const SELECTED = {
  schemaVersion: '2.0.0',
  items: [
    {
      id: 'zyxwvutsrq0123456789abcd',
      title: '另一条精选',
      summary: '摘要。',
      source: { name: 'Another' },
      links: { aihot: 'https://aihot.news/items/zyxwvutsrq0123456789abcd', original: '' },
    },
  ],
}

test('normalizeDaily：抹平成 id/标题/摘要/来源/两个链接', () => {
  const got = normalizeDaily(DAILY, 5)
  assert.equal(got.ok, true)
  assert.equal(got.date, '2026-11-10')
  assert.equal(got.lead.title, '今天的主线')
  assert.equal(got.items.length, 1)
  const it = got.items[0]
  assert.equal(it.id, 'abcdefghij0123456789klmn')
  assert.equal(it.title, '某公司发布新模型')
  assert.equal(it.source, 'Example Blog')
  assert.equal(it.aihotUrl, 'https://aihot.news/items/abcdefghij0123456789klmn')
  assert.equal(it.originalUrl, 'https://example.com/a')
})

test('normalizeDaily：没有 report 就明确说没取到，不抛', () => {
  const got = normalizeDaily({}, 5)
  assert.equal(got.ok, false)
  assert.match(got.reason, /report/)
})

test('normalizeSelected：读 items，并按 limit 截断', () => {
  const got = normalizeSelected(SELECTED, 5)
  assert.equal(got.ok, true)
  assert.equal(got.items.length, 1)
  assert.equal(got.items[0].id, 'zyxwvutsrq0123456789abcd')
  assert.equal(normalizeSelected(SELECTED, 0).items.length, 0)
})

test('接口没给 id 时兜底 id 稳定且形状合法（日报按 id 去重，不能每次都变）', () => {
  const raw = {
    report: {
      highlights: [
        { title: '没 id 的一条', summary: '', source: { name: 'X' }, links: { aihot: '', original: 'https://e.com/1' } },
      ],
    },
  }
  const a = normalizeDaily(raw, 5).items[0]
  const b = normalizeDaily(raw, 5).items[0]
  assert.equal(a.id, b.id)
  assert.match(a.id, /^[0-9a-z]{20,32}$/)
})

test('fetchAihot：带上 aihot-api 的 UA，daily 打 /dailies/latest', async () => {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), ua: init?.headers?.['user-agent'] })
    return { ok: true, status: 200, json: async () => DAILY }
  }
  const got = await fetchAihot({ mode: 'daily', limit: 3, fetcher })
  assert.equal(got.ok, true)
  assert.equal(got.mode, 'daily')
  assert.equal(calls[0].url, 'https://aihot.news/api/v1/dailies/latest')
  assert.equal(calls[0].ua, AIHOT_UA)
})

test('fetchAihot：HTTP 失败折成 ok:false，不抛', async () => {
  const got = await fetchAihot({ mode: 'daily', fetcher: async () => ({ ok: false, status: 503 }) })
  assert.equal(got.ok, false)
  assert.match(got.reason, /503/)
})

test('aihotForDay：同一天第二次走缓存，不再请求', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aihot-cache-'))
  try {
    let n = 0
    const fetcher = async () => { n += 1; return { ok: true, status: 200, json: async () => DAILY } }
    const first = await aihotForDay({ home, day: '2026-11-10', mode: 'daily', limit: 5, fetcher })
    const second = await aihotForDay({
      home, day: '2026-11-10', mode: 'daily', limit: 5,
      fetcher: async () => { throw new Error('不该再请求') },
    })
    assert.equal(n, 1)
    assert.equal(first.items.length, 1)
    assert.equal(second.items.length, 1)
    assert.equal(second.cached, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('aihotMarkdown：渲染成认得的 [AIHOT] 条目，能反解出 id 与链接', () => {
  const got = normalizeDaily(DAILY, 5)
  const lines = aihotMarkdown(got, { day: '2026-11-10' })
  const heading = lines.find((l) => l.startsWith('### '))
  const parsed = parseEntryHeading(heading)
  assert.equal(parsed.source, 'aihot')
  assert.equal(parsed.id, 'abcdefghij0123456789klmn')
  assert.equal(urlOf(parsed.source, parsed.id), 'https://aihot.news/items/abcdefghij0123456789klmn')
  assert.ok(lines.some((l) => l.startsWith('>')), 'lead 应该渲染成引用行')
})

test('mergeReport：同一天合并两次，AIHOT 条目不会变成两条', () => {
  const got = normalizeDaily(DAILY, 5)
  const lines = aihotMarkdown(got, { day: '2026-11-10' })
  const incoming = `# 2026-11-10\n\n## AI 圈（AIHOT）\n\n${lines.join('\n')}\n`
  const once = mergeReport('', incoming, '2026-11-10').text
  const twice = mergeReport(once, incoming, '2026-11-10').text
  assert.equal(twice, once)
  assert.equal(countPicks(twice).bySource.aihot, 1)
})

test('countPicks：AIHOT 条目单独数，不算进"值得看"', () => {
  const text = [
    '# 2026-11-10',
    '',
    '### BV1xx411c7mD / 一条视频',
    '**档位**：值得看',
    '',
    '## AI 圈（AIHOT）',
    '',
    '### [AIHOT] abcdefghij0123456789klmn / 某条新闻',
    '**说了什么**：一句话。',
  ].join('\n')
  const c = countPicks(text)
  assert.equal(c.good, 1)
  assert.equal(c.bySource.bili, 1)
  assert.equal(c.bySource.aihot, 1)
})

test('只开 AIHOT：不走模型也能出一份日报', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-aihot-'))
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => DAILY })
    const ctx = {
      get: (k) => (k === 'dshHomePath' ? (...p) => join(home, ...p) : undefined),
      settings: { get: () => undefined, set: () => {} },
      effect: () => {},
      logger: { info() {}, warn() {}, error() {} },
    }
    const svc = createDragonflyService(ctx, {
      pluginDir: process.cwd(),
      config: { ...DEFAULTS, sources: { bili: false, douyin: false, aihot: true } },
      log: () => {},
    })
    const out = await svc.run('manual')
    assert.equal(out.ok, true)
    assert.equal(out.code, 0)
    assert.match(out.report.text, /## AI 圈（AIHOT）/)
    assert.match(out.report.text, /### \[AIHOT\] abcdefghij0123456789klmn \/ 某公司发布新模型/)
    assert.equal(svc.status().picks?.bySource?.aihot ?? 1, 1)
    assert.equal(svc.status().quota.aihotRuns, 0, '手动那一轮记账在手动格子里')
    assert.equal(svc.status().quota.manualRuns, 1)
    assert.equal(svc.status().quota.autoRuns, 0)
  } finally {
    globalThis.fetch = realFetch
    await rm(home, { recursive: true, force: true })
  }
})

test('aihotPromptNote：每条都带上正文，取不到时说清原因', () => {
  const note = aihotPromptNote({
    ok: true,
    lead: { title: '头条甲', text: '一句话说清' },
    items: [
      { title: '某公司发布新模型', source: 'Meta', summary: '支持工具调用与长文档解析。' },
      { title: '没有正文的那条' },
    ],
  })
  assert.match(note, /^头条：头条甲 —— 一句话说清$/m)
  assert.match(note, /^- 某公司发布新模型（Meta）$/m)
  assert.match(note, /^ {2}支持工具调用与长文档解析。$/m)
  assert.match(note, /^- 没有正文的那条$/m)
  assert.match(aihotPromptNote({ ok: true, items: [] }), /没有内容/)
  assert.match(aihotPromptNote({ ok: false, reason: 'HTTP 503' }), /没取到：HTTP 503/)
  assert.match(aihotPromptNote(null), /没取到/)
})

test('AI 圈一天只取一次：第二次那一轮直接说已取过', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-aihot-'))
  const realFetch = globalThis.fetch
  try {
    let calls = 0
    globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => DAILY } }
    const ctx = {
      get: (k) => (k === 'dshHomePath' ? (...p) => join(home, ...p) : undefined),
      settings: { get: () => undefined, set: () => {} },
      effect: () => {},
      logger: { info() {}, warn() {}, error() {} },
    }
    const svc = createDragonflyService(ctx, {
      pluginDir: process.cwd(),
      config: { ...DEFAULTS, sources: { bili: false, douyin: false, aihot: true } },
      log: () => {},
    })
    const first = await svc.run('auto')
    assert.equal(first.ok, true)
    assert.equal(svc.status().quota.aihotTaken, true, '取过之后要打上今天的标记')
    const second = await svc.run('auto')
    assert.equal(second.ok, false)
    assert.equal(second.code, 'quota')
    assert.match(second.text, /今天 AI 圈已经取过了/)
    assert.equal(calls, 1, '第二次不该再打接口')
  } finally {
    globalThis.fetch = realFetch
    await rm(home, { recursive: true, force: true })
  }
})

test('dragonfly_aihot 背后的 aihotNow：当天取过就直接用缓存', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-aihot-'))
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => DAILY })
    const ctx = {
      get: (k) => (k === 'dshHomePath' ? (...p) => join(home, ...p) : undefined),
      settings: { get: () => undefined, set: () => {} },
      effect: () => {},
      logger: { info() {}, warn() {}, error() {} },
    }
    const svc = createDragonflyService(ctx, {
      pluginDir: process.cwd(),
      config: { ...DEFAULTS, sources: { bili: false, douyin: false, aihot: true } },
      log: () => {},
    })
    const a = await svc.aihotNow()
    assert.equal(a.ok, true)
    assert.ok(a.items.length > 0)
    assert.equal(a.cached, false)
    const b = await svc.aihotNow()
    assert.equal(b.cached, true, '第二次读缓存')
    globalThis.fetch = async () => { throw new Error('不该再打接口') }
    const c = await svc.aihotNow()
    assert.equal(c.ok, true)
    assert.equal(c.cached, true)
  } finally {
    globalThis.fetch = realFetch
    await rm(home, { recursive: true, force: true })
  }
})
