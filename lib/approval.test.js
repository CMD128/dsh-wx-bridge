/**
 * T10: 审批文字化 + 授权码测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalBridge } from './approval.js'

function setup({ config } = {}) {
  const listeners = {}
  const ctx = {
    on: (evt, fn) => {
      listeners[evt] = listeners[evt] || []
      listeners[evt].push(fn)
    },
    emit: (evt, ...args) => {
      for (const fn of listeners[evt] || []) fn(...args)
    },
  }
  const sent = []
  const channel = { say: async (w, t) => sent.push({ w, t }) }
  const auth = {
    windowsForSession: (sid) => (sid === 's-1' ? ['user:u-1'] : []),
  }
  const bridge = new ApprovalBridge(ctx, { push: {}, approval: config?.approval ?? {} }, channel, auth, { info() {}, warn() {} })
  bridge.start()
  return { ctx, listeners, sent, bridge }
}

function makeReq({ toolName = 'bash', reason = 'run rm -rf /tmp/x' } = {}) {
  return { agent: { session: { id: 's-1', title: '测试' } }, toolName, reason }
}

test('approval/request → 微信收到文字审批', async () => {
  const { ctx, sent, bridge } = setup()
  const waiter = bridge.handleApproval(makeReq({ toolName: 'bash', reason: 'rm -rf /tmp/x' }))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(sent.length, 1)
  assert.ok(sent[0].w === 'user:u-1')
  assert.ok(sent[0].t.includes('bash'))
  assert.ok(sent[0].t.includes('rm -rf /tmp/x'))
  assert.ok(sent[0].t.includes('/approve'))
  // 释放审批（否则测试挂起）
  bridge.dropAll()
  await waiter
})

test('/approve 批准 → resolve allowed-once', async () => {
  const { ctx, bridge } = setup()
  let outcome
  const waiter = bridge.handleApproval(makeReq()).then((o) => { outcome = o })
  await new Promise((r) => setTimeout(r, 10))
  await bridge.decideApproval('user:u-1', 'allowed-once')
  await waiter
  assert.equal(outcome, 'allowed-once')
})

test('/reject 拒绝 → resolve rejected', async () => {
  const { ctx, bridge } = setup()
  let outcome
  const waiter = bridge.handleApproval(makeReq()).then((o) => { outcome = o })
  await new Promise((r) => setTimeout(r, 10))
  await bridge.decideApproval('user:u-1', 'rejected')
  await waiter
  assert.equal(outcome, 'rejected')
})

test('非绑定会话的审批不拦截（返回 undefined）', async () => {
  const { ctx, bridge, sent } = setup()
  const req = { agent: { session: { id: 's-other', title: '别处' } }, toolName: 'bash', reason: 'x' }
  const outcome = await bridge.handleApproval(req)
  assert.equal(outcome, undefined)
  assert.equal(sent.length, 0)
})

test('授权码开启：/approve 无码不放行，带码才放行', async () => {
  const { bridge } = setup({ config: { approval: { enabled: true, authCode: '1234' } } })
  // 建立 pending
  const waiter = bridge.handleApproval(makeReq())
  await new Promise((r) => setTimeout(r, 10))
  // 无码
  const r1 = bridge.decideApproval('user:u-1', 'allowed-once')
  assert.equal(r1, false) // 授权码模式需要码
  // 错误码
  const r2 = bridge.decideApproval('user:u-1', 'allowed-once', '9999')
  assert.equal(r2, false)
  // 正确码
  const r3 = bridge.decideApproval('user:u-1', 'allowed-once', '1234')
  assert.equal(r3, undefined) // 已处理
  await waiter
})

test('授权码关闭（默认）：/approve 直接放行', async () => {
  const { bridge } = setup()
  let outcome
  const waiter = bridge.handleApproval(makeReq()).then((o) => { outcome = o })
  await new Promise((r) => setTimeout(r, 10))
  const r = bridge.decideApproval('user:u-1', 'allowed-once')
  assert.equal(r, undefined) // 已处理
  await waiter
  assert.equal(outcome, 'allowed-once')
})

test('无待审批时 /approve 返回错误提示', async () => {
  const { bridge } = setup()
  const r = await bridge.decideApproval('user:u-1', 'allowed-once', undefined, true)
  assert.equal(r, '当前没有等待审批的请求。')
})