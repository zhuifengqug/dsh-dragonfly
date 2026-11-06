#!/usr/bin/env node
/**
 * dy/mcp-bridge.mjs —— MCP stdio 服务，4 个抖音工具转发给宿主 HTTP 路由
 * ============================================================================
 * 为什么是「极薄桥」而不是直接干活：
 *   真浏览器归宿主进程管（专用 Edge 由宿主拉起、登录态在宿主那边），
 *   duty 子进程里起不来也不该起浏览器。所以这个脚本只做转发 ——
 *
 *   duty 里的模型
 *     → MCP stdio（本文件，一行一条 JSON-RPC）
 *     → HTTP POST <baseUrl>/api/dragonfly/dy/<action>
 *     → 宿主进程里的 BrowserController
 *     → 专用 Edge
 *
 * 两个约束（别改）：
 *   1. 不装任何依赖。手写最小 JSON-RPC，`@modelcontextprotocol/sdk` 一律不碰。
 *   2. 白名单在**注册层**生效：`DRAGONFLY_TOOLS` 里没有的工具，list_tools 里根本不出现。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'dragonfly-dy', version: '0.1.0' }
const REQUEST_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// 工具目录：注册什么、说什么（description 要写「什么时候该用」，模型靠它选工具）
// ---------------------------------------------------------------------------
const TOOL_CATALOG = [
  {
    name: 'dragonfly_dy_open',
    action: 'open',
    description:
      '打开抖音网页并读出这一页的状态。'
      + ' 不传 query 就打开推荐流首页（信息流，适合看今天大家在刷什么）；'
      + ' 传 query 就打开搜索结果页（想找具体话题、人物、事件时用）。'
      + ' 打开后返回的作品列表和可见文本可以用来判断「这条值不值得看」。'
      + ' 一个专用 Edge 窗口会常驻，登录态保留；第一次用可能需要人手动扫码登录一次。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索词。省略 = 打开推荐流首页。例：「秋招」「小城故事」。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dragonfly_dy_state',
    action: 'state',
    description:
      '读当前抖音页面此刻的状态，不改变页面。'
      + ' 返回当前作品（id / 作者 / 标题 / 时长 / 播放进度 / 是否暂停）、'
      + ' 页面类型（推荐流 / 作品页 / 搜索页）、搜索结果列表、可见文本，'
      + ' 以及是否停在登录或人机验证上。'
      + ' 刚执行完 open 或 next 之后想确认「现在到底在哪条片子」时用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dragonfly_dy_next',
    action: 'next',
    description:
      '换到下一条视频（相当于在推荐流里往下滑一次）。'
      + ' 会先尝试点页面上的「下一条」箭头，点不动就退回滚轮 —— 两条路都走真人输入，'
      + ' 失败会明确告诉你是被拦住了还是没换成功。'
      + ' 想连着看几条时，用它一条一条过，别一次跳很多。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dragonfly_dy_frames',
    action: 'frames',
    description:
      '截取当前视频正在播放的画面（几张静态图，不是录视频）。'
      + ' 字幕和标题告诉你说的是什么，画面告诉你拍的是什么 —— '
      + '要判断一条片子到底好不好看、有没有实际内容，就看这个。'
      + ' seconds 越大采样张数越多（1-10 张，张数越多间隔越短），默认 3 张。'
      + ' 只能截当前这一条；要换片子先 next 或 open。',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: '采样强度，1-10，默认 3。数字只决定截几张，不是「录多少秒」。',
        },
      },
      additionalProperties: false,
    },
  },
]

/**
 * 白名单：环境变量 `DRAGONFLY_TOOLS`，逗号分隔。
 * 空 / 没设 ⇒ 全放。名单里有的才注册；名单外的连 list_tools 都不出现。
 */
export function selectTools(catalog, raw) {
  const names = String(raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (!names.length) return [...catalog] // 空 = 全放
  return catalog.filter((tool) => names.includes(tool.name) || names.includes(tool.action))
}

// ---------------------------------------------------------------------------
// 宿主地址：`<home>/dy/control/host.json` 里的 {baseUrl, token}
// ---------------------------------------------------------------------------
export function homeDir(env = process.env) {
  return env.DRAGONFLY_HOME || env.DRAGONFLY_HOME_DIR || ''
}

export function readHostRecord(home) {
  if (!home) {
    return { ok: false, reason: 'no-home', hint: '没拿到家目录（DRAGONFLY_HOME 是空的），找不到宿主地址。' }
  }
  const file = join(home, 'dy', 'control', 'host.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return {
      ok: false,
      reason: 'no-host-record',
      hint: `宿主还没把地址写下来（缺 ${file}）。先让宿主把抖音路由挂起来、完成一次握手，再跑这一轮。`,
    }
  }
  let record
  try {
    record = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'bad-host-record', hint: `宿主地址文件不是合法 JSON：${file}` }
  }
  const baseUrl = typeof record?.baseUrl === 'string' ? record.baseUrl.trim().replace(/\/+$/, '') : ''
  const token = typeof record?.token === 'string' ? record.token : ''
  if (!/^https?:\/\//.test(baseUrl)) {
    return { ok: false, reason: 'bad-host-record', hint: `宿主地址文件里没有可用的 baseUrl：${file}` }
  }
  return { ok: true, baseUrl, token, file }
}

// ---------------------------------------------------------------------------
// 转发
// ---------------------------------------------------------------------------
async function postAction(record, action, payload) {
  const url = `${record.baseUrl}/api/dragonfly/dy/${action}`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(record.token ? { 'x-dragonfly-token': record.token } : {}),
      },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 300)
    return {
      ok: false,
      reason: 'host-unreachable',
      hint: `宿主进程没应答（${url}）。宿主可能没在跑，或者抖音路由还没挂上。`,
      detail,
    }
  }
  const text = await response.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    return {
      ok: false,
      reason: 'host-bad-response',
      hint: `宿主回了非 JSON（HTTP ${response.status}）。看一下宿主日志里 /api/dragonfly/dy/${action} 那段。`,
      detail: text.slice(0, 300),
    }
  }
  if (!response.ok && data && typeof data === 'object' && data.ok !== true) {
    return { ok: false, reason: data.reason || `http-${response.status}`, hint: data.hint || `宿主回 HTTP ${response.status}。`, ...data }
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, reason: 'host-empty-response', hint: `宿主对 ${action} 什么都没返回。` }
  }
  return data
}

/** `tools/call` 的结果：文本块 + （frames 时）图片块 */
function toMcpResult(payload) {
  if (payload && payload.ok === true && Array.isArray(payload.images) && payload.images.length) {
    const summary = { ...payload, images: undefined }
    delete summary.images
    return {
      content: [
        { type: 'text', text: JSON.stringify(summary) },
        ...payload.images
          .filter((image) => image && typeof image.data === 'string' && image.data)
          .map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType || 'image/jpeg' })),
      ],
      isError: false,
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload ?? { ok: false, reason: 'empty', hint: '空结果。' }) }],
    isError: payload?.ok === false ? true : false,
  }
}

// ---------------------------------------------------------------------------
// 一个最小 JSON-RPC over stdio 的 MCP 服务端（一行一条消息）
// ---------------------------------------------------------------------------
function createServer({ tools, home, log = () => {} }) {
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]))

  const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  const handleCall = async (id, params) => {
    const name = typeof params?.name === 'string' ? params.name : ''
    const tool = toolByName.get(name)
    if (!tool) {
      return reply(id, {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: false, reason: 'unknown-tool', hint: `这一轮没有开放工具 ${name || '(未命名)'}。` }),
        }],
        isError: true,
      })
    }
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    const record = readHostRecord(home)
    if (!record.ok) {
      return reply(id, toMcpResult({ ok: false, reason: record.reason, hint: record.hint }))
    }
    const payload = await postAction(record, tool.action, args)
    return reply(id, toMcpResult(payload))
  }

  const handle = async (message) => {
    const { id, method, params } = message ?? {}
    const isNotification = id === undefined || id === null
    if (typeof method !== 'string') {
      if (!isNotification) fail(id, -32600, '不是合法的 JSON-RPC 请求。')
      return
    }
    if (method === 'initialize') {
      // capabilities.tools 必须报，客户端据此才会 list_tools
      if (!isNotification) {
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
      }
      return
    }
    if (method === 'notifications/initialized' || method === 'initialized') return // 通知不回
    if (method === 'ping') {
      if (!isNotification) reply(id, {})
      return
    }
    if (method === 'tools/list') {
      if (isNotification) return
      reply(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
      return
    }
    if (method === 'tools/call') {
      if (isNotification) return
      try {
        await handleCall(id, params)
      } catch (error) {
        reply(id, toMcpResult({
          ok: false,
          reason: 'bridge-failed',
          hint: `桥自己出错了：${String(error?.message || error).slice(0, 300)}`,
        }))
      }
      return
    }
    if (method === 'shutdown') {
      if (!isNotification) reply(id, {})
      return
    }
    if (method.startsWith('notifications/')) return
    if (!isNotification) fail(id, -32601, `不认识的方法：${method}`)
  }

  return { handle }
}

function main() {
  const home = homeDir()
  const tools = selectTools(TOOL_CATALOG, process.env.DRAGONFLY_TOOLS)
  const log = (line) => process.stderr.write(`[dragonfly-dy] ${line}\n`)
  if (!tools.length) {
    // 名单里一个都不认：照常起服务，list_tools 回空数组，让上层看到「今天没开抖音」
    log('DRAGONFLY_TOOLS 名单里没有可注册的工具，list_tools 将回空。')
  }
  const server = createServer({ tools, home, log })

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      // 不是 JSON 的行（被打日志的东西）直接忽略，绝不因此挂掉
      return
    }
    Promise.resolve(server.handle(message)).catch((error) => {
      log(`处理消息失败：${String(error?.message || error).slice(0, 200)}`)
    })
  })
  rl.on('close', () => {
    // 客户端关管道 = 这一轮结束了。浏览器归宿主管，这里什么也不关。
    process.exitCode = 0
  })
}

// 只有当自己被 node 直接执行时才起服务（被 import 时不跑）。
// ⚠️ Windows 上别用 `new URL('file://'+argv[1])` —— 那会把盘符 D: 当成 host，
//    跟 import.meta.url 的 `file:///D:/...` 永远对不上，服务会静默不启动。
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()
if (invokedDirectly) main()

export { TOOL_CATALOG, createServer, toMcpResult, postAction }
