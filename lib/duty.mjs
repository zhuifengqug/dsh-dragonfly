/**
 * lib/duty.mjs —— 值班轮：受限 profile、overlay、spawn 那一轮、锁与单飞
 * ============================================================================
 * 一轮 = 起一个**独立的 dsh 子进程**：
 *
 *   dsh --profile dragonfly-duty --patch <家目录>/headless-overlay.yml "<章程全文>"
 *
 * 为什么要独立进程而不是 subagent：
 *   · 那一轮的权限面靠 profile 收口（关掉 bash/fs/web/subagent/skill…），subagent 关不掉
 *   · 那一轮的工具面靠 overlay 插的 MCP 提供，宿主 ctx.tools 对子进程根本不可见
 *   · cwd 必须是家目录（那一轮被沙箱关着，只能用这个目录）
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, cpSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

import { unwrap } from './config.mjs'

export const PROFILE_NAME = 'dragonfly-duty'

/**
 * 受限 profile 里唯一免密钥能跑通的路由。
 * deepseek-official 要 DEEPSEEK_API_KEY，pi-ai 各家要 providers 配置，受限 profile 里都没有。
 */
export const ACCOUNT_PROVIDER = 'deepseek-account'
export const ACCOUNT_MODEL = 'deepseek-flash'
/** 一轮最多跑多久（超时就杀） */
export const ROUND_TIMEOUT_MS = 30 * 60 * 1000

/** dsh 的 home（profile 都在这儿） */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** YAML 单引号字面量（2026-10-23 安全审计要求：所有路径都走这个） */
const yq = (v) => `'${String(v).replace(/'/g, "''")}'`
/** Windows 反斜杠在 YAML 里不特殊，但统一成 / 更省心 */
const posix = (p) => String(p).replace(/\\/g, '/')

/**
 * 把受限 profile 装到 `<DSH_HOME>/profiles/dragonfly-duty`。
 * 三态：ok / missing（模板没随包）/ failed（拷贝炸了）
 */
export function ensureDutyProfile(pluginDir, log = () => {}) {
  const src = join(pluginDir, 'profile-template', PROFILE_NAME)
  const dir = join(dshHome(), 'profiles', PROFILE_NAME)
  try {
    if (!existsSync(join(src, 'package.json'))) {
      log(`受限 profile 模板不在（${src}）—— 这一轮退回普通 headless`)
      return { state: 'missing', dir }
    }
    mkdirSync(dir, { recursive: true })
    // 你自己往这个 profile 里加过东西就留个备份再覆盖 —— 模板是仓库的，别让你的改动无声消失。
    // （模型提供方不用写在这儿：overlay 每轮跟着桌面 profile 同步，见 hostProvidersBlock）
    const live = join(dir, 'cordis.patch.yml')
    const tpl = join(src, 'cordis.patch.yml')
    try {
      if (existsSync(live) && existsSync(tpl) && readFileSync(live, 'utf8') !== readFileSync(tpl, 'utf8')) {
        const bak = `${live}.bak-${Date.now()}`
        writeFileSync(bak, readFileSync(live, 'utf8'), 'utf8')
        log(`受限 profile 被改过，先备份到 ${bak} 再按模板覆盖`)
      }
    } catch { /* 备份失败不挡装 profile */ }
    cpSync(src, dir, { recursive: true, force: true })
    return { state: 'ok', dir }
  } catch (e) {
    log(`受限 profile 装不上（${e?.message || e}）—— 这一轮退回普通 headless`)
    return { state: 'failed', dir, detail: String(e?.message || e) }
  }
}

/** 从一份 patch YAML 里整块切出某个 id 的条目（从 `- id: X` 到下一个顶层 `- `） */
export function extractPatchBlock(text, id) {
  const all = String(text || '').split(/\r?\n/)
  const start = all.findIndex((l) => l.trim() === `- id: ${id}`)
  if (start < 0) return null
  let end = all.length
  for (let i = start + 1; i < all.length; i += 1) {
    if (/^- /.test(all[i])) { end = i; break }
  }
  const out = all.slice(start, end)
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out.length ? out : null
}

/**
 * 桌面 profile 里 `llm-pi-ai` 的 providers 块。
 * ============================================================================
 * 为什么要有它：值班轮跑在独立的受限 profile 里，那里的 `llm-pi-ai` 是空的 ——
 * 你在桌面加的那些 provider（a6 / magpie / bye…）它一个都看不见，于是
 * `NO_ADAPTER: no adapter registered for provider "a6"`。
 * 所以每轮把桌面那份 providers 原样搬进 overlay：桌面加什么，值班轮就能用什么，
 * 不用再往受限 profile 里手抄一遍（那份文件每轮都会被模板覆盖）。
 * ============================================================================
 */
export function hostProvidersBlock(home = dshHome()) {
  const base = join(home, 'profiles')
  let names = []
  try {
    names = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return null
  }
  const prefer = String(process.env.DSH_PROFILE || '').trim()
  names.sort((a, b) => (a === prefer ? -1 : b === prefer ? 1 : 0))
  for (const name of names) {
    if (name === PROFILE_NAME) continue
    let text = ''
    try { text = readFileSync(join(base, name, 'cordis.patch.yml'), 'utf8') } catch { continue }
    const block = extractPatchBlock(text, 'llm-pi-ai')
    if (block && /providers:/.test(block.join('\n'))) return { profile: name, lines: block }
  }
  return null
}

/**
 * 这一轮到底用哪个模型。
 * ============================================================================
 * 单独抽出来是因为它有两个读者：写 overlay 的那段（真要用），和设置页的诊断
 * （要如实告诉人「你那个默认在值班轮里跑不了，实际走的是账号路由」）。
 * 两处各写一遍必然漂移 —— 诊断说"好的"，那一轮却 MISSING_CREDENTIAL。
 *
 * 规则：
 *   · 配置里填了 provider + model ⇒ 用它（与宿主默认相同时把 reasoningEffort 带上）
 *   · 没填 ⇒ 跟宿主当前默认
 *   · 但受限 profile 里只有 deepseek-account 免密钥能跑，所以"跟随"来的别的路由要换掉
 * ============================================================================
 */
export function effectiveModel(ctx, cfg) {
  const cfgModel = unwrap(cfg?.model) || {}
  let provider = String(unwrap(cfgModel.provider) || '').trim()
  let model = String(unwrap(cfgModel.model) || '').trim()
  let reasoning = ''
  const explicitModel = Boolean(provider && model)

  let sel = null
  try { sel = ctx.get?.('agentDefaultModel')?.currentSelection?.() || null } catch { /* 取不到就留空 */ }

  if (!explicitModel) {
    provider = provider || String(unwrap(sel?.provider) || unwrap(sel?.providerId) || '')
    model = model || String(unwrap(sel?.model) || unwrap(sel?.modelId) || '')
    reasoning = String(unwrap(sel?.reasoningEffort) || '')
  } else {
    const selProvider = String(unwrap(sel?.provider) || unwrap(sel?.providerId) || '')
    const selModel = String(unwrap(sel?.model) || unwrap(sel?.modelId) || '')
    if (selProvider === provider && selModel === model) {
      reasoning = String(unwrap(sel?.reasoningEffort) || '')
    }
  }
  // 兜底：真的什么都取不到时，别写出一个必定报 MISSING_CREDENTIAL 的假值
  if (provider === '[object Object]') provider = ''
  if (model === '[object Object]') model = ''

  const wanted = { provider, model }
  let fellBack = false
  if (!explicitModel && provider && provider !== ACCOUNT_PROVIDER) {
    provider = ACCOUNT_PROVIDER
    model = ACCOUNT_MODEL
    reasoning = ''
    fellBack = true
  }
  if (!provider || !model) {
    provider = ACCOUNT_PROVIDER
    model = ACCOUNT_MODEL
    reasoning = ''
    fellBack = true
  }

  return { provider, model, reasoning, explicitModel, wanted, fellBack }
}

/**
 * 写 overlay。三件事，缺一个那一轮就跑不起来：
 *   ① 补开 credentials / authorization / deepseek-account（headless 自带 patch 把它们关了）
 *   ② 按当前默认模型写 agent-default-model（不写就 MISSING_CREDENTIAL）
 *   ③ 插 MCP —— 这一轮的工具面全靠它
 */
export function ensureOverlay(ctx, layout, cfg, opts = {}) {
  const log = opts.log || (() => {})
  const lines = [
    '# 由 @zhuifengqug/dsh-dragonfly 自动生成，每次跑一轮都重写',
    '# 别手改：下一条自动跑就没了。要改配置去设置页。',
    '',
  ]

  // ① 补开三个服务
  for (const id of ['credentials', 'authorization', 'deepseek-account']) {
    lines.push('- id: ' + id, '  disabled: false')
  }
  lines.push('')

  // ② 模型：规则在 effectiveModel 里（设置页的诊断也读同一个函数，免得两处说法不一致）
  // ⚠️ cfg 可能是宿主给的 volatile 引用（{get()}），effectiveModel 内部已 unwrap
  const m = effectiveModel(ctx, cfg)
  const { provider, model, reasoning } = m
  if (m.fellBack && m.wanted.provider) {
    log(`overlay：桌面默认模型是 ${m.wanted.provider}/${m.wanted.model || '（空）'}，值班轮里没有它的凭证或适配器 —— 改用账号路由 ${provider}/${model}（要固定用别的模型，去设置页填）`)
  }

  if (provider && model) {
    lines.push('- id: agent-default-model', '  config:', `    provider: ${yq(provider)}`, `    model: ${yq(model)}`)
    if (reasoning) lines.push(`    reasoningEffort: ${yq(reasoning)}`)
    lines.push('')
  } else {
    log('overlay：拿不到当前默认模型，agent-default-model 没写 —— 那一轮可能报 MISSING_CREDENTIAL')
  }

  // ②b 模型提供方：桌面 profile 里有哪些 provider，值班轮就有哪些
  const hostProviders = hostProvidersBlock()
  if (hostProviders) {
    lines.push(`# 模型提供方跟着桌面 profile（${hostProviders.profile}）走，你那边加什么这里就有什么`, ...hostProviders.lines, '')
  } else {
    log('overlay：桌面 profile 里没找到 llm-pi-ai 的 providers —— 这一轮只有账号路由可选')
  }

  // ③ MCP：两条，各自成败隔离
  const inserts = []
  const skipped = []          // 没插上的原因（给状态与日报用，别让"没有信源"变成谜）
  const wantBili = cfg?.sources?.bili !== false
  if (wantBili) {
    if (!existsSync(layout.mcpServer)) skipped.push({ source: 'bili', why: 'B站 MCP 服务没铺到家里' })
    else if (!cfg?.pythonPath) skipped.push({ source: 'bili', why: '还没装 Python 环境（设置页里装一下）' })
    else {
      const tools = opts.biliTools || []
      inserts.push([
        '    - id: mcp-dragonfly-bili',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: dragonfly-bili',
        '        transport: stdio',
        `        command: ${yq(posix(cfg.pythonPath))}`,
        '        args:',
        `          - ${yq(posix(layout.mcpServer))}`,
        `        env:`,
        `          DRAGONFLY_HOME: ${yq(posix(layout.home))}`,
        `          DRAGONFLY_BILI_TOOLS: ${yq(tools.join(','))}`,
        // 单片笔记的开关也要下发 —— Python 那边不读 config.json（两份真源），
        // 设置页关掉「写单条笔记」时这里给 0，模型就算硬塞 detail 也不落盘。
        `          DRAGONFLY_NOTES: ${yq(cfg?.notesEnabled === false ? '0' : '1')}`,
      ])
    }
  }
  if (cfg?.sources?.douyin !== false) {
    if (!opts.dyBridge || !existsSync(opts.dyBridge)) skipped.push({ source: 'douyin', why: '抖音桥不在包里' })
    else {
      // ⚠️ 不能直接用 process.execPath：桌面版里那是 DeepSeek Harness.exe（Electron），
      //    当 node 跑 .mjs 会炸在 require-builtin 的 napi 指纹上。要用真 node。
      const node = resolveNode()
      const needsElectronFlag = /electron/i.test(node) || (node === process.execPath && Boolean(process.versions.electron))
      inserts.push([
        '    - id: mcp-dragonfly-dy',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: dragonfly-dy',
        '        transport: stdio',
        `        command: ${yq(posix(node))}`,
        '        args:',
        `          - ${yq(posix(opts.dyBridge))}`,
        `        env:`,
        `          DRAGONFLY_HOME: ${yq(posix(layout.home))}`,
        `          DRAGONFLY_TOOLS: ${yq((opts.dyTools || []).join(','))}`,
        ...(needsElectronFlag ? [`          ELECTRON_RUN_AS_NODE: '1'`] : []),
      ])
    }
  }
  if (inserts.length) {
    lines.push('- insert:')
    for (const block of inserts) lines.push(...block)
    lines.push('')
  } else {
    log(`overlay：一条 MCP 都没插上 —— ${skipped.map((s) => s.why).join('；') || '没有信源工具'}，这一轮只能干等`)
  }

  const text = lines.join('\n')
  try {
    writeFileSync(layout.overlay, text, 'utf8')
    return { ok: true, file: layout.overlay, mcp: inserts.length, skipped }
  } catch (e) {
    log(`overlay 写不进去（${e?.message || e}）`)
    return { ok: false, file: layout.overlay, mcp: 0, skipped, detail: String(e?.message || e) }
  }
}

/**
 * 运行中宿主自带的 CLI —— 桌面版唯一的「版本一定对得上」的入口。
 *
 * 桌面版把 dsh 打包在应用目录里（`resources/app` 或 `resources/app.asar`），
 * 入口是 `dsh-desktop-host/lib/cli.js`，必须用宿主自己的 exe 起：
 *
 *   DeepSeek Harness.exe --expose-internals <cli.js> …（env ELECTRON_RUN_AS_NODE=1）
 *
 * 这正是 `resources/runtime/cli/bin/dsh.cmd` 里做的事，但那层 .cmd 会带进
 * `shell:true`（见 resolveDsh 的警告）。这里直接拿 exe + argv，绕开 cmd。
 *
 * 非桌面宿主（plain node、POSIX 上的服务端）没有这一档，返回空数组。
 * 抽成独立函数是为了能单测：路径拼错、顺序错都能在测试里立刻看出来。
 */
export function dshEntryCandidates(exeDir = dirname(process.execPath || '')) {
  const exe = String(process.execPath || '')
  if (!exe || !/\.exe$/i.test(exe)) return []
  const res = join(exeDir, 'resources')
  const entries = [
    // 桥装版（mantis 之类会铺出 resources/app）优先：它和运行时真正在跑的那份是同一个
    join(res, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    join(res, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    // 原装安装（只有 app.asar）
    join(res, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
  ]
  const out = []
  for (const entry of entries) {
    let ok = false
    try { ok = existsSync(entry) } catch { ok = false }
    if (!ok) continue
    out.push({
      command: exe,
      args: ['--expose-internals', entry],
      shell: false,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'host-app',
    })
  }
  return out
}

/**
 * 章程能不能安全地经 `shell:true` 传过去。
 *
 * cmd.exe 会吃掉引号、换行和百分号 —— 章程是一万多字节的多行中文，
 * 过一遍 cmd 必然变成「命令语法不正确」（2026-11 实测，正是那一轮失败的原因）。
 * 所以只要入口是 shell，就必须在这里拦住，别等子进程报一句看不懂的话。
 */
export function promptThroughShellUnsafe(prompt) {
  const s = String(prompt ?? '')
  if (s.length > 260) return true
  return /[\r\n"^%&|<>]/.test(s)
}

/**
 * 找 dsh 的入口。绝不静默返回 'dsh' —— 找不到就是找不到，要能说清为什么。
 *
 * ⚠️ 优先找 **`bin.js`（一个 node 脚本）而不是 `dsh.cmd`**：
 *    走 .cmd 必须 `shell:true`，而章程是一大段多行中文，经 cmd.exe 一过
 *    引号/换行/百分号全被吃掉，那一轮直接"参数格式不正确"退出（实测过）。
 *    拿到 bin.js 就能 `node bin.js …` 直接起子进程，prompt 原样递过去。
 *
 * 顺序：DSH_CLI（人手工指定）→ 宿主自带 CLI → npm 包 → PATH（只能走 shell）。
 */
export function resolveDsh() {
  const explicit = String(process.env.DSH_CLI || '').trim()
  if (explicit && existsSync(explicit)) return asDsh(explicit)

  // ① 宿主自己的 CLI：版本一定与运行中的宿主一致，shell:false
  const bundled = dshEntryCandidates()
  if (bundled.length) return bundled[0]

  // ② 让 Node 的解析器替我们找（web profile / 桌面版 app 目录，两条路都可能命中）
  try {
    const req = createRequire(import.meta.url)
    for (const spec of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']) {
      try {
        const p = req.resolve(spec)
        if (p && existsSync(p)) return asDsh(p)
      } catch { /* 换下一个 */ }
    }
  } catch { /* 解析器不可用就跳过 */ }

  // ③ npm 全局 / POSIX 常见位置
  const known = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(process.env.ProgramFiles || '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter(Boolean)
  for (const p of known) if (existsSync(p)) return asDsh(p)

  // ④ 兜底：PATH 里的 dsh（只能走 shell，prompt 长了会出事 —— 见 promptThroughShellUnsafe）
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat'] : ['']
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = join(dir, `dsh${ext}`)
      if (existsSync(file)) return { command: file, args: [], shell: true, riskyShell: true }
    }
  }

  return { missing: true, hint: '没找到 dsh。装一下 dsh，或者设一个 DSH_CLI 指到它的 bin.js。' }
}

/**
 * 找一个**真正的 node**。
 *
 * ⚠️ 桌面版里 `process.execPath` 是 `DeepSeek Harness.exe`（Electron）。拿它 + 
 *    `ELECTRON_RUN_AS_NODE=1` 去起 `@deepseek-ai/dsh/lib/bin.js` 会炸在
 *    `Unsupported/no-context`（require-builtin 的 napi 指纹不认这个 Electron 版本）。
 *    所以这里必须找一个独立安装的 node。
 */
export function resolveNode() {
  const explicit = String(process.env.DRAGONFLY_NODE || process.env.DSH_NODE || '').trim()
  if (explicit && existsSync(explicit)) return explicit

  // 不在 Electron 里跑，自己就是 node，直接用
  if (!process.versions.electron) return process.execPath

  // 在 Electron 里：PATH 上找 node（注意跳过错指到 electron 的那些）
  const exts = process.platform === 'win32' ? ['.exe'] : ['']
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = join(dir, `node${ext}`)
      try { if (existsSync(file) && !/electron/i.test(file)) return file } catch { /* 下一个 */ }
    }
  }
  // 常见安装位置
  const known = [
    join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'nodejs', 'node.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean)
  for (const p of known) if (existsSync(p)) return p

  // 都没有就退回自己（会失败，但至少错误信息是真实的）
  return process.execPath
}

/** 把「一个 .js/.mjs 入口」翻成「拿 node 起它」；别的当成可执行文件直接用 */
function asDsh(file) {
  if (/\.(c|m)?js$/i.test(file)) {
    const node = resolveNode()
    // 上面 resolveNode 可能还是回到了 electron —— 那种情况才补 ELECTRON_RUN_AS_NODE
    const needsElectronFlag = /electron/i.test(node) || node === process.execPath && Boolean(process.versions.electron)
    return {
      command: node,
      args: [file],
      shell: false,
      ...(needsElectronFlag ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
    }
  }
  return { command: file, args: [], shell: /\.(cmd|bat)$/i.test(file) }
}

/**
 * 那一轮用哪个目录当工作区。
 *
 * 为什么要有这个：会话的工作区就是它的 cwd，而 cwd 默认是**数据目录**
 * （`$DSH_HOME/dragonfly`）—— 那个路径没在应用里注册成工作区，
 * 所以会话列表里看它「没有工作区」。
 *
 * 只有填了绝对路径才认（相对路径会跟着宿主进程的 cwd 漂，等于没填）；
 * 目录不存在就先建出来 —— spawn 一个不存在的 cwd 会直接 ENOENT。
 */
export function dutyCwd(cfg, layout, log = () => {}) {
  const wanted = String(unwrap(cfg?.workspaceDir) ?? '').trim()
  if (!wanted || !isAbsolute(wanted)) return layout.home
  try {
    if (!existsSync(wanted)) mkdirSync(wanted, { recursive: true })
  } catch (e) {
    log(`工作区目录建不出来（${wanted}）：${e?.message || e}，这一轮退回数据目录`)
    return layout.home
  }
  return wanted
}

/**
 * 起一轮。返回结构化的结果，绝不抛（那一轮的失败要写进日志，而不是把宿主搞崩）。
 *
 * `sessionId` 给了就走 `--session-id`，让 headless 接管那条已有会话接着写
 * （两天一条就是靠这个：同一个 id 连着跑两天，第三天换新的）。
 */
export function spawnDuty({ dsh, profile, overlay, prompt, layout, cwd, sessionId, env, log = () => {} }) {
  return new Promise((resolve) => {
    // 入口只剩 dsh.cmd 这种的时候，章程过不了 cmd.exe —— 与其让子进程报「命令语法不正确」，
    // 不如在这里把话说清楚（2026-11-08~10 那一串失败就是这么来的）。
    if (dsh.shell && promptThroughShellUnsafe(prompt)) {
      return resolve({
        ok: false,
        code: 'no_safe_dsh',
        text: '找不到能安全传参的 dsh 入口：只剩 shell 可用的 ' + String(dsh.command)
          + '，而章程是多行中文，经 cmd.exe 会被吃掉引号/换行，必然失败。\n'
          + '桌面版应当自动用宿主自带的 CLI；若仍是这条，设 DSH_CLI 指到 dsh 的 lib/bin.js。',
      })
    }
    const args = [...dsh.args, '--profile', profile]
    if (overlay) args.push('--patch', overlay)
    if (sessionId) args.push('--session-id', String(sessionId))
    args.push(prompt)

    let child
    try {
      child = spawn(dsh.command, args, {
        cwd: cwd || layout.home,
        windowsHide: true,
        shell: Boolean(dsh.shell),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          DRAGONFLY_HOME: layout.home,
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...(dsh.env || {}),
          ...env,
        },
      })
    } catch (e) {
      return resolve({ ok: false, code: 'spawn_failed', text: `起不来：${e?.message || e}` })
    }

    const out = []
    const err = []
    const cap = (arr, chunk) => {
      arr.push(chunk.toString())
      if (arr.join('').length > 200_000) arr.splice(0, arr.length, arr.join('').slice(-80_000))
    }
    child.stdout?.on('data', (c) => cap(out, c))
    child.stderr?.on('data', (c) => cap(err, c))

    const timer = setTimeout(() => {
      log(`一轮超时（${Math.round(ROUND_TIMEOUT_MS / 60000)} 分钟），杀掉`)
      try { child.kill() } catch { /* ignore */ }
    }, ROUND_TIMEOUT_MS)
    timer.unref?.()

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: 'spawn_failed', text: `起不来：${e?.message || e}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const tail = [...out, ...err].join('').trim()
      if (code === 0) return resolve({ ok: true, code: 0, text: tail.slice(-4000) })
      resolve({ ok: false, code, text: `那一轮以 ${code} 退出。\n${tail.slice(-2000)}` })
    })
  })
}

/** 读插件里随包的章程 */
export function readPluginCharter(pluginDir) {
  const file = join(pluginDir, 'prompts', 'duty.md')
  try { return existsSync(file) ? readFileSync(file, 'utf8') : null } catch { return null }
}
