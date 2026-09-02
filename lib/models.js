/**
 * ModelCatalog: 模型目录 — llm.models RPC + settings 视觉标记合并。
 *
 * 数据源：
 *  1. api.llm.models() → { groups: [{ id, name, models: [{ id, name, description?, reasoning? }] }] }
 *  2. visionModels()  → { 'provider/model': true }（来自 settings 配置的 input 字段）
 *
 * 提供：providers 列表、某 provider 模型列表、关键词搜索、--vision/--ctx 筛选、快捷路径 2/1。
 */
export class ModelCatalog {
  constructor(api, visionLoader = { visionModels: () => ({}) }, logger = { warn() {} }) {
    this.api = api
    this.visionLoader = visionLoader
    this.logger = logger
    this.cache = null // { providers, modelsByProvider, allModels }
  }

  async load() {
    if (this.cache) return this.cache
    try {
      const resp = await this.api.llm.models({})
      const groups = resp?.groups ?? []
      const vision = this.visionLoader.visionModels?.() ?? {}
      const providers = groups.map((g, gi) => ({
        id: g.id,
        name: g.name ?? g.id,
        modelCount: (g.models ?? []).length,
        hasVision: (g.models ?? []).some((m) => vision[`${g.id}/${m.id}`]),
      }))
      const modelsByProvider = new Map()
      const allModels = []
      for (const [gi, g] of groups.entries()) {
        const list = (g.models ?? []).map((m) => {
          const key = `${g.id}/${m.id}`
          return {
            provider: g.id,
            providerIndex: gi + 1,
            id: m.id,
            name: m.name ?? m.id,
            description: m.description ?? null,
            reasoningEfforts: (m.reasoning?.efforts ?? []).map((e) => e.id ?? e),
            hasVision: Boolean(vision[key]),
            // 从 description 推断上下文（如 "FREE · 1M" → 1048576）；无则 null
            inferredCtx: inferContext(m.description),
          }
        })
        modelsByProvider.set(g.id, list)
        allModels.push(...list)
      }
      this.cache = { providers, modelsByProvider, allModels }
      return this.cache
    } catch (error) {
      this.logger.warn(`dsh-wechat: model catalog load failed: ${error?.message ?? error}`)
      return { providers: [], modelsByProvider: new Map(), allModels: [] }
    }
  }

  async providers() {
    return (await this.load()).providers
  }

  async modelsOf(providerId) {
    return (await this.load()).modelsByProvider.get(providerId) ?? []
  }

  /** 关键词搜索 + 筛选。query 为空 = 只要筛选；无 query 无筛选 = 全部。 */
  async search(query = '', filters = {}) {
    const { allModels } = await this.load()
    const q = query.trim().toLowerCase()
    let out = allModels
    if (q) {
      out = out.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    }
    if (filters.vision) out = out.filter((m) => m.hasVision)
    if (filters.minCtx) out = out.filter((m) => (m.inferredCtx ?? 0) >= filters.minCtx)
    if (filters.effort) {
      const e = String(filters.effort).toLowerCase()
      out = out.filter((m) => (m.reasoningEfforts ?? []).includes(e))
    }
    return out
  }

  /** 快捷路径 "2/1" → 第2个 provider 的第1个模型 */
  async resolveShortcut(expr) {
    const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(expr).trim())
    if (!match) return null
    const gi = Number(match[1]) - 1
    const mi = Number(match[2]) - 1
    const providers = await this.providers()
    const p = providers[gi]
    if (!p) return null
    const models = await this.modelsOf(p.id)
    const m = models[mi]
    return m ?? null
  }

  /** 模型展示标签（⚡视觉 / ctx / effort 列表），供列表与回显复用。 */
  describeTags(m) {
    return [
      m.hasVision ? '⚡视觉' : '',
      m.inferredCtx ? `${inferCtxLabel(m.inferredCtx)}` : '',
      m.reasoningEfforts?.length ? `[${m.reasoningEfforts.join('/')}]` : '',
    ].filter(Boolean).join(' ')
  }
}

/** 从描述推断上下文窗口（如 "FREE · 256K" → 262144；"1M" → 1048576）。 */
function inferContext(description) {
  if (!description) return null
  const m1 = /(\d+(?:\.\d+)?)\s*K/i.exec(description)
  if (m1) return Math.round(Number(m1[1]) * 1024)
  const m2 = /(\d+(?:\.\d+)?)\s*M/i.exec(description)
  if (m2) return Math.round(Number(m2[1]) * 1024 * 1024)
  return null
}

/** 字节 → 人类可读上下文标签（"1M"/"256K"）。 */
export function inferCtxLabel(bytes) {
  if (!bytes) return null
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)}M`
  return `${Math.round(bytes / 1024)}K`
}