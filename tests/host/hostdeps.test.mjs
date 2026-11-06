import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { candidateRoots, compareVersions, loadHostDeps, runningAppRoots } from '../../lib/hostdeps.mjs'

const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SELF_MODULES = join(PLUGIN_ROOT, 'node_modules', '@deepseek-ai')

test('compareVersions 按 semver 排序（含预发布）', () => {
  const order = [
    '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-alpha.1',
    '0.2.1-rc.1', '0.2.1-rc.5', '0.2.2-rc.1', '0.3.0',
  ]
  for (let i = 1; i < order.length; i++) {
    assert.equal(compareVersions(order[i], order[i - 1]), 1, `${order[i]} 应大于 ${order[i - 1]}`)
    assert.equal(compareVersions(order[i - 1], order[i]), -1, `${order[i - 1]} 应小于 ${order[i]}`)
  }
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
  assert.equal(compareVersions('10.0.0', '9.9.9'), 1, '数字段按数值比，不是字典序')
})

test('runningAppRoots 指向 exe 旁边的 resources（桌面版 app.asar）', () => {
  const roots = runningAppRoots()
  const exeDir = dirname(process.execPath)
  assert.ok(roots.length >= 2, '至少应有 app.asar / app 两种布局')
  assert.ok(roots.some((r) => r.startsWith(join(exeDir, 'resources'))), roots.join('\n'))
  assert.ok(roots.some((r) => r.includes('app.asar')), roots.join('\n'))
  assert.ok(roots.every((r) => r.endsWith(join('node_modules', '@deepseek-ai'))))
})

test('candidateRoots：宿主本体排在全局 npm 旧装之前，自己依赖排最后', () => {
  const saved = process.env.DSH_HOST_MODULES
  delete process.env.DSH_HOST_MODULES
  try {
    const roots = candidateRoots()
    const app = roots.findIndex((r) => r.includes('app.asar'))
    assert.ok(app >= 0, '应有 app.asar 根')

    const npmIdx = roots.findIndex((r) => r.includes(join('npm', 'node_modules')))
    if (npmIdx >= 0) assert.ok(app < npmIdx, `app.asar(${app}) 必须排在 npm(${npmIdx}) 之前`)

    const profileIdx = roots.findIndex((r) => r.includes(join('profiles')))
    if (profileIdx >= 0) assert.ok(app < profileIdx, `app.asar(${app}) 必须排在 profile(${profileIdx}) 之前`)

    assert.equal(roots[roots.length - 1], SELF_MODULES, '自己依赖那份永远垫底')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOST_MODULES
    else process.env.DSH_HOST_MODULES = saved
  }
})

test('DSH_HOST_MODULES 显式指定时排第一（用户说了算）', () => {
  const saved = process.env.DSH_HOST_MODULES
  const fake = join(PLUGIN_ROOT, 'tests', '.fake-host-modules')
  process.env.DSH_HOST_MODULES = fake
  try {
    assert.equal(candidateRoots()[0], fake)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOST_MODULES
    else process.env.DSH_HOST_MODULES = saved
  }
})

test('loadHostDeps 在普通 node 下不抛（asar 读不到就往下退）', async () => {
  const deps = await loadHostDeps()
  assert.ok(Array.isArray(deps.notes))
  assert.equal(typeof deps.defineTool, 'function')
  if (deps.z) assert.equal(typeof deps.z.object, 'function')
})
