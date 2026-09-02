/**
 * T-sessions: /sessions 过滤测试（归档 + 子代理不列）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBridge } from './bridge.js'

// 临时 DSH_HOME，构造 workspace.json 归档
function makeHome(archived = []) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: archived, workspaceIds: [], initialized: true },
  }), 'utf8')
  return home
}

function makeRoot(id, { dep = 0 } = {}) {
  return {
    session: { id, title: `root-${id}`, header: { cwd: '/tmp', delegationDepth: dep }, events: [] },
    followup: async () => {},
  }
}

function makeCtx({ roots = [], records = [] }) {
  const listeners = {}
  const ctx = {
    on: (evt, fn) => { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn) },
    emit: (evt, ...args) => { for (const fn of listeners[evt] || []) fn(...args) },
    agents: {
      roots: () => roots,
      get: (id) => roots.find((r) => r.session.id === id) ?? null,
      resume: async () => { throw new Error('x') },
    },
    sessionTitle: { get: (s) => (s?.title ? { title: s.title } : null) },
    sessionQuery: null,
  }
  if (records.length) {
    ctx.sessionQuery = {
      listSessions: async () => records,
      readTitle: async (id) => records.find((r) => (r.header ?? r).id === id)?.title,
    }
  }
  return { ctx }
}

function makeBridge(ctx, cwd) {
  const sent = []
  const channel = { say: async (w, t) => sent.push({ w, t }) }
  const auth = {
    isAllowed: () => true, audit: () => {}, setBinding: () => {},
    getBinding: () => null, windowsForSession: () => [],
  }
  const bridge = new SessionBridge(ctx, { push: {} }, channel, auth, { info() {}, warn() {} })
  bridge.start()
  return { bridge, channel: { sent } }
}

test('归档会话不出现（含活 root 归档 + 冷会话归档）', async () => {
  const home = makeHome(['arch-1'])
  const rootArch = makeRoot('arch-1') // 活 root 但归档
  const rootLive = makeRoot('live-roots')
  const { ctx } = makeCtx({ roots: [rootArch, rootLive], records: [] })
  process.env.DSH_HOME = home
  const { bridge, channel } = makeBridge(ctx)
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/sessions' })
  const out = channel.sent[0].t
  assert.ok(!out.includes('arch-1'))
  assert.ok(out.includes('live-roots'))
})

test('子代理会话（delegationDepth>0）不出现', async () => {
  const home = makeHome([])
  const root = makeRoot('root-1')
  const sub = makeRoot('sub-1', { dep: 1 }) // 子代理
  const { ctx } = makeCtx({ roots: [root, sub], records: [] })
  process.env.DSH_HOME = home
  const { bridge, channel } = makeBridge(ctx)
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/sessions' })
  const out = channel.sent[0].t
  assert.ok(out.includes('root-1'))
  assert.ok(!out.includes('sub-1'))
})

test('冷会话中归档/子代理也不列（sessionQuery 记录）', async () => {
  const home = makeHome(['cold-arch'])
  const records = [
    { header: { id: 'cold-arch', cwd: '/tmp', delegationDepth: 0 }, title: '冷归档' },
    { header: { id: 'cold-sub', cwd: '/tmp', delegationDepth: 2 }, title: '冷子代理' },
    { header: { id: 'cold-ok', cwd: '/tmp', delegationDepth: 0 }, title: '正常冷会话' },
  ]
  const { ctx } = makeCtx({ roots: [], records })
  process.env.DSH_HOME = home
  const { bridge, channel } = makeBridge(ctx)
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/sessions' })
  const out = channel.sent[0].t
  assert.ok(out.includes('正常冷会话'))
  assert.ok(!out.includes('冷归档'))
  assert.ok(!out.includes('冷子代理'))
})
test('QQ 机器人工作区会话（AI_Bot）不列出', async () => {
  const home = makeHome([])
  const records = [
    { header: { id: 'main-1', cwd: '/home/user/workspace-main', delegationDepth: 0 }, title: '主工作区' },
    { header: { id: 'qq-1', cwd: '/home/user/AI_Bot/qq-bridge/state/agents', delegationDepth: 0 }, title: 'QQ机器人' },
    { header: { id: 'main-2', cwd: '/home/user/dsh-wechat', delegationDepth: 0 }, title: '其他工作区' },
  ]
  const { ctx } = makeCtx({ roots: [], records })
  process.env.DSH_HOME = home
  const { bridge, channel } = makeBridge(ctx)
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/sessions' })
  const out = channel.sent[0].t
  assert.ok(out.includes('主工作区'))
  assert.ok(!out.includes('QQ机器人'))
  assert.ok(out.includes('其他工作区'))
})
