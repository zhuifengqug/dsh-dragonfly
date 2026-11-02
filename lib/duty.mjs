/**
 * lib/duty.mjs —— 值班轮：受限 profile、overlay、spawn 那一轮、锁与单飞
 * ============================================================================
 * 一轮 = 起一个**独立的 dsh 子进程**：
 *
 *   dsh --profile caifeng-duty --patch <家目录>/headless-overlay.yml "<章程全文>"
 *
 * 为什么要独立进程而不是 subagent：
 *   · 那一轮的权限面靠 profile 收口（关掉 bash/fs/web/subagent/skill…），subagent 关不掉
 *   · 那一轮的工具面靠 overlay 插的 MCP 提供，宿主 ctx.tools 对子进程根本不可见
 *   · cwd 必须是家目录（那一轮被沙箱关着，只能用这个目录）
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import { unwrap } from './config.mjs'

export const PROFILE_NAME = 'caifeng-duty'
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
 * 把受限 profile 装到 `<DSH_HOME>/profiles/caifeng-duty`。
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
    cpSync(src, dir, { recursive: true, force: true })
    return { state: 'ok', dir }
  } catch (e) {
    log(`受限 profile 装不上（${e?.message || e}）—— 这一轮退回普通 headless`)
    return { state: 'failed', dir, detail: String(e?.message || e) }
  }
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
    '# 由 @zhuifengqug/dsh-tianshu-caifeng 自动生成，每次跑一轮都重写',
    '# 别手改：下一条自动跑就没了。要改配置去设置页。',
    '',
  ]

  // ① 补开三个服务
  for (const id of ['credentials', 'authorization', 'deepseek-account']) {
    lines.push('- id: ' + id, '  disabled: false')
  }
  lines.push('')

  // ② 模型：配置里指定了就用配置的，否则跟随宿主当前默认
  // ⚠️ cfg 可能是宿主给的 volatile 引用（{get()}），直接 String() 会写出 '[object Object]'
  const cfgModel = unwrap(cfg?.model) || {}
  let provider = String(unwrap(cfgModel.provider) || '').trim()
  let model = String(unwrap(cfgModel.model) || '').trim()
  let reasoning = ''
  const explicitModel = Boolean(provider && model)
  if (!explicitModel) {
    try {
      const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      provider = provider || String(unwrap(sel?.provider) || unwrap(sel?.providerId) || '')
      model = model || String(unwrap(sel?.model) || unwrap(sel?.modelId) || '')
      reasoning = String(unwrap(sel?.reasoningEffort) || '')
    } catch { /* 取不到就留空，让 profile 自己决定 */ }
  }
  // 兜底：真的什么都取不到时，别写出一个必定报 MISSING_CREDENTIAL 的假值
  if (provider === '[object Object]') provider = ''
  if (model === '[object Object]') model = ''

  // ⚠️ 值班轮 profile 里只有 deepseek-account 这条路能免密钥跑通：
  //    deepseek-official 要 DEEPSEEK_API_KEY，pi-ai 各家要 providers 配置，
  //    而这些在受限 profile 里都没有。用户没显式指定时，别把桌面那个默认模型照抄过来
  //    —— 照抄的结果是每轮都 MISSING_CREDENTIAL / no adapter registered。
  const ACCOUNT_PROVIDER = 'deepseek-account'
  const ACCOUNT_MODEL = 'deepseek-flash'
  if (!explicitModel && provider && provider !== ACCOUNT_PROVIDER) {
    log(`overlay：桌面默认模型是 ${provider}/${model}，值班轮里没有它的凭证或适配器 —— 改用账号路由 ${ACCOUNT_PROVIDER}/${ACCOUNT_MODEL}（要固定用别的模型，去设置页填）`)
    provider = ACCOUNT_PROVIDER
    model = ACCOUNT_MODEL
    reasoning = ''
  }
  if (!provider || !model) {
    provider = ACCOUNT_PROVIDER
    model = ACCOUNT_MODEL
    reasoning = ''
  }

  if (provider && model) {
    lines.push('- id: agent-default-model', '  config:', `    provider: ${yq(provider)}`, `    model: ${yq(model)}`)
    if (reasoning) lines.push(`    reasoningEffort: ${yq(reasoning)}`)
    lines.push('')
  } else {
    log('overlay：拿不到当前默认模型，agent-default-model 没写 —— 那一轮可能报 MISSING_CREDENTIAL')
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
        '    - id: mcp-caifeng-bili',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: caifeng-bili',
        '        transport: stdio',
        `        command: ${yq(posix(cfg.pythonPath))}`,
        '        args:',
        `          - ${yq(posix(layout.mcpServer))}`,
        `        env:`,
        `          CAIFENG_HOME: ${yq(posix(layout.home))}`,
        `          CAIFENG_BILI_TOOLS: ${yq(tools.join(','))}`,
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
        '    - id: mcp-caifeng-dy',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: caifeng-dy',
        '        transport: stdio',
        `        command: ${yq(posix(node))}`,
        '        args:',
        `          - ${yq(posix(opts.dyBridge))}`,
        `        env:`,
        `          CAIFENG_HOME: ${yq(posix(layout.home))}`,
        `          CAIFENG_TOOLS: ${yq((opts.dyTools || []).join(','))}`,
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
 * 找 dsh 的入口。绝不静默返回 'dsh' —— 找不到就是找不到，要能说清为什么。
 *
 * ⚠️ 优先找 **`bin.js`（一个 node 脚本）而不是 `dsh.cmd`**：
 *    走 .cmd 必须 `shell:true`，而章程是一大段多行中文，经 cmd.exe 一过
 *    引号/换行/百分号全被吃掉，那一轮直接"参数格式不正确"退出（实测过）。
 *    拿到 bin.js 就能 `node bin.js …` 直接起子进程，prompt 原样递过去。
 */
export function resolveDsh() {
  const explicit = String(process.env.DSH_CLI || '').trim()
  if (explicit && existsSync(explicit)) return asDsh(explicit)

  // ① 让 Node 的解析器替我们找（web profile / 桌面版 app 目录，两条路都可能命中）
  try {
    const req = createRequire(import.meta.url)
    for (const spec of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']) {
      try {
        const p = req.resolve(spec)
        if (p && existsSync(p)) return asDsh(p)
      } catch { /* 换下一个 */ }
    }
  } catch { /* 解析器不可用就跳过 */ }

  // ② npm 全局 / POSIX 常见位置
  const known = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(process.env.ProgramFiles || '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter(Boolean)
  for (const p of known) if (existsSync(p)) return asDsh(p)

  // ③ 兜底：PATH 里的 dsh（只能走 shell，prompt 长了会出事，记一笔日志）
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
  const explicit = String(process.env.CAIFENG_NODE || process.env.DSH_NODE || '').trim()
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

/** 起一轮。返回结构化的结果，绝不抛（那一轮的失败要写进日志，而不是把宿主搞崩） */
export function spawnDuty({ dsh, profile, overlay, prompt, layout, env, log = () => {} }) {
  return new Promise((resolve) => {
    const args = [...dsh.args, '--profile', profile]
    if (overlay) args.push('--patch', overlay)
    args.push(prompt)

    let child
    try {
      child = spawn(dsh.command, args, {
        cwd: layout.home,
        windowsHide: true,
        shell: Boolean(dsh.shell),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          CAIFENG_HOME: layout.home,
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
