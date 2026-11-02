import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = join(process.cwd(), 'client.js')

/**
 * 客户端测试的套路（跟蜂群那边一致）：
 *   ① 把 client.js 当纯文本读进来，在 vm 里跑一遍 —— 它只认 `window`，不 import 任何东西
 *   ② 假 `window.__ModuleLoader__.load` 把注册值接住
 *   ③ 假 React：createElement 只记录、useEffect 立刻执行、useSyncExternalStore 取快照
 *   ④ 假 ctx.slots：inject(key, cb) 直接 cb()，register 记下来
 * 这样能断言的正是"最难靠肉眼看出来、又最容易改坏"的东西：槽位名字、id、key、order。
 */
async function loadClient() {
  const source = await readFile(SOURCE, 'utf8')

  let registration = null
  const window = {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  }

  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: (effect) => { effect() },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
  }

  vm.runInNewContext(source, {
    window,
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval: () => 0,
    clearInterval: () => {},
    console,
    AbortController,
    Date,
    Math,
    JSON,
    URL,
    encodeURIComponent,
  }, { filename: SOURCE })

  assert.ok(registration, 'client.js 应该调用 window.__ModuleLoader__.load')
  return { registration, react }
}

function makeClientCtx(react) {
  const registrations = []
  const effects = []
  const slots = {
    inject(key, cb) { return cb() },
    register(options, component) {
      registrations.push({ options, component })
      return async () => {}
    },
  }
  const ctx = {
    slots,
    get: (k) => (k === 'slots' ? slots : undefined),
    effect: (fn, label) => { effects.push({ label, cleanup: fn() }) },
    // 让 React 可用：组件在 vm 外面调用时需要真的 createElement
    React: react,
  }
  return { ctx, registrations, effects }
}

test('client.js 自注册的 id 就是包名', async () => {
  const { registration } = await loadClient()
  assert.equal(registration.id, '@zhuifengqug/dsh-tianshu-caifeng')
  assert.equal(typeof registration.factory, 'function')
})

test('factory 返回 { inject: [slots], apply }', async () => {
  const { registration, react } = await loadClient()
  const mod = registration.factory(() => react)
  // vm 里造出来的数组跟外面不是同一个 realm，得先落到本 realm 再比
  assert.deepEqual(Array.from(mod.inject), ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('三处槽位都注册了：侧栏入口 / 主区整页 / 设置页', async () => {
  const { registration, react } = await loadClient()
  const mod = registration.factory(() => react)
  const { ctx, registrations } = makeClientCtx(react)
  mod.apply(ctx)

  const names = registrations.map((r) => r.options.name).sort()
  assert.deepEqual(names, ['main', 'settings.section', 'sidebar.panellist'])
})

test('主区页的 key 必须跟侧栏入口的 id 对上（否则进不去）', async () => {
  const { registration, react } = await loadClient()
  const mod = registration.factory(() => react)
  const { ctx, registrations } = makeClientCtx(react)
  mod.apply(ctx)

  const main = registrations.find((r) => r.options.name === 'main')
  const side = registrations.find((r) => r.options.name === 'sidebar.panellist')
  const settings = registrations.find((r) => r.options.name === 'settings.section')

  assert.equal(main.options.key, 'caifeng')
  assert.equal(side.options.id, 'caifeng')
  assert.equal(settings.options.id, 'caifeng')
  assert.equal(side.options.label, '采风')
})

test('没有 slots 服务时安静退出，不抛', async () => {
  const { registration, react } = await loadClient()
  const mod = registration.factory(() => react)
  assert.doesNotThrow(() => mod.apply({ get: () => undefined, effect: () => {} }))
})

test('槽位不存在时不影响其他槽位（缺一个也照样起）', async () => {
  const { registration, react } = await loadClient()
  const mod = registration.factory(() => react)
  const registrations = []
  const slots = {
    inject(key, cb) {
      if (key === 'sidebar.panellist') throw new Error('没有这个槽位')
      return cb()
    },
    register(options) { registrations.push(options); return async () => {} },
  }
  assert.doesNotThrow(() => mod.apply({ get: () => slots, effect: () => {} }))
  assert.equal(registrations.length, 2, '主区页与设置页仍然应该注册上')
})
