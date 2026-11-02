/**
 * lib/toolset.mjs —— 值班轮这一轮到底能拿到哪些工具（纯函数）
 * ============================================================================
 * 为什么单列一个模块：**"能拿到什么工具"本身就是一条业务规则**，不是常量。
 *
 *   · 自动评论开没开、@ 谁填没填 → 决定 `caifeng_bili_reply` 在不在名单里
 *   · 私信整体关没关        → 决定 `caifeng_bili_dm` 在不在名单里
 *   · 收藏夹关没关          → 决定 `caifeng_bili_favorites` 在不在名单里
 *   · 信源关没关            → 决定整条 MCP 都不插
 *
 * 名单是**在注册期**生效的（Python 侧 `_ALLOWED` 只注册名单里的函数），
 * 所以名单外的工具连 `tools/list` 都不出现 —— 模型那边等于根本不存在。
 * 这比在章程里写"别用"可靠得多。
 *
 * 纯函数 ⇒ 四种组合可以在测试里一次跑完，不用起进程。
 * ============================================================================
 */

/** B站 那一头的 7 个（能不能真正全拿到还要看下面的条件） */
export const BILI_TOOLS = [
  'caifeng_bili_search',
  'caifeng_bili_subtitle',
  'caifeng_bili_comments',
  'caifeng_bili_frames',
  'caifeng_bili_favorites',
  'caifeng_bili_reply',
  'caifeng_bili_dm',
]

/** 本地写口：无论什么配置都得有，否则那一轮写不出任何东西 */
export const LOCAL_TOOLS = ['caifeng_report_write', 'caifeng_seen']

/** 抖音那 4 个 */
export const DY_TOOLS = ['caifeng_dy_open', 'caifeng_dy_state', 'caifeng_dy_next', 'caifeng_dy_frames']

/** 只在读的时候用的那几个：不往 B站 写东西，条件满足就给 */
const BILI_READ = [
  'caifeng_bili_search',
  'caifeng_bili_subtitle',
  'caifeng_bili_comments',
  'caifeng_bili_frames',
]

/**
 * 评论的双条件是硬的：**开关开着，并且填了要 @ 谁**，两条都满足才给 reply 工具。
 * 缺一条就不给 —— 章程里那句"别发"是嘱咐，名单里没有才是闸门。
 */
export function canComment(cfg = {}) {
  return Boolean(cfg.autoComment) && String(cfg.mentionName ?? '').trim().length > 0
}

/**
 * @param {object} cfg 已经 clamp 过的配置
 * @returns {{bili:string[], local:string[], dy:string[], skipped:Array<{tool:string, why:string}>}}
 */
export function dutyToolset(cfg = {}) {
  const bili = []
  const dy = []
  const skipped = []

  const wantBili = cfg.sources?.bili !== false
  if (!wantBili) {
    skipped.push({ tool: 'caifeng_bili_*', why: 'B站 信源关着' })
  } else {
    bili.push(...BILI_READ)

    if (cfg.favoritesEnabled === false) {
      skipped.push({ tool: 'caifeng_bili_favorites', why: '收藏夹关着' })
    } else {
      bili.push('caifeng_bili_favorites')
    }

    if (!cfg.autoComment) {
      skipped.push({ tool: 'caifeng_bili_reply', why: '自动评论关着' })
    } else if (!String(cfg.mentionName ?? '').trim()) {
      skipped.push({ tool: 'caifeng_bili_reply', why: '没填要 @ 谁' })
    } else {
      bili.push('caifeng_bili_reply')
    }

    if (cfg.dmEnabled === false) {
      skipped.push({ tool: 'caifeng_bili_dm', why: '私信关着' })
    } else {
      bili.push('caifeng_bili_dm')
    }
  }

  if (cfg.sources?.douyin === false) {
    skipped.push({ tool: 'caifeng_dy_*', why: '抖音信源关着' })
  } else {
    dy.push(...DY_TOOLS)
  }

  return { bili, local: [...LOCAL_TOOLS], dy, skipped }
}
