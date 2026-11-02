/**
 * lib/service.mjs —— 采风的本体：状态、跑一轮、配置读写、日报读取
 * ============================================================================
 * index.js 只负责"把口子接上"（路由 / 工具 / 命令 / 定时器），所有判断都在这里。
 * 这样做的好处：这一层的每条规则都能用假 ctx + 临时目录整份测。
 * ============================================================================
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULTS, clampConfig, diffKeys, pickKnownKeys } from './config.mjs'
import { autoWindowState, dayKey, nextWindowLabel } from './clock.mjs'
import { resolveHome, ensureDirs } from './paths.mjs'
import {
  acquireLock, appendLog, autoPickedToday, loadDaily,
  readJson, readLogTail, readText, releaseLock, saveDaily, writeJson, writeText,
  ensureCharter,
} from './state.mjs'
import { countPicks, emptyReport, mergeReport, reportView } from './report.mjs'
import { appendRow, emptySeen, parseSeen, seenToday } from './seen.mjs'
import { renderCharter, readCharter } from './charter.mjs'
import {
  ensureDutyProfile, ensureOverlay, readPluginCharter, resolveDsh, spawnDuty, PROFILE_NAME,
} from './duty.mjs'

/** 这一轮能用的工具名（duty 会话白名单，13 个） */
export const DUTY_BILI_TOOLS = [
  'caifeng_bili_search', 'caifeng_bili_subtitle', 'caifeng_bili_comments', 'caifeng_bili_frames',
  'caifeng_bili_favorites', 'caifeng_bili_reply', 'caifeng_bili_dm',
]
export const DUTY_LOCAL_TOOLS = ['caifeng_report_write', 'caifeng_seen']
export const DUTY_DY_TOOLS = ['caifeng_dy_open', 'caifeng_dy_state', 'caifeng_dy_next', 'caifeng_dy_frames']

/**
 * @param {object} ctx cordis 上下文（只用到 ctx.get / ctx.effect / ctx.settings）
 * @param {{pluginDir:string, config?:object, log?:Function}} opts
 */
export function createCaifengService(ctx, opts = {}) {
  const pluginDir = opts.pluginDir
  const log = opts.log || (() => {})
  const dirLog = (line) => { try { appendLog(layout, line) } catch { /* ignore */ } log(line) }

  let layout = resolveHome(ctx, opts.config?.outputDir)
  let cfg = clampConfig(opts.config || {}, DEFAULTS)
  let running = null          // 当前在跑的那一轮
  let lastRun = null          // 上一轮的结果（给状态用）
  let timer = null

  // ── 家目录 ────────────────────────────────────────────────────────────────
  function ensureHome() {
    ensureDirs(layout, dirLog)
    // 见闻录：没有就铺一份两节空表
    if (!existsSync(layout.seen)) writeText(layout.seen, emptySeen())
    // 章程
    ensureCharter(join(pluginDir, 'prompts', 'duty.md'), layout, dirLog)
    // 受限 profile（不在这里装，跑的时候装）
  }

  function reloadLayout() {
    const next = resolveHome(ctx, cfg.outputDir)
    if (next.home !== layout.home) { layout = next; ensureHome() }
    return layout
  }

  // ── 配置 ──────────────────────────────────────────────────────────────────
  /** config.json 是真源；宿主 settings 只是镜像 */
  function loadCfg() {
    const file = readJson(layout.config, null)
    const merged = clampConfig({ ...cfg, ...(file && typeof file === 'object' ? file : {}) }, DEFAULTS)
    cfg = merged
    return cfg
  }

  /** 落盘 + 同步宿主镜像。以文件为准。 */
  function persistCfg(patch) {
    const before = cfg
    const next = clampConfig({ ...cfg, ...pickKnownKeys(patch || {}) }, DEFAULTS)
    const changed = diffKeys(before, next)
    if (!changed.length) return { ok: true, changed: [], config: cfg }

    const file = readJson(layout.config, {}) || {}
    const merged = { ...file, ...Object.fromEntries(changed.map((k) => [k, next[k]])) }
    merged._set = [...new Set([...(Array.isArray(file._set) ? file._set : []), ...changed])]
    writeJson(layout.config, merged)
    cfg = next
    reloadLayout()

    // 宿主镜像：写失败只记日志，不回滚文件（文件是真源）
    try {
      const row = findSettingsRow()
      if (row?.ns) ctx.settings?.update?.(row.ns, Object.fromEntries(changed.map((k) => [k, next[k]])), row.revision)
    } catch (e) { dirLog(`宿主设置镜像没写上（${e?.message || e}）—— 以 config.json 为准`) }
    return { ok: true, changed, config: cfg }
  }

  /** 在 ctx.settings.describe() 里找我们那一行（靠几个特征键认） */
  function findSettingsRow() {
    try {
      const rows = ctx.settings?.describe?.() || []
      const SIG = ['perDay', 'mentionName', 'dmMode', 'dyDailyMinutes']
      for (const r of rows) {
        const v = r?.value
        if (!v || typeof v !== 'object') continue
        if (SIG.every((k) => k in v)) return r
      }
    } catch { /* ignore */ }
    return null
  }

  // ── 状态 ──────────────────────────────────────────────────────────────────
  function status() {
    const today = dayKey()
    const { daily } = loadDaily(layout, today)
    const win = autoWindowState(new Date(), cfg)
    const reportFile = join(layout.out, `${today}.md`)
    const reportText = readText(reportFile)
    const picks = reportText ? countPicks(reportText) : { good: 0, total: 0, bySource: { bili: 0, douyin: 0 } }
    const lock = readJson(layout.lock, null)
    const locked = Boolean(lock && Number(lock.ts) > Date.now() - 10 * 60 * 1000)

    const sources = []
    if (cfg.sources?.bili) sources.push('B站')
    if (cfg.sources?.douyin) sources.push('抖音')

    return {
      // 展示用一句话
      line: `今日已收 ${picks.good} 条（B站 ${picks.bySource.bili} / 抖音 ${picks.bySource.douyin}）· 额度 ${cfg.perDay} · ${
        running ? '正在跑' : (win.ok ? `下次 ${nextWindowLabel(new Date(), cfg).label}` : win.why)
      }`,
      today,
      home: layout.home,
      outputDir: cfg.outputDir,
      sources,
      quota: { perDay: cfg.perDay, used: picks.good, autoRuns: daily.autoRuns, manualRuns: daily.manualRuns },
      picked: picks,
      window: win,
      next: nextWindowLabel(new Date(), cfg).label,
      running: Boolean(running),
      locked,
      lastRun,
      dutyProfile: existsSync(join(pluginDir, 'profile-template', PROFILE_NAME, 'package.json')) ? 'shipped' : 'missing',
      config: cfg,
      logTail: readLogTail(layout, 1500),
      reportFile,
      seenFile: layout.seen,
    }
  }

  /** 日报（给界面渲染） */
  function readReport(day) {
    const d = String(day || dayKey()).trim()
    const file = join(layout.out, `${d}.md`)
    const text = readText(file)
    return { day: d, exists: Boolean(text), text, view: text ? reportView(text) : null }
  }

  /** 最近几天有日报（设置页的日期切换用） */
  function reportDays(limit = 7) {
    try {
      return readdirSync(layout.out)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .map((f) => f.replace(/\.md$/, ''))
        .sort()
        .reverse()
        .slice(0, limit)
    } catch { return [] }
  }

  // ── 跑一轮 ────────────────────────────────────────────────────────────────
  /**
   * 跑一轮。
   * @param {'auto'|'manual'} why
   */
  async function run(why = 'manual') {
    if (running) return { ok: false, code: 'busy', text: '上一轮还没跑完，等它结束。' }

    loadCfg()
    reloadLayout()

    if (!cfg.sources?.bili && !cfg.sources?.douyin) {
      return { ok: false, code: 'no_source', text: '两个信源都关着，这一轮没什么可看的。去设置页打开一个。' }
    }

    // 手动额度与冷却
    const today = dayKey()
    const { daily } = loadDaily(layout, today)
    if (why === 'manual') {
      if (daily.manualRuns >= cfg.manualMax) {
        return { ok: false, code: 'quota', text: `今天手动已经跑了 ${daily.manualRuns} 次（上限 ${cfg.manualMax} 次），明天再点。` }
      }
      const since = Date.now() - Number(daily.lastManualAt || 0)
      if (since < cfg.manualCooldownMin * 60 * 1000) {
        const wait = Math.ceil((cfg.manualCooldownMin * 60 * 1000 - since) / 60000)
        return { ok: false, code: 'cooldown', text: `刚跑过，再等 ${wait} 分钟。` }
      }
    }

    // 自动轮：额度都用完了就别跑了
    if (why === 'auto' && autoPickedToday(daily) >= cfg.perDay) {
      return { ok: false, code: 'quota', text: '今天的额度已经用完了。' }
    }

    ensureHome()

    const lock = acquireLock(layout, why)
    if (!lock.ok) {
      return { ok: false, code: 'locked', text: '另一个窗口正在跑，这一轮先跳过。' }
    }
    if (lock.warning) dirLog(lock.warning)

    const dsh = resolveDsh()
    if (dsh.missing) {
      releaseLock(layout)
      return { ok: false, code: 'no_dsh', text: dsh.hint }
    }

    const prof = ensureDutyProfile(pluginDir, dirLog)
    if (prof.state !== 'ok') dirLog(`受限 profile 不可用（${prof.state}）—— 退回普通 headless`)

    const overlay = ensureOverlay(ctx, layout, cfg, {
      log: dirLog,
      biliTools: [...DUTY_BILI_TOOLS, ...DUTY_LOCAL_TOOLS],
      dyTools: [...DUTY_DY_TOOLS],
      dyBridge: join(pluginDir, 'dy', 'mcp-bridge.mjs'),
    })

    // 一条 MCP 都没插上 = 那一轮手里什么工具都没有，跑了也是干等 ⇒ 直接说清楚
    if (!overlay.mcp) {
      releaseLock(layout)
      return {
        ok: false,
        code: 'no_source',
        text: '还没有信源，跑不了。这一轮既没接上 B站 的 MCP，也没有抖音的桥 —— 去设置页看看 Python 环境和登录。',
      }
    }

    const charter = readCharter(join(pluginDir, 'prompts', 'duty.md'), layout)
    if (!charter) {
      releaseLock(layout)
      return { ok: false, code: 'no_charter', text: '章程读不出来（prompts/duty.md 不在），这一轮没法跑。' }
    }

    const prompt = renderCharter(charter.text, layout, {
      why,
      extra: why === 'manual' ? `这一轮最多挑 ${Math.min(cfg.manualMax, cfg.perDay)} 条。` : '',
    })

    running = { why, startedAt: Date.now() }
    dirLog(`开始跑一轮（${why}）`)
    try {
      const res = await spawnDuty({
        dsh, profile: prof.state === 'ok' ? PROFILE_NAME : 'headless',
        overlay: overlay.ok ? overlay.file : null,
        prompt, layout, log: dirLog,
      })
      lastRun = { why, at: Date.now(), ok: res.ok, code: res.code, text: String(res.text || '').slice(0, 1200) }
      dirLog(`一轮结束：${res.ok ? '正常' : `失败（${res.code}）`}`)

      // 计数：手动/自动各记一次；挑了几条看日报
      const d2 = loadDaily(layout, dayKey()).daily
      if (why === 'manual') { d2.manualRuns += 1; d2.lastManualAt = Date.now() }
      else { d2.autoRuns += 1 }
      const after = readText(join(layout.out, `${dayKey()}.md`))
      const picks = after ? countPicks(after) : { bySource: { bili: 0, douyin: 0 } }
      d2.picked = { bili: picks.bySource.bili, douyin: picks.bySource.douyin }
      saveDaily(layout, d2)

      // 那一轮什么都没写 ⇒ 补一份占位日报（一天一份不能缺）
      if (!existsSync(join(layout.out, `${dayKey()}.md`))) {
        writeText(join(layout.out, `${dayKey()}.md`), emptyReport(dayKey()) + '\n## 总结\n\n这一轮没跑成。\n')
      }
      return { ok: res.ok, code: res.code, text: res.text, report: readReport() }
    } finally {
      running = null
      releaseLock(layout)
    }
  }

  // ── 定时器（60 秒一跳，跟 bili 一样） ────────────────────────────────────
  function tick() {
    try {
      loadCfg()
      const now = new Date()
      const { daily } = loadDaily(layout, dayKey(now))
      if (autoPickedToday(daily) >= cfg.perDay) return

      const win = autoWindowState(now, cfg)
      if (!win.ok) return

      const key = `${dayKey(now)}:${win.window || 'any'}`
      if ((daily.windowsDone || []).includes(key)) return

      daily.windowsDone = [...(daily.windowsDone || []), key]
      saveDaily(layout, daily)
      run('auto').catch((e) => dirLog(`自动轮炸了：${e?.message || e}`))
    } catch (e) {
      dirLog(`调度跳了一次：${e?.message || e}`)
    }
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(tick, 60_000)
    timer.unref?.()
    dirLog('调度器起来了（每 60 秒看一眼）')
  }
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null }
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  ensureHome()
  loadCfg()

  return {
    status, run, readReport, reportDays,
    get config() { return cfg },
    setConfig: persistCfg,
    startTimer, stopTimer, tick,
    get layout() { return layout },
    ensureHome,
    /** 给 duty 轮用的写入口（report_write / seen） */
    writeReport: async (args = {}) => {
      const day = String(args.day || dayKey()).trim()
      const file = join(layout.out, `${day}.md`)
      const incoming = String(args.text || '')
      if (!incoming.trim()) return { ok: false, text: '这次没给内容，什么都没写。' }
      const existing = readText(file) || emptyReport(day)
      const { text, added, replaced } = mergeReport(existing, incoming, day)
      writeText(file, text)
      return { ok: true, day, added, replaced, file }
    },
    appendSeen: async (args = {}) => {
      const id = String(args.id || '').trim()
      if (!id) return { ok: false, text: '没给 id。' }
      const today = dayKey()
      const parsed = parseSeen(readText(layout.seen), new Date())
      const dup = seenToday(parsed, id)
      const status = /收/.test(String(args.status || '')) ? '收' : '弃'
      if (dup && status === '收') {
        return { ok: true, day: today, id, duplicated: true, text: '今天记过这条了，没重复写。' }
      }
      const next = appendRow(readText(layout.seen) || emptySeen(), {
        section: String(args.section || '') || undefined,
        id, title: args.title, up: args.up, status, day: today,
      }, new Date())
      writeText(layout.seen, next)
      return { ok: true, day: today, id, status, file: layout.seen }
    },
    seenRecent: async (args = {}) => {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
      const id = args.id ? String(args.id).trim() : ''
      const parsed = parseSeen(readText(layout.seen), new Date())
      let rows = parsed.rows
      if (id) rows = rows.filter((r) => r.id === id)
      return { rows: rows.slice(-limit), malformed: parsed.malformed }
    },
  }
}
