import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dshEntryCandidates, promptThroughShellUnsafe, resolveDsh, spawnDuty } from '../../lib/duty.mjs'

const onWindows = process.platform === 'win32'

test('dshEntryCandidates：目录不存在时返回空数组（plain node / 非桌面宿主）', () => {
  assert.deepEqual(dshEntryCandidates(join(tmpdir(), 'dragonfly-no-such-dir-xyz')), [])
})

test('dshEntryCandidates：命中 resources/app 下的 desktop-host cli.js', { skip: !onWindows }, () => {
  const root = mkdtempSync(join(tmpdir(), 'df-app-'))
  try {
    const entry = join(root, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    mkdirSync(join(entry, '..'), { recursive: true })
    writeFileSync(entry, '// stub\n', 'utf8')

    const got = dshEntryCandidates(root)
    assert.equal(got.length, 1)
    assert.equal(got[0].command, process.execPath)
    assert.deepEqual(got[0].args, ['--expose-internals', entry])
    assert.equal(got[0].shell, false, '必须 shell:false —— 章程不能过 cmd.exe')
    assert.equal(got[0].env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(got[0].source, 'host-app')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveDsh：桌面宿主优先拿自带 CLI，不落到 shell 兜底', { skip: !onWindows }, () => {
  const d = resolveDsh()
  // 本机就是桌面版：要么命中宿主自带 CLI（shell:false），要么在测试机上是 plain node → 返回别的
  assert.equal(typeof d.command, 'string')
  if (d.source === 'host-app') {
    assert.equal(d.shell, false)
    assert.ok(d.args.includes('--expose-internals'))
  } else {
    // 走到 PATH 兜底时必须标 riskyShell，交给 spawnDuty 拦
    assert.ok(d.missing || d.riskyShell || d.shell === false)
  }
})

test('promptThroughShellUnsafe：多行中文章程过不了 cmd.exe', () => {
  assert.equal(promptThroughShellUnsafe('ok'), false)
  assert.equal(promptThroughShellUnsafe('请看这一条'), false)
  assert.equal(promptThroughShellUnsafe('第一行\n第二行'), true, '换行必炸')
  assert.equal(promptThroughShellUnsafe('100% 完成'), true, '百分号会被吃掉')
  assert.equal(promptThroughShellUnsafe('他说"你好"'), true, '引号会被吃掉')
  assert.equal(promptThroughShellUnsafe('x'.repeat(261)), true, '过长必炸')
})

test('spawnDuty：入口只剩 shell 且章程多行时，立刻返回 no_safe_dsh（不起子进程）', async () => {
  const r = await spawnDuty({
    dsh: { command: 'C:\\fake\\dsh.cmd', args: [], shell: true, riskyShell: true },
    profile: 'dragonfly-duty',
    overlay: null,
    prompt: '# 章程\n\n第一行\n第二行',
    layout: { home: tmpdir() },
    cwd: tmpdir(),
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no_safe_dsh')
  assert.match(r.text, /cmd\.exe|shell/)
})
