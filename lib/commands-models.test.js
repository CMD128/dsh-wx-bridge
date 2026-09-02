/**
 * T9: bridge 模型切换命令测试（/model /default-model）— mock apiProxy + models。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionBridge } from './bridge.js'
import { ModelCatalog } from './models.js'

function makeCtx({ selectModelLog, defaultModelLog }) {
  const listeners = {}
  const ctx = {
    on: (evt, fn) => {
      listeners[evt] = listeners[evt] || []
      listeners[evt].push(fn)
    },
    emit: (evt, ...args) => {
      for (const fn of listeners[evt] || []) fn(...args)
    },
    agents: {
      roots: () => [],
      get: () => null,
      resume: async () => { throw new Error('no resume') },
    },
    sessionTitle: { get: () => null },
    sessionQuery: null,
    apiProxy: {
      sessions: {
        selectModel: async (args) => {
          selectModelLog.push(args)
          return { ok: true, value: { selected: { provider: args.provider, model: args.model } } }
        },
      },
      llm: {
        models: async () => ({
          groups: [
            { id: 'commandcode', name: 'Command Code', models: [
              { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
              { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'FREE · 1M' },
            ] },
            { id: 'opencode-go-gmali', name: 'opencode-go-gmali', models: [
              { id: 'kimi-k3', name: 'Kimi K3' },
            ] },
          ],
          failures: [],
        }),
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'commandcode', model: 'gpt-5.6-sol' }),
      saveSelection: async (next) => {
        defaultModelLog.push(next)
      },
    },
  }
  return { ctx, listeners }
}

function makeBridge({ ctx, auth } = {}) {
  const channel = {
    say: async (windowKey, text) => {
      channel.sent.push({ windowKey, text })
    },
    sent: [],
  }
  const defaultAuth = {
    isAllowed: () => true,
    audit: () => {},
    setBinding: () => {},
    getBinding: (w) => (w === 'user:u-1' ? { sessionId: 's-1' } : null),
    windowsForSession: () => [],
  }
  const bridge = new SessionBridge(
    ctx ?? makeCtx({}).ctx,
    { push: { onSessionComplete: true } },
    channel,
    auth ?? defaultAuth,
    { info: () => {}, warn: () => {} },
  )
  // 注入模型目录
  bridge.models = new ModelCatalog((ctx ?? makeCtx({}).ctx).apiProxy, { visionModels: () => ({}) }, { warn() {} })
  return { bridge, channel, ctx: ctx ?? makeCtx({}).ctx }
}

function bindToSession(ctx) {
  // agents.get 返回一个活 agent 供 /model 用
  ctx.agents.get = (id) => (id === 's-1' ? { session: { id: 's-1', title: 'Test', header: { cwd: '/tmp' }, events: [] }, followup: async () => {} } : null)
  ctx.agents.roots = () => [{ session: { id: 's-1', title: 'Test', header: { cwd: '/tmp' }, events: [] }, followup: async () => {} }]
}

test('/model 无参数 → 列出提供商（树状一级）', async () => {
  const { ctx } = makeCtx({})
  bindToSession(ctx)
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/model' })
  const out = channel.sent[0].text
  assert.ok(out.includes('1. Command Code'))
  assert.ok(out.includes('2. opencode-go-gmali'))
})

test('/model 2 → 列出该提供商模型', async () => {
  const { ctx } = makeCtx({})
  bindToSession(ctx)
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/model 2' })
  const out = channel.sent[0].text
  assert.ok(out.includes('kimi-k3'))
})

test('/model 2/1 → 切换会话模型并回显确认', async () => {
  const { ctx } = makeCtx({})
  const selectLog = []
  ctx.apiProxy.sessions.selectModel = async (args) => {
    selectLog.push(args)
    return { ok: true, value: { selected: { provider: args.provider, model: args.model } } }
  }
  bindToSession(ctx)
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/model 2/1' })
  assert.equal(selectLog.length, 1)
  assert.equal(selectLog[0].sessionId, 's-1')
  assert.equal(selectLog[0].provider, 'opencode-go-gmali')
  assert.equal(selectLog[0].model, 'kimi-k3')
  assert.ok(channel.sent[0].text.includes('已切换'))
  assert.ok(channel.sent[0].text.includes('kimi-k3'))
})

test('/model 关键词 → 搜索并切换第一个命中', async () => {
  const { ctx } = makeCtx({})
  const selectLog = []
  ctx.apiProxy.sessions.selectModel = async (args) => {
    selectLog.push(args)
    return { ok: true, value: { selected: { provider: args.provider, model: args.model } } }
  }
  bindToSession(ctx)
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/model k3' })
  assert.equal(selectLog.length, 1)
  assert.equal(selectLog[0].model, 'kimi-k3')
  assert.ok(channel.sent[0].text.includes('已切换'))
})

test('/model --vision → 只列视觉模型', async () => {
  const { ctx } = makeCtx({})
  bindToSession(ctx)
  ctx.apiProxy = { ...ctx.apiProxy }
  ctx.apiProxy.llm.models = async () => ({
    groups: [
      { id: 'opencode-go-gmali', name: 'opencode', models: [
        { id: 'kimi-k3', name: 'Kimi K3' },
        { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus' },
      ] },
    ],
    failures: [],
  })
  let bridge2, channel2
  {
    const sent = []
    const ch = {
      say: async (w, t) => {
        sent.push({ w, text: t })
      },
    }
    const b = new SessionBridge(ctx, { push: {} }, ch, { isAllowed: () => true, audit: () => {}, setBinding: () => {}, getBinding: (w) => (w === 'user:u-1' ? { sessionId: 's-1' } : null), windowsForSession: () => [] }, { info() {}, warn() {} })
    b.models = new ModelCatalog(ctx.apiProxy, { visionModels: () => ({ 'opencode-go-gmali/kimi-k3': true }) }, { warn() {} })
    bridge2 = b
    channel2 = { sent }
  }
  await bridge2.handleInbound({ windowKey: 'user:u-1', text: '/model --vision' })
  const out = channel2.sent[0]?.text ?? ''
  assert.ok(out.includes('kimi-k3'))
  assert.ok(!out.includes('qwen3.7-plus'))
})

test('/default-model 2/1 → 设全局默认', async () => {
  const { ctx } = makeCtx({})
  const dmLog = []
  ctx.agentDefaultModel.saveSelection = async (next) => { dmLog.push(next) }
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/default-model 2/1' })
  assert.equal(dmLog.length, 1)
  assert.equal(dmLog[0].provider, 'opencode-go-gmali')
  assert.equal(dmLog[0].model, 'kimi-k3')
  assert.ok(channel.sent[0].text.includes('全局默认'))
})
test('/model 更多 翻页（>10 提供商时）', async () => {
  const groups = Array.from({ length: 15 }, (_, i) => ({
    id: `prov-${i}`, name: `Provider ${i}`, models: [{ id: `m-${i}`, name: `M ${i}` }],
  }))
  const { ctx } = makeCtx({})
  bindToSession(ctx)
  ctx.apiProxy.llm.models = async () => ({ groups, failures: [] })
  const { bridge, channel } = makeBridge({ ctx })
  try {
    await bridge.handleInbound({ windowKey: 'user:u-1', text: '/model' })
  } catch (e) { console.log('DEBUG ERR:', e.message); throw e }
  const page1 = channel.sent[0].text
  assert.ok(page1.includes('1. Provider 0'))
  assert.ok(page1.includes('更多'))
  assert.ok(!page1.includes('Provider 10'))
  // 翻页
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/model 更多' })
  const page2 = channel.sent[channel.sent.length - 1].text
  assert.ok(page2.includes('11. Provider 10'))
})

test('/preset 无参数 → 列出可用 preset', async () => {
  const { ctx } = makeCtx({})
  bindToSession(ctx)
  ctx.apiProxy.agentPresets = {
    list: async () => ({ ok: true, value: { presets: [{ id: 'standard', name: 'Standard' }, { id: 'catgirl', name: '猫娘' }] } }),
    select: async () => ({ ok: true }),
  }
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/preset' })
  const out = channel.sent[channel.sent.length - 1].text
  assert.ok(out.includes('catgirl'))
  assert.ok(out.includes('standard'))
})

test('/preset catgirl → 切换当前会话 preset', async () => {
  const { ctx } = makeCtx({})
  bindToSession(ctx)
  const selectLog = []
  ctx.apiProxy.agentPresets = {
    list: async () => ({ ok: true, value: { presets: [{ id: 'catgirl', name: '猫娘' }] } }),
    select: async (args) => { selectLog.push(args); return { ok: true } },
  }
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/preset catgirl' })
  assert.equal(selectLog.length, 1)
  assert.equal(selectLog[0].sessionId, 's-1')
  assert.equal(selectLog[0].agentPreset, 'catgirl')
  assert.ok(channel.sent[channel.sent.length - 1].text.includes('猫娘'))
})

test('/preset 未知名 → 提示', async () => {
  const { ctx } = makeCtx({})
  bindToSession(ctx)
  ctx.apiProxy.agentPresets = {
    list: async () => ({ ok: true, value: { presets: [{ id: 'standard', name: 'Standard' }] } }),
    select: async () => ({ ok: true }),
  }
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/preset nonexistent' })
  assert.ok(channel.sent[channel.sent.length - 1].text.includes('找不到'))
})
