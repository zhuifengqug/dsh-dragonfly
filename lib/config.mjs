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

/** 报告详略 */
export const REPORT_LEVELS = ['full', 'brief']
/** 私信处理方式：只读 / 起草不发送 / 自动回 */
export const DM_MODES = ['read', 'draft', 'auto']
/** 搜索排序 */
export const SEARCH_SORTS = ['pubdate', 'click', 'dm', 'totalrank']
/** 评论长度 */
export const COMMENT_LENGTHS = ['short', 'medium', 'long']
/** 评论长度 → 字数上限（章程里也照这份口径写） */
export const COMMENT_LIMITS = { short: 15, medium: 40, long: 100 }

/** 默认配置（README §9 的唯一一份） */
export const DEFAULTS = {
  sources: { bili: true, douyin: true },
  perDay: 5,
  dyDailyMinutes: 10,
  fetchPerRound: 8,
  windows: ['00:00-24:00'],
  peakValley: true,
  noon: true,
  night: true,
  manualMax: 3,
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
}

/** 键 → 字段名（给设置页与日志用） */
export const FIELD_LABELS = {
  sources: '信源',
  perDay: '每天最多挑几条',
  dyDailyMinutes: '抖音每天最多看几分钟',
  fetchPerRound: '每轮最多细看几条',
  windows: '允许自动跑的时间窗',
  peakValley: '只在谷时跑',
  noon: '中午谷时',
  night: '晚上谷时',
  manualMax: '手动跑最多挑几条',
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
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

const clampStr = (v, allowed, fallback) => {
  const s = String(v ?? '').trim()
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
  const src = patch && typeof patch === 'object' ? patch : {}
  const fall = base && typeof base === 'object' ? base : DEFAULTS
  const out = {}

  const pick = (key, fallback) => (key in src ? src[key] : (key in fall ? fall[key] : fallback))

  // 信源：只认两个布尔
  const s = pick('sources', DEFAULTS.sources) || {}
  out.sources = {
    bili: s.bili === undefined ? DEFAULTS.sources.bili : Boolean(s.bili),
    douyin: s.douyin === undefined ? DEFAULTS.sources.douyin : Boolean(s.douyin),
  }

  out.perDay = clampInt(pick('perDay'), 0, 30, DEFAULTS.perDay)
  out.dyDailyMinutes = clampInt(pick('dyDailyMinutes'), 0, 120, DEFAULTS.dyDailyMinutes)
  out.fetchPerRound = clampInt(pick('fetchPerRound'), 1, 30, DEFAULTS.fetchPerRound)

  // 时间窗：认不出来的整条丢掉；一条都不剩就退回默认（否则等于永远不跑）
  const wins = clampList(pick('windows'), 6).filter((w) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(w))
  out.windows = wins.length ? wins : [...DEFAULTS.windows]

  out.peakValley = Boolean(pick('peakValley'))
  out.noon = Boolean(pick('noon'))
  out.night = Boolean(pick('night'))
  out.manualMax = clampInt(pick('manualMax'), 0, 20, DEFAULTS.manualMax)
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

  return out
}

/** 只挑出真正变了的键（写回时别把整份配置都写一遍） */
export function diffKeys(before, after) {
  const out = []
  for (const k of Object.keys(DEFAULTS)) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) out.push(k)
  }
  return out
}

/** 从一份可能带垃圾的 body 里挑出我们认的键（设置页白名单就从这里来） */
export function pickKnownKeys(body) {
  const src = body && typeof body === 'object' ? body : {}
  const out = {}
  for (const k of Object.keys(DEFAULTS)) if (k in src) out[k] = src[k]
  return out
}
