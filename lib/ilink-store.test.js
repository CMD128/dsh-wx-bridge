/**
 * T2: ilink-store 持久化测试 — 临时目录 + mock credentials。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ILinkStore } from './ilink-store.js'

const REF = 'DSH_WECHAT_ILINK_BOT_TOKEN'

/** mock credentials：内存版实现 resolve/set/unset */
function makeCredentials() {
  const map = new Map()
  return {
    async resolve(ref) {
      return map.get(ref) ?? null
    },
    async set(ref, value) {
      map.set(ref, value)
    },
    async unset(ref) {
      map.delete(ref)
    },
    _map: map,
  }
}

function makeStore({ credentials = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-store-'))
  const logger = { info: () => {}, warn: () => {} }
  const store = new ILinkStore(dir, credentials, logger)
  return { store, dir }
}

test('无 credentials、无文件 → getToken 返回 null', async () => {
  const { store } = makeStore()
  assert.equal(await store.getToken(), null)
})

test('setToken 写文件兜底（无 credentials 时），getToken 读回', async () => {
  const { store, dir } = makeStore()
  await store.setToken('bt-1')
  assert.equal(await store.getToken(), 'bt-1')
  // 重新实例化（模拟重启）后仍能读回
  const store2 = new ILinkStore(dir, null, { info: () => {}, warn: () => {} })
  assert.equal(await store2.getToken(), 'bt-1')
})

test('有 credentials → setToken 写 credentials，不落文件', async () => {
  const creds = makeCredentials()
  const { store, dir } = makeStore({ credentials: creds })
  await store.setToken('bt-2')
  assert.equal(creds._map.get(REF), 'bt-2')
  // 文件不存在（credentials 成功时不写文件兜底），或即使存在也不含 fileToken
  const statePath = join(dir, 'ilink-state.json')
  if (existsSync(statePath)) {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(raw.fileToken, undefined)
  }
})

test('credentials 优先于文件兜底', async () => {
  const creds = makeCredentials()
  await creds.set(REF, 'bt-cred')
  const { store } = makeStore({ credentials: creds })
  assert.equal(await store.getToken(), 'bt-cred')
})

test('clearToken 清空 credentials 与文件', async () => {
  const creds = makeCredentials()
  const { store, dir } = makeStore({ credentials: creds })
  await store.setToken('bt-3')
  await store.clearToken()
  assert.equal(await store.getToken(), null)
  assert.equal(creds._map.has(REF), false)
  const raw = JSON.parse(readFileSync(join(dir, 'ilink-state.json'), 'utf8'))
  assert.equal(raw.fileToken, undefined)
})

test('bindAccount 写状态字段，unbind 清空', async () => {
  const { store } = makeStore()
  await store.bindAccount({ botId: 'b-1', ownerUserId: 'u-1', baseUrl: 'https://x/' })
  assert.equal(store.data.botId, 'b-1')
  assert.equal(store.data.ownerUserId, 'u-1')
  assert.equal(store.data.baseUrl, 'https://x/')
  await store.unbind()
  assert.equal(store.data.botId, null)
  assert.equal(store.data.ownerUserId, null)
  assert.equal(store.data.baseUrl, null)
})

test('setCursor / hasSeen / markSeen + 环形去重上限', async () => {
  const { store } = makeStore()
  store.setCursor('cur-1')
  assert.equal(store.data.getUpdatesBuf, 'cur-1')
  assert.equal(store.hasSeen('m-1'), false)
  store.markSeen('m-1')
  assert.equal(store.hasSeen('m-1'), true)
  // 环形缓冲区：超过 200 条后最早的被挤出
  for (let i = 0; i < 210; i++) store.markSeen(`m-${i}`)
  assert.equal(store.hasSeen('m-0'), false)
  assert.equal(store.hasSeen('m-209'), true)
})

test('状态文件权限 0600', async () => {
  const { store, dir } = makeStore()
  await store.setToken('bt-x')
  const mode = (await import('node:fs')).statSync(join(dir, 'ilink-state.json')).mode & 0o777
  assert.equal(mode, 0o600)
})

test('损坏的状态文件不崩溃，回落默认状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-store-'))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'ilink-state.json'), '{{{not json', 'utf8')
  const store = new ILinkStore(dir, null, { info: () => {}, warn: () => {} })
  assert.equal(await store.getToken(), null)
  assert.equal(store.data.botId, null)
})