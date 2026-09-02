/**
 * ILinkChannel: drives the WeChat ClawBot (腾讯 iLink 官方机器人) connection.
 *
 * 参考 dsh-chatops ilink/channel.ts（MIT），API 与 store 改为注入（可测试）。
 *
 * 状态机：idle → await_scan → (scanned) → confirmed → connecting → connected；
 * 异常 → error。token 失效（-14）→ 回退扫码。网络错误指数退避。
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { aesEcbPaddedSize, extractText } from './ilink-api.js'
import { ILinkStore } from './ilink-store.js'

export const INTERACTIVE_MIN_MS = 350
const SEEN_RING_SIZE = 200

/**
 * 按字节预算切分文本，优先在换行处断。每段 ≤ maxBytes。
 */
export function chunkText(text, maxBytes) {
  const chunks = []
  let rest = text
  while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
    let cut = Math.min(rest.length, Math.floor(maxBytes / 3))
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > maxBytes && cut > 1) cut = Math.floor(cut * 0.9)
    const newline = rest.lastIndexOf('\n', cut)
    if (newline > cut * 0.5) cut = newline + 1
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

export class ILinkChannel {
  constructor(config, events, logger, api, store) {
    this.config = config
    this.events = events
    this.logger = logger
    this.api = api
    this.store = store ?? new ILinkStore(this.storageDir, null, logger)
    this.abort = null
    this.state = 'idle'
    this.lastError = null
    this.qrUrl = null
    this.pendingVerifyCode = null
    this.interactiveQueue = Promise.resolve()
    this.bulkQueue = Promise.resolve()
    this.pendingInteractive = 0
    this.lastSentAt = 0
    this.contextTokens = new Map()
  }

  get storageDir() {
    return (
      this.config.storagePath ||
      join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-wechat')
    )
  }

  get online() {
    return this.state === 'connected'
  }

  statusSnapshot() {
    return {
      state: this.state,
      online: this.online,
      qrUrl: this.qrUrl,
      botId: this.store.data.botId,
      ownerUserId: this.store.data.ownerUserId,
      lastError: this.lastError,
    }
  }

  submitVerifyCode(code) {
    this.pendingVerifyCode = code.trim()
    this.logger.info('dsh-wechat: verify code received, continuing login poll')
  }

  async unbind() {
    await this.stop()
    await this.store.unbind()
    this.state = 'idle'
  }

  async start() {
    if (this.abort) return
    this.abort = new AbortController()
    const signal = this.abort.signal
    void this.run(signal).catch((error) => {
      this.lastError = error?.message ?? String(error)
      this.state = 'error'
      this.logger.warn(`dsh-wechat: lifecycle crashed fatally: ${this.lastError}`)
    })
  }

  async stop() {
    const abort = this.abort
    this.abort = null
    if (!abort) return
    abort.abort()
    const { baseUrl } = this.store.data
    const token = await this.store.getToken()
    if (baseUrl && token) {
      try {
        await this.api.notifyStop({ baseUrl, token, signal: AbortSignal.timeout(5_000) })
      } catch {
        /* best effort */
      }
    }
    this.state = 'idle'
  }

  // ------------------------------------------------------------ lifecycle --

  async run(signal) {
    let crashes = 0
    while (!signal.aborted) {
      const token = await this.store.getToken()
      const { baseUrl } = this.store.data
      try {
        if (token && baseUrl) {
          await this.connect(token, baseUrl, signal)
        } else {
          await this.loginFlow(signal)
        }
        crashes = 0
      } catch (error) {
        if (signal.aborted) return
        crashes += 1
        this.lastError = error?.message ?? String(error)
        this.logger.warn(`dsh-wechat: lifecycle crash (${crashes}): ${this.lastError}`)
        await sleep(backoffMs(crashes), signal)
      }
    }
  }

  /** QR scan state machine: QR → wait → scaned → (verifycode?) → confirmed. */
  async loginFlow(signal) {
    let baseUrl
    while (!signal.aborted) {
      const { qrcode, qrcodeUrl } = await this.api.beginLogin({ signal })
      this.qrUrl = qrcodeUrl ?? qrcode ?? null
      this.state = 'await_scan'
      this.lastError = null
      this.events.onScan(this.qrUrl)

      let verifyCode
      while (!signal.aborted) {
        if (this.pendingVerifyCode) {
          verifyCode = this.pendingVerifyCode
          this.pendingVerifyCode = null
        }
        let result
        try {
          result = await this.api.pollLogin({ qrcode, baseUrl, verifyCode, signal })
        } catch (error) {
          if (error?.code === 'timeout') continue
          throw error
        }
        verifyCode = undefined

        switch (result.status) {
          case 'wait':
            break
          case 'scaned':
            this.state = 'scanned'
            break
          case 'scaned_but_redirect':
          case 'binded_redirect':
            if (result.baseUrl) baseUrl = result.baseUrl
            break
          case 'need_verifycode':
            this.state = 'need_verifycode'
            break
          case 'verify_code_blocked':
            throw new Error('短信验证码被限制，请稍后再试')
          case 'expired':
            this.logger.info('dsh-wechat: 二维码已过期，重新获取')
            break
          case 'confirmed': {
            if (!result.botToken) throw new Error('confirmed 缺少 bot_token')
            await this.store.setToken(result.botToken)
            await this.store.bindAccount({
              botId: result.botId ?? null,
              ownerUserId: result.ownerUserId ?? null,
              baseUrl: result.baseUrl ?? baseUrl ?? null,
            })
            this.qrUrl = null
            this.events.onLogin(result.botId ?? 'ilink-bot')
            return
          }
        }
        if (result.status === 'expired') break
      }
    }
  }

  /** Connected phase: notifyStart + getUpdates long-poll with cursor. */
  async connect(token, baseUrl, signal) {
    this.state = 'connecting'
    try {
      await this.api.notifyStart({ baseUrl, token, signal })
    } catch (error) {
      this.logger.warn(`dsh-wechat: notifystart failed (continuing): ${error?.message ?? error}`)
    }
    this.state = 'connected'
    this.lastError = null

    let failures = 0
    while (!signal.aborted) {
      let response
      try {
        response = await this.api.getUpdates({
          baseUrl,
          token,
          getUpdatesBuf: this.store.data.getUpdatesBuf,
          signal,
        })
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        this.lastError = error?.message ?? String(error)
        this.logger.warn(`dsh-wechat: getupdates failed (${failures}): ${this.lastError}`)
        await sleep(backoffMs(failures), signal)
        continue
      }

      const rejected = (response?.ret !== undefined && response.ret !== 0)
        || (response?.errcode !== undefined && response.errcode !== 0)
      if (rejected) {
        const code = response.errcode ?? response.ret
        if (code === -14) {
          this.logger.warn('dsh-wechat: bot_token 已失效（-14），需要重新扫码绑定')
          await this.store.clearToken()
          this.events.onLogout('stale-token')
          this.state = 'idle'
          return
        }
        failures += 1
        this.lastError = `getupdates rejected (ret=${code})`
        await sleep(backoffMs(failures), signal)
        continue
      }

      failures = 0
      this.lastError = null
      for (const raw of response?.msgs ?? []) {
        this.dispatchInbound(raw)
      }
      if (typeof response?.get_updates_buf === 'string' && response.get_updates_buf) {
        this.store.setCursor(response.get_updates_buf)
      }
    }
  }

  dispatchInbound(raw) {
    try {
      // message_type 2 = the bot's own outbound echo; never loop on it.
      if (raw?.message_type === 2) return
      const id = raw?.message_id !== undefined && raw?.message_id !== null ? String(raw.message_id) : raw?.client_id ?? null
      const fromUserId = typeof raw?.from_user_id === 'string' ? raw.from_user_id.trim() : ''
      if (!id || !fromUserId) return
      if (this.store.hasSeen(id)) return
      this.store.markSeen(id)

      const text = extractText(raw)
      const isImage = (raw?.item_list ?? []).some((i) => i?.type === 2 || i?.image_item)
      const windowKey = `user:${fromUserId}`
      const contextToken = typeof raw?.context_token === 'string' ? raw.context_token.trim() : ''
      if (contextToken) this.contextTokens.set(windowKey, contextToken)

      if (isImage && !text) {
        // 图片消息：当前版本不接收图片内容，回复友好提示（防静默丢消息）。
        this.events.onMessage({ windowKey, kind: 'contact', talkerId: fromUserId, talkerName: fromUserId, text: '', imageNotice: true })
        return
      }
      if (!text) return

      this.events.onMessage({ windowKey, kind: 'contact', talkerId: fromUserId, talkerName: fromUserId, text })
    } catch (error) {
      this.logger.warn(`dsh-wechat: inbound dispatch failed: ${error?.message ?? error}`)
    }
  }

  // -------------------------------------------------------------- outbound --

  say(windowKey, text, opts = {}) {
    const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6000)
    if (!opts.bulk) {
      this.pendingInteractive++
      this.interactiveQueue = this.interactiveQueue.then(async () => {
        try {
          for (const chunk of chunks) {
            await this.throttle(INTERACTIVE_MIN_MS, 100)
            await this.sendChunk(windowKey, chunk)
          }
        } finally {
          this.pendingInteractive--
        }
      })
      return this.interactiveQueue
    }
    this.bulkQueue = this.bulkQueue.then(async () => {
      for (const chunk of chunks) {
        while (this.pendingInteractive > 0) await new Promise((r) => setTimeout(r, 300))
        await this.throttle(this.config.reply?.rateLimitMs ?? 1_200, 400)
        await this.sendChunk(windowKey, chunk)
      }
    })
    return this.bulkQueue
  }

  async sendChunk(windowKey, chunk) {
    const { baseUrl } = this.store.data
    const token = await this.store.getToken()
    if (!baseUrl || !token || !windowKey.startsWith('user:')) return
    try {
      await this.api.sendText({
        baseUrl,
        token,
        toUserId: windowKey.slice('user:'.length),
        text: chunk,
        contextToken: this.contextTokens.get(windowKey),
      })
    } catch (error) {
      this.logger.warn(`dsh-wechat: send to ${windowKey} failed: ${error?.message ?? error}`)
    }
  }

  async throttle(min, jitter) {
    const wait = this.lastSentAt + min + Math.floor(Math.random() * jitter) - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastSentAt = Date.now()
  }

  /**
   * Send a file/image as a native WeChat message (CDN upload + AES).
   * Images (jpg/png/webp/gif) render inline; everything else arrives as a
   * file card. Size is fenced by reply.maxFileMB.
   */
  async sendFile(windowKey, filePath, caption) {
    if (!windowKey.startsWith('user:')) throw new Error('file send requires a private-chat window')
    const toUserId = windowKey.slice('user:'.length)
    const { baseUrl } = this.store.data
    const token = await this.store.getToken()
    if (!baseUrl || !token) throw new Error('iLink 通道未连接')

    const maxMB = this.config.reply?.maxFileMB ?? 20
    const bytes = await readFile(filePath)
    if (bytes.byteLength > maxMB * 1024 * 1024) {
      throw new Error(`文件超过 ${maxMB}MB 上限（${(bytes.byteLength / 1048576).toFixed(1)}MB）`)
    }
    const fileName = basename(filePath)
    const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extname(fileName).toLowerCase())

    await this.bulkQueue
    this.bulkQueue = this.bulkQueue.then(async () => {
      try {
        const aesKey = randomBytes(16)
        const fileKey = randomBytes(16).toString('hex')
        const file = { fileName, bytes }
        const upload = await this.api.getUploadUrl({
          baseUrl, token, toUserId, file, mediaType: isImage ? 1 : 3, aesKey, fileKey,
        })
        const downloadParam = await this.api.uploadCdn({ upload, fileKey, bytes, aesKey })
        const ciphertextSize = aesEcbPaddedSize(bytes.byteLength)
        await this.api.sendArtifact({
          baseUrl, token, toUserId, file,
          mediaType: isImage ? 1 : 3,
          downloadParam, aesKey, ciphertextSize,
          contextToken: this.contextTokens.get(windowKey),
        })
        if (caption) await this.say(windowKey, caption)
      } catch (error) {
        this.logger.warn(`dsh-wechat: 文件发送失败 ${fileName}: ${error?.message ?? error}`)
        await this.say(windowKey, `❌ 文件「${fileName}」发送失败：${error?.message ?? error}`)
        throw error
      }
    })
    return this.bulkQueue
  }
}


function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
/** 指数退避（2s 起步，上限 30s）。 */
function backoffMs(attempt) {
  return Math.min(2_000 * 2 ** (attempt - 1), 30_000)
}
