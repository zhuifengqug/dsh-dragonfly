/**
 * duty-session：「一直用到上下文快满」
 * ============================================================================
 * 判据只有三条，全都拿真文件钉死：
 *   ① 会话文件里最后一条 usage.totalTokens 到了软上限 ⇒ 另起一条
 *   ② 会话文件被删了 / cwd 换了（目录对不上）        ⇒ 另起一条
 *   ③ 上下文读不出来                                 ⇒ 退回「最多 14 天」兜底
 * 其余情况一律接着写同一条 —— 不再按日历天一刀切。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  CONTEXT_LIMIT_TOKENS, SESSION_MAX_DAYS, dutySessionFileExists, loadDutySession, pickDutySession,
  saveDutySession, sessionContextTokens,
} from '../../lib/duty-session.mjs'
import { projectKey } from '../../lib/workspace-link.mjs'
import { layoutOf } from '../../lib/paths.mjs'

const CWD = 'D:\\dsh-workspaces\\蜻蛉值班'

/** 拼一份「多帧 zstd 拼接」的会话文件内容：每条记录一帧 */
function sessionBytes(records) {
  return Buffer.concat(records.map((r) => zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))))
}

/** 一段带 usage 的对话：header + n 轮 assistant 消息 */
function chatWithUsage(totals) {
  const recs = [{ type: 'session', version: 4, id: 'session-demo', cwd: CWD }]
  for (const total of totals) {
    recs.push({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'ok' }] } },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: total - 150, cacheWriteTokens: 0, totalTokens: total },
    })
  }
  return recs
}

/** 造一个临时家 + sessions 根，并可选地铺一条会话文件（带指定上下文占用） */
function fixture({ sessionId = 'session-demo', startedOn = '2026-11-04', withFile = true, totals = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cf-ds-'))
  const home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  const layout = layoutOf(home)
  const sessions = join(base, 'sessions')
  if (withFile && sessionId) {
    const dir = join(sessions, projectKey(CWD), sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, totals ? sessionBytes(chatWithUsage(totals)) : 'x')
  }
  if (sessionId && startedOn !== undefined) saveDutySession(layout, { id: sessionId, startedOn })
  return { base, layout, sessions, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('软上限就是 200K tokens', () => {
  assert.equal(CONTEXT_LIMIT_TOKENS, 200_000)
  assert.equal(SESSION_MAX_DAYS, 14)
})

test('上下文还宽裕：接着写同一条，并把占用写进理由', () => {
  const f = fixture({ totals: [30_000, 42_500] })
  try {
    const r = pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04' })
    assert.equal(r?.id, 'session-demo')
    assert.match(r.why, /上下文 43K\/200K/)
  } finally { f.cleanup() }
})

test('上下文到软上限：另起一条，并说清多大', () => {
  const f = fixture({ totals: [60_000, 213_000] })
  try {
    const lines = []
    const r = pickDutySession({
      layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04',
      log: (l) => lines.push(l),
    })
    assert.equal(r, null)
    assert.match(lines[0], /已经 213K（软上限 200K）/)
  } finally { f.cleanup() }
})

test('跨了很多天也不换 —— 只认上下文，不认日历', () => {
  const f = fixture({ startedOn: '2026-10-01', totals: [20_000] })
  try {
    const r = pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-11' })
    assert.equal(r?.id, 'session-demo')
    assert.match(r.why, /上下文 20K\/200K/)
  } finally { f.cleanup() }
})

test('上下文读不出来：退回天数兜底，超过 14 天才换', () => {
  const f = fixture({ startedOn: '2026-10-20' })  // 只有 'x'，解不成 JSONL
  try {
    assert.equal(sessionContextTokens(join(f.sessions, projectKey(CWD), 'session-demo', 'session.v4.jsonl.zstd')), null)
    const lines = []
    const r = pickDutySession({
      layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-11',
      log: (l) => lines.push(l),
    })
    assert.equal(r, null)
    assert.match(lines[0], /兜底上限 14 天/)
  } finally { f.cleanup() }
})

test('上下文读不出来但天数还短：接着用', () => {
  const f = fixture({ startedOn: '2026-11-10' })
  try {
    const r = pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-11' })
    assert.equal(r?.id, 'session-demo')
    assert.match(r.why, /按天数 2\/14/)
  } finally { f.cleanup() }
})

test('会话文件被删了：当它过期，不硬接', () => {
  const f = fixture({ totals: [10_000] })
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
  const f = fixture({ totals: [10_000] })
  try {
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
    writeFileSync(f.layout.dutySession, '{not json', 'utf8')
    const lines = []
    assert.equal(loadDutySession(f.layout, (l) => lines.push(l)), null)
    assert.equal(lines.length, 1)
  } finally { f.cleanup() }
})

test('记录里没有起始日：只要上下文没满就接着写', () => {
  const f = fixture({ startedOn: '', totals: [12_000] })
  try {
    const r = pickDutySession({ layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04' })
    assert.equal(r?.id, 'session-demo')
    assert.match(r.why, /上下文 12K\/200K/)
  } finally { f.cleanup() }
})

test('还没有记录时：认领目录里最新那条，不再凭空新建', () => {
  const f = fixture({ sessionId: null })
  try {
    const dir = join(f.sessions, projectKey(CWD), 'session-yesterday')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, sessionBytes(chatWithUsage([15_000])))
    const stamp = new Date('2026-11-04T12:00:00+08:00')
    utimesSync(file, stamp, stamp)
    const lines = []
    const r = pickDutySession({
      layout: f.layout, sessionsRoot: f.sessions, cwd: CWD, today: '2026-11-04',
      log: (l) => lines.push(l),
    })
    assert.equal(r?.id, 'session-yesterday')
    assert.equal(r.why, 'adopted')
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

test('sessionContextTokens 取最后一条 usage，多帧也要拼起来读', () => {
  const f = fixture({ totals: [25_000, 80_000, 96_400] })
  try {
    const file = join(f.sessions, projectKey(CWD), 'session-demo', 'session.v4.jsonl.zstd')
    assert.equal(sessionContextTokens(file), 96_400)
    assert.equal(sessionContextTokens(''), null)
    assert.equal(sessionContextTokens(join(f.base, 'nope.zstd')), null)
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
