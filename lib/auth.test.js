/**
 * T5: auth 权限测试 — owner 白名单 + 绑定持久化 + 审计。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStore } from './auth.js'

function makeAuth({ config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-auth-'))
  const auth = new AuthStore(config, dir, { info: () => {}, warn: () => {} })
  return { auth, dir }
}

test('无 owner 时 contact 不放行', () => {
  const { auth } = makeAuth()
  assert.equal(auth.isAllowed('user:u-1', 'contact'), false)
})

test('addOwner 后 contact 放行', () => {
  const { auth } = makeAuth()
  auth.addOwner('u-1')
  assert.equal(auth.isAllowed('user:u-1', 'contact'), true)
  assert.equal(auth.isAllowed('user:u-2', 'contact'), false)
})

test('allowContacts 白名单放行非 owner', () => {
  const { auth } = makeAuth({ config: { security: { allowContacts: ['u-9'] } } })
  assert.equal(auth.isAllowed('user:u-9', 'contact'), true)
  assert.equal(auth.isAllowed('user:u-8', 'contact'), false)
})

test('owner 持久化：重启后仍受信', () => {
  const { auth, dir } = makeAuth()
  auth.addOwner('u-owner')
  const auth2 = new AuthStore({}, dir, { info: () => {}, warn: () => {} })
  assert.equal(auth2.isAllowed('user:u-owner', 'contact'), true)
})

test('setBinding/getBinding/windowsForSession', () => {
  const { auth } = makeAuth()
  auth.setBinding('user:u-1', 's-1')
  assert.equal(auth.getBinding('user:u-1').sessionId, 's-1')
  auth.setBinding('user:u-2', 's-1')
  auth.setBinding('user:u-3', 's-2')
  const windows = auth.windowsForSession('s-1')
  assert.deepEqual(windows.sort(), ['user:u-1', 'user:u-2'])
  // setBinding(null) 解绑
  auth.setBinding('user:u-1', null)
  assert.equal(auth.getBinding('user:u-1').sessionId, null)
})

test('绑定持久化：重启后保留', () => {
  const { auth, dir } = makeAuth()
  auth.setBinding('user:u-1', 's-99')
  const auth2 = new AuthStore({}, dir, { info: () => {}, warn: () => {} })
  assert.equal(auth2.getBinding('user:u-1').sessionId, 's-99')
})

test('audit 追加写 audit.jsonl', () => {
  const { auth, dir } = makeAuth()
  auth.audit('test/event', { a: 1 })
  auth.audit('test/event2', { b: 2 })
  const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.event, 'test/event')
  assert.equal(first.a, 1)
  assert.ok(first.time)
})

test('isRoomTalkerAllowed：owner 或空 allowContacts 都放行', () => {
  const { auth } = makeAuth()
  auth.addOwner('u-owner')
  // owner 放行
  assert.equal(auth.isRoomTalkerAllowed('u-owner'), true)
  // 空 allowContacts → 任何人放行
  assert.equal(auth.isRoomTalkerAllowed('stranger'), true)
  // 非空 allowContacts → 只有列表内放行
  const { auth: auth2 } = makeAuth({ config: { security: { allowContacts: ['alice'] } } })
  assert.equal(auth2.isRoomTalkerAllowed('alice'), true)
  assert.equal(auth2.isRoomTalkerAllowed('bob'), false)
})