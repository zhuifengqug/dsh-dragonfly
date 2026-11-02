/**
 * lib/mcp.mjs —— 极简 MCP stdio 客户端（一行一条 JSON-RPC，不装 SDK）
 * ============================================================================
 * 为什么自己写：宿主那棵树里没有 `@modelcontextprotocol/sdk`，装它等于给插件加
 * 一个 peer 依赖；我们只用三个方法（initialize / notifications-list / tools-call），
 * 手写比引依赖稳。
 *
 * 谁用它：宿主侧的 `caifeng_bili_*` 与 `caifeng_report_write` / `caifeng_seen`
 * 这一批工具，全部转发给同一个 Python MCP 进程 —— 也就是**那份 server.py 是
 * 这些工具契约的唯一主人**，宿主侧不做第二份实现。
 * ============================================================================
 */
import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2024-11-05'

/** 默认一次调用等多久（B站 接口有时候慢；抽帧更慢） */
const DEFAULT_TIMEOUT_MS = 180_000

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.command   python 路径
   * @param {string[]} [opts.args]  server.py 路径
   * @param {string} [opts.cwd]     家目录
   * @param {object} [opts.env]     额外环境变量
   * @param {(line:string)=>void} [opts.log]
   * @param {string} [opts.name]    客户端名（出现在 server 日志里）
   */
  constructor({ command, args = [], cwd, env, log = () => {}, name = 'caifeng' } = {}) {
    if (!command) throw new TypeError('McpClient 需要 command（解释器路径）。')
    this.command = command
    this.args = [...args]
    this.cwd = cwd
    this.env = env || {}
    this.log = log
    this.name = name
    this.child = null
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.stderrTail = ''
    this.ready = null
    this.closed = false
  }

  /** 起进程 + 握手。同一个实例只起一次（再调拿同一个 Promise） */
  start() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.#onData(chunk))

      // stderr 只留最后一段：MCP server 的日志全走这里，出问题时它最有用
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4000)
      })

      child.on('error', (error) => {
        const why = `MCP 进程起不来：${error?.message || error}`
        this.log(why)
        this.#rejectAll(new Error(why))
      })

      child.on('close', (code) => {
        this.closed = true
        const tail = this.stderrTail.trim()
        const why = `MCP 进程退出（${code}）${tail ? `：${tail.slice(-500)}` : ''}`
        if (code !== 0) this.log(why)
        this.#rejectAll(new Error(why))
      })

      await this.#request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.name, version: '0.1.0' },
      })
      this.#notify('notifications/initialized', {})
      return this
    })()
    return this.ready
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }   // 非 JSON 行（日志漏进 stdout）忽略
      const id = message?.id
      if (id === undefined || id === null) continue
      const waiter = this.pending.get(id)
      if (!waiter) continue
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error.message || 'MCP 调用失败'))
      else waiter.resolve(message.result)
    }
  }

  #rejectAll(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  async #request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.child || this.closed) throw new Error('MCP 进程没起来')
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 调用超时（${Math.round(timeoutMs / 1000)} 秒）：${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${payload}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  #notify(method, params) {
    if (!this.child || this.closed) return
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch { /* 通知丢了不影响 */ }
  }

  /** 调一个工具，只取文本结果（图片块丢掉） */
  async call(name, args = {}, opts = {}) {
    const raw = await this.callRaw(name, args, opts)
    return raw.json
  }

  /**
   * 调一个工具，保留图片块。
   * @returns {Promise<{json:any, images:{data:string,mimeType:string}[]}>}
   */
  async callRaw(name, args = {}, opts = {}) {
    await this.start()
    const result = await this.#request(
      'tools/call',
      { name, arguments: args || {} },
      opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    )
    const blocks = Array.isArray(result?.content) ? result.content : []
    const images = blocks
      .filter((block) => block?.type === 'image' && block.data)
      .map((block) => ({ data: block.data, mimeType: block.mimeType || block.mime_type || 'image/jpeg' }))
    const texts = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    const joined = texts.map((block) => block.text).join('\n').trim()

    if (result?.isError) {
      const why = joined || 'MCP 说这次调用失败了（没给原因）'
      const error = new Error(why)
      error.mcpError = true
      throw error
    }

    let json = joined
    if (joined) {
      try { json = JSON.parse(joined) } catch { /* 不是 JSON 就原样返回字符串 */ }
    }
    return { json, images }
  }

  /** 关掉（写盘的家目录那份进程；宿主卸载时调） */
  async close() {
    const child = this.child
    this.child = null
    this.closed = true
    if (!child) return
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
  }
}

/**
 * 按需创建的客户端池：同一个 (command, server) 只起一份。
 * 起不来就把错误留在对象里，下一次调用会重新尝试（不永久判死）。
 */
export function createMcpPool({ log = () => {} } = {}) {
  const clients = new Map()

  const keyOf = (spec) => `${spec.command}|${(spec.args || []).join(',')}`

  return {
    get(spec) {
      const key = keyOf(spec)
      let client = clients.get(key)
      if (!client || client.closed) {
        client = new McpClient({ ...spec, log })
        clients.set(key, client)
      }
      return client
    },
    async closeAll() {
      for (const [, client] of clients) {
        try { await client.close() } catch { /* ignore */ }
      }
      clients.clear()
    },
  }
}
