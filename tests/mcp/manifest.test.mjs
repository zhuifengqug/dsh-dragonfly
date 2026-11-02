/**
 * 第四条缝：两条 MCP 的「清单」
 * ============================================================================
 * 这一层不碰网络、不碰浏览器，只验一件最容易悄悄坏掉的事：
 * **白名单外的东西，连名字都不该出现。**
 *
 * 抖音那条能真起（Node 写的桥，握手是纯 JSON-RPC）；
 * B站 那条是 Python，本机不一定装了 `mcp`，所以退一步只静态核对 `@tool()` 的名单 ——
 * 这仍然能挡住「多加了一个工具」「少写了一个工具」这类错。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bridge = join(repo, 'dy', 'mcp-bridge.mjs')
const python = join(repo, 'vendor', 'caifeng-bili-mcp', 'server.py')

/** 起一次桥，喂几条 JSON-RPC，收所有回包 */
function talk({ env = {}, messages, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`桥没在 ${timeoutMs}ms 内回话。stderr=${err.slice(-800)}`))
    }, timeoutMs)
    child.stdout.on('data', (c) => { out += c.toString() })
    child.stderr.on('data', (c) => { err += c.toString() })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', () => {
      clearTimeout(timer)
      const lines = out.split('\n').map((s) => s.trim()).filter(Boolean)
      const replies = []
      for (const line of lines) {
        try { replies.push(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
      }
      resolve({ replies, stderr: err })
    })
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.end()
  })
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }
const READY = { jsonrpc: '2.0', method: 'notifications/initialized' }
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' }

const ALL_DY = ['caifeng_dy_open', 'caifeng_dy_state', 'caifeng_dy_next', 'caifeng_dy_frames']

test('抖音桥：白名单为空时四个工具都在', async () => {
  const { replies } = await talk({ messages: [INIT, READY, LIST] })
  const listed = replies.find((r) => r.id === 2)
  assert.ok(listed, 'tools/list 没回')
  assert.deepEqual(listed.result.tools.map((t) => t.name).sort(), [...ALL_DY].sort())
})

test('抖音桥：白名单只留两个，另外两个连名字都不出现', async () => {
  const { replies } = await talk({
    env: { CAIFENG_TOOLS: 'caifeng_dy_open,caifeng_dy_frames' },
    messages: [INIT, READY, LIST],
  })
  const listed = replies.find((r) => r.id === 2)
  assert.deepEqual(listed.result.tools.map((t) => t.name).sort(), ['caifeng_dy_frames', 'caifeng_dy_open'])
})

test('抖音桥：名单为空串等同于没设（四个都开）', async () => {
  const { replies } = await talk({ env: { CAIFENG_TOOLS: '' }, messages: [INIT, READY, LIST] })
  const listed = replies.find((r) => r.id === 2)
  assert.equal(listed.result.tools.length, 4)
})

test('抖音桥：每个工具都带一段说明和非空 inputSchema', async () => {
  const { replies } = await talk({ messages: [INIT, READY, LIST] })
  const tools = replies.find((r) => r.id === 2).result.tools
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10, `${tool.name} 的说明太短`)
    assert.equal(tool.inputSchema?.type, 'object')
  }
})

test('抖音桥：不认识的方法回 -32601，不是静默吞掉', async () => {
  const { replies } = await talk({
    messages: [INIT, READY, { jsonrpc: '2.0', id: 9, method: 'tools/call_typo' }],
  })
  const bad = replies.find((r) => r.id === 9)
  assert.ok(bad, '没回包')
  assert.equal(bad.error?.code, -32601)
})

test('抖音桥：没写 host.json 时调用是结构化失败，不是崩', async () => {
  // 家目录指向一个空的临时目录 ⇒ 必然没有 dy/control/host.json
  const home = join(repo, 'tmp', 'no-such-home-for-test')
  const { replies } = await talk({
    env: { CAIFENG_HOME: home },
    messages: [
      INIT, READY,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'caifeng_dy_state', arguments: {} } },
    ],
  })
  const call = replies.find((r) => r.id === 3)
  assert.ok(call, '没回包')
  const text = call.result.content.find((c) => c.type === 'text')?.text || ''
  assert.match(text, /"ok":\s*false/, `应该回 ok:false，实际：${text.slice(0, 200)}`)
  assert.match(text, /host-config|host-record|no-home/, `应该说明是宿主地址的问题，实际：${text.slice(0, 300)}`)
})

test('B站 MCP：@tool() 装饰的正好九个，名字跟命名清单对得上', () => {
  const source = readFileSync(python, 'utf8')
  const names = [...source.matchAll(/^@tool\(\)\s*\n\s*(?:async\s+)?def\s+([a-z0-9_]+)/gm)].map((m) => m[1])
  assert.deepEqual(names.sort(), [
    'caifeng_bili_comments',
    'caifeng_bili_dm',
    'caifeng_bili_favorites',
    'caifeng_bili_frames',
    'caifeng_bili_reply',
    'caifeng_bili_search',
    'caifeng_bili_subtitle',
    'caifeng_report_write',
    'caifeng_seen',
  ])
  // 命名清单里没有的东西，一个都不许冒出来
  assert.doesNotMatch(source, /def\s+caifeng_bili_cover/)
  assert.doesNotMatch(source, /def\s+caifeng_paths/)
})

test('B站 MCP：白名单与语感闸门的开关环境变量名没写歪', () => {
  const source = readFileSync(python, 'utf8')
  assert.match(source, /CAIFENG_BILI_TOOLS/, '白名单变量名必须是 CAIFENG_BILI_TOOLS')
  assert.match(source, /CAIFENG_STYLE_OFF/, '语感闸门的开关变量名必须是 CAIFENG_STYLE_OFF')
  assert.match(source, /CAIFENG_HOME/, '家目录变量名必须是 CAIFENG_HOME')
  assert.match(source, /creds["'\/\\]+bili-credential\.json|"creds"[\s\S]{0,40}bili-credential\.json/,
    '凭证要从 <家>/creds/bili-credential.json 读')
})

test('两份 requirements 里的 mcp 都锁在 1.x（2.x 起不来）', () => {
  const req = readFileSync(join(repo, 'vendor', 'caifeng-bili-mcp', 'requirements.txt'), 'utf8')
  const line = req.split('\n').find((l) => /^mcp\b/i.test(l.trim()))
  assert.ok(line, 'requirements.txt 里没有 mcp')
  assert.match(line, /<\s*2/, `mcp 必须锁 <2，实际：${line}`)
})
