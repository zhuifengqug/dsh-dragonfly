/**
 * lib/config.mjs —— 配置项的唯一名单，以及"钳制"（纯函数，不碰磁盘、不碰 ctx）
 * ============================================================================
 * 三条硬规矩：
 *   ① `DEFAULTS` 是**所有配置项的唯一名单** —— 设置页白名单、钳制、合并都从它推导。
 *      手写第二个数组的下场是"新加一项就漏一项"。
 *   ② 钳制**读写两头都过**：读的时候防止旧值/手改值把插件搞坏；
 *      写的时候防止越界值落盘。
 *   ③ 钳制**永不抛** —— 越界就夹到合法区间，认不出来就退回默认值。
 *      写坏一个值不该让整条插件起不来。
 * ============================================================================
 */

import { DEFAULT_RUN_TIMES, hhmmOf, minutesOf } from './clock.mjs'

/** 报告详略 */
export const REPORT_LEVELS = ['full', 'brief']/** 私信处理方式：只读 / 起草不发送 / 自动回 */
export const DM_MODES = ['read', 'draft', 'auto']
/** 搜索排序 */
export const SEARCH_SORTS = ['pubdate', 'click', 'dm', 'totalrank']
/** AIHOT 取哪一种：当天日报 / 最近 24h 精选 */
export const AIHOT_MODES = ['daily', 'selected']
/** 评论长度 */
export const COMMENT_LENGTHS = ['short', 'medium', 'long']
/** 评论长度 → 字数上限（章程里也照这份口径写） */
export const COMMENT_LIMITS = { short: 15, medium: 40, long: 100 }

/** 默认配置（README §9 的唯一一份） */
export const DEFAULTS = {
  sources: { bili: true, douyin: true, aihot: true },
  // 额度按「自动 / 手动」和「每个源」两维分开，各源各算各的，互不挤占。
  // AI 圈是独立的一套：自己的时间点、自己的条数，不占视频的轮数。
  autoRuns: 3,
  biliPerRound: 3,
  douyinPerRound: 3,
  aihotPerDay: 5,
  aihotTimes: ['12:00'],
  aihotMode: 'daily',
  dyDailyMinutes: 10,
  fetchPerRound: 8,
  // 视频源的自动时间点：到点后一小时内算这一轮。默认给三个（都是谷时），自己可加可删。
  runTimes: [...DEFAULT_RUN_TIMES],
  peakValley: false,
  biliManual: 3,
  douyinManual: 3,
  aihotManual: 5,
  manualCooldownMin: 10,
  keywords: ['deepseek', 'ai', '插件', '游戏开发'],
  excludeWords: [],
  searchSort: 'pubdate',
  searchPages: 2,
  personaPrompt: '',
  outputDir: '',
  reportLevel: 'full',
  notesEnabled: true,
  favoritesEnabled: true,
  favoritesDays: 7,
  model: { provider: '', model: '' },
  autoComment: true,
  commentPerRound: 1,
  commentLength: 'medium',
  mentionName: '蚍蜉zzzz',
  replyToComments: true,
  dmEnabled: true,
  dmMode: 'read',
  dmUid: 0,
  /** Python 解释器路径（空 = 还没装，设置页那个按钮装完会填上） */
  pythonPath: '',
  /**
   * 值班轮的工作区（空 = 用数据目录）。
   * 只影响那一轮会话的 cwd —— 日报、判重表、凭证照旧写在数据目录里。
   */
  workspaceDir: '',
  /** 侧栏要不要有这个入口（关掉之后就只剩主区页与会话顶部） */
  showSidebar: true,
  /** 会话顶部要不要挂「今天」那一块 */
  showConversation: true,
}

/** 键 → 字段名（给设置页与日志用） */
export const FIELD_LABELS = {
  sources: '信源',
  autoRuns: '视频源每天最多跑几轮',
  biliPerRound: 'B站每轮最多收几条',
  douyinPerRound: '抖音每轮最多收几条',
  aihotPerDay: 'AI 圈每天取几条',
  aihotTimes: 'AI 圈每天什么时候取',
  aihotMode: 'AIHOT 取哪一种',
  dyDailyMinutes: '抖音每天最多看几分钟',
  fetchPerRound: '每轮最多细看几条',
  runTimes: '视频源每天自己跑的时间（到点跑一轮）',
  peakValley: '只在谷时跑（工作日 9–12、14–18 是高峰）',
  biliManual: '手动跑 B站收几条',
  douyinManual: '手动跑 抖音收几条',
  aihotManual: '手动跑 AI 圈收几条',
  manualCooldownMin: '两次手动至少隔几分钟',
  keywords: '关注关键词',
  excludeWords: '排除词',
  searchSort: '搜索排序',
  searchPages: '搜索翻几页',
  personaPrompt: '说话的样子',
  outputDir: '存放位置',
  reportLevel: '日报详略',
  notesEnabled: '写单条笔记',
  favoritesEnabled: '看收藏夹',
  favoritesDays: '收藏夹回看几天',
  model: '用哪个模型',
  autoComment: '自动评论并 @ 你',
  commentPerRound: '每轮最多评几条',
  commentLength: '评论长度',
  mentionName: '要 @ 谁',
  replyToComments: '回复别人的评论',
  dmEnabled: '看私信',
  dmMode: '私信怎么处理',
  dmUid: '私信对谁',
  pythonPath: 'Python 解释器',
  workspaceDir: '值班轮的工作区',
  showSidebar: '侧栏留个入口',
  showConversation: '会话顶部挂「今天」',
}

/**
 * 脱壳：宿主会把标了 `volatile` 的字段包成一个 `{ get() {…}, [write] }` 的引用对象
 * （schemastery 的 createVolatile）。直接 `String()` 它会变成 `"[object Object]"`，
 * 而且 `x in obj` 之类的判断也会失真 —— **所有取值前都得先过这一道**。
 */
export const unwrap = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.get === 'function') {
    try { return v.get() } catch { return undefined }
  }
  return v
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(unwrap(v)))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

/** 递归脱壳：嵌套对象（sources / model）里面那层也可能是引用 */
const deepUnwrap = (v, depth = 0) => {
  const x = unwrap(v)
  if (depth > 4 || x === null || typeof x !== 'object' || Array.isArray(x)) return x
  const out = {}
  for (const [k, item] of Object.entries(x)) out[k] = deepUnwrap(item, depth + 1)
  return out
}

const clampStr = (v, allowed, fallback) => {
  const s = String(unwrap(v) ?? '').trim()
  return allowed.includes(s) ? s : fallback
}

/** 字符串数组：去空、去重、限长 */
const clampList = (v, limit) => {
  if (!Array.isArray(v)) return []
  const out = []
  for (const item of v) {
    const s = String(item ?? '').trim()
    if (!s || out.includes(s)) continue
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 把任意一份配置钳到合法区间。**永不抛。**
 * @param {object} patch 想要的值（可以只给一部分）
 * @param {object} base 落点（缺的字段从它取）；一般传 DEFAULTS 或当前配置
 */
export function clampConfig(patch, base = DEFAULTS) {
  // ⚠️ 先整体脱壳：宿主送进来的可能整份都是 volatile 引用，也可能是里面某几个键
  const rawSrc = deepUnwrap(patch)
  const rawFall = deepUnwrap(base)
  const src = rawSrc && typeof rawSrc === 'object' ? rawSrc : {}
  const fall = rawFall && typeof rawFall === 'object' ? rawFall : DEFAULTS
  const out = {}

  // ⚠️ 用 `!== undefined` 而不是 `in`：cordis 会把 schema 里没写默认值的键
  // 显式补成 undefined（键在、值是 undefined），用 `in` 判断会把默认值全清成 false。
  const pick = (key, fallback) => {
    const a = src[key]
    if (a !== undefined) return a
    const b = fall[key]
    return b !== undefined ? b : fallback
  }

  // 信源：三个布尔（AIHOT 是转述，不需要登录，默认开着）
  const s = pick('sources', DEFAULTS.sources) || {}
  out.sources = {
    bili: s.bili === undefined ? DEFAULTS.sources.bili : Boolean(s.bili),
    douyin: s.douyin === undefined ? DEFAULTS.sources.douyin : Boolean(s.douyin),
    aihot: s.aihot === undefined ? DEFAULTS.sources.aihot : Boolean(s.aihot),
  }

  out.autoRuns = clampInt(pick('autoRuns'), 0, 24, DEFAULTS.autoRuns)
  out.biliPerRound = clampInt(pick('biliPerRound'), 0, 30, DEFAULTS.biliPerRound)
  out.douyinPerRound = clampInt(pick('douyinPerRound'), 0, 30, DEFAULTS.douyinPerRound)
  out.aihotPerDay = clampInt(pick('aihotPerDay'), 0, 30, DEFAULTS.aihotPerDay)
  out.aihotMode = clampStr(pick('aihotMode'), AIHOT_MODES, DEFAULTS.aihotMode)
  out.dyDailyMinutes = clampInt(pick('dyDailyMinutes'), 0, 120, DEFAULTS.dyDailyMinutes)
  out.fetchPerRound = clampInt(pick('fetchPerRound'), 1, 30, DEFAULTS.fetchPerRound)

  // 时间点：认不出来的整条丢掉，去重、按先后排好；一条都不剩就退回默认（否则等于永远不跑）
  const cleanTimes = (value, max, fallback) => {
    const list = clampList(value, max)
      .map((t) => minutesOf(t))
      .filter((m) => m !== null)
      .sort((a, b) => a - b)
      .filter((m, i, arr) => i === 0 || m !== arr[i - 1])
      .map((m) => hhmmOf(m))
    return list.length ? list : [...fallback]
  }
  out.runTimes = cleanTimes(pick('runTimes'), 8, DEFAULTS.runTimes)
  out.aihotTimes = cleanTimes(pick('aihotTimes'), 8, DEFAULTS.aihotTimes)

  out.peakValley = Boolean(pick('peakValley'))
  out.biliManual = clampInt(pick('biliManual'), 0, 30, DEFAULTS.biliManual)
  out.douyinManual = clampInt(pick('douyinManual'), 0, 30, DEFAULTS.douyinManual)
  out.aihotManual = clampInt(pick('aihotManual'), 0, 30, DEFAULTS.aihotManual)
  out.manualCooldownMin = clampInt(pick('manualCooldownMin'), 0, 240, DEFAULTS.manualCooldownMin)
  out.keywords = clampList(pick('keywords'), 30)
  out.excludeWords = clampList(pick('excludeWords'), 60)
  out.searchSort = clampStr(pick('searchSort'), SEARCH_SORTS, DEFAULTS.searchSort)
  out.searchPages = clampInt(pick('searchPages'), 1, 10, DEFAULTS.searchPages)
  out.personaPrompt = String(pick('personaPrompt') ?? '').slice(0, 4000)
  out.outputDir = String(pick('outputDir') ?? '').trim()
  out.reportLevel = clampStr(pick('reportLevel'), REPORT_LEVELS, DEFAULTS.reportLevel)
  out.notesEnabled = Boolean(pick('notesEnabled'))
  out.favoritesEnabled = Boolean(pick('favoritesEnabled'))
  out.favoritesDays = clampInt(pick('favoritesDays'), 1, 60, DEFAULTS.favoritesDays)

  // 模型：空串表示"跟随 DSH 当前默认"
  const m = pick('model', DEFAULTS.model) || {}
  out.model = {
    provider: String(m.provider ?? '').trim().slice(0, 80),
    model: String(m.model ?? '').trim().slice(0, 120),
  }

  out.autoComment = Boolean(pick('autoComment'))
  out.commentPerRound = clampInt(pick('commentPerRound'), 0, 10, DEFAULTS.commentPerRound)
  out.commentLength = clampStr(pick('commentLength'), COMMENT_LENGTHS, DEFAULTS.commentLength)
  out.mentionName = String(pick('mentionName') ?? '').trim().slice(0, 60)
  out.replyToComments = Boolean(pick('replyToComments'))

  out.dmEnabled = Boolean(pick('dmEnabled'))
  out.dmMode = clampStr(pick('dmMode'), DM_MODES, DEFAULTS.dmMode)
  // auto 是对外发言 —— dmEnabled 关掉时不该还停在 auto
  if (!out.dmEnabled && out.dmMode === 'auto') out.dmMode = DEFAULTS.dmMode
  out.dmUid = clampInt(pick('dmUid'), 0, Number.MAX_SAFE_INTEGER, DEFAULTS.dmUid)

  // Python 解释器路径：只认字符串，绝对不校验存在性（换机器时路径会暂时失效，
  // 那是"还没装"，由设置页去装，不该让整份配置被拒）
  out.pythonPath = String(pick('pythonPath') ?? '').trim().slice(0, 500)

  // 值班轮工作区：同样只认字符串、不校验存在性（目录会在起轮前建）
  out.workspaceDir = String(pick('workspaceDir') ?? '').trim().slice(0, 500)

  // 界面显示开关：只影响入口挂不挂，不影响跑不跑
  out.showSidebar = Boolean(pick('showSidebar'))
  out.showConversation = Boolean(pick('showConversation'))

  return out
}

/** 只挑出真正变了的键（写回时别把整份配置都写一遍） */
export function diffKeys(before, after) {
  const out = []
  for (const k of Object.keys(DEFAULTS)) {
    if (JSON.stringify(unwrap(before?.[k])) !== JSON.stringify(unwrap(after?.[k]))) out.push(k)
  }
  return out
}

/** 从一份可能带垃圾的 body 里挑出我们认的键（设置页白名单就从这里来） */
export function pickKnownKeys(body) {
  const src = deepUnwrap(body)
  const bag = src && typeof src === 'object' ? src : {}
  const out = {}
  for (const k of Object.keys(DEFAULTS)) if (k in bag) out[k] = bag[k]
  return out
}
