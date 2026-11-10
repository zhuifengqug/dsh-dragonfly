/**
 * lib/service.mjs —— 蜻蛉的本体：状态、跑一轮、配置读写、日报读取
 * ============================================================================
 * index.js 只负责"把口子接上"（路由 / 工具 / 命令 / 定时器），所有判断都在这里。
 * 这样做的好处：这一层的每条规则都能用假 ctx + 临时目录整份测。
 * ============================================================================
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { DEFAULTS, clampConfig, diffKeys, pickKnownKeys } from './config.mjs'
import { autoWindowState, dayKey, nextWindowLabel } from './clock.mjs'
import { resolveHome, ensureDirs, layoutOf } from './paths.mjs'
import {
  acquireLock, appendLog, autoPickedToday, loadDaily,
  readJson, readLogTail, readText, releaseLock, saveDaily, writeJson, writeText,
  ensureCharter, ensureHomeFile,
} from './state.mjs'
import { SECTIONS, countPicks, emptyReport, mergeReport, reportView } from './report.mjs'
import { aihotForDay, aihotMarkdown, aihotPromptNote } from './aihot.mjs'
import { appendRow, emptySeen, parseSeen, seenToday } from './seen.mjs'
import { renderCharter, readCharter } from './charter.mjs'
import { setupPython as setupPythonEnv, pythonStatus, venvPython } from './uvfetch.mjs'
import { loginStart, loginPoll, readCredential, renderQrPng, saveCredential } from './login.mjs'
import { verifyRecent, appendVerifyToReport } from './verify.mjs'
import { diagnoseRound, oneLineVerdict } from './diagnose.mjs'
import { importFromBili, importHistory as importHistoryImpl, moveHome } from './migrate.mjs'
import {
  ensureDutyProfile, ensureOverlay, effectiveModel, readPluginCharter, resolveDsh, spawnDuty, dutyCwd, PROFILE_NAME,
  ROUND_TIMEOUT_MS,
} from './duty.mjs'
import { attachToWorkspace, listSessionIds, reconcileWorkspace, sessionDir, sessionsRoot, watchNewSession } from './workspace-link.mjs'
import { pickDutySession, saveDutySession } from './duty-session.mjs'
import { BILI_TOOLS, DY_TOOLS, LOCAL_TOOLS, dutyToolset } from './toolset.mjs'

/** 这一轮能用的工具名（不受配置影响时的全集，给测试与文档用） */
export const DUTY_BILI_TOOLS = BILI_TOOLS
export const DUTY_LOCAL_TOOLS = LOCAL_TOOLS
export const DUTY_DY_TOOLS = DY_TOOLS

/** 一个时间窗里最多自动试几次（成功才收窗）。失败不重试等于当天白丢一轮。 */
export const AUTO_TRIES_PER_WINDOW = 2

/**
 * @param {object} ctx cordis 上下文（只用到 ctx.get / ctx.effect / ctx.settings）
 * @param {{pluginDir:string, config?:object, log?:Function}} opts
 */
export function createDragonflyService(ctx, opts = {}) {
  const pluginDir = opts.pluginDir
  const log = opts.log || (() => {})
  const dirLog = (line) => { try { appendLog(layout, line) } catch { /* ignore */ } log(line) }

  let layout = resolveHome(ctx, opts.config?.outputDir)
  let cfg = clampConfig(opts.config || {}, DEFAULTS)
  let running = null          // 当前在跑的那一轮
  let lastRun = null          // 上一轮的结果（给状态用）
  let timer = null
  /**
   * 工作区服务所在的「子 fiber 上下文」。
   *
   * 为什么不能直接用主 ctx：cordis 的 `ctx.get(name)` 只在本 fiber **inject 过**的
   * 服务里找（`Fiber._store` 按 `Object.keys(this.inject)` 预填；`strict:false`
   * 只放宽激活态校验，不扩大可见范围）。我们的 inject 只有 webServer/tools/settings/commands，
   * 所以在主 ctx 上 `get('workspaceRegistry')` 永远是 undefined —— 这就是
   * 「对账逻辑在跑，但一次都没生效」的真正原因。
   *
   * index.js 会 `ctx.inject(['workspaceRegistry'], (wc) => …)` 开一个子 fiber，
   * 把它挂进这里；服务不在（headless 之类）就一直是 null，我们安静跳过。
   */
  let wsCtx = null

  // ── 家目录 ────────────────────────────────────────────────────────────────
  function ensureHome() {
    ensureDirs(layout, dirLog)
    // 见闻录：没有就铺一份两节空表
    if (!existsSync(layout.seen)) writeText(layout.seen, emptySeen())
    // 章程
    ensureCharter(join(pluginDir, 'prompts', 'duty.md'), layout, dirLog)
    // B站 MCP 服务本体：随包那份铺到家里（duty 轮起的是家里这份）
    const src = join(pluginDir, 'vendor', 'dragonfly-bili-mcp', 'server.py')
    if (existsSync(src)) {
      const r = ensureHomeFile(src, layout.mcpServer, layout, dirLog)
      if (r.state === 'failed') dirLog('铺 mcp_server.py 失败 —— B站 那一头本轮起不来')
    } else {
      dirLog('随包的 B站 MCP 服务不在（vendor/dragonfly-bili-mcp/server.py）')
    }
  }

  /** 手上有没有一个能跑的 python（配置里写了 + venv 里有一个） */
  function pythonPath() {
    const configured = String(cfg.pythonPath || '').trim()
    if (configured && existsSync(configured)) return configured
    const venv = venvPython(layout)
    if (existsSync(venv)) return venv
    return ''
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
    const picks = reportText ? countPicks(reportText) : { good: 0, total: 0, bySource: { bili: 0, douyin: 0, aihot: 0 } }
    const lock = readJson(layout.lock, null)
    const locked = Boolean(lock && Number(lock.ts) > Date.now() - 10 * 60 * 1000)

    const sources = []
    if (cfg.sources?.bili) sources.push('B站')
    if (cfg.sources?.douyin) sources.push('抖音')
    if (cfg.sources?.aihot) sources.push('AI 圈')

    const py = pythonPath()
    const cred = readCredential(layout.biliCredential)
    const aihotPart = cfg.sources?.aihot ? ` · AI 圈 ${picks.bySource.aihot}` : ''

    return {
      // 展示用一句话
      line: `今日已收 ${picks.good} 条（B站 ${picks.bySource.bili} / 抖音 ${picks.bySource.douyin}${aihotPart}）· 额度 ${cfg.perDay} · ${
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
      // 运行环境（设置页那段折起来的内容）
      runtime: {
        python: py,
        pythonReady: Boolean(py),
        biliLoggedIn: Boolean(cred?.sessdata),
        biliUid: String(cred?.dedeuserid || ''),
        dyProfile: existsSync(layout.dyProfile),
        dyUsedMinutes: Math.round((Number(daily.dySeconds || 0) / 60) * 10) / 10,
        dyDailyMinutes: Number(cfg.dyDailyMinutes ?? 0) || 0,
      },
      verdict: oneLineVerdict(lastRun, readLogTail(layout, 4000)),
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

  // ── AIHOT 那一节 ──────────────────────────────────────────────────────────
  /**
   * 把 AIHOT 那一节并进当天的日报。
   *
   * 它跟 B站/抖音 的条目不是一回事：**转述**，不挑选、不带档位、不占当天额度，
   * 也不进判重表（第二天还能再看到同一件事，那是日报，不是视频）。
   * 同一天重跑按条目 id 整条覆盖，所以不会越跑越长。
   */
  async function appendAihotSection(day = dayKey()) {
    const got = await aihotForDay({
      home: layout.home,
      day,
      mode: cfg.aihotMode,
      limit: cfg.aihotPerDay,
      log: dirLog,
    })
    if (!got.ok) return { ok: false, got }

    const lines = aihotMarkdown(got, { day })
    if (!lines.length) return { ok: true, got }

    const file = join(layout.out, `${day}.md`)
    const existing = readText(file) || emptyReport(day)
    const title = (SECTIONS.find((s) => s.key === 'aihot') || {}).title || 'AI 圈（AIHOT）'
    const incoming = `# ${day}\n\n## ${title}\n\n${lines.join('\n')}\n`
    writeText(file, mergeReport(existing, incoming, day).text)
    dirLog(`AI 圈写进日报：${got.items.length} 条（${got.mode === 'selected' ? '24h 精选' : '当天日报'}）`)
    return { ok: true, got }
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

    // 只开了 AIHOT：那一轮不需要模型、不需要 MCP，取一份写进日报就走
    const anyVideo = Boolean(cfg.sources?.bili || cfg.sources?.douyin)
    if (!anyVideo && !cfg.sources?.aihot) {
      return { ok: false, code: 'no_source', text: '三个信源都关着，这一轮没什么可看的。去设置页打开一个。' }
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

    if (!anyVideo) {
      try {
        const r = await appendAihotSection()
        const text = r.ok ? `AI 圈 ${r.got.items.length} 条。` : `AIHOT 没取到（${r.got.reason}）。`
        lastRun = { why, at: Date.now(), ok: r.ok, code: r.ok ? 0 : 'aihot', text }
        try { writeJson(layout.lastRun, lastRun) } catch { /* ignore */ }
        dirLog(`只取 AIHOT：${text}`)
        const d3 = loadDaily(layout, dayKey()).daily
        if (why === 'manual') { d3.manualRuns += 1; d3.lastManualAt = Date.now() } else { d3.autoRuns += 1 }
        saveDaily(layout, d3)
        return { ok: r.ok, code: r.ok ? 0 : 'aihot', text, report: readReport() }
      } finally {
        releaseLock(layout)
      }
    }

    const dsh = resolveDsh()
    if (dsh.missing) {
      releaseLock(layout)
      return { ok: false, code: 'no_dsh', text: dsh.hint }
    }

    const prof = ensureDutyProfile(pluginDir, dirLog)
    if (prof.state !== 'ok') dirLog(`受限 profile 不可用（${prof.state}）—— 退回普通 headless`)

    // 这一轮的名单按当前配置算：关掉的开关对应的工具**不给**（注册期生效，
    // 模型那边连 tools/list 都看不到），这比章程里写"别用"可靠。
    const toolset = dutyToolset(cfg)
    for (const s of toolset.skipped) dirLog(`这一轮不给 ${s.tool}：${s.why}`)

    const overlay = ensureOverlay(ctx, layout, { ...cfg, pythonPath: pythonPath() }, {
      log: dirLog,
      biliTools: [...toolset.bili, ...toolset.local],
      dyTools: [...toolset.dy],
      dyBridge: join(pluginDir, 'dy', 'mcp-bridge.mjs'),
    })

    // 一条 MCP 都没插上 = 那一轮手里什么工具都没有，跑了也是干等 ⇒ 直接说清楚
    if (!overlay.mcp) {
      releaseLock(layout)
      const why = (overlay.skipped || []).map((s) => s.why).filter(Boolean).join('；')
      return {
        ok: false,
        code: 'no_source',
        text: `还没有信源，跑不了。${why ? `原因：${why}。` : ''}去设置页看看 Python 环境和登录。`,
      }
    }

    const charter = readCharter(join(pluginDir, 'prompts', 'duty.md'), layout)
    if (!charter) {
      releaseLock(layout)
      return { ok: false, code: 'no_charter', text: '章程读不出来（prompts/duty.md 不在），这一轮没法跑。' }
    }

    // AI 圈那一节先落地：总结要覆盖整份日报，负责写总结的这一轮得在动笔前就看见它。
    // 取不到只记一行日志 —— 不能因为一个信息源把整轮判成失败。
    let aihotNote = ''
    if (cfg.sources?.aihot) {
      try {
        const r = await appendAihotSection()
        aihotNote = aihotPromptNote(r.ok ? r.got : { ok: false, reason: r.got?.reason })
        dirLog(`AI 圈先写进日报：${r.ok ? `${r.got?.items?.length || 0} 条` : '没取到'}`)
      } catch (e) {
        aihotNote = aihotPromptNote({ ok: false, reason: String(e?.message || e) })
        dirLog(`AI 圈没写进日报（不影响这一轮）：${e?.message || e}`)
      }
    }

    const prompt = renderCharter(charter.text, layout, {
      why,
      cfg,
      limit: why === 'manual' ? Math.min(cfg.manualMax, cfg.perDay) : cfg.perDay,
      extra: aihotNote
        ? [
          '# 今天 AI 圈（已经写进日报了，你不用去抓，下面是每条的具体内容）',
          '',
          aihotNote,
          '',
          '总结那一句要把这些也算进去 —— 总结是整份日报的收束：你挑的、扫过没收的、AI 圈这几条，',
          '各是什么事、今天整体什么味道，一次说完；不是只写你这一轮扫到的。',
        ].join('\n')
        : '',
    })

    running = { why, startedAt: Date.now() }
    dirLog(`开始跑一轮（${why}）`)

    // 工作区归属：那一轮是独立进程起的，只有 cwd、没有 workspaceId，
    // 宿主的 attachSession 永远不会被它调到 ⇒ 会话落盘的那一刻由这里认领。
    const cwd = dutyCwd(cfg, layout, dirLog)
    const root = sessionsRoot(ctx, layout.home ? dirname(layout.home) : '')
    const before = listSessionIds(root, cwd)

    // 两天一条：能接上旧会话就接，接不上（超过两天 / 文件没了 / cwd 变了）就新建
    const reuse = pickDutySession({ layout, sessionsRoot: root, cwd, today: dayKey(), log: dirLog })
    if (reuse?.id) dirLog(`接着写上一次的会话 ${reuse.id}（${reuse.why}）`)

    /** 拿到子 fiber 之前 wsCtx 是 null，这时退回主 ctx（拿不到就静默返回 no-registry） */
    const wsScope = wsCtx || ctx
    const watcher = watchNewSession({
      root, cwd, before, log: dirLog,
      // 会话目录一般在那一轮刚起就出现了；给足整轮的时长兜底，
      // 免得整点那一轮跑得久、会话其实早就有了却没认领。
      timeoutMs: ROUND_TIMEOUT_MS,
      onAppear: (id) => {
        // 新建出来的那条 = 接下来两天接着写的那条，先把 id 记下来
        if (!reuse?.id) saveDutySession(layout, { id, startedOn: dayKey() }, dirLog)
        return attachToWorkspace(wsScope, cwd, id, dirLog).then((r) => {
          // 没有工作区 / 没有注册表 = 这一轮本来就不需要归属，别在这儿空转
          if (r.reason === 'no-workspace' || r.reason === 'no-registry') return true
          if (!r.ok && r.reason !== 'already') {
            dirLog(`这一轮的会话没能挂进工作区（${r.reason}）`)
            return false // 会话头可能还没落全，下一拍再试
          }
          return true
        })
      },
    })

    try {
      const spawn = (sessionId) => spawnDuty({
        dsh, profile: prof.state === 'ok' ? PROFILE_NAME : 'headless',
        overlay: overlay.ok ? overlay.file : null,
        prompt, layout, cwd, sessionId, log: dirLog,
      })

      let res = await spawn(reuse?.id)
      // 接管失败的兜底：cwd 不符 / 会话被占 / headless 不认 —— 去掉 --session-id 重跑一次，
      // 别让一整轮白跑。新会话由上面的 watcher 认领并记进 duty-session.json。
      if (!res.ok && reuse?.id) {
        dirLog(`接不上旧的会话（退出码 ${res.code}），另起一条重跑`)
        res = await spawn(null)
      }
      lastRun = { why, at: Date.now(), ok: res.ok, code: res.code, text: String(res.text || '').slice(0, 1200) }
      try { writeJson(layout.lastRun, lastRun) } catch { /* 记不下来不影响这一轮 */ }
      dirLog(`一轮结束：${res.ok ? '正常' : `失败（${res.code}）`}`)

      // 计数：手动/自动各记一次；挑了几条看日报
      const d2 = loadDaily(layout, dayKey()).daily
      if (why === 'manual') { d2.manualRuns += 1; d2.lastManualAt = Date.now() }
      else { d2.autoRuns += 1 }
      const after = readText(join(layout.out, `${dayKey()}.md`))
      const picks = after ? countPicks(after) : { bySource: { bili: 0, douyin: 0, aihot: 0 } }
      d2.picked = { bili: picks.bySource.bili, douyin: picks.bySource.douyin, aihot: picks.bySource.aihot }
      saveDaily(layout, d2)

      // 那一轮什么都没写 ⇒ 补一份占位日报（一天一份不能缺）
      if (!existsSync(join(layout.out, `${dayKey()}.md`))) {
        writeText(join(layout.out, `${dayKey()}.md`), emptyReport(dayKey()) + '\n## 总结\n\n这一轮没跑成。\n')
      }

      // 评论复核：开了自动评论，宿主自己拉评论列表核一遍，作为独立小节追加
      // （那一轮说的"发出去了"不算数，这条是契约）
      if (cfg.autoComment && cfg.sources?.bili) {
        try {
          const vr = await reviewComments({ max: cfg.commentPerRound + 2 })
          if (vr.checked?.length) dirLog(`评论复核：${vr.checked.length} 条，已追加进日报`)
        } catch (e) { dirLog(`评论复核没做成（不影响这一轮）：${e?.message || e}`) }
      }

      return { ok: res.ok, code: res.code, text: res.text, report: readReport() }
    } finally {
      // 跑完再等一小会儿：会话文件是那一轮进程异步落盘的，
      // 进程刚退出时目录可能才刚出现（这一等最多 5 秒，不等也行）。
      try { await Promise.race([watcher.done, new Promise((r) => setTimeout(r, 5000))]) } catch { /* ignore */ }
      watcher.stop()
      running = null
      releaseLock(layout)
    }
  }

  // ── 运行时：Python、登录、抖音、诊断 ──────────────────────────────────────
  /** 设置页那个「装 Python 环境」按钮 */
  async function setupPython() {
    const req = join(pluginDir, 'vendor', 'dragonfly-bili-mcp', 'requirements.txt')
    const res = await setupPythonEnv(layout, req, { log: dirLog })
    if (res.ok && res.python) {
      // 装成了就记进配置（下次不用再猜路径）
      const r = persistCfg({ pythonPath: res.python })
      dirLog(`Python 环境就绪：${res.python}${r.changed?.length ? '（已记进配置）' : ''}`)
    }
    return res
  }

  async function pythonInfo() {
    return pythonStatus(layout)
  }

  /** 出一张登录二维码。返回 `{key, url, png}`（png 可能为 null，那就只给 url） */
  async function biliLoginStart() {
    const r = await loginStart()
    const png = await renderQrPng(pythonPath() || 'python', layout.home, r.url)
    return { ...r, png }
  }

  /** 轮询一次；成功就把凭证落到 `<家>/creds/bili-credential.json` */
  async function biliLoginPoll(key) {
    const r = await loginPoll(key)
    if (r.state === 'ok' && r.credential) {
      saveCredential(layout.biliCredential, r.credential)
      dirLog('B站 登录成功，凭证已保存')
      return { state: 'ok' }
    }
    return r
  }

  /** 现在登录的是谁（只看凭证在不在、uid 是多少；不打听别的） */
  function biliWho() {
    const c = readCredential(layout.biliCredential)
    if (!c) return { ok: false, loggedIn: false, text: '还没扫码登录。' }
    return {
      ok: true,
      loggedIn: true,
      uid: String(c.dedeuserid || ''),
      text: `已登录（UID ${c.dedeuserid || '未知'}）`,
    }
  }

  /** 评论复核：宿主自己拉评论列表核验，结果追加进日报 */
  async function reviewComments(opts = {}) {
    const cred = readCredential(layout.biliCredential)
    const r = await verifyRecent(layout, cred, { max: opts.max || 6, log: dirLog })
    if (r.checked?.length) appendVerifyToReport(layout, r.text)
    return r
  }

  /** 诊断：一句话结论 + 上一轮的细节 */
  async function diagnose() {
    const tail = readLogTail(layout, 6000)
    const d = diagnoseRound(lastRun?.text || tail)
    return {
      ok: true,
      verdict: oneLineVerdict(lastRun, tail),
      detail: d || null,
      checks: await checks(),
      lastRun,
      logTail: tail,
    }
  }

  /**
   * 诊断面板逐项：每一项都要有「现在是怎样」和「不对的话点哪儿」。
   * 只给状态不给下一步，等于让用户自己去猜 —— 那就不叫诊断了。
   */
  async function checks() {
    const out = []
    const py = pythonPath()
    // pythonStatus 要跑一次 python -V（异步），所以整段是 async 的
    const pyInfo = await pythonStatus(layout)
    const pyOk = Boolean(py) && pyInfo.venv === true
    out.push({
      key: 'python',
      label: 'Python 环境',
      ok: pyOk,
      line: pyOk
        ? `${py}${pyInfo.version ? `（${pyInfo.version}）` : ''}`
        : (py ? `配的是 ${py}，但它跑不起来` : (pyInfo.hint || '还没装')),
      hint: pyOk ? '' : (py ? '点「重装 Python 环境」。' : '点下面的「装 Python 环境」。'),
    })

    const cred = readCredential(layout.biliCredential)
    out.push({
      key: 'bili',
      label: 'B站 登录',
      ok: Boolean(cred?.sessdata),
      line: cred?.sessdata ? `已登录${cred.dedeuserid ? `（UID ${cred.dedeuserid}）` : ''}` : '还没扫码',
      hint: cred?.sessdata ? '' : '点「扫二维码登录 B站」。',
    })

    const dyProfile = existsSync(layout.dyProfile)
    out.push({
      key: 'douyin',
      label: '抖音浏览器',
      ok: dyProfile,
      line: dyProfile ? '专用浏览器已经起过（登录态在 dy/profile）' : '还没起过专用浏览器',
      hint: dyProfile ? '' : '点一次「现在就跑」，第一次会自动拉起 Edge 让你登录。',
    })

    const m = effectiveModel(ctx, cfg)
    const wantedLabel = m.explicitModel ? '配置里的' : '宿主默认的'
    out.push({
      key: 'model',
      label: '模型',
      ok: Boolean(m.provider && m.model),
      // 说的是「这一轮真会用哪个」，不是「你配置里写了什么」——
      // 两者不同的时候，光看配置会让人以为没事
      line: m.fellBack && m.wanted.provider
        ? `${m.provider} / ${m.model}（${wantedLabel} ${m.wanted.provider} / ${m.wanted.model} 在值班轮里跑不了）`
        : (m.provider && m.model ? `${m.provider} / ${m.model}` : '跟随宿主默认'),
      hint: m.fellBack && m.wanted.provider
        ? '要么清空「模型」跟着账号路由走，要么填一个值班轮里能用的。'
        : (m.provider && m.model ? '' : '留空就跟宿主走；要固定就在「模型」里选一个。'),
    })

    // 工作区：值班轮跑在哪个目录、那个目录有没有登记成工作区。
    // 这一项特意放在这儿 —— 会话在界面上"掉进未分组"时，用户没有任何办法自己看出来
    // 是路径没填、路径不是工作区、还是宿主没这个服务。
    const wsCwd = dutyCwd(cfg, layout, dirLog)
    let wsLine = `跑在 ${wsCwd}`
    let wsOk = true
    let wsHint = ''
    try {
      const registry = ctx?.get?.('workspaceRegistry') || ctx?.get?.('workspaceRegistry', false)
      if (!registry || typeof registry.resolveByPath !== 'function') {
        wsOk = false
        wsLine = '这个宿主没有工作区服务（会话会落在「未分组」）'
        wsHint = '插件照常跑，只是会话不会归到某个工作区。更新宿主版本再看。'
      } else {
        const ws = await registry.resolveByPath(wsCwd)
        if (!ws) {
          wsOk = false
          wsLine = `${wsCwd} 还没有登记成工作区`
          wsHint = '在左侧「工作区」里把这个目录加上；加完下一轮的会话就会归进去。'
        } else {
          wsLine = `${ws.record?.title ?? wsCwd}（${(ws.sessionIds || []).length} 个会话）`
        }
      }
    } catch (e) {
      wsOk = false
      wsLine = `查不了：${e?.message || e}`
      wsHint = '多半是路径还没建出来。点一次「现在就跑」，它会把目录建好。'
    }
    out.push({ key: 'workspace', label: '工作区', ok: wsOk, line: wsLine, hint: wsHint })

    // dsh 入口：以前诊断里没有这一项，链路断了在设置页完全看不出来。
    // 11-08~10 连续三天的失败就是这么被藏住的 —— 只能翻 last-run.json 才知道。
    let dshOk = true
    let dshLine = ''
    let dshHint = ''
    try {
      const d = resolveDsh()
      if (d.missing) {
        dshOk = false
        dshLine = d.hint || '找不到 dsh 入口'
        dshHint = '设 DSH_CLI 指到 dsh 的 lib/bin.js，或把 dsh 加进 PATH。'
      } else if (d.riskyShell) {
        dshOk = false
        dshLine = `只能用 shell 起 ${d.command}（章程是多行中文，过 cmd.exe 必失败）`
        dshHint = '桌面版应当自动用宿主自带的 CLI；若仍是这样，设 DSH_CLI 指到 dsh 的 lib/bin.js。'
      } else if (d.source === 'host-app') {
        dshLine = `宿主自带 CLI（${d.args[d.args.length - 1]}）`
      } else {
        dshLine = `${d.command}${(d.args || []).length ? ' ' + d.args.join(' ') : ''}`
      }
    } catch (e) {
      dshOk = false
      dshLine = `查不了：${e?.message || e}`
    }
    out.push({ key: 'dshEntry', label: 'dsh 入口', ok: dshOk, line: dshLine, hint: dshHint })

    out.push({
      key: 'lastRun',
      label: '最近一次运行',
      ok: Boolean(lastRun?.ok),
      line: lastRun ? oneLineVerdict(lastRun, '') : '还没跑过',
      hint: lastRun && !lastRun.ok ? '展开下面的日志看看。' : '',
    })

    return out
  }

  /** 从旧插件导入（首次启动会自动试一次；这个口子是给设置页手动再试的） */
  function importOld() {
    const r = importFromBili(layout, dirLog)
    if (r.state === 'imported') { loadCfg(); reloadLayout() }
    return r
  }

  /** 把旧插件的判重表 / 单片笔记 / 旧日报 / 月度归档整批补搬过来（幂等） */
  function importHistory() {
    const r = importHistoryImpl(layout, { log: dirLog })
    if (r.seenAdded) loadCfg()
    return r
  }

  /** 改存放位置（只复制配置/判重/凭证；目标非空要先 confirm） */
  function changeHome(dir, opts = {}) {
    const wanted = String(dir || '').trim()
    if (!wanted) return { ok: false, text: '没给新位置。' }
    const target = layoutOf(resolve(wanted))
    const r = moveHome(layout, target, { confirm: Boolean(opts.confirm), log: dirLog })
    if (!r.ok) return r
    // 搬家成功 ⇒ 把 outputDir 记进配置（这样下次启动就直接用新位置）
    persistCfg({ outputDir: wanted })
    reloadLayout()
    return r
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

      // 失败也吃窗口是之前的一处硬伤：11-08~10 每轮都在 1 秒内失败，
      // 窗口却被记成「已跑过」，当天不再重试，表面上就是「没自动跑」。
      // 现在改成：每个窗口最多试 AUTO_TRIES_PER_WINDOW 次，成功了才记进 windowsDone。
      const tries = { ...(daily.windowTries || {}) }
      const tried = Number(tries[key] || 0)
      if (tried >= AUTO_TRIES_PER_WINDOW) return

      tries[key] = tried + 1
      daily.windowTries = tries
      saveDaily(layout, daily)
      run('auto').then((r) => {
        if (r?.ok) {
          try {
            const d3 = loadDaily(layout, dayKey(now)).daily
            if (!(d3.windowsDone || []).includes(key)) {
              d3.windowsDone = [...(d3.windowsDone || []), key]
              saveDaily(layout, d3)
            }
            return
          } catch { /* 记不下来不影响这一轮 */ }
        }
        const left = AUTO_TRIES_PER_WINDOW - (tries[key] || 0)
        dirLog(`自动轮失败（${r?.code}），本窗口还能再试 ${Math.max(0, left)} 次`)
      }).catch((e) => dirLog(`自动轮炸了：${e?.message || e}`))
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
  // 上一轮的结果要能活过重启 —— 否则一重启就说"还没跑过"，诊断里那句就成了谎
  try { lastRun = readJson(layout.lastRun, null) } catch { lastRun = null }
  // 首次启动：从旧的 bili-duty 一次性导入（幂等；已经有痕迹就什么都不做）
  try {
    const r = importFromBili(layout, dirLog)
    if (r.state === 'imported') { loadCfg(); reloadLayout() }
  } catch (e) { dirLog(`导入旧数据时出错（跳过）：${e?.message || e}`) }

  /**
   * 开机对一次账：会话目录里有的补进工作区，记账里指向空处的摘掉。
   *
   * 单独一个口子（而不是塞在构造函数里）的原因：`workspaceRegistry` 不一定比我们早起来，
   * 调用方要按「起不来就过一会儿再试」的节奏来问，不能在这里死等。
   */
  async function reconcileWorkspaceNow() {
    const cwd = dutyCwd(cfg, layout, dirLog)
    const root = sessionsRoot(ctx, layout.home ? dirname(layout.home) : '')
    const live = listSessionIds(root, cwd)
    // 子 fiber 还没挂上就退回主 ctx（那边恒拿不到 registry，会返回 no-registry）
    return reconcileWorkspace(wsCtx || ctx, cwd, live, dirLog)
  }

  /** index.js 在 `ctx.inject(['workspaceRegistry'], …)` 里把它交进来；服务下线时传 null */
  function setWorkspaceContext(next) {
    wsCtx = next || null
  }

  /**
   * 抖音的每日分钟数账。
   * 章程里那句「最多看 N 分钟」是嘱咐，模型不一定照做；这里是宿主自己数的数。
   * `used` 读的是当天 state.json 的 `dySeconds`，`spend` 把刚花掉的秒数记回去。
   */
  function dyBudget() {
    const { daily } = loadDaily(layout, dayKey())
    return {
      limit: Number(cfg.dyDailyMinutes ?? 0) || 0,
      used: Number(daily.dySeconds || 0) || 0,
      spend: (sec) => {
        const n = Number(sec || 0)
        if (!(n > 0)) return
        const d = loadDaily(layout, dayKey()).daily
        d.dySeconds = Math.round((Number(d.dySeconds || 0) + n) * 10) / 10
        saveDaily(layout, d)
      },
    }
  }

  return {
    status, run, readReport, reportDays,
    get config() { return cfg },
    setConfig: persistCfg,
    startTimer, stopTimer, tick,
    reconcileWorkspace: reconcileWorkspaceNow,
    setWorkspaceContext,
    get layout() { return layout },
    dyBudget,
    ensureHome,
    // 运行环境与运维
    setupPython, pythonInfo, biliLoginStart, biliLoginPoll, biliWho,
    reviewComments, diagnose, importOld, importHistory, changeHome,
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
