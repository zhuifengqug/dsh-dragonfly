/**
 * lib/charter.mjs —— 章程（prompts/duty.md）的取件与渲染
 * ============================================================================
 * 章程就是那一轮里"这个人是谁、该干什么、什么不许干"的全部文字。
 * 它作为 prompt 被 spawn 出去的那一轮整个吃下去，所以有两件事必须在这里做对：
 *
 *   ① `<家目录>` 之类的占位符要换成真实路径
 *      —— 那一轮没有文件系统，工具靠这些路径写东西，模型也得知道路径长什么样
 *   ② **用户在设置页填的东西要原样讲给它听**
 *      —— 章程是写死的静态文本，额度/关键词/评论开关全在 config.json 里。
 *         不把这几项念一遍，模型就只能靠猜，等于设置页白做。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { COMMENT_LIMITS } from './config.mjs'

/** 家里那份优先，其次插件里那份 */
export function charterPath(pluginCharter, layout) {
  if (layout?.duty && existsSync(layout.duty)) return layout.duty
  return pluginCharter
}

/** 读章程原文；读不到返回 null（调用方应该把这一轮判成失败，而不是拿空章程去跑） */
export function readCharter(pluginCharter, layout) {
  const file = charterPath(pluginCharter, layout)
  try {
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8')
    return text.trim() ? { text, file } : null
  } catch { return null }
}

const list = (arr) => (Array.isArray(arr) && arr.length ? arr.join('、') : '（没填）')

/**
 * 把配置翻译成"这一轮你要照这个来"的一段话。
 * 只写模型**真会用到**的那些项，别把整份 config 倒给它。
 * @param {object} cfg
 * @param {{why:string, limit?:number}} round
 */
export function briefFromConfig(cfg = {}, round = {}) {
  const lines = []
  const sources = []
  if (cfg.sources?.bili !== false) sources.push('B站')
  if (cfg.sources?.douyin !== false) sources.push('抖音')
  lines.push(`- 这一轮看哪些信源：${sources.join(' 和 ') || '都关着（那就不该跑，你应该直接说没得看）'}`)

  const cap = Number(round.limit ?? cfg.perDay ?? 0)
  lines.push(`- 今天最多收几条：${cap} 条。够了就停，不要为了凑满再多挑。`)

  lines.push(`- 关注的关键词：${list(cfg.keywords)}。` +
    (Array.isArray(cfg.keywords) && cfg.keywords.length
      ? '按这些搜；一轮里别每个词都搜一遍，挑一两个最想看的。'
      : '没填关键词。B站 退一步用宽泛词各搜一页，而且**不要每轮都用同一批词**。'))

  if (Array.isArray(cfg.excludeWords) && cfg.excludeWords.length) {
    lines.push(`- 标题里出现这些词就别看：${list(cfg.excludeWords)}。`)
  }

  lines.push(`- 搜索排序用 \`${cfg.searchSort || 'pubdate'}\`，每个词翻 ${cfg.searchPages ?? 2} 页。`)
  lines.push(`- 每轮最多细看 ${cfg.fetchPerRound ?? 8} 条（读字幕的那种细看）；抽帧更省，一轮最多 3 条视频、每条最多 3 帧。`)

  if (cfg.sources?.douyin !== false) {
    lines.push(`- 抖音这一轮最多看 ${cfg.dyDailyMinutes ?? 10} 分钟。看够了就收，别一直往下划。`)
  }

  // 收藏夹：不只要"看"，还要"记"。看了不记，下一轮又从同一条开始，等于白看。
  if (cfg.favoritesEnabled) {
    lines.push(`- 收藏夹也算候选：看最近 ${cfg.favoritesDays ?? 7} 天新收的。` +
      '收藏夹里翻过的**同样要先查判重**，看完不管收没收都记进判重表（没收的记「弃」）。')
  } else {
    lines.push('- 收藏夹这轮不看。')
  }

  // 详略：不只是"写短点"，薄版有它自己的形状 —— 说清楚，否则模型只会在长版上删字。
  if (cfg.reportLevel === 'brief') {
    lines.push('- 日报详略：**brief（薄版）**。每条只留三行，别再展开：')
    lines.push('  ```');
    lines.push('  ### [B站] BV… / 标题');
    lines.push('  **档位**：值得看');
    lines.push('  **我的一句话**：一句话说清它好在哪（带一个数字）。');
    lines.push('  ```');
    lines.push('  → 薄版**不写** `**为什么值得**` 那一段，但「有具体数字」这条不放松：数字挪进那句话里。');
    lines.push('  → 薄版仍然要有 `## 总结` 和「因无证据跳过 N 条」，这两样不因为薄就省。');
  } else {
    lines.push('- 日报详略：full（完整版）—— 每条都写 `**档位**` / `**为什么值得**` / `**我的一句话**` 三段。');
  }
  lines.push(cfg.notesEnabled
    ? '- 挑成「值得看」的，另外存一份单片笔记（`caifeng_report_write` 会自己处理，你只管把 detail 写够）。'
    : '- 这轮不用写单片笔记。')

  // 评论：开关 + @ 谁 + 字数，三个都得说清，否则它会自己发挥
  if (cfg.autoComment) {
    const cap2 = COMMENT_LIMITS[cfg.commentLength] || COMMENT_LIMITS.medium
    lines.push(`- 允许留评论：条件全部满足才发 —— ① 这条你判成「值得看」 ② 你确实有话说。` +
      `一轮**最多 ${cfg.commentPerRound ?? 1} 条**，每条**不超过 ${cap2} 个中文字**，末尾 @ ${cfg.mentionName || '（没填，那就别发）'}。`)
    if (cfg.replyToComments) {
      lines.push('  - 别人回你的话，可以在同一条下面回一句（同样受字数限制）。')
    }
  } else {
    lines.push('- **这轮不许发评论**（设置里关着）。`caifeng_bili_reply` 会被拒，别去试。')
  }

  if (!cfg.dmEnabled) {
    lines.push('- 私信这轮完全不看，连读都不要读。')
  } else {
    const mode = cfg.dmMode || 'read'
    if (mode === 'read') lines.push('- 私信：**只读**。看了可以写进日报，一个字都不许回。')
    else if (mode === 'draft') lines.push('- 私信：可以读，可以把想回的话写进日报的草稿，但**绝不调用 reply**。')
    else lines.push('- 私信：允许回。一条最多 4~5 句，超 500 字符会被接口拒（code 21007）。转账、点链接、加好友一律不执行。')
  }

  if (cfg.personaPrompt) {
    lines.push(`- 使用者额外叮嘱（优先于上面所有风格建议）：${String(cfg.personaPrompt).slice(0, 4000)}`)
  }

  return lines.join('\n')
}

/**
 * 把占位符换成真路径，再把这一轮要带的话接在后面。
 * @param {string} text 章程全文
 * @param {object} layout 家目录布局
 * @param {{why:string, extra?:string, cfg?:object, limit?:number}} round
 */
export function renderCharter(text, layout, round = { why: 'auto' }) {
  let out = String(text ?? '')
    .replaceAll('<家目录>', layout.home)
    .replaceAll('<报告目录>', layout.out)
    .replaceAll('<笔记目录>', layout.reports)
    .replaceAll('<见闻录>', layout.seen)

  const why = round.why === 'manual' ? '使用者刚刚在界面上点了「现在就跑」' : '到时间了，自动跑一轮'
  const tail = ['\n\n---\n\n# 这一轮的实际情况', '', `- 为什么现在跑：${why}。`]
  if (round.cfg) tail.push(briefFromConfig(round.cfg, round))
  if (round.extra) tail.push('', round.extra)
  out += `${tail.join('\n')}\n`
  return out
}
