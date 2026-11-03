/**
 * dy/core.mjs —— BrowserController：连浏览器、开页、读状态、换视频、截图
 * ============================================================================
 * 分工：`browser-host.mjs` 负责「摆一台专用 Edge 出来」，这个文件负责「在里面干活」。
 * 我们只做四件事：打开、读状态、换一条、截几张。写评论 / 私信 / 点赞一概不做。
 *
 * ⚠️ 页面内那段 `readPageState` **必须整体当字符串注入**（参考实现就是这么做的）：
 *    它要被序列化送进页面执行，闭包里的任何变量都不会跟过去 —— 所以它只能是
 *    一个自包含的函数源码。选择器照抄参考实现，别自己发明。
 * ============================================================================
 */
import { controlPaths, readPortRecord, ensureBrowser, loadPlaywright } from './browser-host.mjs'

/** 我们标记自己页面的写法：只操作 window.name 等于它的那张 */
export const DY_PAGE_NAME = 'caifeng-dy'

/** 抖音的合法原点（离开它就当「不是我们的页面」处理） */
const DOUYIN_ORIGIN = 'https://www.douyin.com'

/**
 * 推荐流首页。
 * ⚠️ 必须是带 `recommend=1` 的这个地址：裸 `https://www.douyin.com/` 会被跳到
 *    `/jingxuan`（精选页），那页没有 feed 卡片、也没有能上下滑的作品流 —— 读出来
 *    只能是 unknown。参考实现用的就是这一条。
 */
export const HOME_URL = 'https://www.douyin.com/?recommend=1&from_nav=1'
export const searchUrl = (query) => `${DOUYIN_ORIGIN}/search/${encodeURIComponent(String(query ?? ''))}`

/** 截图采样间隔（离散阶梯：张数一多就自动收紧，避免一轮跑太久） */
export const SAMPLE_INTERVAL_MS = {
  1: 0, 2: 900, 3: 700, 4: 600, 5: 520, 6: 460, 7: 420, 8: 390, 9: 360, 10: 340,
}

/** seconds 夹到 1..10 并取整（工具层也会夹一次，这里再夹一次防止被绕过） */
export function normalizeSeconds(value, fallback = 3) {
  // 没给（undefined / null / 空串）= 用默认值，别让 Number(null)===0 把它当成「要 0 张」
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(10, Math.max(1, Math.round(n)))
}

/**
 * 页面内纯函数：读当前页面的可见状态。
 *
 * 🔴 这是一段**源码字符串**，不是普通函数：它会被原样送进页面执行。
 *    只读 DOM 与 HTMLVideoElement，不碰抖音的私有接口，不发请求，不改页面。
 */
export const READ_PAGE_STATE_SOURCE = String.raw`function readPageState() {
  var EMPTY_SELECTION = { candidateCount: 0, ambiguous: false, identityConflict: false };
  if (location.origin !== 'https://www.douyin.com') {
    return {
      url: null, title: null, video: null, videoSelection: EMPTY_SELECTION,
      pageKind: 'unknown', searchResults: [], visibleText: '',
      loginRequired: false, verificationRequired: false,
      documentReadyState: document.readyState, unsupportedPage: true,
      note: '当前页已离开抖音，没有读取该页面内容。'
    };
  }
  var visible = function (element) {
    var r = element.getBoundingClientRect(), s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
      && r.top < innerHeight && r.left < innerWidth
      && s.display !== 'none' && s.visibility !== 'hidden';
  };
  var clean = function (value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); };
  var bounded = function (value, limit) {
    var text = clean(value);
    if (!text || text.length > limit || text.indexOf('\u0000') >= 0) return null;
    return text;
  };
  var workId = function (value) {
    try {
      var u = new URL(value, location.href);
      var m = /\/video\/(\d+)/.exec(u.pathname);
      return (m && m[1]) || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || null;
    } catch (e) { return null; }
  };
  var privateArea = '[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  var text = [].slice.call(document.querySelectorAll('body *')).filter(function (node) {
    return node.childElementCount === 0 && visible(node) && !node.closest(privateArea);
  }).map(function (node) { return clean(node.innerText || node.textContent); })
    .filter(Boolean).join('\n').slice(-9000);
  var loginRequired = /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text);
  var verificationRequired = [].slice.call(document.querySelectorAll(
    '#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]'
  )).some(visible) || /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text);

  // 可见视频按「视口内面积」排；透明度被抹掉的预载元素不算。
  var candidates = [].slice.call(document.querySelectorAll('video')).filter(function (element) {
    if (!visible(element) || element.closest(privateArea)) return false;
    for (var node = element; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) === 0) return false;
    }
    return true;
  }).map(function (element) {
    var r = element.getBoundingClientRect();
    return {
      element: element,
      area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left))
        * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top))
    };
  }).sort(function (a, b) { return b.area - a.area; });

  var element = candidates[0] ? candidates[0].element : null;

  // 推荐流上的卡片：先把它们算出来，下面「activeContainer 回落」要用。
  var recommendRoute = new URL(location.href);
  var recommendFeed =
    ['/', '/recommend', '/recommend/'].indexOf(recommendRoute.pathname) >= 0
    && !workId(recommendRoute.href);
  var feedCards = [].slice.call(document.querySelectorAll(
    '[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]'
  )).filter(function (card) { return visible(card) && !card.closest(privateArea); });
  var FEED_CARD_SEL = '[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]';

  var video = null, activeContainer = null, identityConflict = false;
  if (element) {
    activeContainer = element.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');
    if (!activeContainer) {
      activeContainer = element.parentElement;
      for (var i = 0; activeContainer && activeContainer.parentElement && i < 8; i++) {
        if (activeContainer.querySelector('[class*="video-info-detail"]')) break;
        activeContainer = activeContainer.parentElement;
      }
    }
    // 🔴 关键回落（参考实现这一行，移植时漏了它会让推荐流整片读成 unknown）：
    //    整页只有一张 feed 卡时，那个 video 就在卡里 —— 直接把卡片当容器，
    //    否则往上爬 8 层只会爬到一堆没有作品 id、没有链接的壳。
    if (!activeContainer || !activeContainer.matches(FEED_CARD_SEL)) {
      if (feedCards.length === 1 && feedCards[0].contains(element)) activeContainer = feedCards[0];
    }
    var links = [].slice.call(activeContainer ? activeContainer.querySelectorAll('a[href]') : [])
      .filter(function (link) { return visible(link) && !link.closest(privateArea); });
    var playerId = /(?:^|\s)video_(\d+)(?:\s|$)/.exec(
      (element.closest('[data-e2e="player-container"]') || {}).className || '') ;
    var activeId = /(?:^|\s)video_(\d+)(?:\s|$)/.exec(
      (activeContainer || {}).className || '');
    playerId = playerId ? playerId[1] : null;
    activeId = activeId ? activeId[1] : null;
    identityConflict = Boolean(playerId && activeId && playerId !== activeId);
    var id = identityConflict ? null
      : playerId || activeId
        || links.map(function (link) { return workId(link.href); }).filter(Boolean)[0]
        || workId(location.href)
        || null;
    var authorElement = links.filter(function (link) { return /\/user\//.test(link.href); })[0]
      || [].slice.call(activeContainer ? activeContainer.querySelectorAll('span,div') : [])
        .filter(function (node) {
          return node.childElementCount === 0 && /^@/.test(clean(node.textContent)) && visible(node);
        })[0];
    var titleElement = activeContainer
      ? activeContainer.querySelector(
        '[data-e2e="video-desc"],[data-e2e="video-title"],[data-e2e="detail-video-info"],[class*="video-info-detail"]')
      : null;
    var captionAuthor = /@([^·\n]+)·/.exec(titleElement ? (titleElement.textContent || '') : '');
    var titleText = titleElement
      ? (titleElement.getAttribute('data-e2e') === 'detail-video-info'
        ? titleElement.innerText.split('\n')[0]
        : titleElement.textContent)
      : (links.map(function (link) { return workId(link.href) ? link.textContent : ''; }).filter(Boolean)[0] || '');
    var r = element.getBoundingClientRect();
    video = {
      id: id,
      url: id ? 'https://www.douyin.com/video/' + id : null,
      author: (function () {
        var name = clean(authorElement ? authorElement.textContent : '').replace(/^@\s*/, '');
        return name ? bounded(name, 256) : bounded(captionAuthor ? captionAuthor[1] : '', 256);
      })(),
      title: (bounded(titleText, 1000) || '').slice(0, 1000) || null,
      time: element.currentTime,
      duration: Number.isFinite(element.duration) ? element.duration : null,
      paused: element.paused,
      muted: element.muted,
      readyState: element.readyState,
      ended: element.ended,
      width: element.videoWidth,
      height: element.videoHeight,
      viewport: {
        x: Math.max(0, r.left),
        y: Math.max(0, r.top),
        width: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)),
        height: Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top))
      }
    };
  }

  // 推荐流里的「直播预览」：有卡片、没有作品 id，也不在登录/验证态里。
  // 判据是「没有作品 id」，不是「没有 video 元素」—— 直播卡里也有一个 <video>，
  // 只是它没有作品 id。写成只看 video 存不存在，会让整片推荐流永远落不进 live-preview。
  var livePreview =
    recommendFeed
    && !(video && video.id)
    && !loginRequired
    && !verificationRequired
    && feedCards.length === 1
    // ⚠️ im-dialog 在页面上**一直存在**（私信面板挂载着没打开），按"有没有这个节点"
    //    判会让推荐流永远落不进 live-preview —— 必须判它**可见**。
    && ![].slice.call(document.querySelectorAll('[data-e2e="im-dialog"]')).some(visible);

  var searchResults = [];
  if (location.pathname.indexOf('/search/') === 0) {
    var cards = [].slice.call(document.querySelectorAll(
      '.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"],a[href*="/video/"],a[href*="modal_id="]'
    )).filter(visible);
    var used = [];
    for (var c = 0; c < cards.length; c++) {
      var candidate = cards[c];
      var anchor = candidate.matches('a') ? candidate
        : candidate.querySelector('a[href*="/video/"],a[href*="modal_id="]');
      var cardId = (anchor && workId(anchor.href)) || candidate.getAttribute('data-aweme-id') || null;
      var card = candidate.closest('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]') || candidate;
      var leaves = [].slice.call(card.querySelectorAll('div,span'))
        .filter(function (node) { return !node.childElementCount; })
        .map(function (node) { return clean(node.textContent); });
      var head = card.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"]');
      var cardTitle = clean(head ? head.textContent : '')
        || leaves.sort(function (a, b) { return b.length - a.length; })[0]
        || clean(card.textContent);
      var key = cardId || cardTitle;
      if (!cardTitle || used.indexOf(key) >= 0) continue;
      used.push(key);
      var cardAuthor = card.querySelector('a[href*="/user/"]');
      var inlineAuthor = /@([^\n·]+)/.exec(card.innerText || '');
      searchResults.push({
        index: searchResults.length,
        id: cardId || null,
        url: cardId ? 'https://www.douyin.com/video/' + cardId : null,
        title: cardTitle.slice(0, 1000),
        author: bounded(cardAuthor ? cardAuthor.textContent : '', 256)
          || bounded(inlineAuthor ? inlineAuthor[1] : '', 256)
      });
    }
  }

  var nav = new URL(location.href);
  Array.from(nav.searchParams.keys()).forEach(function (key) {
    if (['modal_id', 'aweme_id', 'recommend'].indexOf(key) < 0) nav.searchParams.delete(key);
  });
  return {
    url: nav.href,
    title: document.title,
    video: video,
    videoSelection: {
      candidateCount: candidates.length,
      ambiguous: candidates.length > 1 || identityConflict,
      identityConflict: identityConflict
    },
    pageKind: livePreview ? 'live-preview'
      : (video && video.id) ? 'video'
        : location.pathname.indexOf('/search/') === 0 ? 'search'
          : 'unknown',
    searchResults: searchResults.slice(0, 20),
    visibleText: text,
    loginRequired: loginRequired,
    verificationRequired: verificationRequired,
    documentReadyState: document.readyState
  };
}`

/** 把源码字符串变成一个真函数对象 —— playwright 会自己 toString() 再送进页面 */
function compilePageFunction(source, name) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`return (${source});`)
  const fn = factory()
  if (typeof fn !== 'function') throw new Error(`页面函数 ${name} 编译失败。`)
  return fn
}

let cachedReadPageState = null
function readPageStateFunction() {
  if (!cachedReadPageState) cachedReadPageState = compilePageFunction(READ_PAGE_STATE_SOURCE, 'readPageState')
  return cachedReadPageState
}

/**
 * 另外四个页面函数也要**编译成真函数**再交给 playwright。
 * ⚠️ 直接把源码字符串传给 `page.evaluate` 会被当成一段「表达式」执行：
 *    字符串形式的 `function foo(){}` 求值结果是 undefined，参数被丢掉 ——
 *    计数器根本没装上，读回来是 undefined，紧接着 `.blocked` 就抛 TypeError。
 */
const pageFnCache = new Map()
function pageFn(source, name) {
  if (!pageFnCache.has(name)) pageFnCache.set(name, compilePageFunction(source, name))
  return pageFnCache.get(name)
}

/** 结构化失败：工具层只看 reason / hint 两句人话 */
export function browserFailure(reason, hint, extra = {}) {
  const error = new Error(hint || reason)
  error.reason = reason
  error.hint = hint || reason
  Object.assign(error, extra)
  return error
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 当前身份：只认「有 id 且已经能出画」的作品，直播预览单独一个记号 */
export function identityOf(state) {
  if (!state || state.unsupportedPage) return null
  if (state.loginRequired || state.verificationRequired) return null
  if (state.videoSelection?.identityConflict) return null
  if (typeof state.video?.id === 'string' && /^\d{1,64}$/.test(state.video.id) && state.video.readyState >= 2) {
    return `video:${state.video.id}`
  }
  if (state.pageKind === 'live-preview') return 'live-preview'
  return null
}

export class BrowserController {
  /**
   * @param {object} options
   * @param {string} options.home        家目录（`<home>/dy/...`）
   * @param {number} [options.port]      指定端口（不给就从 port.json 读 / 拉起时挑）
   * @param {number} [options.connectTimeoutMs]
   */
  constructor({ home, port = null, connectTimeoutMs = 30_000, log = () => {} } = {}) {
    if (!home || typeof home !== 'string') throw new TypeError('BrowserController 需要家目录。')
    this.home = home
    this.port = Number.isInteger(port) && port > 0 ? port : null
    this.connectTimeoutMs = connectTimeoutMs
    this.log = log
    this.browser = null
    this.page = null
    this.queue = Promise.resolve()
  }

  /** 串行：同一时刻只做一件事，避免两个工具调用同时点同一张页 */
  run(task) {
    const next = this.queue.then(task, task)
    this.queue = next.then(() => {}, () => {})
    return next
  }

  /** 端口：显式给的 > port.json 记的 > 拉起浏览器时新挑的 */
  async resolvePort() {
    if (this.port) return this.port
    const paths = controlPaths(this.home)
    const recorded = readPortRecord(paths.portFile)
    if (recorded) {
      this.port = recorded.port
      return this.port
    }
    const launched = await ensureBrowser({ home: this.home, log: this.log })
    if (!launched.ok) throw browserFailure(launched.reason, launched.hint, { detail: launched.detail })
    this.port = launched.port
    return this.port
  }

  /** 连 CDP；连不上就先把浏览器拉起来再连一次 */
  async connect({ timeoutMs = this.connectTimeoutMs } = {}) {
    if (this.browser?.isConnected?.()) return this.browser
    const playwright = await loadPlaywright()
    if (!playwright.ok) throw browserFailure(playwright.reason, playwright.hint)

    const tryConnect = async (port) => playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: timeoutMs,
      noDefaults: true,
    })

    let port = await this.resolvePort()
    try {
      this.browser = await tryConnect(port)
      return this.browser
    } catch (error) {
      // 端口上没人（或者那不是我们那台），拉起浏览器再来一次
      this.log(`连 CDP ${port} 没成，拉起专用 Edge 再试：${error?.message || error}`)
    }

    const launched = await ensureBrowser({ home: this.home, log: this.log })
    if (!launched.ok) throw browserFailure(launched.reason, launched.hint, { detail: launched.detail })
    port = launched.port
    this.port = port
    try {
      this.browser = await tryConnect(port)
    } catch (error) {
      throw browserFailure(
        'connect-failed',
        `连不上专用 Edge 的调试端口 ${port}。确认那个窗口还开着、没有被别的程序占着，再跑一次。`,
        { detail: String(error?.message || error).slice(0, 500) },
      )
    }
    return this.browser
  }

  /** 找到（或开一张）属于我们的页：只认 window.name === DY_PAGE_NAME 的那张 */
  async ensurePage() {
    const browser = await this.connect()
    if (this.page && !this.page.isClosed()) {
      const stillOurs = await this.page.evaluate((name) => window.name === name, DY_PAGE_NAME).catch(() => false)
      if (stillOurs) return this.page
      this.page = null
    }
    const contexts = browser.contexts()
    const context = contexts[0]
    if (!context) throw browserFailure('no-context', '专用 Edge 连上了但没有任何浏览器上下文，浏览器可能正在退出。')

    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue
      const ours = await candidate.evaluate((name) => window.name === name, DY_PAGE_NAME).catch(() => false)
      if (ours) {
        this.page = candidate
        break
      }
    }

    if (!this.page) {
      const page = await context.newPage()
      await page.evaluate((name) => { window.name = name; }, DY_PAGE_NAME)
      page.setDefaultTimeout?.(15_000)
      page.setDefaultNavigationTimeout?.(30_000)
      this.page = page
    }
    return this.page
  }

  /**
   * navigate(url)：goto + settle。
   * settle 只做两件事：等 document.readyState 不再是 loading，再给一小段安静时间。
   * 这里**不猜**「内容加载好了没」—— 那是 state() 的事。
   */
  async navigate(url) {
    const page = await this.ensurePage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch (error) {
      throw browserFailure(
        'navigate-failed',
        `打开抖音页面失败（${url}）。检查一下专用 Edge 窗口是不是还在、有没有卡在验证上。`,
        { detail: String(error?.message || error).slice(0, 500) },
      )
    }
    // 导航会把 window.name 一起带走吗？不会，但保险起见再盖一次章
    await page.evaluate((name) => { window.name = name; }, DY_PAGE_NAME).catch(() => {})

    // 抖音有时把首页甩到 /jingxuan（精选），那页没有能上下滑的作品流。
    // 参考实现的办法：还在 /jingxuan 就点一下导航里的「推荐」。
    if (url === HOME_URL && page.url().includes('/jingxuan')) {
      try {
        const tab = page.locator('a').filter({ hasText: /^推荐$/ })
        if (await tab.count() > 0) await tab.first().click({ timeout: 5000 })
      } catch { /* 点不动就算了，state() 会如实回 unknown */ }
    }

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const ready = await page.evaluate(() => document.readyState).catch(() => 'loading')
      if (ready === 'complete' || ready === 'interactive') break
      await sleep(200)
    }
    await sleep(400)
    // 抖音是客户端渲染：`readyState:complete` 之后推荐流还要再等一会儿才有作品。
    // 真机上紧接着读 state() 会读到 `pageKind:'unknown'` / 一闪而过的 `live-preview`，
    // 而 duty 那一轮只读一次状态 —— 读到 unknown 就按规矩跳过，这一趟白跑。
    // 所以在这里等到「能认出这是什么页」为止（最多 12 秒），等不到也照常返回，
    // 让 state() 去说它看到的实情，不在这里编。
    await this.settleState()
    return { ok: true, url: page.url() }
  }

  /**
   * 等页面「认得出是什么」再交回去。
   * · `video` / `search` ⇒ 立刻认
   * · `live-preview` / `unknown` ⇒ 继续等（推荐流刚打开时先挂直播卡、再换成作品，
   *   真机上就是「第一次读到 live-preview、一秒后读到 video」）
   * 超时返回最后一次看到的状态，不抛。
   */
  async settleState(timeoutMs = 12_000) {
    const started = Date.now()
    let last = null
    while (Date.now() - started < timeoutMs) {
      let snapshot
      try {
        snapshot = await this.state()
      } catch {
        snapshot = null
      }
      if (snapshot) {
        last = snapshot
        if (snapshot.pageKind === 'video' || snapshot.pageKind === 'search') return snapshot
        // 直播卡不会自己变成作品（等 12 秒也是白等）—— 认了它，交给上层划走
        if (snapshot.pageKind === 'live-preview' && Date.now() - started > 4000) return snapshot
      }
      await sleep(700)
    }
    return last
  }

  /** state()：页面内跑 readPageState，返回它的形状 */
  async state() {
    const page = await this.ensurePage()
    let state
    try {
      state = await page.evaluate(readPageStateFunction())
    } catch (error) {
      throw browserFailure(
        'state-failed',
        '读页面状态失败。抖音页面可能正在跳转或者已经崩了；重开一次专用窗口再跑。',
        { detail: String(error?.message || error).slice(0, 500) },
      )
    }
    if (!state || typeof state !== 'object') {
      throw browserFailure('state-failed', '页面没有返回可用的状态对象。')
    }
    return state
  }

  /**
   * 换一条：优先点箭头，点不动就滚轮。
   * 🔴 只认 isTrusted：注入 `window.__caifengSwitchInputs[token]` 计数，
   *    点完计数没涨就认定「这次输入被页面拦了」，改滚轮回退。
   */
  async switchVideo(direction) {
    if (direction !== 1 && direction !== -1) throw new TypeError('换片方向只接受 1 或 -1。')
    const page = await this.ensurePage()
    const before = await this.state()
    const beforeIdentity = identityOf(before)
    if (!beforeIdentity) {
      return { changed: false, before: before.video, after: before.video, state: before, reasonCode: 'video-identity-not-ready' }
    }
    if (before.loginRequired || before.verificationRequired) {
      return { changed: false, before: before.video, after: before.video, state: before, reasonCode: 'switch-blocked' }
    }

    const token = `caifeng-switch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const selector = `[data-e2e="video-switch-${direction > 0 ? 'next' : 'prev'}-arrow"]`

    await page.evaluate(pageFn(installSwitchCounterSource, 'installSwitchCounter'), { token, selector })

    let usedInput = null
    // ① 先试箭头
    const point = await page.evaluate(pageFn(probeSwitchTargetSource, 'probeSwitchTarget'), { token, selector })
    if (point && point.ok) {
      try {
        await page.mouse.move(point.x, point.y)
        await page.mouse.click(point.x, point.y)
        usedInput = 'arrow'
      } catch { usedInput = null }
    }

    // ② 箭头不行（没有 / 不在视口 / 被拦）就滚轮
    if (!usedInput) {
      const box = before.video?.viewport
      if (!box || box.width < 2 || box.height < 2) {
        await page.evaluate(pageFn(cleanupSwitchCounterSource, 'cleanupSwitchCounter'), token).catch(() => {})
        return {
          changed: false, before: before.video, after: before.video, state: before,
          reasonCode: 'switch-control-not-interactable',
        }
      }
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      try {
        await page.mouse.move(cx, cy)
        await page.mouse.wheel(0, direction * 700)
        usedInput = 'wheel'
      } catch {
        usedInput = null
      }
    }
    if (!usedInput) {
      await page.evaluate(pageFn(cleanupSwitchCounterSource, 'cleanupSwitchCounter'), token).catch(() => {})
      return { changed: false, before: before.video, after: before.video, state: before, reasonCode: 'switch-input-unconfirmed' }
    }

    const receipt = await page.evaluate(pageFn(readSwitchCounterSource, 'readSwitchCounter'), token).catch(() => ({ trusted: 0, blocked: false }))
    await page.evaluate(pageFn(cleanupSwitchCounterSource, 'cleanupSwitchCounter'), token).catch(() => {})

    if (receipt.blocked) {
      return { changed: false, before: before.video, after: before.video, state: await this.state(), reasonCode: 'switch-input-blocked' }
    }
    if (!receipt.trusted) {
      // 事件没被页面认作「真人输入」⇒ 点/滚都没生效，别硬等 12 秒
      return { changed: false, before: before.video, after: before.video, state: await this.state(), reasonCode: 'switch-input-not-trusted' }
    }

    // ③ 轮询等身份变化：最多 40 次 × 300ms，连续 2 次相同才算稳定
    let after = before
    let afterIdentity = null
    let previous = null
    let stable = 0
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(300)
      after = await this.state()
      if (after.loginRequired || after.verificationRequired) break
      const current = identityOf(after)
      if (current && current !== beforeIdentity) {
        stable = current === previous ? stable + 1 : 1
        previous = current
        if (stable >= 2) {
          afterIdentity = current
          break
        }
      } else {
        stable = 0
        previous = null
      }
    }

    const changed = Boolean(afterIdentity && afterIdentity !== beforeIdentity)
    return {
      changed,
      via: usedInput,
      before: before.video,
      beforeIdentity,
      after: after.video,
      afterIdentity: afterIdentity,
      state: after,
      reasonCode: changed ? undefined
        : (after.loginRequired || after.verificationRequired) ? 'switch-blocked'
          : 'switch-not-confirmed',
    }
  }

  /**
   * 在搜索结果页点进第一条作品。
   *
   * 搜索页只给标题列表 —— 不点开就没有 id、没有时长、没有画面，那一轮只能记
   * 「拿不到证据」。所以点这一下是搜索流程的一部分，不是额外福利。
   * 返回 `{ ok:true, state }` 或 `{ ok:false, reason, hint }`。
   */
  async openFirstResult({ timeoutMs = 10_000 } = {}) {
    const page = await this.ensurePage()
    const before = identityOf(await this.state())

    // 搜索页默认停在「综合」，视频卡是懒加载的 —— 先点一下「视频」这个 tab，
    // 不然 DOM 里一个 /video/ 链接都没有（真机上就是这么空的）。
    await page
      .evaluate(() => {
        const tab = [].slice
          .call(document.querySelectorAll('div,span,a,li'))
          .find((n) => n.children.length === 0 && /^视频$/.test((n.textContent || '').trim()))
        if (tab) tab.click()
      })
      .catch(() => {})

    const started = Date.now()
    let clicked = false
    while (Date.now() - started < timeoutMs) {
      // 用真鼠标点卡片中心：抖音的卡片监听的是真事件，`a.click()` 会被拦掉
      // （实测点了没反应，页面还停在搜索页）。
      const spot = await page
        .evaluate(() => {
          const links = [].slice.call(document.querySelectorAll('a[href*="/video/"]'))
          const usable = links.filter((a) => {
            const r = a.getBoundingClientRect()
            return r.width > 40 && r.height > 20 && /\/video\/\d{15,25}/.test(a.getAttribute('href') || '')
          })
          if (!usable.length) return null
          const r = usable[0].getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
        .catch(() => null)
      if (spot) {
        await page.mouse.click(spot.x, spot.y).catch(() => {})
        clicked = true
        break
      }
      await sleep(600)
    }
    if (!clicked) {
      return { ok: false, reason: 'no-search-result', hint: '搜索页里没找到能点开的作品卡片（点了「视频」也还是空的，可能这词真没结果）。' }
    }
    // 不能用 settleState：它一看到 pageKind==='search' 就回头交差，
    // 而这时候弹层还没起来。这里只认「真拿到作品 id」。
    const waitUntil = Date.now() + 12_000
    let after = await this.state()
    while (Date.now() < waitUntil) {
      if (after?.video?.id) break
      await sleep(500)
      after = await this.state()
    }
    if (!after?.video?.id || identityOf(after) === before) {
      return {
        ok: false,
        reason: 'result-not-opened',
        hint: '点了第一条，但播放器没起来（可能被登录/验证挡住，或者那条是图文）。换一条或先 open 不带关键词刷推荐流。',
        state: after,
      }
    }
    return { ok: true, state: after }
  }

  /**
   * 截图：从当前视频视口裁。`seconds` 只决定**采几张**，不决定采多久。
   * 返回 { ok, images:[{data,mimeType}], dataBase64, mimeType, videoId, duration, count }
   */
  async capture({ seconds = 3 } = {}) {
    const page = await this.ensurePage()
    const count = normalizeSeconds(seconds)
    const interval = SAMPLE_INTERVAL_MS[count] ?? 400

    const first = await this.state()
    const videoId = first.video?.id ?? null
    if (first.unsupportedPage) {
      return { ok: false, reason: 'unsupported-page', hint: '当前页不在抖音，没截图。先用 caifeng_dy_open 打开。', images: [] }
    }
    if (first.loginRequired || first.verificationRequired) {
      return { ok: false, reason: 'blocked', hint: '页面停在登录或验证上，截不到视频画面。先去专用窗口里处理掉。', images: [] }
    }
    if (!first.video) {
      return { ok: false, reason: 'no-video', hint: '当前页没有可见视频（搜索页请先打开一条作品）。', images: [] }
    }

    const images = []
    let last = first
    for (let index = 0; index < count; index++) {
      if (index && interval) await sleep(interval)
      const sampled = await this.state()
      if (sampled.video?.id !== videoId) {
        // 采样期间换了作品：已有的留着，但不再按这条继续采
        break
      }
      if (sampled.loginRequired || sampled.verificationRequired || sampled.unsupportedPage) break
      const box = sampled.video.viewport
      if (!box || box.width < 2 || box.height < 2) break
      let buffer
      try {
        buffer = await page.screenshot({
          type: 'jpeg',
          quality: 65,
          clip: { x: box.x, y: box.y, width: box.width, height: box.height },
          animations: 'allow',
          caret: 'initial',
          timeout: 10_000,
        })
      } catch {
        break
      }
      if (!buffer?.length) break
      images.push({ data: Buffer.from(buffer).toString('base64'), mimeType: 'image/jpeg', time: sampled.video.time })
      last = sampled
    }

    if (!images.length) {
      return { ok: false, reason: 'no-frame', hint: '这一轮一张画面都没截到（视口不可见或页面在跳转）。', images: [], videoId, duration: last.video?.duration ?? null }
    }
    return {
      ok: true,
      images: images.map(({ data, mimeType }) => ({ data, mimeType })),
      dataBase64: images[0].data,
      mimeType: 'image/jpeg',
      videoId,
      duration: last.video?.duration ?? null,
      count: images.length,
    }
  }

  /** 只断开 CDP，**不关浏览器**（登录态留着） */
  async close() {
    const browser = this.browser
    this.browser = null
    this.page = null
    if (!browser) return { ok: true, closed: false }
    try {
      await browser.close()
      return { ok: true, closed: true }
    } catch {
      return { ok: true, closed: false }
    }
  }
}

/**
 * 页面内：装一个只数「真人输入」的计数器。
 * 监听 pointerdown/mousedown/mouseup/click/wheel，**只统计 isTrusted 的**。
 */
const installSwitchCounterSource = String.raw`function installSwitchCounter(args) {
  var token = args.token, selector = args.selector;
  window.__caifengSwitchInputs = window.__caifengSwitchInputs || Object.create(null);
  var entry = { trusted: 0, blocked: false, cleanup: null };
  window.__caifengSwitchInputs[token] = entry;
  var types = ['pointerdown', 'mousedown', 'mouseup', 'click', 'wheel'];
  var listener = function (event) {
    if (event.isTrusted !== true) { entry.blocked = true; return; }
    var target = event.target instanceof Element ? event.target : null;
    var arrow = selector ? document.querySelector(selector) : null;
    var inVideo = target && target.closest(
      '[data-e2e="feed-active-video"],[data-e2e="video-detail"],[data-e2e="player-container"]');
    if (arrow && target && !(target === arrow || arrow.contains(target)) && !inVideo) return;
    entry.trusted += 1;
  };
  for (var i = 0; i < types.length; i++) {
    document.addEventListener(types[i], listener, { capture: true, passive: true });
  }
  entry.cleanup = function () {
    for (var i = 0; i < types.length; i++) document.removeEventListener(types[i], listener, true);
    delete window.__caifengSwitchInputs[token];
  };
  return { ok: true };
}`

/** 页面内：读计数器 */
const readSwitchCounterSource = String.raw`function readSwitchCounter(token) {
  var entry = window.__caifengSwitchInputs && window.__caifengSwitchInputs[token];
  if (!entry) return { trusted: 0, blocked: false, missing: true };
  return { trusted: entry.trusted, blocked: entry.blocked };
}`

/** 页面内：拆掉监听 */
const cleanupSwitchCounterSource = String.raw`function cleanupSwitchCounter(token) {
  var entry = window.__caifengSwitchInputs && window.__caifengSwitchInputs[token];
  if (entry && typeof entry.cleanup === 'function') entry.cleanup();
  return { ok: true };
}`

/**
 * 页面内：箭头能不能点。
 * 三道关：只有一个、可见且启用、**点中心点 elementFromPoint 命中的就是它**。
 */
const probeSwitchTargetSource = String.raw`function probeSwitchTarget(args) {
  var selector = args.selector;
  var nodes = Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function (element) {
    var r = element.getBoundingClientRect(), s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  });
  if (nodes.length !== 1) return { ok: false, reason: nodes.length ? 'ambiguous' : 'missing' };
  var element = nodes[0];
  if (element.closest('[disabled],[aria-disabled="true"]')) return { ok: false, reason: 'disabled' };
  var r = element.getBoundingClientRect();
  var x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (r.width < 2 || r.height < 2) return { ok: false, reason: 'too-small' };
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { ok: false, reason: 'out-of-viewport' };
  var hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== element && !element.contains(hit))) return { ok: false, reason: 'occluded' };
  return { ok: true, x: x, y: y };
}`

