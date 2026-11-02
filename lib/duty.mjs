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
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

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
  let provider = String(cfg?.model?.provider || '').trim()
  let model = String(cfg?.model?.model || '').trim()
  let reasoning = ''
  if (!provider || !model) {
    try {
      const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      provider = provider || String(sel?.provider || sel?.providerId || '')
      model = model || String(sel?.model || sel?.modelId || '')
      reasoning = String(sel?.reasoningEffort || '')
    } catch { /* 取不到就留空，让 profile 自己决定 */ }
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
      inserts.push([
        '    - id: mcp-caifeng-dy',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: caifeng-dy',
        '        transport: stdio',
        `        command: ${yq(posix(process.execPath))}`,
        '        args:',
        `          - ${yq(posix(opts.dyBridge))}`,
        `        env:`,
        `          CAIFENG_HOME: ${yq(posix(layout.home))}`,
        `          CAIFENG_TOOLS: ${yq((opts.dyTools || []).join(','))}`,
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

/** 找 dsh CLI。绝不静默返回 'dsh' —— 找不到就是找不到，要能说清为什么。 */
export function resolveDsh() {
  const fromEnv = process.env.DSH_CLI
  if (fromEnv && existsSync(fromEnv)) return { command: fromEnv, args: [], shell: /\.cmd$/i.test(fromEnv) }

  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat'] : ['']
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = join(dir, `dsh${ext}`)
      if (existsSync(file)) return { command: file, args: [], shell: /\.(cmd|bat)$/i.test(file) }
    }
  }
  return { missing: true, hint: '没找到 dsh 命令。装一下 dsh 或者设一个 DSH_CLI 指到它的路径。' }
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
