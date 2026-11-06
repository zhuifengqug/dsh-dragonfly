import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BILI_TOOLS, DY_TOOLS, LOCAL_TOOLS, canComment, dutyToolset } from '../../lib/toolset.mjs'
import { DEFAULTS, clampConfig } from '../../lib/config.mjs'

/**
 * 这一层测的是"这一轮手里有什么工具"这条业务规则。
 *
 * 为什么值得单独测：名单是**注册期**生效的（Python 侧只注册名单里的函数，
 * 名单外的连 tools/list 都不出现）。所以"关掉评论 ⇒ 模型拿不到 reply"
 * 这件事是靠名单断的，不是靠章程里那句"别发"。名单算错 = 闸门形同虚设，
 * 而这种错在真机上很难看出来（工具还在，只是多了一个），必须在这里钉住。
 */

const cfg = (patch = {}) => clampConfig({ ...DEFAULTS, ...patch }, DEFAULTS)

test('默认配置下：B站 7 个 + 本地 2 个 + 抖音 4 个，一个不少', () => {
  const ts = dutyToolset(cfg())
  assert.deepEqual(ts.bili.sort(), [...BILI_TOOLS].sort())
  assert.deepEqual(ts.local, LOCAL_TOOLS)
  assert.deepEqual(ts.dy, DY_TOOLS)
  assert.equal(ts.skipped.length, 0)
})

test('评论双条件：开关 + 填了 @ 谁 —— 四种组合只有一种给 reply', () => {
  const cases = [
    { autoComment: true, mentionName: '蚍蜉zzzz', expect: true, why: '两条都满足' },
    { autoComment: true, mentionName: '', expect: false, why: '没填 @ 谁' },
    { autoComment: true, mentionName: '   ', expect: false, why: '只填空格也算没填' },
    { autoComment: false, mentionName: '蚍蜉zzzz', expect: false, why: '开关关着' },
    { autoComment: false, mentionName: '', expect: false, why: '两条都不满足' },
  ]
  for (const c of cases) {
    const c1 = cfg({ autoComment: c.autoComment, mentionName: c.mentionName })
    const has = dutyToolset(c1).bili.includes('dragonfly_bili_reply')
    assert.equal(has, c.expect, `${c.why}：reply ${c.expect ? '应该' : '不应该'}在名单里`)
    assert.equal(canComment(c1), c.expect, `${c.why}：canComment 要跟名单一致`)
  }
})

test('关掉评论时，名单里还得说清楚为什么没给', () => {
  const ts = dutyToolset(cfg({ autoComment: false }))
  const why = ts.skipped.find((s) => s.tool === 'dragonfly_bili_reply')
  assert.ok(why, '应该留下一条跳过原因')
  assert.match(why.why, /关/)
})

test('私信关着时连 dc 工具都不给（不是"给了但嘱咐别用"）', () => {
  const ts = dutyToolset(cfg({ dmEnabled: false }))
  assert.equal(ts.bili.includes('dragonfly_bili_dm'), false)
  assert.ok(ts.skipped.some((s) => s.tool === 'dragonfly_bili_dm'))
})

test('收藏夹关着时不给 favorites，其余读工具照给', () => {
  const ts = dutyToolset(cfg({ favoritesEnabled: false }))
  assert.equal(ts.bili.includes('dragonfly_bili_favorites'), false)
  assert.ok(ts.bili.includes('dragonfly_bili_search'))
  assert.ok(ts.bili.includes('dragonfly_bili_subtitle'))
})

test('B站 信源关着时一个 B站 工具都不给，本地写口仍然给', () => {
  const ts = dutyToolset(cfg({ sources: { bili: false, douyin: true } }))
  assert.deepEqual(ts.bili, [])
  assert.deepEqual(ts.local, LOCAL_TOOLS, '写日报与判重必须还在，否则这一轮什么也留不下')
})

test('抖音信源关着时一个抖音工具都不给', () => {
  const ts = dutyToolset(cfg({ sources: { bili: true, douyin: false } }))
  assert.deepEqual(ts.dy, [])
  assert.ok(ts.bili.length > 0)
})

test('两个信源都关着时只剩本地写口', () => {
  const ts = dutyToolset(cfg({ sources: { bili: false, douyin: false } }))
  assert.deepEqual(ts.bili, [])
  assert.deepEqual(ts.dy, [])
  assert.deepEqual(ts.local, LOCAL_TOOLS)
})

test('dmMode 是 auto 不影响名单：工具给不给只看 dmEnabled', () => {
  const a = dutyToolset(cfg({ dmEnabled: true, dmMode: 'auto' }))
  const b = dutyToolset(cfg({ dmEnabled: true, dmMode: 'read' }))
  assert.deepEqual(a.bili.sort(), b.bili.sort())
})

test('名单里没有重复项', () => {
  const ts = dutyToolset(cfg())
  const all = [...ts.bili, ...ts.local, ...ts.dy]
  assert.equal(new Set(all).size, all.length)
})
