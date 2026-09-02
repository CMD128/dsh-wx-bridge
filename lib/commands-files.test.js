/**
 * T13: 文件回传测试 — channel.sendFile（mock CDN）+ bridge /send /files 命令。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ILinkChannel } from './ilink-channel.js'
import { ILinkStore } from './ilink-store.js'
import { SessionBridge } from './bridge.js'

function makeChannel() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-file-'))
  const logger = { info: () => {}, warn: () => {} }
  const store = new ILinkStore(dir, null, logger)
  const api = {
    getUploadUrl: async () => ({ ret: 0, upload_param: 'enc-param' }),
    uploadCdn: async () => 'download-param-xyz',
    sendArtifact: async () => true,
    sendText: async () => true,
  }
  const channel = new ILinkChannel({ storagePath: dir, reply: { maxFileMB: 20 } }, {}, logger, api, store)
  return { channel, store, dir }
}

test('channel.sendFile：文本文件走 CDN 上传 + sendArtifact', async () => {
  const { channel, store } = makeChannel()
  await store.setToken('bt')
  await store.bindAccount({ botId: 'b', ownerUserId: 'u', baseUrl: 'https://x/' })
  const calls = []
  channel.api.getUploadUrl = async (args) => { calls.push(['getUploadUrl', args.file.fileName]); return { ret: 0, upload_param: 'p' } }
  channel.api.uploadCdn = async () => 'dl-param'
  channel.api.sendArtifact = async (args) => { calls.push(['sendArtifact', args.file.fileName, args.mediaType]); return true }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-file-'))
  const filePath = join(dir, 'report.md')
  writeFileSync(filePath, '# 周报\n内容', 'utf8')

  await channel.sendFile('user:u-1', filePath, '📎 周报')
  assert.ok(calls.some((c) => c[0] === 'getUploadUrl'))
  assert.ok(calls.some((c) => c[0] === 'sendArtifact' && c[2] === 3)) // mediaType 3 = 文件
})

test('channel.sendFile：图片走 mediaType 1 + 发 caption', async () => {
  const { channel, store } = makeChannel()
  await store.setToken('bt')
  await store.bindAccount({ botId: 'b', ownerUserId: 'u', baseUrl: 'https://x/' })
  const calls = []
  channel.api.getUploadUrl = async (args) => { calls.push(['getUploadUrl', args.mediaType]); return { ret: 0, upload_param: 'p' } }
  channel.api.uploadCdn = async () => 'dl-param'
  channel.api.sendArtifact = async (args) => { calls.push(['sendArtifact', args.mediaType]); return true }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-file-'))
  const imgPath = join(dir, 'pic.png')
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  await channel.sendFile('user:u-1', imgPath, '图')
  assert.ok(calls.some((c) => c[0] === 'getUploadUrl' && c[1] === 1))
})

test('channel.sendFile：超大文件拒绝', async () => {
  const { channel, store } = makeChannel()
  await store.setToken('bt')
  await store.bindAccount({ botId: 'b', ownerUserId: 'u', baseUrl: 'https://x/' })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-file-'))
  const bigPath = join(dir, 'big.bin')
  writeFileSync(bigPath, Buffer.alloc(25 * 1024 * 1024)) // 25MB > 20MB
  await assert.rejects(() => channel.sendFile('user:u-1', bigPath), /超过/)
})

// ---------------- bridge /send /files ----------------

function makeBridgeWithCwd({ cwd }) {
  const listeners = {}
  const agent = {
    session: { id: 's-1', title: '测试', header: { cwd }, events: [] },
    followup: async () => {},
  }
  const ctx = {
    on: (evt, fn) => { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn) },
    emit: (evt, ...args) => { for (const fn of listeners[evt] || []) fn(...args) },
    agents: { roots: () => [agent], get: (id) => (id === 's-1' ? agent : null), resume: async () => { throw new Error('x') } },
    sessionTitle: { get: () => ({ title: '测试' }) },
    sessionQuery: null,
    apiProxy: { sessions: { cancel: async () => ({ ok: true }) } },
  }
  const sent = []
  const channel = {
    say: async (w, t) => sent.push({ w, t }),
    sendFile: async (w, path, caption) => { sent.push({ w, file: path, caption }) },
  }
  const auth = {
    isAllowed: () => true, audit: () => {}, setBinding: () => {},
    getBinding: (w) => (w === 'user:u-1' ? { sessionId: 's-1' } : null), windowsForSession: () => [],
  }
  const bridge = new SessionBridge(ctx, { push: {} }, channel, auth, { info() {}, warn() {} })
  bridge.start()
  return { bridge, channel: { sent } }
}

test('/send <路径>：发送工作区内文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-bridge-'))
  writeFileSync(join(dir, 'a.md'), 'hello', 'utf8')
  const { bridge, channel } = makeBridgeWithCwd({ cwd: dir })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/send a.md' })
  assert.ok(channel.sent.some((s) => s.file === join(dir, 'a.md')))
})

test('/send 路径逃逸被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-bridge-'))
  const { bridge, channel } = makeBridgeWithCwd({ cwd: dir })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/send ../../etc/passwd' })
  const out = channel.sent[channel.sent.length - 1]
  assert.ok(out.t.includes('只允许'))
})

test('/send 文件不存在 → 提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-bridge-'))
  const { bridge, channel } = makeBridgeWithCwd({ cwd: dir })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/send nope.md' })
  const out = channel.sent[channel.sent.length - 1]
  assert.ok(out.t.includes('不存在'))
})

test('/files 列出工作区目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-bridge-'))
  writeFileSync(join(dir, 'a.md'), 'x', 'utf8')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'b.txt'), 'y', 'utf8')
  const { bridge, channel } = makeBridgeWithCwd({ cwd: dir })
  await bridge.handleInbound({ windowKey: 'user:u-1', text: '/files' })
  const out = channel.sent[channel.sent.length - 1]
  assert.ok(out.t.includes('a.md'))
  assert.ok(out.t.includes('sub/'))
})