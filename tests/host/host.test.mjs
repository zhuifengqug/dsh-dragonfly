import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, Config, inject, name } from '../../index.js'
import { createCaifengService } from '../../lib/service.mjs'
import { DEFAULTS } from '../../lib/config.mjs'

/**
 * 假 ctx —— 只实现我们真用到的那几个口子。
 * 这种"最小假 ctx"是这一层测试的关键：它逼我们照着宿主真实契约写，
 * 一旦有人偷偷 `ctx.somethingNew()`，测试立刻炸。
 */
function makeCtx(home) {
  const toolList = []
  const commandList = []
  const routeList = []
  const effects = []
  const services = new Map()
  services.set('dshHomePath', (seg) => join(home, seg))

  return {
    toolList,
    commandList,
    routeList,
    effects,
    services,
    get: (k) => services.get(k),
    set: (k, v) => services.set(k, v),
    // 宿主是 cordis：服务要用 provide 挂（set 只能改已 provide 过的）
    provide: (k, v) => {
      if (services.has(k)) throw new Error(`service "${k}" has been registered`)
      services.set(k, v)
      return () => { services.delete(k) }
    },
    effect: (fn, label) => {
      const cleanup = fn()
      effects.push({ label, cleanup })
      return () => { try { cleanup?.() } catch { /* ignore */ } }
    },
    tools: {
      register(spec) {
        toolList.push(spec)
        return async () => {}
      },
    },
    commands: {
      register(spec) {
        commandList.push(spec)
        return async () => {}
      },
    },
    webServer: {
      register(spec) {
        routeList.push(spec)
        return async () => {}
      },
    },
    settings: {
      describe: () => [],
      update: () => {},
    },
  }
}

test('插件导出 name / inject / Config 三件套', () => {
  assert.equal(name, 'tianshu-caifeng')
  assert.deepEqual(inject, ['webServer', 'tools', 'settings', 'commands'])
  assert.ok(Config, 'Config 应该存在（拿得到 schemastery）')
})

test('apply 把三条口子都接上了：工具、命令、路由', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-host-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, DEFAULTS)

    const names = ctx.toolList.map((t) => t.name).sort()
    assert.deepEqual(names, ['caifeng_config', 'caifeng_run', 'caifeng_status'])

    assert.equal(ctx.commandList.length, 1)
    assert.equal(ctx.commandList[0].name, 'caifeng')

    assert.equal(ctx.routeList.length, 1)
    assert.equal(ctx.routeList[0].path, '/api/caifeng')
    assert.equal(ctx.routeList[0].kind, 'prefix')

    // 服务只暴露三个口子
    const svc = ctx.get('tianshuCaifeng')
    assert.deepEqual(Object.keys(svc).sort(), ['config', 'run', 'status'])

    // 卸载时定时器要停（否则进程退不掉）
    for (const e of ctx.effects) if (typeof e.cleanup === 'function') e.cleanup()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('工具的输出形状符合宿主契约（defineTool 编译后的形状）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-shape-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, DEFAULTS)
    for (const t of ctx.toolList) {
      assert.equal(typeof t.description, 'string')
      // defineTool 会把 author 形状编译成 JSON Schema：object 根 + properties
      assert.equal(t.parameters.type, 'object')
      assert.equal(typeof t.parameters.properties, 'object')
      assert.equal(typeof t.execute, 'function')
      assert.equal(t.output.schema.type, 'object')
      assert.equal(typeof t.output.render, 'function')
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('caifeng_status 在没有信源时报「跑不了」，不是报错', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-nosrc-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, { ...DEFAULTS, sources: { bili: false, douyin: false } })
    const statusTool = ctx.toolList.find((t) => t.name === 'caifeng_status')
    const out = await statusTool.execute({}, {})
    assert.equal(out.ok, true)
    assert.match(out.text, /额度/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('caifeng_run 在两个信源都关着时明确说清楚', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-run-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, { ...DEFAULTS, sources: { bili: false, douyin: false } })
    const runTool = ctx.toolList.find((t) => t.name === 'caifeng_run')
    const out = await runTool.execute({}, {})
    assert.equal(out.ok, false)
    assert.match(out.text, /信源|跑不了|没什么可看/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('caifeng_config 改值会落盘到 config.json（文件是真源）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-cfg-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, DEFAULTS)
    const cfgTool = ctx.toolList.find((t) => t.name === 'caifeng_config')
    const out = await cfgTool.execute({ patch: { perDay: 2, dmMode: 'draft' } }, {})
    assert.equal(out.ok, true)
    assert.ok(out.changed.includes('perDay'))

    const file = join(home, 'tianshu-caifeng', 'config.json')
    assert.ok(existsSync(file), 'config.json 应该被写出来')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.perDay, 2)
    assert.equal(saved.dmMode, 'draft')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── 服务层：写口与判重（票 #4 的一部分，先立起来） ───────────────────────────
function makeService(home) {
  const ctx = makeCtx(home)
  return { ctx, service: createCaifengService(ctx, { pluginDir: process.cwd(), config: DEFAULTS, log: () => {} }) }
}

test('report_write 同日按 id 合并，不产生第二条', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-report-'))
  try {
    const { service } = makeService(home)
    const entry = '### [B站] BV1xx411c7mD / 标题\n**档位**：值得看\n**为什么值得**：12 分钟，播放 3 万。\n'
    const a = await service.writeReport({ text: entry })
    assert.deepEqual(a.added, ['BV1xx411c7mD'])
    const b = await service.writeReport({ text: entry.replace('标题', '改了标题') })
    assert.deepEqual(b.replaced, ['BV1xx411c7mD'])
    const text = await readFile(a.file, 'utf8')
    assert.equal((text.match(/BV1xx411c7mD/g) || []).length, 1)
    assert.match(text, /改了标题/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('report_write 空内容不写（别拿空壳盖掉已有日报）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-empty-'))
  try {
    const { service } = makeService(home)
    const r = await service.writeReport({ text: '   ' })
    assert.equal(r.ok, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('seen 写口幂等：同一天同一条记两次，只有一行', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-seen-'))
  try {
    const { service } = makeService(home)
    await service.appendSeen({ id: 'BV1xx411c7mD', title: '甲', up: 'UP', status: '弃' })
    const second = await service.appendSeen({ id: 'BV1xx411c7mD', title: '甲', up: 'UP', status: '收' })
    assert.equal(second.duplicated, true)
    const recent = await service.seenRecent({ id: 'BV1xx411c7mD' })
    assert.equal(recent.rows.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('初次起来就把家目录、见闻录、章程铺好', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-home-'))
  try {
    const { service } = makeService(home)
    const lay = service.layout
    assert.ok(existsSync(lay.home))
    assert.ok(existsSync(lay.out))
    assert.ok(existsSync(lay.reports))
    assert.ok(existsSync(lay.seen))
    // 章程：插件里有 prompts/duty.md 就铺；没有也算正常（这一阶段还没写章程）
    if (existsSync(join(process.cwd(), 'prompts', 'duty.md'))) assert.ok(existsSync(lay.duty))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('status 的展示行包含收了几条 / 额度 / 下次', async () => {
  const home = await mkdtemp(join(tmpdir(), 'caifeng-status-'))
  try {
    const { service } = makeService(home)
    const s = service.status()
    assert.match(s.line, /今日已收 \d+ 条/)
    assert.match(s.line, /额度 \d+/)
    assert.equal(s.running, false)
    assert.deepEqual(s.sources, ['B站', '抖音'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

