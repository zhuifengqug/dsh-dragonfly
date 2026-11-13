/**
 * workspace-link：让值班轮的会话一落盘就挂进工作区
 * ============================================================================
 * 这一层存在的唯一理由是宿主**没有**「启动时把 cwd 相符的会话补进工作区」的机制：
 *
 *   - `dsh-workspace` 的 `bootstrap()` 只在 `state.initialized === false` 时跑一次；
 *   - `attachSession()` 只被 `SessionService.create()`（带 workspaceId 发起）调到，
 *     而值班轮是 `spawn(dsh … '--profile' 'dragonfly-duty' prompt)`，只有 cwd。
 *
 * 所以这里最容易错的几处，全部拿真文件/假服务钉死：
 *
 *   ① `projectKey()` 必须与宿主逐字一致（差一个字符就永远找不到那一轮的目录）
 *   ② 新建出来的会话才算「这一轮的」，跑之前就存在的不能重复认领
 *   ③ `attachToWorkspace()` 没有工作区时要安静返回，不能抛、不能空转
 *   ④ 会话头还没落全（attach 抛错）时要继续试，而不是一次失败就放弃
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  attachToWorkspace, listSessionIds, pickRegistry, projectKey, reconcileWorkspace, sessionDir, sessionsRoot, watchNewSession,
} from '../../lib/workspace-link.mjs'

/** 造一个假的 sessions 根：每个 id 铺成 `<root>/<projectKey>/<id>/session.v4.jsonl.zstd` */
function seedSession(root, cwd, id) {
  const dir = join(root, projectKey(cwd), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
  return dir
}

test('projectKey 与宿主同名：中文按 ~XXXX 转义', () => {
  assert.equal(projectKey('D:\\dsh-workspaces\\蜻蛉值班'), '--D-dsh-workspaces-~873B~86C9~503C~73ED--')
  assert.equal(projectKey('D:\\DSHData\\home\\dragonfly'), '--D-DSHData-home-dragonfly--')
  // 连续的 `/ \ :` 折叠成一个 `-`；前导 `-` 去掉
  assert.equal(projectKey('D:\\a\\\\b::c'), '--D-a-b-c--')
  // `~` 自己也要转义（否则与转义序列撞车）
  assert.equal(projectKey('/x~y'), '--x~007Ey--')
})

test('listSessionIds 只认带 session.v4.jsonl.zstd 的目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-ws-'))
  try {
    const cwd = 'D:\\dsh-workspaces\\蜻蛉值班'
    seedSession(root, cwd, 'session-aaa')
    // 空目录（还没有会话文件）不算
    mkdirSync(join(root, projectKey(cwd), 'session-empty'), { recursive: true })
    const got = listSessionIds(root, cwd)
    assert.deepEqual(got, ['session-aaa'])
    // 目录不存在时安静返回空
    assert.deepEqual(listSessionIds(root, 'D:\\nowhere'), [])
    assert.deepEqual(listSessionIds('', cwd), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('watchNewSession 只报「跑之前没有」的那个会话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-ws-'))
  try {
    const cwd = 'D:\\dsh-workspaces\\蜻蛉值班'
    seedSession(root, cwd, 'session-old')
    const before = listSessionIds(root, cwd)
    const seen = []
    const w = watchNewSession({
      root, cwd, before, pollMs: 20, timeoutMs: 3000, unref: false,
      onAppear: (id) => { seen.push(id); return true },
    })
    // 模拟那一轮起进程后落盘
    setTimeout(() => seedSession(root, cwd, 'session-new'), 60)
    const id = await w.done
    assert.equal(id, 'session-new')
    assert.deepEqual(seen, ['session-new'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('watchNewSession：onAppear 返回 false 时继续试下一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-ws-'))
  try {
    const cwd = 'D:\\dsh-workspaces\\蜻蛉值班'
    let calls = 0
    const w = watchNewSession({
      root, cwd, before: [], pollMs: 20, timeoutMs: 3000, unref: false,
      onAppear: () => { calls += 1; return calls >= 3 },
    })
    seedSession(root, cwd, 'session-x')
    const id = await w.done
    assert.equal(id, 'session-x')
    assert.ok(calls >= 3, `应当试到第三次才成功，实际 ${calls}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('watchNewSession：没根目录 / 超时都会安静收场', async () => {
  const none = watchNewSession({ root: '', cwd: 'D:\\x', onAppear: () => true })
  assert.equal(await none.done, null)

  const root = mkdtempSync(join(tmpdir(), 'cf-ws-'))
  try {
    const slow = watchNewSession({ root, cwd: 'D:\\x', pollMs: 20, timeoutMs: 120, unref: false, onAppear: () => true })
    assert.equal(await slow.done, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('watchNewSession：默认 unref 时不会去碰空的定时器句柄', async () => {
  // 回归：曾经把 unref 打在漏声明的变量上，默认路径（unref=true）一构造就抛
  // 「Cannot read properties of null (reading 'unref')」，整个 run() 还没 spawn 就倒了。
  const root = mkdtempSync(join(tmpdir(), 'cf-ws-'))
  try {
    const w = watchNewSession({ root, cwd: 'D:\\x', pollMs: 20, timeoutMs: 50, onAppear: () => true })
    w.stop()
    assert.equal(await w.done, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('attachToWorkspace：没有注册表 / 没有工作区时安静返回', async () => {
  assert.deepEqual(await attachToWorkspace({ get: () => undefined }, 'D:\\x', 'session-1'), {
    ok: false, reason: 'no-registry',
  })
  const empty = { get: () => ({ resolveByPath: async () => undefined }) }
  assert.deepEqual(await attachToWorkspace(empty, 'D:\\x', 'session-1'), {
    ok: false, reason: 'no-workspace',
  })
})

test('attachToWorkspace：已在工作区里就不再调 attachSession', async () => {
  let calls = 0
  const ws = {
    sessionIds: ['session-1'],
    record: { title: '蜻蛉值班' },
    attachSession: async () => { calls += 1 },
  }
  const ctx = { get: () => ({ resolveByPath: async () => ws }) }
  assert.deepEqual(await attachToWorkspace(ctx, 'D:\\x', 'session-1'), { ok: true, reason: 'already' })
  assert.equal(calls, 0)
})

test('attachToWorkspace：真的调 attachSession，抛错时把原因带回来', async () => {
  const ws = { sessionIds: [], record: { title: '蜻蛉值班' }, attachSession: async () => {} }
  const ctx = { get: () => ({ resolveByPath: async () => ws }) }
  assert.equal((await attachToWorkspace(ctx, 'D:\\x', 'session-2')).ok, true)
  assert.deepEqual(ws.sessionIds, []) // 假实现不改数组，这里只断言调用成功

  const boom = { sessionIds: [], record: {}, attachSession: async () => { throw new Error('cwd differs') } }
  const ctx2 = { get: () => ({ resolveByPath: async () => boom }) }
  const r = await attachToWorkspace(ctx2, 'D:\\x', 'session-3')
  assert.equal(r.ok, false)
  assert.match(r.reason, /cwd differs/)
})

test('attachToWorkspace：同一条会话一轮里晃多次也只 attach 一次、只记一行', async () => {
  let calls = 0
  const ws = { sessionIds: [], record: { title: '蜻蛉值班' }, attachSession: async () => { calls += 1 } }
  const ctx = { get: () => ({ resolveByPath: async () => ws }) }
  const lines = []
  const log = (l) => lines.push(l)
  assert.equal((await attachToWorkspace(ctx, 'D:\\x', 'session-dup', log)).ok, true)
  assert.deepEqual(await attachToWorkspace(ctx, 'D:\\x', 'session-dup', log), { ok: true, reason: 'cached' })
  assert.equal(calls, 1, '第二次不该再调 attachSession')
  assert.equal(lines.length, 1, '不该刷第二行日志')
})

test('attachToWorkspace：domain 被关掉时重取注册表再挂一次', async () => {
  let attempt = 0
  let fresh = 0
  const old = {
    sessionIds: [], record: {},
    attachSession: async () => { throw new Error("domain 'workspace' is closed") },
  }
  const newer = { sessionIds: [], record: { title: '蜻蛉值班' }, attachSession: async () => { attempt += 1 } }
  const ctx = {
    get: () => {
      fresh += 1
      return { resolveByPath: async () => (fresh === 1 ? old : newer) }
    },
  }
  const lines = []
  const r = await attachToWorkspace(ctx, 'D:\\x', 'session-closed', (l) => lines.push(l))
  assert.equal(r.ok, true)
  assert.equal(attempt, 1)
  assert.match(lines.join('\n'), /重取注册表后/)
})


test('sessionDir：把 cwd 编码成那一层目录名', () => {
  assert.equal(
    sessionDir('D:\\DSHData\\home\\sessions', 'D:\\dsh-workspaces\\蜻蛉值班'),
    join('D:\\DSHData\\home\\sessions', '--D-dsh-workspaces-~873B~86C9~503C~73ED--'),
  )
  assert.equal(sessionDir('', 'D:\\x'), '')
})

test('reconcileWorkspace：目录里多出来的补进去，记账里悬空的摘掉，其余不动', async () => {
  const calls = []
  const ws = {
    sessionIds: ['session-gone', 'session-alive'],
    record: { title: '蜻蛉值班' },
    attachSession: async (id) => { calls.push(['attach', id]) },
    detachSession: async (id) => { calls.push(['detach', id]) },
  }
  const ctx = { get: () => ({ resolveByPath: async () => ws }) }
  const r = await reconcileWorkspace(ctx, 'D:\\x', ['session-alive', 'session-new'])
  assert.deepEqual(r, { ok: true, attached: 1, detached: 1 })
  assert.deepEqual(calls, [['attach', 'session-new'], ['detach', 'session-gone']])
})

test('reconcileWorkspace：已经对上账时一次写都不发（但日志照写一行）', async () => {
  let writes = 0
  const ws = {
    sessionIds: ['session-alive'],
    record: { title: '蜻蛉值班' },
    attachSession: async () => { writes += 1 },
    detachSession: async () => { writes += 1 },
  }
  const ctx = { get: () => ({ resolveByPath: async () => ws }) }
  const lines = []
  assert.deepEqual(
    await reconcileWorkspace(ctx, 'D:\\x', ['session-alive'], (l) => lines.push(l)),
    { ok: true, attached: 0, detached: 0 },
  )
  assert.equal(writes, 0)
  // 「什么都没做」和「做了 0 件事」必须在日志里分得开 —— 上一轮就是栽在这儿
  assert.equal(lines.length, 1)
  assert.match(lines[0], /磁盘 1 个 \/ 记账 1 个 → 补进 0、摘掉 0/)
})

test('pickRegistry：注入过的子 fiber 直接挂在 ctx 上也能取到', async () => {
  // 主 ctx 的 get() 恒拿不到（inject 里没有它）；子 fiber 的 ctx 会把服务挂成属性
  const ws = { sessionIds: [], record: { title: '蜻蛉值班' }, attachSession: async () => {} }
  const childCtx = { workspaceRegistry: { resolveByPath: async () => ws }, get: () => undefined }
  assert.equal(pickRegistry(childCtx), childCtx.workspaceRegistry)
  assert.equal((await attachToWorkspace(childCtx, 'D:\\x', 'session-9')).ok, true)
  assert.equal(pickRegistry({ get: () => undefined }), null)
  assert.equal(pickRegistry(null), null)
})

test('reconcileWorkspace：没有注册表 / 没有工作区都安静返回', async () => {
  assert.deepEqual(await reconcileWorkspace({ get: () => undefined }, 'D:\\x', []), { ok: false, reason: 'no-registry' })
  const empty = { get: () => ({ resolveByPath: async () => undefined }) }
  assert.deepEqual(await reconcileWorkspace(empty, 'D:\\x', []), { ok: false, reason: 'no-workspace' })
})

test('reconcileWorkspace：单个会话挂不上不影响其他会话', async () => {
  const okd = []
  const ws = {
    sessionIds: [],
    record: {},
    attachSession: async (id) => {
      if (id === 'session-bad') throw new Error('header not ready')
      okd.push(id)
    },
    detachSession: async () => {},
  }
  const ctx = { get: () => ({ resolveByPath: async () => ws }) }
  const r = await reconcileWorkspace(ctx, 'D:\\x', ['session-bad', 'session-good'])
  assert.deepEqual(r, { ok: true, attached: 1, detached: 0 })
  assert.deepEqual(okd, ['session-good'])
})
