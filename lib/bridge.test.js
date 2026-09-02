/**
 * T4: bridge 会话桥接测试 — mock agents/sessionQuery/sessionTitle 上下文。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionBridge } from './bridge.js'

/** 构造一个最小 ctx：agents + sessionTitle + 事件发射 */
function makeCtx({ roots = [], resumeImpl } = {}) {
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
      roots: () => roots,
      get: (id) => roots.find((r) => r.session?.id === id) ?? null,
      resume: resumeImpl ?? (async ({ resumeSessionId }) => {
        throw new Error(`resume not configured for ${resumeSessionId}`)
      }),
    },
    sessionTitle: {
      get: (session) => {
        // mock 服务返回 agent.session.title（真实服务返回折叠标题）
        if (session && session.title && typeof session.title === 'string') return { title: session.title }
        return null
      },
    },
    sessionQuery: null,
  }
  return { ctx, listeners }
}

function makeAgent({ id, title = '测试会话', events = [] }) {
  return {
    session: { id, title, header: { cwd: '/tmp/ws' }, events },
    followup: async () => {},
  }
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
    getBinding: () => null,
    windowsForSession: () => [],
  }
  const bridge = new SessionBridge(
    ctx ?? makeCtx().ctx,
    { push: { onSessionComplete: true } },
    channel,
    auth ?? defaultAuth,
    { info: () => {}, warn: () => {} },
  )
  bridge.start()
  return { bridge, channel }
}

test('/help 返回帮助文本', async () => {
  const { bridge, channel } = makeBridge()
  await bridge.handleInbound({ windowKey: 'user:u-1', kind: 'contact', talkerId: 'u-1', text: '/help' })
  assert.equal(channel.sent.length, 1)
  assert.ok(channel.sent[0].text.includes('/sessions'))
  assert.ok(channel.sent[0].text.includes('/use'))
})

test('/sessions 列出现有 root 会话（含标题与状态）', async () => {
  const agent = makeAgent({ id: 's-1', title: '写周报' })
  const { bridge, channel } = makeBridge({ ctx: makeCtx({ roots: [agent] }).ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/sessions' })
  assert.equal(channel.sent.length, 1)
  assert.ok(channel.sent[0].text.includes('1. 写周报'))
})

test('/use N 绑定活会话（有 agent）', async () => {
  const agent = makeAgent({ id: 's-2', title: '修复bug' })
  const bindings = {}
  const auth = {
    isAllowed: () => true,
    audit: () => {},
    setBinding: (w, id) => { bindings[w] = id },
    getBinding: () => null,
    windowsForSession: () => [],
  }
  const { bridge, channel } = makeBridge({ ctx: makeCtx({ roots: [agent] }).ctx, auth })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/use 1' })
  assert.equal(bindings['user:u-1'], 's-2')
  assert.ok(channel.sent[0].text.includes('已绑定'))
})

test('/use 冷会话 → resume 唤醒后绑定', async () => {
  const cold = { id: 'cold-1', title: '冷会话', live: false }
  const resumeImpl = async ({ resumeSessionId }) => ({ agent: { session: { id: resumeSessionId, title: '冷会话' } } })
  const ctx = makeCtx({ roots: [], resumeImpl }).ctx
  ctx.sessionQuery = {
    listSessions: async () => [{ header: { id: 'cold-1', cwd: '/tmp' } }],
    readTitle: async () => '冷会话',
  }
  const bindings = {}
  const auth = {
    isAllowed: () => true,
    audit: () => {},
    setBinding: (w, id) => { bindings[w] = id },
    getBinding: () => null,
    windowsForSession: () => [],
  }
  const { bridge, channel } = makeBridge({ ctx, auth })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/use 1' })
  assert.equal(bindings['user:u-1'], 'cold-1')
  assert.ok(channel.sent[0].text.includes('已绑定'))
})

test('/use 不存在 → 错误提示', async () => {
  const { bridge, channel } = makeBridge()
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/use 99' })
  assert.ok(channel.sent[0].text.includes('找不到会话'))
})

test('非指令文本 → followup 到绑定会话 + "已发送"应答', async () => {
  const agent = makeAgent({ id: 's-3', title: '默认' })
  let followed = null
  agent.followup = async (msg) => { followed = msg }
  const bindings = { 'user:u-1': 's-3' }
  const auth = {
    isAllowed: () => true,
    audit: () => {},
    setBinding: () => {},
    getBinding: (w) => bindings[w] ? { sessionId: bindings[w] } : null,
    windowsForSession: () => [],
  }
  const { bridge, channel } = makeBridge({ ctx: makeCtx({ roots: [agent] }).ctx, auth })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '帮我把 README 翻译成英文' })
  assert.ok(followed, 'followup 应被调用')
  const content = followed.content[0]
  assert.equal(content.type, 'text')
  assert.equal(content.text, '帮我把 README 翻译成英文')
  assert.equal(followed.source.kind, 'plugin')
  assert.ok(channel.sent[0].text.includes('已发送'))
})

test('未绑定 → fallback 到最近活跃 root 并自动绑定', async () => {
  const agent = makeAgent({ id: 's-4', title: '最近活跃' })
  const bindings = {}
  const auth = {
    isAllowed: () => true,
    audit: () => {},
    setBinding: (w, id) => { bindings[w] = id },
    getBinding: () => null,
    windowsForSession: () => [],
  }
  const ctx = makeCtx({ roots: [agent] }).ctx
  const { bridge, channel } = makeBridge({ ctx, auth })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '你好' })
  assert.equal(bindings['user:u-1'], 's-4')
  assert.ok(channel.sent[0].text.includes('自动绑定'))
})

test('turn/end 事件 → 推送 ✅ 摘要（仅已观察到 running 的）', async () => {
  const agent = makeAgent({ id: 's-5', title: '周报' })
  const auth = {
    isAllowed: () => true,
    audit: () => {},
    setBinding: () => {},
    getBinding: () => null,
    windowsForSession: (sid) => (sid === 's-5' ? ['user:u-1'] : []),
  }
  const { bridge, channel, listeners } = (() => {
    const ctx = makeCtx({ roots: [agent] }).ctx
    const ch = { say: async (w, t) => ch.sent.push({ w, t }), sent: [] }
    const b = new SessionBridge(ctx, { push: { onSessionComplete: true } }, ch, auth, { info: () => {}, warn: () => {} })
    b.start()
    return { bridge: b, channel: ch, listeners: ctx }
  })()
  // 模拟 turn/start → assistant/message → turn/end
  listeners.emit('session/event', agent.session, { type: 'turn/start' })
  listeners.emit('session/event', agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是结果' }] } } })
  listeners.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(channel.sent.length, 1)
  assert.ok(channel.sent[0].t.includes('任务完成'))
  assert.ok(channel.sent[0].t.includes('这是结果'))
})
test('未绑定 → fallback 优先默认会话（config.defaultSessionId）', async () => {
  const agent = makeAgent({ id: 's-default', title: '默认会话' })
  const bindings = {}
  const auth = {
    isAllowed: () => true, audit: () => {}, setBinding: (w, id) => { bindings[w] = id },
    getBinding: () => null, windowsForSession: () => [],
  }
  const ctx = makeCtx({ roots: [agent] }).ctx
  const ch = { say: async (w, t) => ch.sent.push({ w, text: t }), sent: [] }
  const bridge = new SessionBridge(ctx, { push: {}, defaultSessionId: 's-default' }, ch, auth, { info() {}, warn() {} })
  bridge.start()
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '你好' })
  assert.equal(bindings['user:u-1'], 's-default')
  assert.ok(ch.sent[0].text.includes('默认会话'))
})

test('图片消息 imageNotice → 回复提示', async () => {
  const agent = makeAgent({ id: 's-img', title: '测试' })
  const ctx = makeCtx({ roots: [agent] }).ctx
  const ch = { say: async (w, t) => ch.sent.push({ w, text: t }), sent: [] }
  const bridge = new SessionBridge(ctx, { push: {} }, ch, { isAllowed: () => true, audit: () => {}, setBinding: () => {}, getBinding: () => null, windowsForSession: () => [] }, { info() {}, warn() {} })
  bridge.start()
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '', imageNotice: true })
  assert.ok(ch.sent[0].text.includes('图片'))
})
