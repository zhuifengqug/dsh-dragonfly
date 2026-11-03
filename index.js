/**
 * index.js —— 宿主侧：把口子接上
 * ============================================================================
 * 这个文件只干四件事，判断一律在 lib/ 里：
 *   ① 导出 cordis 要的三件套：`name` / `inject` / `Config` / `apply`
 *   ② 注册 HTTP 路由 `/api/caifeng/*`（界面全靠它，走 fetch）
 *   ③ 注册宿主工具 `caifeng_*`（给用户会话用的那几个）
 *   ④ 注册 `/caifeng` 命令 + 起 60 秒调度
 *
 * ⚠️ `@deepseek-ai/*` 一个都不裸 import：桌面版 profile 不装 optional peer，
 *    裸 import 会让整条插件**不激活**（宿主只留一句 warning）。全部走 lib/hostdeps.mjs。
 * ============================================================================
 */
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'

import { loadHostDeps } from './lib/hostdeps.mjs'
import { createCaifengService } from './lib/service.mjs'
import { DEFAULTS, FIELD_LABELS, clampConfig, pickKnownKeys } from './lib/config.mjs'
import { listModels, currentDefault } from './lib/models.mjs'
import { createDyHost } from './lib/dy-host.mjs'

const pluginDir = dirname(fileURLToPath(import.meta.url))

/** 插件名（跟命名清单一致） */
export const name = 'tianshu-caifeng'

/**
 * 要用的服务。
 * ⚠️ `attachments` / `llm` 故意不列：只在真要用的时候 `ctx.get()` 取，取不到就降级 ——
 *    列进 inject 等于"没有这些服务我就不启动"，太脆。
 */
export const inject = ['webServer', 'tools', 'settings', 'commands']

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

/** 每个字段都要 `.extra('volatile', true)`：settings.update 只认 volatile 字段 */
const describe = (spec) => spec.extra('volatile', true)

/**
 * Config 形状。范围一律**不在这里做**（schema 校验不过会被 cordis 拒收 ⇒ 整条插件不激活），
 * 全部交给 lib/config.mjs 的 clamp。
 *
 * ⚠️ 嵌套对象（`sources` / `model`）**外面那层不许标 volatile**：
 *    cordis 说「volatile 字段要求一条固定的对象路径，且外层不能也是 volatile」，
 *    标了就会抛 ValidationError，整条插件不激活。只标里面那层。
 */
export const Config = !z ? undefined : z.object({
  sources: z.object({
    bili: describe(z.boolean()),
    douyin: describe(z.boolean()),
  }),
  perDay: describe(z.number()),
  dyDailyMinutes: describe(z.number()),
  fetchPerRound: describe(z.number()),
  windows: describe(z.array(z.string())),
  peakValley: describe(z.boolean()),
  noon: describe(z.boolean()),
  night: describe(z.boolean()),
  manualMax: describe(z.number()),
  manualCooldownMin: describe(z.number()),
  keywords: describe(z.array(z.string())),
  excludeWords: describe(z.array(z.string())),
  searchSort: describe(z.string()),
  searchPages: describe(z.number()),
  personaPrompt: describe(z.string()),
  outputDir: describe(z.string()),
  reportLevel: describe(z.string()),
  notesEnabled: describe(z.boolean()),
  favoritesEnabled: describe(z.boolean()),
  favoritesDays: describe(z.number()),
  model: z.object({
    provider: describe(z.string()),
    model: describe(z.string()),
  }),
  autoComment: describe(z.boolean()),
  commentPerRound: describe(z.number()),
  commentLength: describe(z.string()),
  mentionName: describe(z.string()),
  replyToComments: describe(z.boolean()),
  dmEnabled: describe(z.boolean()),
  dmMode: describe(z.string()),
  dmUid: describe(z.number()),
  pythonPath: describe(z.string()),
})

/** 文本输出（跟 bili 一样的形状，宿主认这个） */
const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** 结果必须是 lossless JSON，否则宿主会报 "value is not lossless JSON" */
const lossless = (value) => {
  try { return JSON.parse(JSON.stringify(value)) } catch { return { ok: false, text: String(value) } }
}

const text = (value) => [{ type: 'text', text: String(value ?? '') }]

export function apply(ctx, config = {}) {
  const logNotes = []
  const log = (line) => {
    logNotes.push(line)
    // 只在真的有话要说时打到控制台，别刷屏
    if (process.env.CAIFENG_DEBUG) console.log(`[caifeng] ${line}`)
  }

  for (const note of hostDeps.notes) log(note)

  const service = createCaifengService(ctx, { pluginDir, config, log })

  /**
   * 抖音在宿主这一头。
   * 桥在 duty 子进程里，要靠 `<家>/dy/control/host.json` 找回来 —— 所以路由注册完立刻 publish 一次。
   */
  const dyHost = createDyHost({
    layout: () => service.layout,
    origin: () => {
      try { return ctx.webServer?.getOrigin?.() } catch { return undefined }
    },
    budget: () => service.dyBudget(),
    log,
  })

  // ── 工具 ──────────────────────────────────────────────────────────────────
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: spec.output || textOutput,
    async execute(args, exec) {
      try { return lossless(await spec.execute(args || {}, exec)) }
      catch (e) { return { ok: false, text: `出错了：${e?.message || e}` } }
    },
  }))

  ctx.effect(() => tool({
    name: 'caifeng_status',
    description: '看采风今天的情况：收了几条、额度剩多少、下次什么时候跑、有没有在跑。',
    parameters: {},
    execute: async () => {
      const s = service.status()
      return {
        ok: true,
        text: [
          s.line,
          `存放位置：${s.home}`,
          `信源：${s.sources.join(' + ') || '都关着'}`,
          s.running ? '现在正在跑一轮。' : '现在没在跑。',
        ].join('\n'),
        status: s,
      }
    },
  }), 'caifeng: tool status')

  ctx.effect(() => tool({
    name: 'caifeng_run',
    description: '立刻跑一轮采风（跟界面上点「现在就跑」一样，手动额度与冷却照走）。',
    parameters: {},
    execute: async () => {
      const res = await service.run('manual')
      return { ok: res.ok, text: res.text || (res.ok ? '跑完了。' : '没跑成。'), result: res }
    },
  }), 'caifeng: tool run')

  ctx.effect(() => tool({
    name: 'caifeng_config',
    description: '读或改采风的配置。不给 patch 就是读。',
    parameters: {
      patch: { type: 'object', additionalProperties: true, description: '要改的字段（只认认识的键）' },
    },
    execute: async (args) => {
      if (!args?.patch || typeof args.patch !== 'object') {
        return { ok: true, text: '当前配置如下。', config: service.config }
      }
      const res = service.setConfig(args.patch)
      return {
        ok: res.ok,
        text: res.changed?.length ? `改了：${res.changed.map((k) => FIELD_LABELS[k] || k).join('、')}` : '没什么要改的。',
        changed: res.changed,
        config: res.config,
      }
    },
  }), 'caifeng: tool config')

  // ── 命令 ──────────────────────────────────────────────────────────────────
  // ⚠️ 别给 `input: { hint: '' }`：宿主要求 hint 非空，空串会抛
  //    `command "caifeng" input hint must not be empty`，整条插件就不激活了。
  //    这个命令不吃参数，直接不传 input。
  ctx.effect(() => ctx.commands.register({
    name: 'caifeng',
    description: '立刻跑一轮采风',
    handler: async () => {
      const res = await service.run('manual')
      return res.ok
        ? { kind: 'success', text: res.text || '跑完了。' }
        : { kind: 'error', text: res.text || '没跑成。' }
    },
  }), 'caifeng: command')

  // ── HTTP 路由 ────────────────────────────────────────────────────────────
  const json = (res, code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c.toString()
      if (raw.length > 512 * 1024) { raw = raw.slice(0, 512 * 1024); req.destroy?.() }
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })

  const sameOriginOk = (req) => {
    const origin = req.headers?.origin
    if (!origin) return true          // 同源 fetch 有时不带 Origin
    const host = req.headers?.host
    try { return new URL(origin).host === host } catch { return false }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/caifeng',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname.replace(/^\/api\/caifeng/, '').replace(/\/$/, '') || '/'
      const isPost = req.method === 'POST'

      /**
       * 抖音这一支走令牌，不走同源判断。
       * 来的是 duty 子进程里那条 MCP 桥（Node fetch，没有 Origin、没有会话 Cookie），
       * 它只认 `<家目录>/dy/control/host.json` 里那次 handshake 写下的令牌。
       */
      if (path.startsWith('/dy/')) {
        const token = String(req.headers?.['x-caifeng-token'] || '')
        if (!dyHost.checkToken(token)) {
          log('抖音：来路令牌不对，拒了')
          return json(res, 403, { ok: false, reason: 'bad-token', text: '令牌不对' })
        }
        if (!isPost) return json(res, 405, { ok: false, reason: 'method', text: '只收 POST' })
        const action = path.slice('/dy/'.length)
        const body = await readBody(req)
        try {
          const r = await dyHost.handle(action, body)
          return json(res, 200, r)
        } catch (e) {
          log(`抖音 ${action} 炸了：${e?.message || e}`)
          return json(res, 200, {
            ok: false,
            reason: e?.reason || 'boom',
            hint: e?.hint || String(e?.message || e),
          })
        }
      }

      // 跨进程挡一道（宿主若提供 connection 服务就用它的判断）
      try {
        const rej = ctx.get?.('connection')?.requestRejection?.({ headers: req.headers })
        if (rej) return json(res, typeof rej === 'number' ? rej : 403, { ok: false, text: '不允许的来路' })
      } catch { /* 没有这个服务就跳过 */ }
      if (!sameOriginOk(req)) return json(res, 403, { ok: false, text: '不允许的来路' })

      try {
        if (path === '/status' && !isPost) {
          return json(res, 200, { ok: true, ...service.status(), dy: dyHost.status() })
        }

        if (path === '/config' && !isPost) {
          return json(res, 200, {
            ok: true,
            config: service.config,
            defaults: DEFAULTS,
            labels: FIELD_LABELS,
          })
        }

        if (path === '/config' && isPost) {
          const body = await readBody(req)
          const patch = pickKnownKeys(body?.patch || body || {})
          if (!Object.keys(patch).length) return json(res, 400, { ok: false, text: '没给要改的字段' })
          const res0 = service.setConfig(patch)
          return json(res, 200, { ok: res0.ok, changed: res0.changed, config: res0.config })
        }

        if (path === '/run' && isPost) {
          const r = await service.run('manual')
          return json(res, 200, { ok: r.ok, text: r.text, code: r.code })
        }

        if (path === '/report' && !isPost) {
          const day = url.searchParams.get('day') || ''
          return json(res, 200, { ok: true, ...service.readReport(day) })
        }

        if (path === '/days' && !isPost) {
          return json(res, 200, { ok: true, days: service.reportDays(7) })
        }

        // ── 运行环境：Python / 登录 / 模型 / 诊断 ──────────────────────────
        if (path === '/models' && !isPost) {
          const r = await listModels(ctx)
          return json(res, 200, { ok: true, ...r, current: currentDefault(ctx) })
        }

        if (path === '/python' && !isPost) {
          return json(res, 200, { ok: true, ...(await service.pythonInfo()) })
        }

        if (path === '/python' && isPost) {
          // 装环境要几分钟，这里不阻塞界面：先回一句"开始了"，进度看 /status 的日志尾巴
          service.setupPython().then((r) => log(`装 Python 环境：${r.ok ? '好' : `失败（${r.stage || ''}）`}`)).catch(() => {})
          return json(res, 202, { ok: true, text: '开始装了，几分钟。装完这个页面刷新一下就能看到。' })
        }

        if (path === '/login/start' && isPost) {
          const r = await service.biliLoginStart()
          // 二维码是个本地 PNG 文件，浏览器读不到盘 —— 转成 data URL 递过去
          let qr = ''
          if (r.png) {
            try {
              qr = `data:image/png;base64,${readFileSync(r.png).toString('base64')}`
            } catch { qr = '' }
          }
          return json(res, 200, { ok: true, key: r.key, url: r.url, qr })
        }

        if (path === '/login/poll' && isPost) {
          const body = await readBody(req)
          const key = String(body?.key || '').trim()
          if (!key) return json(res, 400, { ok: false, text: '没给 key' })
          const r = await service.biliLoginPoll(key)
          return json(res, 200, { ok: true, ...r })
        }

        if (path === '/whoami' && !isPost) {
          return json(res, 200, service.biliWho())
        }

        if (path === '/diagnose' && !isPost) {
          return json(res, 200, await service.diagnose())
        }

        if (path === '/review' && isPost) {
          const r = await service.reviewComments({ max: 6 })
          return json(res, 200, { ok: true, ...r })
        }

        if (path === '/import' && isPost) {
          const r = service.importOld()
          return json(res, 200, r)
        }

        if (path === '/move-home' && isPost) {
          const body = await readBody(req)
          const r = service.changeHome(body?.dir || body?.outputDir || '', { confirm: Boolean(body?.confirm) })
          return json(res, r.ok ? 200 : 409, r)
        }

        return json(res, 404, { ok: false, text: `没有这个口子：${path}` })
      } catch (e) {
        log(`路由 ${path} 炸了：${e?.message || e}`)
        return json(res, 500, { ok: false, text: `出错了：${e?.message || e}` })
      }
    },
  }), 'caifeng: web route')

  /**
   * 路由一注册就把宿主地址写给桥。
   * 端口要监听之后才知道，所以 getOrigin() 此刻可能还抛错 —— 那就退避重试，
   * 直到写成功为止（每轮 duty 都会重新读这个文件，所以只要最终写上就行）。
   */
  ctx.effect(() => {
    let timer = null
    let delay = 200
    let tries = 0
    let done = false
    const attempt = () => {
      timer = null
      if (done || tries >= 12) return
      tries += 1
      const r = dyHost.publish()
      if (r.ok) { done = true; return }
      delay = Math.min(delay * 2, 5000)
      timer = setTimeout(attempt, delay)
      timer.unref?.()
    }
    attempt()
    return () => {
      done = true
      if (timer) clearTimeout(timer)
    }
  }, 'caifeng: dy handshake')

  // ── 调度 ──────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    service.startTimer()
    return () => service.stopTimer()
  }, 'caifeng: scheduler')

  // 卸载时只断 CDP，不关浏览器 —— 登录态要留着，下次还要接着用
  ctx.effect(() => () => { dyHost.close().catch(() => {}) }, 'caifeng: dy close')

  // 服务：只暴露三个口子（别再多了）
  // ⚠️ 必须是 `ctx.provide`，不是 `ctx.set` —— cordis 的 set 只改「已经 provide 过」的服务，
  //    直接 set 会抛 `cannot set property "tianshuCaifeng" without provide`。
  //    provide 自己已经挂在 fiber.effect 上，卸载自动回收，这里不用再包一层。
  if (typeof ctx.provide === 'function') {
    ctx.provide('tianshuCaifeng', {
      status: () => service.status(),
      run: () => service.run('manual'),
      config: () => service.config,
    })
  } else {
    log('宿主没有 ctx.provide，tianshuCaifeng 服务没挂上（工具与界面照常）')
  }

  log(`采风起来了：家在 ${service.layout.home}`)
  void text
  void clampConfig
}
