/**
 * tests/dy/dy.test.mjs —— 抖音信源的离线测试
 * ============================================================================
 * 规矩：**不碰真浏览器、不连网络**。所有 controller 都是假对象。
 * 这里测的是「接线与契约」—— 4 个动作在成功/失败两条路上返回什么形状，
 * 以及桥的白名单有没有真的在注册层生效。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { open, state, next, frames, DY_ACTIONS, DY_TOOL_NAMES } from '../../dy/tools.mjs'
import { normalizeSeconds } from '../../dy/core.mjs'
import { findLiveCdp, readPortRecord, writePortRecord, probeCdp } from '../../dy/browser-host.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..', '..')
const BRIDGE = join(PLUGIN_ROOT, 'dy', 'mcp-bridge.mjs')

/** 一份「看起来对」的页面状态，形状跟 readPageState 一致 */
const sampleState = (overrides = {}) => ({
  url: 'https://www.douyin.com/video/7412345678901234567',
  title: '抖音',
  video: {
    id: '7412345678901234567',
    url: 'https://www.douyin.com/video/7412345678901234567',
    author: '某个作者',
    title: '一条测试作品',
    time: 3.5,
    duration: 30,
    paused: false,
    muted: true,
    readyState: 4,
    ended: false,
    width: 720,
    height: 1280,
    viewport: { x: 100, y: 0, width: 720, height: 900 },
  },
  videoSelection: { candidateCount: 1, ambiguous: false, identityConflict: false },
  pageKind: 'video',
  searchResults: [],
  visibleText: '测试文本',
  loginRequired: false,
  verificationRequired: false,
  documentReadyState: 'complete',
  ...overrides,
})

/** 假 controller：记录被要求做了什么，回固定对象 */
function fakeController(overrides = {}) {
  const calls = { navigate: [], switchVideo: [], capture: [], state: 0 }
  const controller = {
    calls,
    async navigate(url) {
      calls.navigate.push(url)
      return { ok: true, url }
    },
    async state() {
      calls.state += 1
      return sampleState()
    },
    async switchVideo(direction) {
      calls.switchVideo.push(direction)
      return {
        changed: true,
        via: 'arrow',
        before: sampleState().video,
        beforeIdentity: 'video:7412345678901234567',
        after: sampleState({ video: { ...sampleState().video, id: '7499999999999999999' } }).video,
        afterIdentity: 'video:7499999999999999999',
        state: sampleState({ video: { ...sampleState().video, id: '7499999999999999999' } }),
      }
    },
    async capture({ seconds } = {}) {
      calls.capture.push(seconds)
      return {
        ok: true,
        images: [{ data: 'AAAA', mimeType: 'image/jpeg' }, { data: 'BBBB', mimeType: 'image/jpeg' }],
        dataBase64: 'AAAA',
        mimeType: 'image/jpeg',
        videoId: '7412345678901234567',
        duration: 30,
        count: 2,
      }
    },
    ...overrides,
  }
  return controller
}

/** 每个动作都抛错的 controller —— 验证「永不抛」 */
function throwingController(error = new Error('假故障')) {
  const boom = async () => { throw error }
  return { navigate: boom, state: boom, switchVideo: boom, capture: boom }
}

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------
test('open 无 query 时打开抖音首页', async () => {
  const controller = fakeController()
  const result = await open({ controller })
  assert.equal(result.ok, true)
  assert.deepEqual(controller.calls.navigate, ['https://www.douyin.com/?recommend=1&from_nav=1'])
  assert.equal(result.state.pageKind, 'video')
})

test('open 有 query 时打开搜索结果页并编码', async () => {
  const controller = fakeController()
  const result = await open({ query: '秋招 面试', controller })
  assert.equal(result.ok, true)
  assert.deepEqual(controller.calls.navigate, [
    `https://www.douyin.com/search/${encodeURIComponent('秋招 面试')}`,
  ])
  assert.ok(controller.calls.navigate[0].includes('%20'), '空格应该被编码')
  assert.equal(result.query, '秋招 面试')
})

test('open 的 query 为空白字符串时仍然走首页', async () => {
  const controller = fakeController()
  const result = await open({ query: '   ', controller })
  assert.equal(result.ok, true)
  assert.deepEqual(controller.calls.navigate, ['https://www.douyin.com/?recommend=1&from_nav=1'])
  assert.equal(result.query, null)
})

test('state 成功路径返回 ok:true 与页面状态', async () => {
  const controller = fakeController()
  const result = await state({ controller })
  assert.equal(result.ok, true)
  assert.equal(result.state.video.id, '7412345678901234567')
  assert.equal(controller.calls.state, 1)
})

test('next 成功路径换到下一条', async () => {
  const controller = fakeController()
  const result = await next({ controller })
  assert.equal(result.ok, true)
  assert.deepEqual(controller.calls.switchVideo, [1], 'next 只往下走一个方向')
  assert.equal(result.state.video.id, '7499999999999999999')
})

test('open 落到直播卡上会自己划走一张，别抱着一张读不出 id 的卡收工', async () => {
  const live = sampleState({ pageKind: 'live-preview', video: { ...sampleState().video, id: null, duration: null } })
  const controller = fakeController({ async state() { return live } })
  const result = await open({ controller })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'live-preview')
  assert.deepEqual(controller.calls.switchVideo, [1])
  assert.equal(result.state.pageKind, 'video')
})

test('open 带 query（搜索页）时不因为 live-preview 去划走', async () => {
  const live = sampleState({ pageKind: 'live-preview', video: { ...sampleState().video, id: null } })
  const controller = fakeController({ async state() { return live } })
  const result = await open({ query: '秋招', controller })
  assert.equal(result.skipped, null)
  assert.deepEqual(controller.calls.switchVideo, [])
})

test('next 换到直播卡上会再划，最多两跳', async () => {
  let round = 0
  const live = sampleState({ pageKind: 'live-preview', video: { ...sampleState().video, id: null } })
  const controller = fakeController({
    async switchVideo(direction) {
      controller.calls.switchVideo.push(direction)
      round += 1
      return { changed: true, via: 'arrow', before: null, state: round < 3 ? live : sampleState() }
    },
  })
  const result = await next({ controller })
  assert.equal(result.ok, true)
  assert.equal(result.hopped, 2, '两跳之后停手，不无限划')
  assert.equal(controller.calls.switchVideo.length, 3)
  assert.equal(result.state.pageKind, 'video')
})

test('frames 成功路径带回图片数组', async () => {
  const controller = fakeController()
  const result = await frames({ controller })
  assert.equal(result.ok, true)
  assert.equal(result.images.length, 2)
  assert.deepEqual(result.images[0], { data: 'AAAA', mimeType: 'image/jpeg' })
  assert.equal(result.videoId, '7412345678901234567')
  assert.equal(result.duration, 30)
})

// ---------------------------------------------------------------------------
// seconds 夹取
// ---------------------------------------------------------------------------
test('frames 的 seconds 默认 3', async () => {
  const controller = fakeController()
  await frames({ controller })
  assert.deepEqual(controller.calls.capture, [3])
})

test('frames 的 seconds 被夹到 1..10', async () => {
  const low = fakeController()
  await frames({ seconds: -5, controller: low })
  assert.deepEqual(low.calls.capture, [1])

  const high = fakeController()
  await frames({ seconds: 999, controller: high })
  assert.deepEqual(high.calls.capture, [10])

  const mid = fakeController()
  await frames({ seconds: 6, controller: mid })
  assert.deepEqual(mid.calls.capture, [6])

  const garbage = fakeController()
  await frames({ seconds: 'abc', controller: garbage })
  assert.deepEqual(garbage.calls.capture, [3], '非数字回落到默认值')
})

test('normalizeSeconds 取整并夹在 1..10', () => {
  assert.equal(normalizeSeconds(0), 1)
  assert.equal(normalizeSeconds(11), 10)
  assert.equal(normalizeSeconds(10.4), 10)
  assert.equal(normalizeSeconds(4.6), 5)
  assert.equal(normalizeSeconds(null), 3)
  assert.equal(normalizeSeconds(undefined), 3)
  assert.equal(normalizeSeconds('7'), 7)
})

// ---------------------------------------------------------------------------
// 接管上一轮还开着的浏览器：端口记录的优先级
// ---------------------------------------------------------------------------
test('findLiveCdp 先认 port.json 记的那个端口', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'caifeng-port-'))
  const file = join(dir, 'port.json')
  try {
    writePortRecord(file, 9300)
    assert.equal(readPortRecord(file).port, 9300)
    const seen = []
    const port = await findLiveCdp({
      file,
      min: 9290,
      max: 9295,
      probe: async (p) => { seen.push(p); return p === 9300 },
    })
    assert.equal(port, 9300)
    assert.equal(seen[0], 9300, '记录的那个要第一个试')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findLiveCdp 记录的端口死了就往下扫，找到活的那个', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'caifeng-port-'))
  const file = join(dir, 'port.json')
  try {
    writePortRecord(file, 9290)
    const port = await findLiveCdp({ file, min: 9290, max: 9296, probe: async (p) => p === 9294 })
    assert.equal(port, 9294)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findLiveCdp 一个活的都没有时返回 null，不抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'caifeng-port-'))
  const file = join(dir, 'port.json')
  try {
    writePortRecord(file, 9290)
    assert.equal(await findLiveCdp({ file, min: 9290, max: 9293, probe: async () => false }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeCdp 对没人听的端口返回 false 而不是抛', async () => {
  assert.equal(await probeCdp(1, 300), false)
})

// ---------------------------------------------------------------------------
// 失败路径：controller 抛错时返回 ok:false，绝不抛
// ---------------------------------------------------------------------------
test('controller 抛裸错时 4 个动作都返回 ok:false 而不是抛', async () => {
  const controller = throwingController()
  for (const [name, action] of Object.entries(DY_ACTIONS)) {
    const result = await action({ query: 'x', seconds: 5, controller })
    assert.equal(result.ok, false, `${name} 应该降级成 ok:false`)
    assert.equal(typeof result.reason, 'string', `${name} 要给 reason`)
    assert.equal(typeof result.hint, 'string', `${name} 要给 hint`)
  }
})

test('controller 抛带 reason 的结构化错误时原样透出', async () => {
  const error = new Error('连不上')
  error.reason = 'connect-failed'
  error.hint = '先把专用窗口打开。'
  const result = await open({ controller: throwingController(error) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'connect-failed')
  assert.equal(result.hint, '先把专用窗口打开。')
})

test('没注入 controller 时给 no-controller，而不是崩', async () => {
  for (const [name, action] of Object.entries(DY_ACTIONS)) {
    const result = await action({})
    assert.equal(result.ok, false, `${name} 应该 ok:false`)
    assert.equal(result.reason, 'no-controller')
  }
})

test('state 遇到非抖音页面时给 unsupported-page', async () => {
  const controller = fakeController({
    async state() { return { unsupportedPage: true, note: '离开抖音' } },
  })
  const result = await state({ controller })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unsupported-page')
  assert.equal(result.state.unsupportedPage, true)
})

test('next 没换动时给 ok:false 并带上 reasonCode', async () => {
  const controller = fakeController({
    async switchVideo() {
      return {
        changed: false,
        reasonCode: 'switch-input-not-trusted',
        before: sampleState().video,
        state: sampleState(),
      }
    },
  })
  const result = await next({ controller })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'switch-input-not-trusted')
  assert.ok(result.state)
})

test('frames 截不到图时给 ok:false 与空图片数组', async () => {
  const controller = fakeController({
    async capture() {
      return { ok: false, reason: 'blocked', hint: '页面停在验证上。', videoId: null, duration: null }
    },
  })
  const result = await frames({ seconds: 4, controller })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'blocked')
  assert.deepEqual(result.images, [])
})

test('frames 只有 dataBase64 没有 images 时也能回一张', async () => {
  const controller = fakeController({
    async capture() {
      return { ok: true, dataBase64: 'CCCC', mimeType: 'image/jpeg', videoId: '1', duration: 5 }
    },
  })
  const result = await frames({ controller })
  assert.equal(result.ok, true)
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].data, 'CCCC')
})

// ---------------------------------------------------------------------------
// 动作表
// ---------------------------------------------------------------------------
test('动作表正好是这 4 个名字', () => {
  assert.deepEqual([...DY_TOOL_NAMES], ['open', 'state', 'next', 'frames'])
})

// ---------------------------------------------------------------------------
// 桥：白名单在注册层生效 + 语法检查
// ---------------------------------------------------------------------------
test('桥里读 CAIFENG_TOOLS 且名单外不注册', () => {
  const source = readFileSync(BRIDGE, 'utf8')
  assert.ok(source.includes('CAIFENG_TOOLS'), '必须读 CAIFENG_TOOLS')
  // 「名单外的连注册都不注册」＝ 用 filter 收窄后交给 tools/list，而不是在 call 时挡
  assert.match(source, /selectTools\s*\(/, '应该有 selectTools 收窄')
  assert.match(source, /catalog\.filter\(/, 'selectTools 应该用 filter 收窄目录')
  assert.match(source, /tools:\s*tools\.map\(/, 'tools/list 回的应该是收窄后的数组')
  // 4 个工具名必须精确
  for (const name of ['caifeng_dy_open', 'caifeng_dy_state', 'caifeng_dy_next', 'caifeng_dy_frames']) {
    assert.ok(source.includes(`'${name}'`), `桥里要有 ${name}`)
  }
})

test('桥不依赖 @modelcontextprotocol/sdk，也没有静态 import playwright', () => {
  const source = readFileSync(BRIDGE, 'utf8')
  assert.ok(!/^\s*import[^\n]*@modelcontextprotocol\/sdk/m.test(source), '不许装 SDK')
  assert.ok(!/^\s*import[^\n]*playwright-core/m.test(source), '桥不该碰 playwright')
})

test('四个文件都能通过 node --check', () => {
  const files = ['mcp-bridge.mjs', 'core.mjs', 'browser-host.mjs', 'tools.mjs']
    .map((name) => join(PLUGIN_ROOT, 'dy', name))
  for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  }
})

test('browser-host.mjs 用动态 import 加载 playwright-core', () => {
  const source = readFileSync(join(PLUGIN_ROOT, 'dy', 'browser-host.mjs'), 'utf8')
  assert.ok(!/^\s*import[^\n]*playwright-core/m.test(source), '不许在文首静态 import playwright-core')
  assert.match(source, /await import\(\s*['"]playwright-core['"]\s*\)/, '应该在函数里动态 import')
  assert.ok(source.includes('no-playwright'), '失败要给结构化 reason no-playwright')
})

test('core.mjs 的 readPageState 是源码字符串而不是普通函数', () => {
  const source = readFileSync(join(PLUGIN_ROOT, 'dy', 'core.mjs'), 'utf8')
  assert.match(source, /export const READ_PAGE_STATE_SOURCE\s*=\s*String\.raw`/, '必须整体作为字符串注入')
  assert.ok(source.includes('feed-active-video'), '选择器照参考实现')
  assert.ok(source.includes("'live-preview'"), 'pageKind 四值之一')
})

// ---------------------------------------------------------------------------
// readPageState：在 vm 沙箱里用 DOM 桩真跑一遍（不进浏览器）
// 这是整条链路最容易写错的地方 —— 它要被序列化送进页面执行，
// 里面任何一个笔误都不会在 node --check 阶段暴露。
// ---------------------------------------------------------------------------
const rect = (x, y, w, h) => ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h })
const plainStyle = { display: 'block', visibility: 'visible', opacity: '1' }

/** 一个够用的元素桩 */
const stubNode = (overrides = {}) => ({
  childElementCount: 0,
  parentElement: null,
  textContent: '',
  innerText: '',
  className: '',
  getBoundingClientRect: () => rect(0, 0, 720, 900),
  getAttribute: () => null,
  matches: () => false,
  closest: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  contains: () => false,
  ...overrides,
})

/** 在 vm 沙箱里跑 readPageState，返回它的结果 */
async function runReadPageState({ location, document }) {
  const vm = await import('node:vm')
  const { READ_PAGE_STATE_SOURCE } = await import('../../dy/core.mjs')
  const sandbox = {
    location, document,
    getComputedStyle: () => plainStyle,
    innerWidth: 1000,
    innerHeight: 800,
    URL,
    URLSearchParams,
  }
  return vm.runInNewContext(`${READ_PAGE_STATE_SOURCE}; readPageState();`, sandbox)
}

test('readPageState 离开抖音时立刻返回 unsupportedPage', async () => {
  const result = await runReadPageState({
    location: {
      origin: 'https://example.com',
      href: 'https://example.com/x',
      pathname: '/x',
      searchParams: new URLSearchParams(),
    },
    document: { readyState: 'complete', title: 'T', querySelectorAll: () => [], querySelector: () => null },
  })
  assert.equal(result.unsupportedPage, true)
  assert.equal(result.pageKind, 'unknown')
  assert.equal(result.video, null)
  // note 是给人看的一句话，不是空串
  assert.ok(result.note && result.note.length > 0)
})

test('readPageState 在抖音搜索页返回 search 与清干净 query 的 url', async () => {
  const result = await runReadPageState({
    location: {
      origin: 'https://www.douyin.com',
      href: 'https://www.douyin.com/search/x?foo=1&modal_id=99',
      pathname: '/search/x',
      searchParams: new URLSearchParams('foo=1&modal_id=99'),
    },
    document: { readyState: 'complete', title: '搜索', querySelectorAll: () => [], querySelector: () => null },
  })
  assert.equal(result.pageKind, 'search')
  assert.equal(result.video, null)
  assert.equal(result.videoSelection.candidateCount, 0)
  assert.ok(!result.url.includes('foo=1'), '没用的 query 应被删掉')
  assert.ok(result.url.includes('modal_id=99'), 'modal_id 要留着')
})

test('readPageState 抖音首页没视频没卡片时是 unknown，不误判成 live-preview', async () => {
  const result = await runReadPageState({
    location: {
      origin: 'https://www.douyin.com',
      href: 'https://www.douyin.com/',
      pathname: '/',
      searchParams: new URLSearchParams(),
    },
    document: { readyState: 'complete', title: '抖音', querySelectorAll: () => [], querySelector: () => null },
  })
  assert.equal(result.pageKind, 'unknown')
})

// 这一条是照真机崩过的样子写的：推荐流里只有一个 feed-live 卡片，
// 卡片里确实有一个 <video>，但它没有作品 id（直播预览）。
// 旧实现不知道「唯一那张卡片就是容器」，往上爬 8 层爬到一堆空壳 ⇒ 整片读成 unknown。
test('readPageState 推荐流里唯一的 feed-live 卡片会落进 live-preview，而不是 unknown', async () => {
  const card = stubNode({ getAttribute: (name) => (name === 'data-e2e' ? 'feed-live' : null) })
  card.matches = (selector) => String(selector).includes('feed-live')
  const videoEl = stubNode({
    currentTime: 0, duration: null, paused: true, muted: false,
    readyState: 0, ended: false, videoWidth: 0, videoHeight: 0,
    closest: () => null,     // 不在 feed-active-video / video-detail 里
  })
  card.contains = (node) => node === videoEl
  videoEl.parentElement = card

  const result = await runReadPageState({
    location: {
      origin: 'https://www.douyin.com',
      href: 'https://www.douyin.com/?recommend=1',
      pathname: '/',
      searchParams: new URLSearchParams('recommend=1'),
    },
    document: {
      readyState: 'complete',
      title: '抖音',
      querySelectorAll: (selector) => {
        if (selector === 'video') return [videoEl]
        if (selector.includes('feed-live')) return [card]
        return []
      },
      querySelector: () => null,
    },
  })

  assert.equal(result.pageKind, 'live-preview')
  assert.ok(!result.video || !result.video.id, '直播预览没有作品 id')
})

test('readPageState 在作品页读得出 id / 作者 / 标题 / 播放进度', async () => {
  const titleEl = stubNode({
    textContent: '今天在县城吃到了十块钱的早餐',
    innerText: '今天在县城吃到了十块钱的早餐',
    getAttribute: (name) => (name === 'data-e2e' ? 'video-desc' : null),
  })
  const authorLink = stubNode({
    textContent: '@小城日记',
    href: 'https://www.douyin.com/user/MS4wLjABAAAA',
    matches: (selector) => selector === 'a',
  })
  const container = stubNode({
    className: 'video_7412345678901234567',
    querySelector: (selector) => (selector.includes('video-desc') ? titleEl : null),
    querySelectorAll: (selector) => (selector.includes('a[href]') ? [authorLink] : []),
  })
  container.parentElement = stubNode()
  const player = stubNode({ className: 'player-container' })
  const videoEl = stubNode({
    currentTime: 12.5,
    duration: 45,
    paused: false,
    muted: true,
    readyState: 4,
    ended: false,
    videoWidth: 720,
    videoHeight: 1280,
    closest: (selector) => (selector.includes('feed-active-video') ? container
      : selector.includes('player-container') ? player : null),
  })

  const result = await runReadPageState({
    location: {
      origin: 'https://www.douyin.com',
      href: 'https://www.douyin.com/video/7412345678901234567',
      pathname: '/video/7412345678901234567',
      searchParams: new URLSearchParams(),
    },
    document: {
      readyState: 'complete',
      title: '抖音',
      querySelectorAll: (selector) => {
        if (selector === 'video') return [videoEl]
        if (selector.includes('feed-active-video')) return [container]
        return []
      },
      querySelector: () => null,
    },
  })

  assert.equal(result.pageKind, 'video')
  assert.equal(result.video.id, '7412345678901234567')
  assert.equal(result.video.author, '小城日记')
  assert.equal(result.video.title, '今天在县城吃到了十块钱的早餐')
  assert.equal(result.video.time, 12.5)
  assert.equal(result.video.duration, 45)
  assert.equal(result.video.readyState, 4)
  // 注意：vm 沙箱里的对象来自另一个 realm，deepEqual 会因原型不同而判不等，
  // 所以这里逐字段比（或先 JSON 往返）。
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.video.viewport)),
    { x: 0, y: 0, width: 720, height: 800 },
  )
  assert.equal(result.videoSelection.candidateCount, 1)
  assert.equal(result.videoSelection.ambiguous, false)
  assert.equal(result.videoSelection.identityConflict, false)
})

test('readPageState 的 pageKind 只可能是那四个值', async () => {
  const cases = [
    { pathname: '/', href: 'https://www.douyin.com/' },
    { pathname: '/search/x', href: 'https://www.douyin.com/search/x' },
    { pathname: '/video/1', href: 'https://www.douyin.com/video/1' },
    { pathname: '/discover', href: 'https://www.douyin.com/discover' },
  ]
  const allowed = new Set(['live-preview', 'video', 'search', 'unknown'])
  for (const item of cases) {
    const result = await runReadPageState({
      location: {
        origin: 'https://www.douyin.com',
        href: item.href,
        pathname: item.pathname,
        searchParams: new URLSearchParams(),
      },
      document: { readyState: 'complete', title: '抖音', querySelectorAll: () => [], querySelector: () => null },
    })
    assert.ok(allowed.has(result.pageKind), `${item.pathname} 的 pageKind=${result.pageKind} 不在允许值里`)
  }
})

test('identityOf 只认出画的作品，冲突或未就绪一律 null', async () => {
  const { identityOf } = await import('../../dy/core.mjs')
  assert.equal(identityOf({ video: { id: '123', readyState: 4 }, videoSelection: {} }), 'video:123')
  assert.equal(identityOf({ video: null, pageKind: 'live-preview', videoSelection: {} }), 'live-preview')
  assert.equal(identityOf({ video: { id: '1', readyState: 4 }, videoSelection: { identityConflict: true } }), null)
  assert.equal(identityOf({ video: { id: '1', readyState: 0 }, videoSelection: {} }), null)
  assert.equal(identityOf({ video: { id: '1', readyState: 4 }, loginRequired: true }), null)
  assert.equal(identityOf({ unsupportedPage: true }), null)
  assert.equal(identityOf(null), null)
})


test('open 落在搜索页会点进第一条，并回报 opened', async () => {
  const calls = { navigate: [], opened: 0 }
  const searchState = sampleState({ pageKind: 'search', video: null })
  const controller = {
    calls,
    async navigate(url) { calls.navigate.push(url); return { ok: true, url } },
    async state() { return searchState },
    async openFirstResult() { calls.opened += 1; return { ok: true, state: sampleState() } },
  }
  const r = await open({ query: 'deepseek 插件', controller })
  assert.equal(r.ok, true)
  assert.equal(r.opened, 'first-result')
  assert.equal(calls.opened, 1)
  assert.equal(r.state.pageKind, 'video')
})

test('next 停在搜索页时去点第一条，不硬滑', async () => {
  const calls = { switchVideo: 0, opened: 0 }
  const controller = {
    calls,
    async state() { return sampleState({ pageKind: 'search', video: null }) },
    async switchVideo() { calls.switchVideo += 1; return { changed: false } },
    async openFirstResult() { calls.opened += 1; return { ok: true, state: sampleState() } },
  }
  const r = await next({ controller })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'first-result')
  assert.equal(calls.opened, 1)
  assert.equal(calls.switchVideo, 0)
})

test('next 在搜索页点不开时把原因说清楚，不冒充换片失败', async () => {
  const controller = {
    async state() { return sampleState({ pageKind: 'search', video: null }) },
    async switchVideo() { throw new Error('不该走到这里') },
    async openFirstResult() { return { ok: false, reason: 'no-search-result', hint: '这页没结果' } },
  }
  const r = await next({ controller })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-search-result')
  assert.match(r.hint, /没结果/)
})
