/**
 * lib/diagnose.mjs —— 把"这一轮为什么没跑起来"从日志尾部翻成人话
 * ============================================================================
 * 起因：`dsh: NO_ADAPTER: no adapter registered for provider "xxx"` 这种话，
 * 出现在日志里等于没解释 —— 那一轮 1 秒就退出，用户只看到"失败"，以为插件坏了。
 *
 * 设计约束（刻意压到最小面积）：
 *   · **纯函数**：只吃一段字符串、吐一个对象（或 null），不读文件、不抛异常
 *   · **只在"该有报告却没有"时被调用**（跑通那条路根本不经过它）
 *   · **认不出来就返回 null** ⇒ 调用方走原来的兜底文案
 * ============================================================================
 */

/**
 * @param {string} tail 这一轮日志的尾部
 * @returns {{title:string, body:string, hint:string} | null}
 */
export function diagnoseRound(tail) {
  const t = String(tail || '')
  if (!t) return null

  // ① 模型提供方没有驱动
  const noAdapter =
    t.match(/no adapter registered for provider\s+"([^"]+)"/i) ||
    t.match(/NO_ADAPTER[^\n]*provider\s+"([^"]+)"/i)
  if (noAdapter) {
    const p = String(noAdapter[1] || '').trim()
    return {
      title: `这一轮的模型提供方没注册驱动：${p}`,
      hint: 'NO_ADAPTER',
      body: [
        `它一启动就退出了 —— 不是不会采，而是**那一轮要用的模型提供方 \`${p}\`，在它跑的那个 profile 里没有对应的驱动**。`,
        '',
        '提供方的"配置"可能是全局的，但"注册这个提供方的驱动"是每个 profile 各装各的。',
        '',
        '**怎么办**：去设置页「采风 → 运行环境 → 模型」，换成官方那个，或者把注册该提供方的插件也装进 `caifeng-duty` 这个 profile。',
        '',
        '> 这类失败是环境配置，不是插件坏了。改完不用重装，直接再点一次「现在就跑」。',
      ].join('\n'),
    }
  }

  // ② 没有可用凭据
  if (/MISSING_CREDENTIAL|missing credential|no api key|Unauthorized|E401|\b401\b/i.test(t)) {
    return {
      title: '这一轮没有可用的模型凭据',
      hint: 'NO_CREDENTIAL',
      body: [
        '它启动后没能拿到模型凭据就退了。',
        '',
        '**怎么办**：去 DSH 设置里确认已登录 / 已填 API key，然后再跑一次。凭据是宿主那一层的事，插件读不到、也不该替你填。',
      ].join('\n'),
    }
  }

  // ③ 找不到 dsh
  if (/9009|不是内部或外部命令|could not be found|cannot find the file|ENOENT/i.test(t) && /dsh/i.test(t)) {
    return {
      title: '这一轮找不到 dsh 可执行文件',
      hint: 'NO_DSH',
      body: [
        '桌面版多半不是 npm 全局安装，PATH 里没有 `dsh`。',
        '',
        '**怎么办**：设一个环境变量 `DSH_CLI` 指到 dsh 的入口（例如应用目录里的 `@deepseek-ai/dsh/lib/bin.js`），或者把它的目录加进 PATH。',
      ].join('\n'),
    }
  }

  // ④ Python 侧起不来（我们这个插件特有的最常见一种）
  if (/ModuleNotFoundError|No module named|python(?:\.exe)?['"]?: not found|No such file or directory.*python/i.test(t)) {
    return {
      title: '这一轮 Python 那边没起来',
      hint: 'NO_PYTHON',
      body: [
        'B站 的搜索/字幕/评论靠 Python 侧，它没起来，所以这一轮手里没有工具。',
        '',
        '**怎么办**：去设置页「采风 → 运行环境 → Python 环境」点一次「装 Python 环境」，装完再跑。',
        '如果已经装过，看一下路径还在不在（换机器或删过 `.venv` 都会让它失效）。',
      ].join('\n'),
    }
  }

  // ⑤ MCP 起不来
  if (/mcp|stdio server|initialize.*timed? ?out/i.test(t) && /(error|failed|timeout|退出)/i.test(t)) {
    return {
      title: '这一轮 MCP 服务没接上',
      hint: 'NO_MCP',
      body: [
        '那一轮的工具是从 MCP 来的，MCP 没起来就等于没有工具。',
        '',
        '**怎么办**：先看 B站 那边的 Python 环境装好没有；抖音那边要有 Edge 和登录态。',
        '两条信源各自独立 —— 一条挂了另一条还能跑，日报里会写明这一轮只用了哪一边。',
      ].join('\n'),
    }
  }

  // ⑥ 提示词变量没有值
  const noVar = t.match(/prompt variable\s+"?([\w.{}$-]+)"?\s+has no value/i)
  if (noVar) {
    return {
      title: `提示词变量 \`${noVar[1]}\` 没有值`,
      hint: 'NO_VAR',
      body: [
        '多半是那个 profile 的模型 / 会话没绑好。',
        '',
        '**怎么办**：换一个新会话，或重启一次 DSH 再试。',
      ].join('\n'),
    }
  }

  return null
}

/**
 * 一句话结论（设置页那个「诊断」按钮直接显示这个）。
 * @param {{ok:boolean, code?:any, text?:string}} lastRun 上一轮结果
 * @param {string} logTail 日志尾部
 */
export function oneLineVerdict(lastRun, logTail) {
  if (!lastRun) return '还没跑过。点右上角「现在就跑」试试。'
  if (lastRun.ok) return '上一轮正常结束。'
  const d = diagnoseRound(lastRun.text || logTail)
  if (d) return d.title
  const code = lastRun.code
  if (code === 'no_source') return '还没有信源，跑不了 —— 少了一头的工具。'
  if (code === 'no_charter') return '章程文件不见了，这一轮没法跑。'
  if (code === 'no_dsh') return '找不到 dsh 可执行文件。'
  if (code === 'locked') return '另一个窗口正在跑，这一轮跳过了。'
  if (code === 'busy') return '上一轮还没跑完。'
  if (code === 'quota') return '今天的额度用完了。'
  if (code === 'cooldown') return '刚跑过，还在冷却里。'
  return `上一轮失败了（${code}）。展开日志看看。`
}
