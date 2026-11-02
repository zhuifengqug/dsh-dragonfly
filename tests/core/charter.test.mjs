/**
 * 章程拼装：设置页填的那些值，必须原样出现在那一轮的 prompt 里
 * ============================================================================
 * 这一层最容易出的错不是崩溃，是**静默丢失**：
 * 用户在设置页关了评论、改了额度，章程里却还是那句话，模型照旧去发。
 * 所以这里的断言都盯着"开关关掉之后，对应的许可必须消失"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { briefFromConfig, renderCharter } from '../../lib/charter.mjs'
import { DEFAULTS, clampConfig } from '../../lib/config.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHARTER = readFileSync(join(REPO, 'prompts', 'duty.md'), 'utf8')

const layout = {
  home: 'D:/home/tianshu-caifeng',
  out: 'D:/home/tianshu-caifeng/out',
  reports: 'D:/home/tianshu-caifeng/reports',
  seen: 'D:/home/tianshu-caifeng/seen.md',
  duty: '',
}

test('占位符都换成了真路径，一个不剩', () => {
  const text = '报告写 <报告目录>，笔记写 <笔记目录>，判重看 <见闻录>，家在 <家目录>。'
  const out = renderCharter(text, layout, { why: 'auto', cfg: DEFAULTS })
  assert.match(out, /报告写 D:\/home\/tianshu-caifeng\/out/)
  assert.match(out, /笔记写 D:\/home\/tianshu-caifeng\/reports/)
  assert.match(out, /判重看 D:\/home\/tianshu-caifeng\/seen\.md/)
  assert.match(out, /家在 D:\/home\/tianshu-caifeng/)
  assert.doesNotMatch(out, /<家目录>|<报告目录>|<笔记目录>|<见闻录>/)
})

test('额度写进章程，且手动轮按 manualMax 压着', () => {
  const cfg = clampConfig({ perDay: 6, manualMax: 2 })
  assert.match(briefFromConfig(cfg, { limit: 2 }), /最多收几条：2 条/)
  assert.match(briefFromConfig(cfg, { limit: 6 }), /最多收几条：6 条/)
})

test('关掉评论 ⇒ 章程里必须出现「不许发」而不再给授权', () => {
  const on = briefFromConfig(clampConfig({ autoComment: true, mentionName: '蚍蜉zzzz', commentLength: 'long' }))
  assert.match(on, /允许留评论/)
  assert.match(on, /@ 蚍蜉zzzz/)
  assert.match(on, /不超过 100 个中文字/)

  const off = briefFromConfig(clampConfig({ autoComment: false }))
  assert.match(off, /不许发评论/)
  assert.doesNotMatch(off, /允许留评论/)
})

test('评论条数受 commentPerRound 限制，也受 commentLength 影响字数', () => {
  const short = briefFromConfig(clampConfig({ autoComment: true, commentPerRound: 3, commentLength: 'short' }))
  assert.match(short, /最多 3 条/)
  assert.match(short, /不超过 15 个中文字/)
})

test('私信三种模式各说各的，read 明确不许回', () => {
  assert.match(briefFromConfig(clampConfig({ dmMode: 'read' })), /只读/)
  assert.match(briefFromConfig(clampConfig({ dmMode: 'draft' })), /绝不调用 reply/)
  assert.match(briefFromConfig(clampConfig({ dmMode: 'auto' })), /允许回/)
  assert.match(briefFromConfig(clampConfig({ dmEnabled: false })), /连读都不要读/)
})

test('dmEnabled 关掉时 auto 被钳回 read，章程不会偷偷给回复权限', () => {
  const cfg = clampConfig({ dmEnabled: false, dmMode: 'auto' })
  assert.equal(cfg.dmMode, 'read')
  assert.match(briefFromConfig(cfg), /连读都不要读/)
})

test('关键词空着 ⇒ 让模型自己换词，别每轮同一批', () => {
  const none = briefFromConfig(clampConfig({ keywords: [] }))
  assert.match(none, /没填关键词/)
  assert.match(none, /不要每轮都用同一批词/)

  const some = briefFromConfig(clampConfig({ keywords: ['deepseek', '插件'] }))
  assert.match(some, /deepseek、插件/)
})

test('关掉收藏夹 ⇒ 明确说这轮不看，而不是含糊带过', () => {
  assert.match(briefFromConfig(clampConfig({ favoritesEnabled: false })), /收藏夹这轮不看/)
  assert.match(briefFromConfig(clampConfig({ favoritesEnabled: true, favoritesDays: 3 })), /最近 3 天/)
})

test('近义词集合：关掉「写单条笔记」时，这一条必须明说，不能含糊', () => {
  const brief = briefFromConfig(clampConfig({ reportLevel: 'brief', notesEnabled: false }))
  assert.match(brief, /不用写单片笔记/)
})

test('brief 详略给的是**薄版形状**，不是"写短点"一句空话', () => {
  const brief = briefFromConfig(clampConfig({ reportLevel: 'brief' }))
  assert.match(brief, /brief（薄版）/)
  // 三条：标题行 / 档位 / 一句话，且不许写「为什么值得」
  assert.match(brief, /\*\*档位\*\*/)
  assert.match(brief, /\*\*我的一句话\*\*/)
  assert.match(brief, /不写[^\n]*为什么值得/)
  // 薄不等于可以省总结与跳过条数
  assert.match(brief, /## 总结/)
  assert.match(brief, /因无证据跳过/)
})

test('full 详略要求三段都在', () => {
  const full = briefFromConfig(clampConfig({ reportLevel: 'full' }))
  assert.match(full, /full（完整版）/)
  assert.match(full, /为什么值得/)
})

test('收藏夹开着时要明说"翻了也要记进判重表"，否则下一轮又从头开始', () => {
  const on = briefFromConfig(clampConfig({ favoritesEnabled: true, favoritesDays: 5 }))
  assert.match(on, /最近 5 天/)
  assert.match(on, /判重/)
  assert.match(on, /弃/)
})

test('两个信源都关着时，章程直接让它别跑', () => {
  const cfg = clampConfig({ sources: { bili: false, douyin: false } })
  assert.match(briefFromConfig(cfg), /都关着/)
})

test('personaPrompt 原样带进去，但截到 4000 字', () => {
  const long = '啊'.repeat(5000)
  const cfg = clampConfig({ personaPrompt: long })
  const out = briefFromConfig(cfg)
  assert.match(out, /使用者额外叮嘱/)
  assert.ok(out.length < 9000, `章程被撑得太长：${out.length}`)
})

test('renderCharter 把配置段接在章程尾巴上，不插进正文中间', () => {
  const out = renderCharter('# 正文\n\n规则若干。', layout, { why: 'manual', cfg: clampConfig({ perDay: 4 }) })
  const bodyAt = out.indexOf('# 正文')
  const briefAt = out.indexOf('# 这一轮的实际情况')
  assert.ok(bodyAt >= 0 && briefAt > bodyAt, '配置段应该在正文之后')
  assert.match(out, /点了「现在就跑」/)
  assert.match(out, /最多收几条：4 条/)
})

// ── 章程正文里写死的纪律（改章程时容易一句话删掉，钉住）──────────────
test('章程写明：被语感闸门拦下只改一次，第二次就不发', () => {
  assert.match(CHARTER, /只改一次/)
  assert.match(CHARTER, /这条没发/)
  assert.match(CHARTER, /blocked_by/)
  assert.match(CHARTER, /不要反复重试/)
})

test('章程写明：没有 rpid 别编，宿主会写「未取到 rpid」', () => {
  assert.match(CHARTER, /rpid/)
  assert.match(CHARTER, /别自己编/)
  assert.match(CHARTER, /未取到 rpid/)
})

test('章程写明：评论的两个条件不是模型自己判断的，是工具给不给', () => {
  assert.match(CHARTER, /不是你来判断的/)
  assert.match(CHARTER, /压根不在你手里/)
})

test('章程写明：私信节不许出现设置项名字和内部术语', () => {
  assert.match(CHARTER, /别在里面出现设置项的名字和内部术语/)
  assert.match(CHARTER, /dmMode/)
})

test('章程写明：判重是「处理过」而不是「收过」', () => {
  assert.match(CHARTER, /处理过/)
  assert.match(CHARTER, /弃掉的也算处理过/)
})

test('章程写明：不许为了凑数硬收', () => {
  assert.match(CHARTER, /不要为了凑数硬收/)
})
