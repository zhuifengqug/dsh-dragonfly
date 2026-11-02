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
import { dirname, join } from 'node:path'

import { loadHostDeps } from './lib/hostdeps.mjs'
import { createCaifengService } from './lib/service.mjs'
import { DEFAULTS, FIELD_LABELS, clampConfig, pickKnownKeys } from './lib/config.mjs'

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
 */
export const Config = !z ? undefined : z.object({
  sources: describe(z.object({
    bili: describe(z.boolean()),
    douyin: describe(z.boolean()),
  })),
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
  model: describe(z.object({
    provider: describe(z.string()),
    model: describe(z.string()),
  })),
  autoComment: describe(z.boolean()),
  commentPerRound: describe(z.number()),
  commentLength: describe(z.string()),
  mentionName: describe(z.string()),
  replyToComments: describe(z.boolean()),
  dmEnabled: describe(z.boolean()),
  dmMode: describe(z.string()),
  dmUid: describe(z.number()),
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
  ctx.effect(() => ctx.commands.register({
    name: 'caifeng',
    description: '立刻跑一轮采风',
    input: { hint: '', attachments: false },
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
      // 跨进程挡一道（宿主若提供 connection 服务就用它的判断）
      try {
        const rej = ctx.get?.('connection')?.requestRejection?.({ headers: req.headers })
        if (rej) return json(res, typeof rej === 'number' ? rej : 403, { ok: false, text: '不允许的来路' })
      } catch { /* 没有这个服务就跳过 */ }
      if (!sameOriginOk(req)) return json(res, 403, { ok: false, text: '不允许的来路' })

      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname.replace(/^\/api\/caifeng/, '').replace(/\/$/, '') || '/'
      const isPost = req.method === 'POST'

      try {
        if (path === '/status' && !isPost) return json(res, 200, { ok: true, ...service.status() })

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

        return json(res, 404, { ok: false, text: `没有这个口子：${path}` })
      } catch (e) {
        log(`路由 ${path} 炸了：${e?.message || e}`)
        return json(res, 500, { ok: false, text: `出错了：${e?.message || e}` })
      }
    },
  }), 'caifeng: web route')

  // ── 调度 ──────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    service.startTimer()
    return () => service.stopTimer()
  }, 'caifeng: scheduler')

  // 服务：只暴露三个口子（别再多了）
  ctx.set?.('tianshuCaifeng', {
    status: () => service.status(),
    run: () => service.run('manual'),
    config: () => service.config,
  })

  log(`采风起来了：家在 ${service.layout.home}`)
  void text
  void clampConfig
}
