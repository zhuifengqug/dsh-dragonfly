import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, Config, inject, name } from '../../index.js'
import { createDragonflyService } from '../../lib/service.mjs'
import { DEFAULTS } from '../../lib/config.mjs'
import { layoutOf } from '../../lib/paths.mjs'
import { loadDaily } from '../../lib/state.mjs'
import { dayKey } from '../../lib/clock.mjs'

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
  const injected = []
  const services = new Map()
  services.set('dshHomePath', (seg) => join(home, seg))

  return {
    toolList,
    commandList,
    routeList,
    effects,
    injected,
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
    // 宿主是 cordis：`ctx.inject([...], cb)` 开子 fiber，服务就位后才跑 cb。
    // 这里立刻用假服务调一次，并把注入过的名字记下来给用例断言。
    inject(names, cb) {
      injected.push([...names])
      const child = {
        workspaceRegistry: services.get('workspaceRegistry'),
        get: (k) => services.get(k),
        set: (k, v) => services.set(k, v),
        effect: (fn) => { const c = fn(); effects.push({ label: 'inject-child', cleanup: c }); return () => c?.() },
      }
      const cleanup = cb(child)
      effects.push({ label: `inject:${names.join(',')}`, cleanup })
      return () => { try { cleanup?.() } catch { /* ignore */ } }
    },
  }
}

test('插件导出 name / inject / Config 三件套', () => {
  assert.equal(name, 'dragonfly')
  assert.deepEqual(inject, ['webServer', 'tools', 'settings', 'commands'])
  assert.ok(Config, 'Config 应该存在（拿得到 schemastery）')
})

test('apply 把三条口子都接上了：工具、命令、路由', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-host-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, DEFAULTS)

    const names = ctx.toolList.map((t) => t.name).sort()
    assert.deepEqual(names, ['dragonfly_aihot', 'dragonfly_config', 'dragonfly_run', 'dragonfly_status'])

    assert.equal(ctx.commandList.length, 1)
    assert.equal(ctx.commandList[0].name, 'dragonfly')

    assert.equal(ctx.routeList.length, 1)
    assert.equal(ctx.routeList[0].path, '/api/dragonfly')
    assert.equal(ctx.routeList[0].kind, 'prefix')

    // 服务只暴露三个口子
    const svc = ctx.get('dragonfly')
    assert.deepEqual(Object.keys(svc).sort(), ['config', 'run', 'status'])

    // 卸载时定时器要停（否则进程退不掉）
    for (const e of ctx.effects) if (typeof e.cleanup === 'function') e.cleanup()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('apply 用 ctx.inject 开一个 workspaceRegistry 子 fiber（主 ctx 上取不到它）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-host-'))
  try {
    const ctx = makeCtx(home)
    // 主 ctx 的 inject 里没有它 —— 这正是「对账跑了却一次没生效」的根因
    assert.equal(ctx.get('workspaceRegistry'), undefined)
    const ws = {
      sessionIds: [],
      record: { title: '蜻蛉值班' },
      resolveByPath: async () => ws,
      attachSession: async () => {},
      detachSession: async () => {},
    }
    ctx.set('workspaceRegistry', ws)
    apply(ctx, DEFAULTS)
    assert.deepEqual(ctx.injected, [['workspaceRegistry']])
    for (const e of ctx.effects) if (typeof e.cleanup === 'function') e.cleanup()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('工具的输出形状符合宿主契约（defineTool 编译后的形状）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-shape-'))
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

test('dragonfly_status 在没有信源时报「跑不了」，不是报错', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-nosrc-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, { ...DEFAULTS, sources: { bili: false, douyin: false } })
    const statusTool = ctx.toolList.find((t) => t.name === 'dragonfly_status')
    const out = await statusTool.execute({}, {})
    assert.equal(out.ok, true)
    assert.match(out.text, /已收 \d+ 条/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('dragonfly_run 在三个信源都关着时明确说清楚', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-run-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, { ...DEFAULTS, sources: { bili: false, douyin: false, aihot: false } })
    const runTool = ctx.toolList.find((t) => t.name === 'dragonfly_run')
    const out = await runTool.execute({}, {})
    assert.equal(out.ok, false)
    assert.match(out.text, /信源|跑不了|没什么可看/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('dragonfly_config 改值会落盘到 config.json（文件是真源）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-cfg-'))
  try {
    const ctx = makeCtx(home)
    apply(ctx, DEFAULTS)
    const cfgTool = ctx.toolList.find((t) => t.name === 'dragonfly_config')
    const out = await cfgTool.execute({ patch: { biliPerRound: 2, dmMode: 'draft' } }, {})
    assert.equal(out.ok, true)
    assert.ok(out.changed.includes('biliPerRound'))

    const file = join(home, 'dragonfly', 'config.json')
    assert.ok(existsSync(file), 'config.json 应该被写出来')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.biliPerRound, 2)
    assert.equal(saved.dmMode, 'draft')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── 服务层：写口与判重（票 #4 的一部分，先立起来） ───────────────────────────
function makeService(home) {
  const ctx = makeCtx(home)
  return { ctx, service: createDragonflyService(ctx, { pluginDir: process.cwd(), config: DEFAULTS, log: () => {} }) }
}

test('report_write 同日按 id 合并，不产生第二条', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-report-'))
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
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-empty-'))
  try {
    const { service } = makeService(home)
    const r = await service.writeReport({ text: '   ' })
    assert.equal(r.ok, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('seen 写口幂等：同一天同一条记两次，只有一行', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-seen-'))
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
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-home-'))
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

test('status 的展示行包含收了几条 / 每个源的额度 / 自动轮数', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-status-'))
  try {
    const { service } = makeService(home)
    const s = service.status()
    assert.match(s.line, /今日已收 \d+ 条/)
    assert.match(s.line, /B站 \d+/)
    assert.match(s.line, /视频 \d+\/\d+ 轮/)
    assert.equal(s.quota.roundCaps.bili, DEFAULTS.biliPerRound)
    assert.equal(s.quota.autoRunsMax, DEFAULTS.autoRuns)
    assert.equal(s.running, false)
    assert.deepEqual(s.sources, ['B站', '抖音', 'AI 圈'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('诊断逐项：七样都列出来，缺的那样要带「点哪儿」', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-diag-'))
  const realDshHome = process.env.DSH_HOME
  // 把 DSH_HOME 指到临时目录：否则"从旧插件导入"会把真机上 bili-duty 的配置与凭据搬进来，
  // 这条用例就变成"看这台机器装没装过"，而不是"空机器上诊断说什么"
  process.env.DSH_HOME = join(home, 'dsh')
  try {
    const { service } = makeService(home)
    const d = await service.diagnose()

    assert.equal(d.ok, true)
    assert.ok(Array.isArray(d.checks))
    assert.deepEqual(
      d.checks.map((c) => c.key),
      ['python', 'bili', 'douyin', 'model', 'workspace', 'dshEntry', 'lastRun'],
    )

    for (const c of d.checks) {
      assert.equal(typeof c.label, 'string')
      assert.equal(typeof c.ok, 'boolean')
      assert.equal(typeof c.line, 'string')
      assert.ok(c.line.length > 0, `${c.key} 得说清现在是怎样`)
    }

    // 全新装的机器：Python / 登录 / 抖音 三样必然还没有，每样都得告诉人点哪儿
    const byKey = Object.fromEntries(d.checks.map((c) => [c.key, c]))
    for (const key of ['python', 'bili', 'douyin']) {
      assert.equal(byKey[key].ok, false, `${key} 在空家目录里不该是 ok`)
      assert.ok(byKey[key].hint.length > 0, `${key} 不对时必须给下一步，不能只说"不行"`)
    }
    assert.match(byKey.python.hint, /装 Python/)
    assert.match(byKey.bili.hint, /登录/)
    assert.match(byKey.douyin.hint, /现在就跑/)

    // 还没跑过的时候也要有一句话，不能是空字符串
    assert.match(byKey.lastRun.line, /还没跑过/)

    // 假 ctx 里没有 workspaceRegistry ⇒ 这一项要说不清是哪一种，并给出下一步；
    // 会话"掉进未分组"时用户没法自己看出是路径没填还是宿主没这服务，所以这句必须有
    assert.equal(byKey.workspace.ok, false)
    assert.match(byKey.workspace.line, /工作区/)
    assert.ok(byKey.workspace.hint.length > 0, 'workspace 不对时必须给下一步')
  } finally {
    if (realDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realDshHome
    await rm(home, { recursive: true, force: true })
  }
})

test('诊断的工作区项：登记过就说标题与条数，没登记就说点哪儿去加', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-diag-ws-'))
  const realDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(home, 'dsh')
  try {
    const { ctx, service } = makeService(home)
    const cwd = join(home, '值班')
    ctx.set('workspaceRegistry', {
      resolveByPath: async () => ({
        record: { title: '蜻蛉值班' },
        sessionIds: ['session-a', 'session-b'],
        attachSession: async () => {},
      }),
    })
    // 目录得先存在，dutyCwd 才会认这个绝对路径
    await mkdir(cwd, { recursive: true })
    await service.setConfig({ workspaceDir: cwd })

    const reg = (d) => d.checks.find((c) => c.key === 'workspace')
    const hit = reg(await service.diagnose())
    assert.equal(hit.ok, true)
    assert.match(hit.line, /蜻蛉值班/)
    assert.match(hit.line, /2 个会话/)

    // 换成"这个目录还没登记成工作区"：不能装没事，要让人知道去左侧加一下
    ctx.set('workspaceRegistry', { resolveByPath: async () => undefined })
    const miss = reg(await service.diagnose())
    assert.equal(miss.ok, false)
    assert.match(miss.line, /还没有登记成工作区/)
    assert.match(miss.hint, /工作区/)
  } finally {
    if (realDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realDshHome
    await rm(home, { recursive: true, force: true })
  }
})

test('诊断在依赖缺失时给的是人话，不是堆栈', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-diag2-'))
  try {
    const { service } = makeService(home)
    const d = await service.diagnose()
    // 结论必须是一句话；不允许把 traceback 原样当结论
    assert.ok(d.verdict.length > 0)
    assert.doesNotMatch(d.verdict, /\n/)
    assert.doesNotMatch(d.verdict, /Traceback|at .*\.js:\d+/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})


// ── 调度：失败不吃窗口（11-08~10 连续失败却记成「跑过了」的回归） ─────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('自动轮：失败不封窗，同一窗口最多试 2 次', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dragonfly-tick-'))
  const realDshHome = process.env.DSH_HOME
  // 指到临时 DSH_HOME：否则 ensureDutyProfile 会写到真机 profile 上去
  process.env.DSH_HOME = join(home, 'dsh')
  try {
    const ctx = makeCtx(home)
    // 三个信源都关着 ⇒ run() 立刻以 no_source 失败。用它验「失败只计数、不封窗」，
    // 顺带保证这条用例不落盘、不起进程、不打外网。
    // 时间点用「此刻这个小时」，否则 tick() 会因为不在时间点上直接早退，这条用例就白跑了。
    const bjHour = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours()
    const nowSlot = `${String(bjHour).padStart(2, '0')}:00`
    const service = createDragonflyService(ctx, {
      pluginDir: process.cwd(),
      // peakValley 关掉：这条用例验的是「失败怎么记」，别让谷时开关把它挡在门外
      config: { ...DEFAULTS, peakValley: false, runTimes: [nowSlot], sources: { bili: false, douyin: false, aihot: false } },
      log: () => {},
    })
    const layout = layoutOf(service.status().home)

    service.tick()
    await sleep(1500)
    let daily = loadDaily(layout, dayKey()).daily
    const keys = Object.keys(daily.windowTries || {})
    assert.equal(keys.length, 1, '应该记下一个窗口的尝试次数')
    assert.equal(daily.windowTries[keys[0]], 1)
    assert.deepEqual(daily.windowsDone || [], [], '失败不该进 windowsDone')

    service.tick()
    await sleep(1500)
    service.tick()
    await sleep(1500)
    daily = loadDaily(layout, dayKey()).daily
    assert.equal(daily.windowTries[keys[0]], 2, '超过 AUTO_TRIES_PER_WINDOW 就不要再试')
    assert.deepEqual(daily.windowsDone || [], [], '失败了还是不该封窗')
  } finally {
    process.env.DSH_HOME = realDshHome
    await rm(home, { recursive: true, force: true })
  }
})