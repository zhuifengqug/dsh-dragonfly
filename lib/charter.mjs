/**
 * lib/charter.mjs —— 章程（prompts/duty.md）的取件与渲染
 * ============================================================================
 * 章程就是那一轮里"这个人是谁、该干什么、什么不许干"的全部文字。
 * 它作为 prompt 被 spawn 出去的那一轮整个吃下去，所以：
 *   · `<家目录>` 是一个占位符，必须替换成真实路径（模型没有文件系统，只能靠这些路径写东西）
 *   · 家目录里有用户改过的版本，优先用家里那份
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'

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

/**
 * 把占位符换成真路径，再把这一轮要带的话接在后面。
 * @param {string} text 章程全文
 * @param {object} layout 家目录布局
 * @param {{why:string, extra?:string}} round 这一轮为什么跑、要不要额外叮嘱
 */
export function renderCharter(text, layout, round = { why: 'auto' }) {
  let out = String(text ?? '')
    .replaceAll('<家目录>', layout.home)
    .replaceAll('<报告目录>', layout.out)
    .replaceAll('<笔记目录>', layout.reports)
    .replaceAll('<见闻录>', layout.seen)

  const why = round.why === 'manual' ? '使用者刚刚在界面上点了「现在就跑」' : '到时间了，自动跑一轮'
  const tail = [`\n\n---\n\n这一轮的情况：${why}。`]
  if (round.extra) tail.push('', round.extra)
  out += tail.join('\n')
  return out
}
