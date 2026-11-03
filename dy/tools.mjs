/**
 * dy/tools.mjs —— 4 个动作的实现，给宿主的 HTTP 路由调
 * ============================================================================
 * 契约只有一条：**永不抛**。每个函数都返回可 JSON 序列化的对象，失败就是
 * `{ ok:false, reason, hint }`。上层（HTTP 路由 / MCP 桥 / duty 子进程里的模型）
 * 靠 reason 决定下一步，靠 hint 说话给人听。
 *
 * controller 是注入进来的，方便测试拿假对象顶替 —— 这个文件不许自己 new
 * BrowserController，也不许自己读环境变量。
 * ============================================================================
 */
import { HOME_URL, searchUrl, normalizeSeconds } from './core.mjs'

/** 统一的失败形状 */
const failure = (reason, hint, extra = {}) => ({ ok: false, reason, hint, ...extra })

/**
 * 把 controller 抛出来的东西翻译成人话。
 * controller 自己抛的是带 `.reason/.hint` 的 Error（见 core.mjs 的 browserFailure）；
 * 裸 Error 就当未知故障，但别把栈甩给模型。
 */
function translate(error) {
  if (error && typeof error === 'object' && typeof error.reason === 'string') {
    return failure(error.reason, error.hint || String(error.message || error.reason))
  }
  const detail = String(error?.message || error || '未知错误').slice(0, 500)
  return failure('tool-failed', `抖音这一手没走通：${detail}`)
}

/** 包一层：保证永不抛 */
async function guard(task) {
  try {
    return await task()
  } catch (error) {
    return translate(error)
  }
}

const isController = (controller) =>
  controller && typeof controller === 'object' && typeof controller.state === 'function'

const noController = () =>
  failure('no-controller', '抖音浏览器控制器还没接上（宿主侧没注入 controller）。这属于部署问题，不是页面问题。')

/**
 * open({query}) —— 首页或搜索结果页。
 * 无 query ⇒ https://www.douyin.com/
 * 有 query ⇒ https://www.douyin.com/search/<encodeURIComponent(query)>
 */
export async function open({ query, controller } = {}) {
  return guard(async () => {
    if (!isController(controller)) return noController()
    const text = typeof query === 'string' ? query.trim() : ''
    const target = text ? searchUrl(text) : HOME_URL
    const navigated = await controller.navigate(target)
    let state = await controller.state()
    // 推荐流落到直播卡上是常态（那种卡没有作品 id，读不出标题时长）。
    // 这里替它往下划一张，别让那一轮直接抱着「读不出东西」收工。
    let skipped = null
    if (!text && (state?.pageKind === 'live-preview' || state?.pageKind === 'unknown')) {
      const moved = await controller.switchVideo(1).catch(() => null)
      if (moved?.changed && moved.state) {
        state = moved.state
        skipped = 'live-preview'
      }
    }
    return {
      ok: true,
      query: text || null,
      url: navigated?.url ?? target,
      skipped,
      state,
    }
  })
}

/** state() —— 就一件事：读当前页状态 */
export async function state({ controller } = {}) {
  return guard(async () => {
    if (!isController(controller)) return noController()
    const snapshot = await controller.state()
    if (snapshot?.unsupportedPage) {
      return failure(
        'unsupported-page',
        '当前专用标签页不在抖音上，读不到内容。先用 caifeng_dy_open 打开首页或搜索页。',
        { state: snapshot },
      )
    }
    return { ok: true, state: snapshot }
  })
}

/** next() —— 换下一条（推荐流往后刷） */
export async function next({ controller } = {}) {
  return guard(async () => {
    if (!isController(controller)) return noController()
    let result = await controller.switchVideo(1)
    let after = result?.state ?? (await controller.state())
    if (!result?.changed) {
      return failure(
        result?.reasonCode || 'switch-not-confirmed',
        '这一下没换到下一条（可能页面停在登录/验证，或者根本不是能上下滑的流）。',
        { state: after, before: result?.before ?? null },
      )
    }
    // 换到直播卡上了：那种卡没有作品 id，留着等于这一手白给 —— 再划一张
    let hopped = 0
    while (after?.pageKind === 'live-preview' && hopped < 2) {
      const again = await controller.switchVideo(1)
      hopped += 1
      if (!again?.changed) break
      result = again
      after = again.state ?? (await controller.state())
    }
    return { ok: true, state: after, before: result?.before ?? null, via: result?.via ?? null, hopped }
  })
}

/**
 * frames({seconds}) —— 截几张当前画面。
 * seconds 只决定「采几张」（1-10 张，间隔离散），不是「拍多少秒视频」。
 */
export async function frames({ seconds, controller } = {}) {
  return guard(async () => {
    if (!isController(controller)) return noController()
    const count = normalizeSeconds(seconds)
    const captured = await controller.capture({ seconds: count })
    if (!captured?.ok) {
      return failure(
        captured?.reason || 'no-frame',
        captured?.hint || '这一轮没截到画面。',
        { images: [], videoId: captured?.videoId ?? null, duration: captured?.duration ?? null },
      )
    }
    const images = Array.isArray(captured.images)
      ? captured.images
        .filter((image) => image && typeof image.data === 'string' && image.data)
        .map((image) => ({ data: image.data, mimeType: image.mimeType || 'image/jpeg' }))
      : []
    if (!images.length && typeof captured.dataBase64 === 'string' && captured.dataBase64) {
      images.push({ data: captured.dataBase64, mimeType: captured.mimeType || 'image/jpeg' })
    }
    return {
      ok: true,
      images,
      videoId: captured.videoId ?? null,
      duration: captured.duration ?? null,
    }
  })
}

/** 给宿主 HTTP 路由用的一张表：`/api/caifeng/dy/<action>` 直接查 */
export const DY_ACTIONS = Object.freeze({ open, state, next, frames })

/** MCP 桥也用这张表判断「这个名字认不认」 */
export const DY_TOOL_NAMES = Object.freeze(Object.keys(DY_ACTIONS))
