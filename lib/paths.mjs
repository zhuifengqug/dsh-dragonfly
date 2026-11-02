/**
 * lib/paths.mjs —— 这个插件住在哪里、家里都有什么
 * ============================================================================
 * 规矩（跟 bili 那边一致）：**配置、凭证、报告、日志都放插件自己的家**
 * （默认 `$DSH_HOME/tianshu-caifeng/`），**绝不写进插件包目录** ——
 * 装进 node_modules 后可能只读、升级也会被覆盖。
 *
 * ⭐ 唯一的例外是「使用者改了存放位置」：`config.json` 里的 `outputDir` 一旦非空，
 *    家就整体搬到那里去。搬家的规则写在 README §5（只复制配置 / 判重 / 凭证）。
 * ============================================================================
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

/** 家目录的默认名字（$DSH_HOME 下面那一层） */
export const HOME_DIR_NAME = 'tianshu-caifeng'

/**
 * 默认家目录。
 *
 * ⚠️ `ctx.get('dshHomePath')` 返回的是**函数**不是字符串
 * （`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`）。
 * 当字符串用会让路径变成「函数源码 + \tianshu-caifeng」⇒ mkdir ENOENT ⇒ 整条插件不激活。
 */
export function defaultHome(ctx) {
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p(HOME_DIR_NAME)
      if (v) return String(v)
    } else if (typeof p === 'string' && p) {
      return join(p, HOME_DIR_NAME)
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), HOME_DIR_NAME)
}

/** 家目录下的固定布局（纯函数：给 root 就出全套路径，不碰磁盘） */
export function layoutOf(root) {
  const home = resolve(String(root))
  return {
    home,
    config: join(home, 'config.json'),
    localOverride: join(home, 'local-override.json'),
    seen: join(home, 'seen.md'),
    seenDir: join(home, 'seen'),
    out: join(home, 'out'),
    reports: join(home, 'reports'),
    duty: join(home, 'duty.md'),
    charterSha: join(home, 'charter.sha256'),
    log: join(home, 'duty.log'),
    lock: join(home, 'run-lock.json'),
    creds: join(home, 'creds'),
    biliCredential: join(home, 'creds', 'bili-credential.json'),
    mcpServer: join(home, 'mcp_server.py'),
    venv: join(home, '.venv'),
    overlay: join(home, 'headless-overlay.yml'),
    dy: join(home, 'dy'),
    dyProfile: join(home, 'dy', 'profile'),
    dyControl: join(home, 'dy', 'control'),
    state: join(home, 'state.json'),
  }
}

/** 使用者填的存放位置（空 = 用默认家）。相对路径**不认**，一律当没填。 */
export function resolveHome(ctx, outputDir) {
  const wanted = String(outputDir || '').trim()
  if (wanted && isAbsolute(wanted)) return layoutOf(wanted)
  return layoutOf(defaultHome(ctx))
}

/** 把家里该有的目录铺出来（幂等，字段缺失不会抛） */
export function ensureDirs(layout, log = () => {}) {
  for (const dir of [layout.home, layout.out, layout.reports, layout.creds, layout.seenDir, layout.dy]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch (e) {
      log(`建目录失败 ${dir}：${e?.message ?? e}`)
    }
  }
  return layout
}
