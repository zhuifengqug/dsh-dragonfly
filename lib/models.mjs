/**
 * lib/models.mjs —— 模型候选：跟着宿主走，读不到就让人手填
 * ============================================================================
 * 设置页那个「模型」下拉要填的是 provider + model。两个来源：
 *
 *   1. 宿主的 llm 服务：`ctx.get('llm')` → listProviders() / listModels(id)
 *   2. 宿主当前默认：`ctx.get('agentDefaultModel')?.currentSelection?.()`
 *
 * 为什么两个都要：
 *   · 空着不填 = 跟随 DSH 当前默认，这是最常见的情况（大多数人不动这里）
 *   · 宿主 llm 服务取不到（旧版本 / 没声明 inject）时，退化成一个空列表 + 允许手填，
 *     绝不因为「列不出来」就把配置写坏或让设置页崩掉
 * ============================================================================
 */

/** 当前默认的那一对（读不到返回 null，不抛） */
export function currentDefault(ctx) {
  try {
    const sel = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
    const provider = String(sel?.provider || sel?.providerId || '').trim()
    const model = String(sel?.model || sel?.modelId || '').trim()
    const reasoning = String(sel?.reasoningEffort || '').trim()
    if (!provider && !model) return null
    return { provider, model, reasoning }
  } catch { return null }
}

/**
 * provider 列表 + 每个 provider 下的 model 列表。
 * 返回 `{ok, providers:[{id, models:[{id, reasoning?}]}], note}`。
 * `ok:false` 时 `note` 说明为什么列不出来（设置页照这句话显示，允许手填）。
 */
export async function listModels(ctx) {
  let llm
  try { llm = ctx?.get?.('llm') } catch { llm = null }
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, providers: [], note: '这一版宿主没给模型清单接口，手填就行（或者留空跟随默认）。' }
  }

  const providers = []
  let raw
  try { raw = await llm.listProviders() } catch (e) {
    return { ok: false, providers: [], note: `列 provider 失败：${e?.message || e}` }
  }
  for (const p of Array.isArray(raw) ? raw : []) {
    const id = String(p?.id || p?.providerId || '').trim()
    if (!id) continue
    const models = []
    try {
      const ms = await llm.listModels(id)
      for (const m of Array.isArray(ms) ? ms : []) {
        const mid = String(m?.id || m?.modelId || '').trim()
        if (!mid) continue
        models.push({ id: mid, reasoning: Boolean(m?.reasoning ?? m?.reasoningSupported) })
      }
    } catch { /* 这个 provider 列不出来就空着，不影响别的 */ }
    providers.push({ id, models })
  }
  if (!providers.length) {
    return { ok: false, providers: [], note: '宿主没列出任何 provider，手填吧。' }
  }
  return { ok: true, providers, note: '' }
}

/**
 * 这一轮该用哪一对模型：
 * 配置里写了就用配置的；没写就跟随宿主默认；都没有返回 `null`（让 profile 自己决定）。
 */
export function resolveModel(ctx, cfg) {
  const provider = String(cfg?.model?.provider || '').trim()
  const model = String(cfg?.model?.model || '').trim()
  if (provider && model) return { provider, model, reasoning: '', source: 'config' }
  const sel = currentDefault(ctx)
  if (sel) return { ...sel, source: 'host-default' }
  return null
}
