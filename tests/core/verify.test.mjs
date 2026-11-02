/**
 * 评论复核：措辞与三态
 * ============================================================================
 * 这一层只有两个东西绝对不能出错，其余都是细节：
 *
 *   ① **看不到 ≠ 没发出**。接口翻页、热度排序都会漏，所以「找不到」只能说
 *      「没查到」，绝不能写「没发出去」—— 那句话会让使用者以为评论丢了。
 *   ② **没 rpid 就别编**。回执里没有 rpid 就写「未取到 rpid」，
 *      编一个数字出来，复核就变成了自己骗自己。
 *
 * 下面把 fetch 换掉，喂固定的几种回包（找得到 / 找不到 / 标了 invisible），
 * 把这两条钉住。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dayKey } from '../../lib/clock.mjs'
import { appendVerifyToReport, parseLedger, verifyOne, verifyRecent } from '../../lib/verify.mjs'

const CRED = { sessdata: 's', bili_jct: 'j', buvid3: 'b' }

/** 把 global.fetch 换成一个按 URL 分派的假实现；返回还原函数 */
function stubFetch(handler) {
  const real = globalThis.fetch
  globalThis.fetch = async (url) => ({ text: async () => JSON.stringify(handler(String(url))) })
  return () => { globalThis.fetch = real }
}

/** 断言：文字里出现的每一次「没发出去」都必须紧跟在「不等于」后面 */
function assertNeverClaimsNotSent(text, where) {
  for (const m of text.matchAll(/没发出去/g)) {
    const before = text.slice(Math.max(0, m.index - 4), m.index)
    assert.match(before, /不等于$/, `${where}：只能说「不等于没发出去」，不能断言没发出去：${text}`)
  }
}

test('台账里认得出 BV 号、rpid、楼中楼 root 和正文', () => {
  const rows = parseLedger([
    '- 2026-11-02 18:30 BV1xx411c7mD rpid=123 · 他说的那个坑我也踩过',
    '- 2026-11-02 18:31 BV1yy411c7mE rpid=456 root=123 · 同问',
    '这行没有 BV 号，跳过',
  ].join('\n'))

  assert.equal(rows.length, 2)
  assert.equal(rows[0].bv, 'BV1xx411c7mD')
  assert.equal(rows[0].rpid, 123)
  assert.equal(rows[0].root, 0)
  assert.match(rows[0].text, /坑我也踩过/)
  assert.equal(rows[1].root, 123)
})

test('没有 rpid：写「未取到 rpid」，不查也不猜', async () => {
  const restore = stubFetch(() => { throw new Error('不该发请求') })
  try {
    const r = await verifyOne({ bv: 'BV1xx411c7mD', rpid: 0, root: 0, text: '' })
    assert.equal(r.visible, null)
    assert.match(r.note, /未取到 rpid/)
  } finally { restore() }
})

test('查到了 ⇒ 公开可见并带上赞数', async () => {
  const restore = stubFetch((url) => {
    if (url.includes('/x/web-interface/view')) return { code: 0, data: { aid: 42, owner: { mid: 1 } } }
    return { code: 0, data: { replies: [{ rpid: 123, like: 7, invisible: false }] } }
  })
  try {
    const r = await verifyOne({ bv: 'BV1xx411c7mD', rpid: 123, root: 0, text: '' })
    assert.equal(r.visible, true)
    assert.equal(r.likes, 7)
  } finally { restore() }
})

test('查不到 ⇒ 只能是「没查到」，措辞里不许出现「没发出去」', async () => {
  const restore = stubFetch((url) => {
    if (url.includes('/x/web-interface/view')) return { code: 0, data: { aid: 42, owner: { mid: 1 } } }
    return { code: 0, data: { replies: [] } }
  })
  try {
    const r = await verifyOne({ bv: 'BV1xx411c7mD', rpid: 123, root: 0, text: '' })
    assert.equal(r.visible, null)
    assert.match(r.note, /不等于没发出去/)
    assertNeverClaimsNotSent(r.note, '顶层查不到')
  } finally { restore() }
})

test('接口标了 invisible ⇒ 明确不可见，不是「没查到」', async () => {
  const restore = stubFetch((url) => {
    if (url.includes('/x/web-interface/view')) return { code: 0, data: { aid: 42, owner: { mid: 1 } } }
    return { code: 0, data: { replies: [{ rpid: 123, like: 0, invisible: true }] } }
  })
  try {
    const r = await verifyOne({ bv: 'BV1xx411c7mD', rpid: 123, root: 0, text: '' })
    assert.equal(r.visible, false)
    assert.match(r.note, /invisible/)
  } finally { restore() }
})

test('楼中楼查不到时也不许断言没发出去', async () => {
  const restore = stubFetch((url) => {
    if (url.includes('/x/web-interface/view')) return { code: 0, data: { aid: 42, owner: { mid: 1 } } }
    return { code: 0, data: { replies: [{ rpid: 999, like: 1 }] } }
  })
  try {
    const r = await verifyOne({ bv: 'BV1xx411c7mD', rpid: 123, root: 55, text: '' })
    assert.equal(r.visible, null)
    assert.match(r.how, /楼中楼/)
    assertNeverClaimsNotSent(r.note, '楼中楼查不到')
  } finally { restore() }
})

test('verifyRecent 的整段文字：独立小节 + 逐条结论，没 rpid 的那条照写「未取到 rpid」', async () => {
  const home = mkdtempSync(join(tmpdir(), 'caifeng-verify-'))
  const layout = { home, out: join(home, 'out') }
  writeFileSync(join(home, 'comments.md'), [
    '- 2026-11-02 18:30 BV1xx411c7mD rpid=123 · 第一条',
    '- 2026-11-02 18:31 BV1yy411c7mE · 第二条没回执',
  ].join('\n'), 'utf8')

  const restore = stubFetch((url) => {
    if (url.includes('/x/web-interface/view')) {
      return url.includes('BV1xx411c7mD')
        ? { code: 0, data: { aid: 42, owner: { mid: 1 } } }
        : { code: 0, data: { aid: 43, owner: { mid: 1 } } }
    }
    return { code: 0, data: { replies: [{ rpid: 123, like: 3, invisible: false }] } }
  })

  try {
    const r = await verifyRecent(layout, CRED, { max: 6 })
    assert.match(r.text, /## 评论复核（宿主自动跑的，不是那一轮自己说的）/)
    assert.match(r.text, /rpid \*\*123\*\* —— 公开可见（赞 3）/)
    assert.match(r.text, /rpid \*\*未取到 rpid\*\*/)
    assertNeverClaimsNotSent(r.text, 'verifyRecent 全文')
  } finally { restore(); rmSync(home, { recursive: true, force: true }) }
})

test('没登录就别去核，给一句人话', async () => {
  const home = mkdtempSync(join(tmpdir(), 'caifeng-verify-'))
  try {
    const r = await verifyRecent({ home, out: join(home, 'out') }, null)
    assert.match(r.text, /还没扫码登录/)
    assert.equal(r.checked.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('复核段追加进日报后，再追加一次不会出现两遍', () => {
  const home = mkdtempSync(join(tmpdir(), 'caifeng-verify-'))
  const out = join(home, 'out')
  try {
    mkdirSync(out, { recursive: true })
    const day = dayKey()
    const report = join(out, `${day}.md`)
    writeFileSync(report, `# ${day}\n\n## 总结\n跑完了。\n`, 'utf8')

    appendVerifyToReport({ home, out }, '\n## 评论复核（宿主自动跑的，不是那一轮自己说的）\n\n- 第一次\n')
    appendVerifyToReport({ home, out }, '\n## 评论复核（宿主自动跑的，不是那一轮自己说的）\n\n- 第二次\n')

    const text = readFileSync(report, 'utf8')
    assert.equal(text.split('## 评论复核').length - 1, 1, `应该只有一段复核：\n${text}`)
    assert.match(text, /第二次/)
    assert.doesNotMatch(text, /第一次/)
    assert.match(text, /## 总结/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('日报还不存在时不硬造一份', () => {
  const home = mkdtempSync(join(tmpdir(), 'caifeng-verify-'))
  try {
    const out = join(home, 'out')
    mkdirSync(out, { recursive: true })
    assert.equal(appendVerifyToReport({ home, out }, '一段复核'), null)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
