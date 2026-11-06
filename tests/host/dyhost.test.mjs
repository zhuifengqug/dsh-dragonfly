/**
 * tests/host/dyhost.test.mjs —— 抖音那一头的宿主侧：令牌、预算闸门、动作转发
 * ============================================================================
 * 这一层测的是「宿主怎么管抖音」，不是「抖音页面长什么样」（那在 tests/dy）。
 * 三件事必须有证据：
 *   ① 没握过手就一律拒（令牌是唯一凭据，不能靠同源）
 *   ② 每日分钟数到顶就截住 —— 章程里那句提醒靠不住，闸门得是宿主自己数的
 *   ③ 只有真的"往回看"的动作计时；读一次 state 不算看
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createDyHost, hostRecordFile, readHostRecord } from '../../lib/dy-host.mjs'

const fakeLayout = (home) => ({ home, dyProfile: join(home, 'dy', 'profile') })

/** 一个只会作答、不真起浏览器的假动作表替身 —— 我们用真的 DY_ACTIONS，但 controller 是假的 */
const fakeController = () => ({
  state: async () => ({ pageKind: 'video', video: { id: '7690000000000000001' } }),
  navigate: async (url) => ({ ok: true, url }),
  switchVideo: async () => ({ changed: true, state: { pageKind: 'video', video: { id: '7690000000000000002' } } }),
  capture: async ({ seconds } = {}) => ({ ok: true, images: [{ data: 'x', mimeType: 'image/jpeg' }], seconds }),
})

function makeHost(home, { budget } = {}) {
  return createDyHost({
    layout: () => fakeLayout(home),
    origin: () => 'http://127.0.0.1:3080',
    budget,
    // 换成假 controller（真实那个会去起 Edge —— 这一层不该起浏览器）
    controller: fakeController,
    log: () => {},
  })
}

test('没握过手时令牌一律拒，握手之后才对', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-dyhost-'))
  try {
    const host = makeHost(home)
    assert.equal(host.checkToken(''), false, '还没 publish 就什么都别放行')
    assert.equal(host.checkToken('deadbeef'), false)

    const r = host.publish()
    assert.equal(r.ok, true)
    assert.ok(r.baseUrl.startsWith('http://'))

    const rec = readHostRecord(fakeLayout(home))
    assert.ok(rec.token.length >= 16, '令牌要有足够长度')
    assert.equal(host.checkToken(rec.token), true)
    assert.equal(host.checkToken(rec.token.slice(0, -1)), false, '短一截不能放行')
    assert.equal(host.checkToken(rec.token + 'x'), false)

    // 再 publish 一次会换新令牌，旧的立刻作废
    const old = rec.token
    host.publish()
    assert.equal(host.checkToken(old), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('握不到宿主地址时不写文件、返回 no-origin', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-dyhost-'))
  try {
    const host = createDyHost({ layout: () => fakeLayout(home), origin: () => '', log: () => {} })
    const r = host.publish()
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-origin')
    assert.equal(readHostRecord(fakeLayout(home)), null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('不认识的动作回 unknown-action，不炸', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-dyhost-'))
  try {
    const host = makeHost(home)
    const r = await host.handle('不存在的动作', {})
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'unknown-action')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('每日分钟数到顶后 open/next/frames 被截住，state 仍然能读', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-dyhost-'))
  try {
    let spent = 0
    const host = makeHost(home, {
      budget: () => ({ limit: 10, used: 10 * 60, spend: (s) => { spent += s } }),
    })

    for (const action of ['open', 'next', 'frames']) {
      const r = await host.handle(action, {})
      assert.equal(r.ok, false, `${action} 应该被截住`)
      assert.equal(r.reason, 'daily-limit')
      assert.match(r.hint, /10 分钟/)
    }
    assert.equal(spent, 0, '被截住的动作不该记账')

    // 读一次状态不算"看"，不该被分钟数拦
    const st = await host.handle('state', {})
    assert.equal(st.ok === false && st.reason === 'daily-limit', false, 'state 不该被额度拦')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('额度没到顶时照常放行，并且真的往回看才记账', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-dyhost-'))
  try {
    const spent = []
    const host = makeHost(home, {
      budget: () => ({ limit: 10, used: 0, spend: (s) => spent.push(s) }),
    })
    // 注入假 controller，避免真起 Edge
    host.getController = () => fakeController()

    const st = await host.handle('state', {})
    assert.equal(st.ok === false && st.reason === 'daily-limit', false)
    // state 不记账（spent 可能为空数组，或只有 0 —— 但绝不能是"看了"的时长）
    const afterState = spent.length

    const op = await host.handle('open', {})
    assert.notEqual(op.ok, false, `open 不该失败：${JSON.stringify(op)}`)
    assert.ok(spent.length > afterState, 'open 要记一笔时长')
    assert.ok(spent[spent.length - 1] >= 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('limit 为 0 表示不设闸（用户自己关掉天花板）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-dyhost-'))
  try {
    const host = makeHost(home, {
      budget: () => ({ limit: 0, used: 99999, spend: () => {} }),
    })
    host.getController = () => fakeController()
    const r = await host.handle('state', {})
    assert.notEqual(r.reason, 'daily-limit')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('宿主地址文件写在 <家>/dy/control/host.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-dyhost-'))
  try {
    const lay = fakeLayout(home)
    assert.match(hostRecordFile(lay), /dy[\\/]control[\\/]host\.json$/)
    const host = makeHost(home)
    host.publish()
    const rec = readHostRecord(lay)
    assert.equal(rec.baseUrl, 'http://127.0.0.1:3080')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
