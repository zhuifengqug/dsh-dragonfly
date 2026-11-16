import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { acquireLock, releaseLock } from '../../lib/state.mjs'

/**
 * 锁是「并发不重复跑」的唯一闸门。
 *
 * 11-15 / 11-16 两次 12:00 都起了两轮：日志里同一秒两条「开始跑一轮」，
 * 两轮抢同一条会话，抢输的那个看到 already owned，就另起了一条新会话 ——
 * 用户看到的是「对话从来不复用」。根因是 acquireLock 先读文件判空、再写，
 * 两个调度器在同一毫秒都读到「没人拿」。这几条用例把原子的语义钉住。
 */

async function withLayout(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dragonfly-lock-'))
  const layout = { lock: join(dir, 'run.lock') }
  try { return await fn(layout, dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('锁是原子的：同进程里第二次抢不到（旧实现因为 pid 相同会放过去）', async () => {
  await withLayout(async (layout) => {
    const a = acquireLock(layout, 'auto')
    assert.equal(a.ok, true)
    const b = acquireLock(layout, 'manual')
    assert.equal(b.ok, false, '已经有人拿着锁，第二次必须抢不到')
    assert.equal(b.holder.who, 'auto')
    releaseLock(layout)
    assert.equal(existsSync(layout.lock), false)
  })
})

test('僵尸锁能被接管：超过十分钟、进程也没了', async () => {
  await withLayout(async (layout) => {
    // 2 小时前、pid 用一个几乎不可能存在的号
    writeFileSync(layout.lock, JSON.stringify({ pid: 999999, token: 'x', ts: Date.now() - 2 * 60 * 60 * 1000, who: 'auto' }))
    const r = acquireLock(layout, 'manual')
    assert.equal(r.ok, true, '僵尸锁应该被清掉重抢')
    assert.equal(JSON.parse(readFileSync(layout.lock, 'utf8')).who, 'manual')
    releaseLock(layout)
  })
})

test('别人的锁不许放：pid 同、token 不同就不删', async () => {
  await withLayout(async (layout) => {
    writeFileSync(layout.lock, JSON.stringify({ pid: process.pid, token: 'not-mine', ts: Date.now(), who: 'auto' }))
    releaseLock(layout)
    assert.equal(existsSync(layout.lock), true, '不是自己那把就不能删')
  })
})

test('自己那把能放掉', async () => {
  await withLayout(async (layout) => {
    const mine = acquireLock(layout, 'manual')
    assert.equal(mine.ok, true)
    assert.ok(mine.lock.token, '自己的锁要带 token')
    releaseLock(layout)
    assert.equal(existsSync(layout.lock), false)
  })
})
