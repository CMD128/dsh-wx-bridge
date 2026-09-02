/**
 * T1: ilink-api 协议层测试 — mock 全局 fetch，断言请求格式与错误分类。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createILinkApi, ILinkError, extractText, messageId } from './ilink-api.js'

/** 构造一个最小 Response-like */
function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
  }
}

/** 记录所有 fetch 调用的参数 */
function installFetchMock(handler) {
  const calls = []
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init })
    const result = handler ? handler(String(url), init) : jsonResponse({ ret: 0 })
    return result
  })
  return {
    calls,
    restore() {
      mock.restoreAll()
    },
  }
}

test('beginLogin 请求格式：POST /ilink/bot/get_bot_qrcode + iLink 头', async () => {
  const m = installFetchMock(() =>
    jsonResponse({ qrcode: 'qr-token-123', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/AbC?qrcode=qr-token-123', ret: 0 }),
  )
  try {
    const api = createILinkApi()
    const r = await api.beginLogin({})
    assert.equal(m.calls.length, 1)
    const { url, init } = m.calls[0]
    assert.ok(url.includes('ilink/bot/get_bot_qrcode?bot_type=3'))
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['iLink-App-Id'], 'bot')
    assert.ok(init.headers['X-WECHAT-UIN'])
    assert.deepEqual(JSON.parse(init.body), { local_token_list: [] })
    assert.equal(r.qrcode, 'qr-token-123')
  } finally {
    m.restore()
  }
})

test('beginLogin 无 qrcode → ILinkError(invalid-qr)', async () => {
  const m = installFetchMock(() => jsonResponse({ ret: 0 }))
  try {
    const api = createILinkApi()
    await assert.rejects(() => api.beginLogin({}), (e) => e instanceof ILinkError && e.code === 'invalid-qr')
  } finally {
    m.restore()
  }
})

test('pollLogin confirmed → 解析 botToken/botId/ownerUserId/baseUrl', async () => {
  const m = installFetchMock(() =>
    jsonResponse({
      status: 'confirmed',
      bot_token: 'bt-123',
      ilink_bot_id: 'b-1',
      ilink_user_id: 'u-1',
      baseurl: 'https://ilinkai.weixin.qq.com/',
    }),
  )
  try {
    const api = createILinkApi()
    const r = await api.pollLogin({ qrcode: 'q' })
    assert.equal(r.status, 'confirmed')
    assert.equal(r.botToken, 'bt-123')
    assert.equal(r.botId, 'b-1')
    assert.equal(r.ownerUserId, 'u-1')
    assert.equal(r.baseUrl, 'https://ilinkai.weixin.qq.com/')
    // authenticated: false
    assert.equal(m.calls[0].init.headers.Authorization, undefined)
  } finally {
    m.restore()
  }
})

test('pollLogin wait → 无凭据字段', async () => {
  const m = installFetchMock(() => jsonResponse({ status: 'wait' }))
  try {
    const api = createILinkApi()
    const r = await api.pollLogin({ qrcode: 'q' })
    assert.equal(r.status, 'wait')
    assert.equal(r.botToken, undefined)
  } finally {
    m.restore()
  }
})

test('getUpdates 超时 → 返回空批而不是抛错', async () => {
  const m = installFetchMock(() => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  })
  try {
    const api = createILinkApi()
    const r = await api.getUpdates({ baseUrl: 'https://x', token: 't' })
    assert.deepEqual(r, { ret: 0, msgs: [], get_updates_buf: '' })
  } finally {
    m.restore()
  }
})

test('getUpdates 正常 → 透传 msgs + cursor', async () => {
  const m = installFetchMock(() =>
    jsonResponse({ ret: 0, msgs: [{ message_id: 1 }], get_updates_buf: 'cursor-1' }),
  )
  try {
    const api = createILinkApi()
    const r = await api.getUpdates({ baseUrl: 'https://x', token: 't', getUpdatesBuf: 'old' })
    assert.equal(r.msgs.length, 1)
    assert.equal(r.get_updates_buf, 'cursor-1')
    // body 里有 base_info
    const body = JSON.parse(m.calls[0].init.body)
    assert.equal(body.get_updates_buf, 'old')
    assert.ok(body.base_info.channel_version)
  } finally {
    m.restore()
  }
})

test('sendText 发送格式：message_type=2 + client_id 前缀 dsh-wechat-', async () => {
  const m = installFetchMock(() => jsonResponse({ ret: 0 }))
  try {
    const api = createILinkApi()
    await api.sendText({ baseUrl: 'https://x', token: 't', toUserId: 'u-9', text: '你好' })
    const { url, init } = m.calls[0]
    assert.ok(url.includes('ilink/bot/sendmessage'))
    assert.equal(init.headers.Authorization, 'Bearer t')
    const msg = JSON.parse(init.body).msg
    assert.equal(msg.to_user_id, 'u-9')
    assert.equal(msg.message_type, 2)
    assert.ok(msg.client_id.startsWith('dsh-wechat-'))
    assert.equal(msg.item_list[0].type, 1)
    assert.equal(msg.item_list[0].text_item.text, '你好')
  } finally {
    m.restore()
  }
})

test('sendText 带 contextToken → 请求含 context_token', async () => {
  const m = installFetchMock(() => jsonResponse({ ret: 0 }))
  try {
    const api = createILinkApi()
    await api.sendText({ baseUrl: 'https://x', token: 't', toUserId: 'u-9', text: 'hi', contextToken: 'ctx-7' })
    const msg = JSON.parse(m.calls[0].init.body).msg
    assert.equal(msg.context_token, 'ctx-7')
  } finally {
    m.restore()
  }
})

test('sendText ret!=0 → ILinkError(send-rejected)', async () => {
  const m = installFetchMock(() => jsonResponse({ ret: -1 }))
  try {
    const api = createILinkApi()
    await assert.rejects(() => api.sendText({ baseUrl: 'https://x', token: 't', toUserId: 'u', text: 'x' }), (e) => e instanceof ILinkError && e.code === 'send-rejected')
  } finally {
    m.restore()
  }
})

test('非 2xx → ILinkError(http-error)', async () => {
  const m = installFetchMock(() => jsonResponse({}, 500))
  try {
    const api = createILinkApi()
    await assert.rejects(() => api.beginLogin({}), (e) => e instanceof ILinkError && e.code === 'http-error')
  } finally {
    m.restore()
  }
})

test('网络错误 → ILinkError(network-error) 并暴露 cause', async () => {
  const m = installFetchMock(() => {
    const err = new TypeError('fetch failed')
    err.cause = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
    throw err
  })
  try {
    const api = createILinkApi()
    await assert.rejects(() => api.beginLogin({}), (e) => e instanceof ILinkError && e.code === 'network-error' && e.message.includes('ECONNREFUSED'))
  } finally {
    m.restore()
  }
})

test('extractText：type=1 文本与 type=3 语音转写', () => {
  assert.equal(extractText({ item_list: [{ type: 1, text_item: { text: '  hi  ' } }] }), 'hi')
  assert.equal(extractText({ item_list: [{ type: 3, voice_item: { text: '语音' } }] }), '语音')
  assert.equal(extractText({ item_list: [] }), null)
  assert.equal(extractText(null), null)
})

test('messageId：message_id 优先，client_id 兜底', () => {
  assert.equal(messageId({ message_id: 42 }), '42')
  assert.equal(messageId({ client_id: 'c-1' }), 'c-1')
  assert.equal(messageId({}), null)
})