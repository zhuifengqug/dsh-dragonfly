/**
 * 搬运与运维：从旧插件导入、改存放位置、诊断
 * ============================================================================
 * 这一组测的是"顾客搬家时不会丢东西、也不会把老房子拆了"。
 * 三个规矩，每条都有代价：
 *
 *   · 只读旧目录 —— 写坏它等于把用户的历史砸了，且没有第二次机会
 *   · 只搬三类文件 —— 日报留在原处（搬走会让"今天"的目录看起来塞满旧文件）
 *   · 幂等 —— 每次启动都会尝试导入，重复导入会覆盖用户后来的改动
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { countReports, importFromBili, moveHome } from '../../lib/migrate.mjs'
import { layoutOf } from '../../lib/paths.mjs'
import { parseSeen } from '../../lib/seen.mjs'

let root
let oldHome

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'caifeng-migrate-'))
  oldHome = join(root, 'bili-duty')
  process.env.DSH_HOME = root
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(root, { recursive: true, force: true })
})

/** 造一个"旧的刷B站家" */
function makeOld({ config, seen, credential, reports = 2 } = {}) {
  mkdirSync(join(oldHome, 'out'), { recursive: true })
  if (config !== undefined) writeFileSync(join(oldHome, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
  if (seen !== undefined) writeFileSync(join(oldHome, 'seen.md'), seen, 'utf8')
  if (credential) writeFileSync(join(oldHome, 'bili_credential.json'), JSON.stringify(credential), 'utf8')
  for (let i = 0; i < reports; i += 1) {
    writeFileSync(join(oldHome, 'out', `2026-10-2${i}.md`), `# 旧日报 ${i}\n`, 'utf8')
  }
  return oldHome
}

const OLD_SEEN = [
  '# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）',
  '',
  '## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）',
  '',
  '| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |',
  '| --- | --- | --- | --- | --- |',
  '',
  '## 看过的视频',
  '| 2026-10-31 | BV1tbxe6rEVn | 大肥鱼讲游戏制作 | 千云sm | 挑了 |',
  '| 2026-10-31 | BV1FTxi6vEoK | DeepSeek 控制虚幻引擎 | 芝士派 | 挑了 |',
  '',
].join('\n')

test('旧目录不存在时安静跳过，不报错', () => {
  const layout = layoutOf(join(root, 'tianshu-caifeng'))
  const r = importFromBili(layout)
  assert.equal(r.ok, true)
  assert.equal(r.state, 'no-source')
  assert.equal(existsSync(layout.home), false, '连目录都不该建')
})

test('首次启动：配置与凭据搬过来，旧日报一份都不搬', () => {
  makeOld({ config: { perDay: 3, mentionName: '蚍蜉zzzz', headlessProfile: 'bili-duty-a6' }, seen: OLD_SEEN, credential: { sessdata: 'x' } })
  const layout = layoutOf(join(root, 'tianshu-caifeng'))
  const r = importFromBili(layout)

  assert.equal(r.state, 'imported')
  const cfg = JSON.parse(readFileSync(layout.config, 'utf8'))
  assert.equal(cfg.perDay, 3, '配置字段按名迁移')
  assert.equal(cfg['migrated-from'], 'bili-duty')
  assert.equal(cfg.headlessProfile, undefined, '旧插件专有的键要丢掉')
  assert.equal(existsSync(layout.biliCredential), true, '凭据要搬')

  assert.equal(existsSync(join(layout.home, 'out')), false, '日报不搬')
  assert.equal(r.oldReports, 2, '但要说清旧目录还剩几份')
})

test('旧判重表并进 B站 节：旧格式的「挑了」读得懂，不会整份照抄', () => {
  makeOld({ seen: OLD_SEEN })
  const layout = layoutOf(join(root, 'tianshu-caifeng'))
  const r = importFromBili(layout)

  const text = readFileSync(layout.seen, 'utf8')
  assert.match(text, /^## B站$/m, '要有 B站 这一节')
  assert.doesNotMatch(text, /看过的视频/, '旧的小节名不该原样留着')
  assert.doesNotMatch(text, /评论记录/, '评论记录不是判重数据，不该搬')
  assert.match(text, /BV1tbxe6rEVn/)
  assert.match(text, /BV1FTxi6vEoK/)

  // 搬过来的行必须能被自己的解析器认出来 —— 否则等于没搬
  const parsed = parseSeen(text)
  assert.equal(parsed.rows.filter((x) => x.id.startsWith('BV')).length, 2)
  assert.ok(parsed.rows.every((x) => x.section === 'bili'))
  assert.ok(parsed.rows.every((x) => x.picked), '旧的「挑了」要算「收」')
  assert.match(r.copied.join('、'), /判重表（2 条）/)
})

test('幂等：再导一次什么都不做，也不覆盖用户后来改的配置', () => {
  makeOld({ config: { perDay: 3 }, seen: OLD_SEEN })
  const layout = layoutOf(join(root, 'tianshu-caifeng'))
  importFromBili(layout)
  writeFileSync(layout.config, JSON.stringify({ perDay: 9, 'migrated-from': 'bili-duty' }), 'utf8')

  const again = importFromBili(layout)
  assert.equal(again.state, 'already')
  assert.equal(JSON.parse(readFileSync(layout.config, 'utf8')).perDay, 9, '第二次不能覆盖')
})

test('这边已经在用了就不动', () => {
  makeOld({ config: { perDay: 3 } })
  const layout = layoutOf(join(root, 'tianshu-caifeng'))
  mkdirSync(join(layout.home, 'out'), { recursive: true })
  writeFileSync(layout.seen, '# 见闻录\n', 'utf8')
  writeFileSync(join(layout.home, 'out', '2026-11-02.md'), '# 2026-11-02\n', 'utf8')

  const r = importFromBili(layout)
  assert.equal(r.state, 'in-use')
})

test('导入过程一个字节都不写旧目录', () => {
  makeOld({ config: { perDay: 3 }, seen: OLD_SEEN, credential: { sessdata: 'x' } })
  const before = {
    files: readdirSync(oldHome).sort(),
    config: readFileSync(join(oldHome, 'config.json'), 'utf8'),
    seen: readFileSync(join(oldHome, 'seen.md'), 'utf8'),
    reports: countReports(oldHome),
  }
  const layout = layoutOf(join(root, 'tianshu-caifeng'))
  importFromBili(layout)

  assert.deepEqual(readdirSync(oldHome).sort(), before.files, '旧目录里不该多出文件')
  assert.equal(readFileSync(join(oldHome, 'config.json'), 'utf8'), before.config)
  assert.equal(readFileSync(join(oldHome, 'seen.md'), 'utf8'), before.seen)
  assert.equal(countReports(oldHome), before.reports)
})

test('改存放位置：只复制配置、判重、凭据三类', () => {
  const from = layoutOf(join(root, 'old-home'))
  mkdirSync(join(from.home, 'out'), { recursive: true })
  mkdirSync(join(from.home, 'reports'), { recursive: true })
  mkdirSync(from.creds, { recursive: true })
  writeFileSync(from.config, '{"perDay":4}', 'utf8')
  writeFileSync(from.seen, '# 见闻录\n', 'utf8')
  writeFileSync(from.biliCredential, '{"sessdata":"x"}', 'utf8')
  writeFileSync(join(from.home, 'out', '2026-11-01.md'), '# 旧\n', 'utf8')
  writeFileSync(join(from.home, 'reports', 'BV1xx411c7mD.md'), '# 笔记\n', 'utf8')
  writeFileSync(join(from.home, 'duty.log'), 'log\n', 'utf8')

  const to = layoutOf(join(root, 'new-home'))
  const r = moveHome(from, to, { confirm: true })

  assert.equal(r.ok, true)
  assert.equal(existsSync(to.config), true)
  assert.equal(existsSync(to.seen), true)
  assert.equal(existsSync(to.biliCredential), true)
  assert.equal(existsSync(join(to.home, 'out')), false, '日报不搬')
  assert.equal(existsSync(join(to.home, 'reports')), false, '笔记不搬')
  assert.equal(existsSync(join(to.home, 'duty.log')), false, '日志不搬')
  assert.equal(r.oldReports, 1, '要告诉旧目录还剩几份日报')
  assert.equal(r.needDyLogin, true, '新位置没有浏览器登录态 ⇒ 要提示重扫')
  assert.match(r.text, /旧目录还有 1 份日报/)
})

test('改存放位置：目标非空时先要确认，不确认就一个字节都不写', () => {
  const from = layoutOf(join(root, 'old-home'))
  mkdirSync(from.home, { recursive: true })
  writeFileSync(from.config, '{"perDay":4}', 'utf8')

  const to = layoutOf(join(root, 'busy-home'))
  mkdirSync(to.home, { recursive: true })
  writeFileSync(join(to.home, 'something.txt'), 'occupied\n', 'utf8')

  const r = moveHome(from, to)
  assert.equal(r.ok, false)
  assert.equal(r.needConfirm, true)
  assert.equal(existsSync(to.config), false, '没确认就写了，等于把人家的目录搞乱')
})

test('改存放位置：目标已有同名文件不覆盖', () => {
  const from = layoutOf(join(root, 'old-home'))
  mkdirSync(from.home, { recursive: true })
  writeFileSync(from.config, '{"perDay":4}', 'utf8')

  const to = layoutOf(join(root, 'new-home'))
  mkdirSync(to.home, { recursive: true })
  writeFileSync(to.config, '{"perDay":99}', 'utf8')

  const r = moveHome(from, to, { confirm: true })
  assert.equal(readFileSync(to.config, 'utf8'), '{"perDay":99}', '目标已有就得保留')
  assert.match(r.skipped.join('；'), /config\.json/)
})

test('搬到同一个位置：直接说没搬', () => {
  const same = layoutOf(join(root, 'same'))
  const r = moveHome(same, same)
  assert.equal(r.ok, false)
  assert.match(r.text, /一样/)
})
