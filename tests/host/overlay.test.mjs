/**
 * overlay：那一轮跑起来的三件必需品
 * ============================================================================
 * overlay 是每次跑一轮都重写的一份 YAML patch，它出错的后果全都是「那一轮悄悄跑不成」：
 *
 *   ① 不补开 credentials/authorization/deepseek-account ⇒ 用不了账号模型
 *   ② 不写 agent-default-model ⇒ `MISSING_CREDENTIAL: no api key for provider route …`
 *   ③ 不插 MCP ⇒ 那一轮一个工具都没有，等于空跑
 *
 * 这三件里最容易漏的是 **③ 的 env**：白名单、家目录、单片笔记开关全走 env 下发。
 * 环境变量名写歪一个，Python 那边就退化成「全放」或「全不放」—— 静默，不报错。
 * 所以这里逐条断言 env 行，而不是只断言"有 insert"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dutyCwd, effectiveModel, ensureOverlay } from '../../lib/duty.mjs'

function makeLayout(home) {
  return {
    home,
    overlay: join(home, 'headless-overlay.yml'),
    mcpServer: join(home, 'mcp_server.py'),
    dy: join(home, 'dy'),
  }
}

/** 造一个最小的家目录：有 mcp_server.py、有 dy 桥 */
function makeHome({ withMcp = true, withBridge = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dragonfly-overlay-'))
  if (withMcp) writeFileSync(join(home, 'mcp_server.py'), '# fake\n', 'utf8')
  if (withBridge) {
    mkdirSync(join(home, 'dy'), { recursive: true })
    writeFileSync(join(home, 'dy', 'bridge.mjs'), '// fake\n', 'utf8')
  }
  return home
}

const CTX = { get: () => undefined }

function run(home, cfg, opts = {}) {
  const layout = makeLayout(home)
  const r = ensureOverlay(CTX, layout, cfg, {
    log: () => {},
    biliTools: ['dragonfly_bili_search', 'dragonfly_report_write'],
    dyTools: ['dragonfly_dy_open'],
    dyBridge: join(home, 'dy', 'bridge.mjs'),
    ...opts,
  })
  const text = existsSync(layout.overlay) ? readFileSync(layout.overlay, 'utf8') : ''
  return { r, text }
}

test('三个服务无条件补开 —— 少一个就用不了账号模型', () => {
  const home = makeHome()
  try {
    const { text } = run(home, { pythonPath: 'D:/py/python.exe' })
    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      assert.match(text, new RegExp(`- id: ${id}\\n  disabled: false`), `${id} 没补开`)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('没填模型时落到账号路由，绝不照抄桌面那个 deepseek-official', () => {
  const home = makeHome()
  try {
    const { text } = run(home, { pythonPath: 'D:/py/python.exe' })
    assert.match(text, /- id: agent-default-model/)
    assert.match(text, /provider: 'deepseek-account'/)
    assert.match(text, /model: 'deepseek-flash'/)
    assert.doesNotMatch(text, /deepseek-official/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('填了模型就用填的，并带上 reasoningEffort', () => {
  const home = makeHome()
  try {
    const ctx = { get: () => ({ currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' }) }) }
    const layout = makeLayout(home)
    ensureOverlay(ctx, layout, { model: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } }, {
      log: () => {},
      biliTools: [], dyTools: [], dyBridge: join(home, 'dy', 'bridge.mjs'),
    })
    const text = readFileSync(layout.overlay, 'utf8')
    assert.match(text, /provider: 'deepseek-account'/)
    assert.match(text, /model: 'deepseek-v4-pro'/)
    assert.match(text, /reasoningEffort: 'high'/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('两条 MCP 都插上时环境变量一个不多一个不少', () => {
  const home = makeHome()
  try {
    const { r, text } = run(home, { pythonPath: 'D:/py/python.exe', notesEnabled: true })
    assert.equal(r.mcp, 2)
    assert.equal(r.skipped.length, 0)

    // B站 那条
    assert.match(text, /- id: mcp-dragonfly-bili/)
    assert.match(text, /serverName: dragonfly-bili/)
    assert.match(text, /command: 'D:\/py\/python\.exe'/)
    assert.match(text, /DRAGONFLY_HOME: '.*'/)
    assert.match(text, /DRAGONFLY_BILI_TOOLS: 'dragonfly_bili_search,dragonfly_report_write'/)
    assert.match(text, /DRAGONFLY_NOTES: '1'/)

    // 抖音 那条
    assert.match(text, /- id: mcp-dragonfly-dy/)
    assert.match(text, /serverName: dragonfly-dy/)
    assert.match(text, /DRAGONFLY_TOOLS: 'dragonfly_dy_open'/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('关掉「写单条笔记」⇒ DRAGONFLY_NOTES 下发 0（Python 那边据此不落盘）', () => {
  const home = makeHome()
  try {
    const { text } = run(home, { pythonPath: 'D:/py/python.exe', notesEnabled: false })
    assert.match(text, /DRAGONFLY_NOTES: '0'/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('没装 Python ⇒ 只插抖音那条，并把原因记下来（不悄悄少一个工具面）', () => {
  const home = makeHome()
  try {
    const { r, text } = run(home, { pythonPath: '' })
    assert.equal(r.mcp, 1, '只该插上抖音那条')
    assert.match(text, /- id: mcp-dragonfly-dy/)
    assert.doesNotMatch(text, /- id: mcp-dragonfly-bili/)
    const why = r.skipped.map((s) => s.why).join('；')
    assert.match(why, /Python/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('B站 MCP 服务没铺到家里 ⇒ 说清是"没铺"，不是"没装 Python"', () => {
  const home = makeHome({ withMcp: false })
  try {
    const { r } = run(home, { pythonPath: 'D:/py/python.exe' })
    const bili = r.skipped.find((s) => s.source === 'bili')
    assert.ok(bili, '应该记一条 bili 的跳过原因')
    assert.match(bili.why, /没铺/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('抖音桥不在包里 ⇒ 只插 B站 那条', () => {
  const home = makeHome({ withBridge: false })
  try {
    const { r, text } = run(home, { pythonPath: 'D:/py/python.exe' })
    assert.equal(r.mcp, 1)
    assert.doesNotMatch(text, /- id: mcp-dragonfly-dy/)
    assert.match(r.skipped.map((s) => s.why).join('；'), /抖音桥/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('信源关掉 ⇒ 那条 MCP 就不插（关掉不是"章程里嘱咐一句"）', () => {
  const home = makeHome()
  try {
    const { r, text } = run(home, { pythonPath: 'D:/py/python.exe', sources: { bili: false, douyin: true } })
    assert.equal(r.mcp, 1)
    assert.doesNotMatch(text, /- id: mcp-dragonfly-bili/)
    assert.match(text, /- id: mcp-dragonfly-dy/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('两条都没插上 ⇒ mcp=0（调用方据此回 no_source，不是硬跑一场空）', () => {
  const home = makeHome({ withMcp: false, withBridge: false })
  try {
    const { r } = run(home, { pythonPath: '' })
    assert.equal(r.mcp, 0)
    assert.ok(r.skipped.length >= 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('路径里的反斜杠与单引号都被安全转义（YAML 单引号字面量）', () => {
  const home = makeHome()
  try {
    const { text } = run(home, { pythonPath: "D:/we'ird/py.exe" })
    assert.match(text, /command: 'D:\/we''ird\/py\.exe'/, '单引号要写成两个')
    assert.doesNotMatch(text, /command: 'D:\/we'ird/, '未转义的单引号会把 YAML 撑破')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

/**
 * effectiveModel：overlay 与设置页诊断共用同一个判定
 * ---------------------------------------------------------------------------
 * 这两处如果各算各的，就会出现"诊断说没事、那一轮却 MISSING_CREDENTIAL"。
 */
test('effectiveModel：桌面默认是 deepseek-official 时回落，并把「原本想要什么」留着', () => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }) }) }
  const m = effectiveModel(ctx, { model: { provider: '', model: '' } })
  assert.equal(m.provider, 'deepseek-account')
  assert.equal(m.model, 'deepseek-flash')
  assert.equal(m.fellBack, true)
  assert.deepEqual(m.wanted, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(m.reasoning, '', '换过路由就把 reasoningEffort 丢掉，别把别家的档位塞过来')
})

test('effectiveModel：显式填的模型照用，不回退', () => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'high' }) }) }
  const m = effectiveModel(ctx, { model: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } })
  assert.equal(m.provider, 'deepseek-account')
  assert.equal(m.model, 'deepseek-v4-pro')
  assert.equal(m.reasoning, 'high')
  assert.equal(m.fellBack, false)
})

test('effectiveModel：什么都取不到时也给一个能跑的，不是空', () => {
  const m = effectiveModel({ get: () => undefined }, {})
  assert.equal(m.provider, 'deepseek-account')
  assert.equal(m.model, 'deepseek-flash')
  assert.equal(m.fellBack, true)
})

/**
 * dutyCwd：那一轮的 cwd
 * ---------------------------------------------------------------------------
 * 会话的工作区就是 cwd。默认是数据目录 —— 那个路径没在应用里注册成工作区，
 * 所以会话列表里看它「没有工作区」。填了工作区就该用工作区。
 */
test('dutyCwd：没填就用数据目录', () => {
  const layout = makeLayout(mkdtempSync(join(tmpdir(), 'dragonfly-cwd-')))
  assert.equal(dutyCwd({}, layout), layout.home)
  assert.equal(dutyCwd({ workspaceDir: '   ' }, layout), layout.home)
})

test('dutyCwd：填了绝对路径就用它，目录不存在会先建出来', () => {
  const layout = makeLayout(mkdtempSync(join(tmpdir(), 'dragonfly-cwd-')))
  const wanted = join(layout.home, '值班室')
  assert.equal(existsSync(wanted), false)
  assert.equal(dutyCwd({ workspaceDir: wanted }, layout), wanted)
  assert.equal(existsSync(wanted), true, 'spawn 一个不存在的 cwd 会 ENOENT，必须先建')
})

test('dutyCwd：相对路径不认（会跟着宿主进程的 cwd 漂，等于没填）', () => {
  const layout = makeLayout(mkdtempSync(join(tmpdir(), 'dragonfly-cwd-')))
  assert.equal(dutyCwd({ workspaceDir: 'some/relative/dir' }, layout), layout.home)
})
