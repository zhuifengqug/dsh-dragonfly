/**
 * duty-session：「两天一条」
 * ============================================================================
 * 要么接着写同一条会话，要么开新的 —— 判断只有四个条件，全都拿真文件钉死：
 *
 *   ① 记录里有 id、文件还在、起始日距今 < 2 天  ⇒ 接着写
 *   ② 起始日到了第 2 天（days >= 2）            ⇒ 开新的
 *   ③ 会话文件被删了 / cwd 换了（目录对不上）    ⇒ 开新的
 *   ④ 记录坏了 / 没起始日                       ⇒ 不抛，能接就接、不能接就开新的
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  SESSION_LIFESPAN_DAYS, dutySessionFileExists, loadDutySession, pickDutySession, saveDutySession,
} from '../../lib/duty-session.mjs'
import { projectKey } from '../../lib/workspace-link.mjs'
import { layoutOf } from '../../lib/paths.mjs'

const CWD = 'D:\\dsh-workspaces\\蜻蛉值班'

/** 造一个临时家 + sessions 根，并可选地铺一条会话文件 */
function fixture({ sessionId = 'session-demo', startedOn = '2026-11-04', withFile = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cf-ds-'))
  const home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  const layout = layoutOf(home)
  const sessions = join(base, 'sessions')
  if (withFile && sessionId) {
    const dir = join(sessions, projectKey(CWD), sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
  }
  if (sessionId && startedOn !== undefined) saveDutySession(layout, { id: sessionId, startedOn })
  return { base, layout, sessions, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('上限就是两天', () => {
  assert.equal(SESSION_LIFESPAN_DAYS, 2)
})

test('第一天：接着写同一条', () => {
  const f = fixture({ startedOn: '2026-11-04' })
  try {
    const r = pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04' })
    assert.equal(r?.id, 'session-demo')
    assert.match(r.why, /1\/2/)
  } finally { f.cleanup() }
})

test('第二天：还是同一条（这就是「两天一条」）', () => {
  const f = fixture({ startedOn: '2026-11-04' })
  try {
    const r = pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-05' })
    assert.equal(r?.id, 'session-demo')
    assert.match(r.why, /2\/2/)
  } finally { f.cleanup() }
})

test('第三天：开新的，并说明为什么', () => {
  const f = fixture({ startedOn: '2026-11-04' })
  try {
    const lines = []
    const r = pickDutySession({
      layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-06',
      log: (l) => lines.push(l),
    })
    assert.equal(r, null)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /用了 2 天/)
  } finally { f.cleanup() }
})

test('会话文件被删了：当它过期，不硬接', () => {
  const f = fixture({ startedOn: '2026-11-04' })
  try {
    rmSync(join(f.sessions, projectKey(CWD), 'session-demo'), { recursive: true, force: true })
    const lines = []
    const r = pickDutySession({
      layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04',
      log: (l) => lines.push(l),
    })
    assert.equal(r, null)
    assert.match(lines[0], /文件不在了/)
  } finally { f.cleanup() }
})

test('换了工作区目录：目录对不上也是过期', () => {
  const f = fixture({ startedOn: '2026-11-04' })
  try {
    // 文件在 CWD 那个目录下；这一轮 cwd 换成别的，就找不到它了
    const r = pickDutySession({
      layout: f.layout, sessionsRoot: f.sessions, cwd: 'D:\\dsh-workspaces\\别处', today: '2026-11-04',
    })
    assert.equal(r, null)
  } finally { f.cleanup() }
})

test('没记录 / 记录坏了：安静返回 null，不抛', () => {
  const f = fixture({ sessionId: null })
  try {
    assert.equal(loadDutySession(f.layout), null)
    assert.equal(pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04' }), null)
    // 半截 JSON 也不能把这一轮搞崩
    writeFileSync(f.layout.dutySession, '{not json', 'utf8')
    const lines = []
    assert.equal(loadDutySession(f.layout, (l) => lines.push(l)), null)
    assert.equal(lines.length, 1)
  } finally { f.cleanup() }
})

test('记录里没有起始日：接着写，别浪费那条会话', () => {
  const f = fixture({ startedOn: '' })
  try {
    const r = pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04' })
    assert.equal(r?.id, 'session-demo')
    assert.equal(r.why, 'no-start-date')
  } finally { f.cleanup() }
})

test('还没有记录时：认领目录里最新那条，不再凭空新建', () => {
  const f = fixture({ sessionId: null })
  try {
    // 目录里放一条"上一轮留下的"会话，文件时间是今天
    const dir = join(f.sessions, projectKey(CWD), 'session-yesterday')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, 'x')
    // 文件时间钉死到 2026-11-04 —— newestSession 是按 mtime 推起始日的，
    // 不钉的话这条用例会跟着真实日期漂（真到了第二天就成「时钟倒流」，认领不了）
    const stamp = new Date('2026-11-04T12:00:00+08:00')
    utimesSync(file, stamp, stamp)
    const lines = []
    const r = pickDutySession({
      layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04',
      log: (l) => lines.push(l),
    })
    assert.equal(r?.id, 'session-yesterday')
    assert.equal(r.why, 'adopted')
    // 认领完要写回记录，下一轮才算得清天数
    assert.equal(loadDutySession(f.layout)?.id, 'session-yesterday')
    assert.match(lines[0], /认领目录里最新那条/)
  } finally { f.cleanup() }
})

test('还没有记录、目录也空：老老实实返回 null', () => {
  const f = fixture({ sessionId: null })
  try {
    assert.equal(pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04' }), null)
  } finally { f.cleanup() }
})

test('dutySessionFileExists 只认非空文件', () => {
  const f = fixture({ startedOn: '2026-11-04' })
  try {
    assert.equal(dutySessionFileExists(f.sessions, CWD, 'session-demo'), true)
    writeFileSync(join(f.sessions, projectKey(CWD), 'session-demo', 'session.v4.jsonl.zstd'), '')
    assert.equal(dutySessionFileExists(f.sessions, CWD, 'session-demo'), false)
    assert.equal(dutySessionFileExists('', CWD, 'session-demo'), false)
  } finally { f.cleanup() }
})
