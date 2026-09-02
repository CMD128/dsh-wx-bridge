/**
 * T8: models 模型目录测试 — mock llm.models RPC + settings 视觉标记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalog } from './models.js'

/** 模拟 llm.models RPC 返回 */
function makeCatalog({ modelsRpc, visionMap = {}, settingsNs } = {}) {
  const api = {
    llm: {
      models: async () => ({
        groups: modelsRpc ?? [
          { id: 'commandcode', name: 'Command Code', models: [
            { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
            { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'FREE · 1M' },
          ] },
          { id: 'opencode-go-gmali', name: 'opencode-go-gmali', models: [
            { id: 'kimi-k3', name: 'Kimi K3' },
            { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus' },
          ] },
        ],
        failures: [],
      }),
    },
  }
  const catalog = new ModelCatalog(api, {
    visionModels: () => visionMap,
  })
  return { catalog, api }
}

test('模型目录解析：groups → providers', async () => {
  const { catalog } = makeCatalog()
  const providers = await catalog.providers()
  assert.equal(providers.length, 2)
  assert.equal(providers[0].id, 'commandcode')
  assert.equal(providers[0].modelCount, 2)
})

test('provider 模型列表带元数据', async () => {
  const { catalog } = makeCatalog()
  const models = await catalog.modelsOf('commandcode')
  assert.equal(models.length, 2)
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'high'])
  assert.equal(models[1].hasVision, false)
})

test('vision 标记合并（来自 settings input 字段）', async () => {
  const { catalog } = makeCatalog({
    visionMap: { 'opencode-go-gmali/kimi-k3': true },
  })
  const models = await catalog.modelsOf('opencode-go-gmali')
  assert.equal(models[0].hasVision, true) // kimi-k3
  assert.equal(models[1].hasVision, false) // qwen3.7-plus
})

test('关键词搜索：id/name 匹配', async () => {
  const { catalog } = makeCatalog()
  const hits = await catalog.search('k3')
  assert.ok(hits.length >= 1)
  assert.ok(hits.every((m) => m.id.includes('k3') || m.name.includes('k3')))
})

test('--vision 筛选：只返回视觉模型', async () => {
  const { catalog } = makeCatalog({
    visionMap: { 'opencode-go-gmali/kimi-k3': true },
  })
  const hits = await catalog.search('', { vision: true })
  assert.ok(hits.length >= 1)
  assert.ok(hits.every((m) => m.hasVision))
})

test('--ctx 筛选：contextWindow 或 description 推断 ≥ 阈值', async () => {
  const { catalog } = makeCatalog()
  const hits = await catalog.search('', { minCtx: 1000000 })
  // description "FREE · 1M" → 1M = 1048576 应命中
  assert.ok(hits.some((m) => m.id === 'deepseek/deepseek-v4-flash'))
})

test('快捷路径解析 2/1 → provider2第1模型', async () => {
  const { catalog } = makeCatalog()
  const m = await catalog.resolveShortcut('2/1')
  assert.ok(m)
  assert.equal(m.provider, 'opencode-go-gmali')
  assert.equal(m.id, 'kimi-k3')
})

test('RPC 失败返回空目录不抛错', async () => {
  const api = { llm: { models: async () => { throw new Error('rpc down') } } }
  const catalog = new ModelCatalog(api, { visionModels: () => ({}) })
  const providers = await catalog.providers()
  assert.deepEqual(providers, [])
})