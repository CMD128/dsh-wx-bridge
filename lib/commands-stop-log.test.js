/**
 * T12: /stop /log 命令测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionBridge } from './bridge.js'

function makeCtx({ cancelLog } = {}) {
  const listeners = {}
  const agent = {
    session: { id: 's-1', title: '测试', header: { cwd: '/tmp' }, events: [] },
    followup: async () => {},
  }
  const ctx = {
    on: (evt, fn) => {
      listeners[evt] = listeners[evt] || []
      listeners[evt].push(fn)
    },
    emit: (evt, ...args) => {
      for (const fn of listeners[evt] || []) fn(...args)
    },
    agents: {
      roots: () => [agent],
      get: (id) => (id === 's-1' ? agent : null),
      resume: async () => { throw new Error('no resume') },
    },
    sessionTitle: { get: () => ({ title: agent.session.title }) },
    sessionQuery: null,
    apiProxy: {
      sessions: {
        cancel: async (args) => {
          cancelLog?.push(args)
          return { ok: true }
        },
      },
    },
  }
  return { ctx, listeners, agent }
}

function makeBridge({ ctx, auth } = {}) {
  const sent = []
  const channel = { say: async (w, t) => sent.push({ w, t }) }
  const defaultAuth = {
    isAllowed: () => true,
    audit: () => {},
    setBinding: () => {},
    getBinding: (w) => (w === 'user:u-1' ? { sessionId: 's-1' } : null),
    windowsForSession: () => [],
  }
  const bridge = new SessionBridge(
    ctx,
    { push: { onSessionComplete: true } },
    channel,
    auth ?? defaultAuth,
    { info: () => {}, warn: () => {} },
  )
  bridge.start()
  return { bridge, channel: { sent }, ctx }
}

test('/stop 中断绑定会话（sessions.cancel）', async () => {
  const cancelLog = []
  const { ctx } = makeCtx({ cancelLog })
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/stop' })
  assert.equal(cancelLog.length, 1)
  assert.equal(cancelLog[0].sessionId, 's-1')
  assert.ok(channel.sent[0].t.includes('已中断') || channel.sent[0].t.includes('停止'))
})

test('/stop 未绑定会话 → 提示', async () => {
  const { ctx } = makeCtx({})
  const { bridge, channel } = makeBridge({
    ctx,
    auth: {
      isAllowed: () => true, audit: () => {}, setBinding: () => {},
      getBinding: () => null, windowsForSession: () => [],
    },
  })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/stop' })
  assert.ok(channel.sent[0].t.includes('未绑定'))
})

test('/log 无输出记录 → 提示', async () => {
  const { ctx } = makeCtx({})
  const { bridge, channel } = makeBridge({ ctx })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/log' })
  assert.ok(channel.sent[0].t.includes('暂无输出记录'))
})

test('/log 显示环形缓冲输出', async () => {
  const { ctx, agent } = makeCtx({})
  const { bridge, channel } = makeBridge({ ctx })
  // 先注册监听（makeBridge 的 start() 已注册），再 emit 两条输出
  ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一条输出' }] } } })
  ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二条输出' }] } } })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/log' })
  assert.ok(channel.sent[0].t.includes('第一条输出'))
  assert.ok(channel.sent[0].t.includes('第二条输出'))
})
test('/detail N 显示会话模型与推送状态', async () => {
  const cancelLog = []
  const { ctx, agent } = makeCtx({ cancelLog })
  const sent = []
  const channel = { say: async (w, t) => sent.push({ w, text: t }) }
  const auth = { isAllowed: () => true, audit: () => {}, setBinding: () => {}, getBinding: () => null, windowsForSession: () => [] }
  const bridge = new SessionBridge(ctx, { push: { onSessionComplete: true, sessionOn: { 's-1': false } } }, channel, auth, { info() {}, warn() {} })
  bridge.start()
  ctx.apiProxy.sessions.models = async () => ({ ok: true, value: { selected: { provider: 'commandcode', model: 'gpt-5.6-sol' } } })
  // 先 /sessions 填充 lastList
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/sessions' })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/detail 1' })
  const out = sent[sent.length - 1].text
  assert.ok(out.includes('测试'))
  assert.ok(out.includes('gpt-5.6-sol'))
  assert.ok(out.includes('推送：⛔ 关')) // sessionOn['s-1']=false 覆盖全局
})

test('按会话推送开关：sessionOn 覆盖全局（开→关，关→开）', () => {
  const { ctx } = makeCtx({})
  const sent = []
  const channel = { say: async () => {} }
  const auth = { isAllowed: () => true, audit: () => {}, setBinding: () => {}, getBinding: () => null, windowsForSession: () => [] }
  const b1 = new SessionBridge(ctx, { push: { onSessionComplete: true, sessionOn: { 's-1': false } } }, channel, auth, { info() {}, warn() {} })
  assert.equal(b1.pushEnabledFor('s-1'), false) // 覆盖为关
  assert.equal(b1.pushEnabledFor('s-2'), true) // 未覆盖用全局开
  const b2 = new SessionBridge(ctx, { push: { onSessionComplete: false, sessionOn: { 's-1': true } } }, channel, auth, { info() {}, warn() {} })
  assert.equal(b2.pushEnabledFor('s-1'), true) // 覆盖为开
  assert.equal(b2.pushEnabledFor('s-2'), false) // 未覆盖用全局关
})
