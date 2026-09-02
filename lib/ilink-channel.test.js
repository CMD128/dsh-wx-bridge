/**
 * T3: ilink-channel 状态机测试 — stub ilink-api + 真实 store（临时目录）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ILinkChannel } from './ilink-channel.js'
import { ILinkStore } from './ilink-store.js'

function makeChannel({ apiOverrides = {}, storeOverrides = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-chan-'))
  const logger = { info: () => {}, warn: () => {} }
  const store = new ILinkStore(dir, null, logger)
  const events = { onMessage: () => {}, onLogin: () => {}, onLogout: () => {}, onScan: () => {} }

  // stub api：所有方法默认挂起（用我们控制的 promise），个别覆盖
  const pending = []
  const api = {
    notifyStart: async () => {},
    notifyStop: async () => {},
    // 模拟真实长轮询：空批时稍等（避免忙循环卡死事件循环）
    getUpdates: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { ret: 0, msgs: [], get_updates_buf: '' }
    },
    sendText: async () => true,
    beginLogin: async () => ({ qrcode: 'qr-1', qrcodeUrl: 'https://qr/1' }),
    pollLogin: async () => ({ status: 'wait' }),
    ...apiOverrides,
  }

  const channel = new ILinkChannel(
    { storagePath: dir, reply: { maxChunkBytes: 6000, rateLimitMs: 0 } },
    events,
    logger,
    api,
    store,
  )
  return { channel, store, events, api, pending }
}

test('chunkText：超长文本按字节切分', async () => {
  const { chunkText } = await import('./ilink-channel.js')
  const text = '啊'.repeat(8000)
  const chunks = chunkText(text, 6000)
  assert.ok(chunks.length >= 2)
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, 'utf8') <= 6000)
  }
  assert.equal(chunks.join(''), text)
})

test('无 token → loginFlow：await_scan → confirmed → 存 token', async () => {
  const { channel, store, events } = makeChannel({
    apiOverrides: {
      pollLogin: async () => ({ status: 'confirmed', botToken: 'bt-1', botId: 'b-1', ownerUserId: 'u-1', baseUrl: 'https://x/' }),
    },
  })
  const scanned = []
  events.onScan = (url) => scanned.push(url)
  let loginCalled = false
  events.onLogin = () => { loginCalled = true }
  await channel.start()
  // 等生命周期跑起来（start 是异步 detached，用小延时）
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(scanned.length >= 1)
  assert.equal(await store.getToken(), 'bt-1')
  assert.equal(store.data.ownerUserId, 'u-1')
  assert.equal(loginCalled, true)
  await channel.stop()
})

test('有 token → connect：notifyStart + getUpdates 循环', async () => {
  const { channel, store, events } = makeChannel()
  await store.setToken('bt-2')
  await store.bindAccount({ botId: 'b-2', ownerUserId: 'u-2', baseUrl: 'https://x/' })
  let notifyCalled = false
  const msgs = [{ message_id: 'm1', from_user_id: 'u-9', item_list: [{ type: 1, text_item: { text: 'hi' } }] }]
  let polls = 0
  const api = {
    notifyStart: async () => { notifyCalled = true },
    notifyStop: async () => {},
    getUpdates: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { ret: 0, msgs: polls++ === 0 ? msgs : [], get_updates_buf: 'cur-1' }
    },
    sendText: async () => true,
  }
  channel.api = api
  const received = []
  events.onMessage = (m) => received.push(m)
  await channel.start()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(notifyCalled, true)
  assert.equal(received.length, 1)
  assert.equal(received[0].text, 'hi')
  assert.equal(received[0].windowKey, 'user:u-9')
  assert.equal(store.data.getUpdatesBuf, 'cur-1')
  await channel.stop()
})

test('getUpdates ret=-14 → clearToken → 回退 loginFlow（重新扫码）', async () => {
  const { channel, store, events } = makeChannel()
  await store.setToken('bt-stale')
  await store.bindAccount({ botId: 'b', ownerUserId: 'u', baseUrl: 'https://x/' })
  let logoutCalled = false
  events.onLogout = () => { logoutCalled = true }
  let polls = 0
  channel.api = {
    notifyStart: async () => {},
    notifyStop: async () => {},
    getUpdates: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { ret: -14, msgs: [], get_updates_buf: '' }
    },
    sendText: async () => true,
    beginLogin: async () => { polls++; return { qrcode: `qr-${polls}`, qrcodeUrl: `https://qr/${polls}` } },
    pollLogin: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { status: 'wait' }
    },
  }
  await channel.start()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(logoutCalled, true)
  assert.equal(await store.getToken(), null) // token 被清
  assert.ok(polls >= 1) // 重新进入扫码
  await channel.stop()
})

test('消息去重：同 message_id 只分发一次', async () => {
  const { channel, store, events } = makeChannel()
  await store.setToken('bt-3')
  await store.bindAccount({ botId: 'b', ownerUserId: 'u', baseUrl: 'https://x/' })
  let count = 0
  events.onMessage = () => { count++ }
  channel.api = {
    notifyStart: async () => {},
    notifyStop: async () => {},
    getUpdates: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { ret: 0, msgs: [{ message_id: 'dup-1', from_user_id: 'u-9', item_list: [{ type: 1, text_item: { text: 'x' } }] }], get_updates_buf: 'c' }
    },
    sendText: async () => true,
  }
  await channel.start()
  await new Promise((r) => setTimeout(r, 60))
  await channel.stop()
  // 第二次启动也应去重（store 持久化 seenMessageIds）
  channel.api = {
    notifyStart: async () => {},
    notifyStop: async () => {},
    getUpdates: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { ret: 0, msgs: [{ message_id: 'dup-1', from_user_id: 'u-9', item_list: [{ type: 1, text_item: { text: 'x' } }] }], get_updates_buf: 'c' }
    },
    sendText: async () => true,
  }
  await channel.start()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(count, 1)
  await channel.stop()
})

test('忽略 message_type=2（自己发出的回声）', async () => {
  const { channel, store, events } = makeChannel()
  await store.setToken('bt-4')
  await store.bindAccount({ botId: 'b', ownerUserId: 'u', baseUrl: 'https://x/' })
  let count = 0
  events.onMessage = () => { count++ }
  channel.api = {
    notifyStart: async () => {},
    notifyStop: async () => {},
    getUpdates: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { ret: 0, msgs: [{ message_id: 'echo', from_user_id: 'u-9', message_type: 2, item_list: [{ type: 1, text_item: { text: 'self' } }] }], get_updates_buf: 'c' }
    },
    sendText: async () => true,
  }
  await channel.start()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(count, 0)
  await channel.stop()
})

test('say() 长文本分段发送，且每段调用 sendText', async () => {
  const { channel, store } = makeChannel()
  await store.setToken('bt-5')
  await store.bindAccount({ botId: 'b', ownerUserId: 'u', baseUrl: 'https://x/' })
  const sent = []
  channel.api = {
    notifyStart: async () => {},
    notifyStop: async () => {},
    getUpdates: async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { ret: 0, msgs: [], get_updates_buf: 'c' }
    },
    sendText: async (args) => { sent.push(args.text) },
  }
  await channel.start()
  await new Promise((r) => setTimeout(r, 30))
  const long = '中'.repeat(7000)
  await channel.say('user:u-9', long)
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(sent.length >= 2)
  assert.equal(sent.join(''), long)
  await channel.stop()
})
test('图片消息（type=2 无文本）→ 发 imageNotice 提示而非静默丢', async () => {
  const { channel, store, events } = makeChannel()
  await store.setToken('bt-img')
  await store.bindAccount({ botId: 'b', ownerUserId: 'u', baseUrl: 'https://x/' })
  const received = []
  events.onMessage = (m) => received.push(m)
  channel.api = {
    notifyStart: async () => {}, notifyStop: async () => {},
    getUpdates: async () => { await new Promise((r) => setTimeout(r, 30)); return { ret: 0, msgs: [{ message_id: 'img-1', from_user_id: 'u-9', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'x' } } }] }], get_updates_buf: 'c' } },
    sendText: async () => true,
  }
  await channel.start()
  await new Promise((r) => setTimeout(r, 60))
  await channel.stop()
  assert.equal(received.length, 1)
  assert.equal(received[0].imageNotice, true)
  assert.equal(received[0].text, '')
})
