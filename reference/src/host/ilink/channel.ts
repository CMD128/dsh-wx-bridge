/**
 * ILinkChannel: drives the WeChat ClawBot (腾讯 iLink 官方机器人) connection.
 *
 * Same structural contract as the wechaty WechatChannel — storageDir,
 * online, start(), stop(), say(windowKey, text) — so SessionBridge/index.ts
 * work unchanged. windowKey is `user:{ilink_user_id}` (private chats; group
 * support is a phase-2 TODO).
 *
 * Lifecycle: restore token → connect; or loginFlow (QR scan state machine)
 * → confirmed → connect. Stale token (-14) drops back to loginFlow.
 */
import { homedir } from 'node:os'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { createILinkApi, extractText, messageId, ILinkError, type ILinkApi } from './api'
import { ILinkStore } from './store'
import { chunkText } from '../channel'
import type { ChannelEvents, InboundMessage } from '../channel'

export type ILinkConnState =
  | 'idle'
  | 'await_scan'       // QR ready, waiting for the phone to scan
  | 'scanned'          // phone scanned, waiting for confirm
  | 'need_verifycode'  // phone asks for an SMS verify code
  | 'connecting'
  | 'connected'
  | 'error'

/** Min interval for interactive messages — fast enough to feel instant. */
const INTERACTIVE_MIN_MS = 350

export class ILinkChannel {
  private api: ILinkApi = createILinkApi()
  readonly store: ILinkStore
  private abort: AbortController | null = null
  private state: ILinkConnState = 'idle'
  private lastError: string | null = null
  private qrUrl: string | null = null
  private pendingVerifyCode: string | null = null
  private interactiveQueue: Promise<void> = Promise.resolve()
  private bulkQueue: Promise<void> = Promise.resolve()
  private pendingInteractive = 0
  private lastSentAt = 0
  /** context_token per windowKey, from the latest inbound message. */
  private contextTokens = new Map<string, string>()

  constructor(
    private config: any,
    private events: ChannelEvents,
    private logger: { info: (m: string) => void; warn: (m: string) => void },
    credentials: any = null,
  ) {
    this.store = new ILinkStore(this.storageDir, credentials, logger)
  }

  get storageDir(): string {
    return (
      this.config.storagePath ||
      join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-chatops')
    )
  }

  /** Lifecycle debug log — the DSH host log is hard to reach; this file is not. */
  private dbg(message: string): void {
    this.logger.info(`dsh-chatops: ${message}`)
    try {
      appendFileSync(
        join(this.storageDir, 'ilink-debug.log'),
        `${new Date().toISOString()} ${message}\n`,
      )
    } catch {
      /* debug log is best-effort */
    }
  }

  get online(): boolean {
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

  /** GUI supplies the SMS code when the phone asks for it. */
  submitVerifyCode(code: string): void {
    this.pendingVerifyCode = code.trim()
    this.logger.info('dsh-chatops: verify code received, continuing login poll')
  }

  async unbind(): Promise<void> {
    await this.stop()
    await this.store.unbind()
    this.state = 'idle'
  }

  async start(): Promise<void> {
    if (this.abort) return // already running
    this.abort = new AbortController()
    const signal = this.abort.signal
    // The whole lifecycle runs detached; start() returns immediately so the
    // plugin never blocks DSH boot on network conditions.
    void this.run(signal).catch((error) => {
      this.lastError = error?.message ?? String(error)
      this.state = 'error'
      this.dbg(`lifecycle crashed fatally: ${this.lastError}`)
    })
  }

  async stop(): Promise<void> {
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

  private async run(signal: AbortSignal): Promise<void> {
    let crashes = 0
    while (!signal.aborted) {
      const token = await this.store.getToken()
      const { baseUrl } = this.store.data
      this.dbg(`lifecycle beat: token=${token ? 'present' : 'missing'} baseUrl=${baseUrl ?? 'missing'}`)
      try {
        if (token && baseUrl) {
          await this.connect(token, baseUrl, signal)
        } else {
          await this.loginFlow(signal)
        }
        crashes = 0
      } catch (error: any) {
        if (signal.aborted) return
        crashes += 1
        this.lastError = error?.message ?? String(error)
        this.dbg(`lifecycle crash (${crashes}): ${this.lastError}`)
        // Network blips must not kill the login flow: back off and retry the
        // whole beat (a fresh QR is fetched when needed) instead of sticking
        // in a terminal 'error' state.
        await sleep(Math.min(2_000 * 2 ** (crashes - 1), 30_000), signal)
      }
    }
  }

  /** QR scan state machine: QR → wait → scaned → (verifycode?) → confirmed. */
  private async loginFlow(signal: AbortSignal): Promise<void> {
    let baseUrl: string | undefined
    while (!signal.aborted) {
      const { qrcode, qrcodeUrl } = await this.api.beginLogin({ signal })
      this.qrUrl = qrcodeUrl
      this.state = 'await_scan'
      this.lastError = null
      this.events.onScan(qrcodeUrl ?? qrcode)
      this.logger.info('dsh-chatops: iLink QR ready — 打开 /wechat/qr 或设置页扫码绑定')

      let verifyCode: string | undefined
      while (!signal.aborted) {
        // A submitted SMS code rides the next poll, then clears.
        if (this.pendingVerifyCode) {
          verifyCode = this.pendingVerifyCode
          this.pendingVerifyCode = null
        }
        let result
        try {
          result = await this.api.pollLogin({ qrcode, baseUrl, verifyCode, signal })
        } catch (error) {
          if (error instanceof ILinkError && error.code === 'timeout') continue
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
            this.logger.info('dsh-chatops: 微信要求短信验证码，请在 /wechat/qr 页面输入')
            break
          case 'verify_code_blocked':
            throw new ILinkError('verify-blocked', '短信验证码被限制，请稍后再试')
          case 'expired':
            this.logger.info('dsh-chatops: 二维码已过期，重新获取')
            break
          case 'confirmed': {
            if (!result.botToken) throw new ILinkError('invalid-confirm', 'confirmed 缺少 bot_token')
            await this.store.setToken(result.botToken)
            await this.store.bindAccount({
              botId: result.botId ?? null,
              ownerUserId: result.ownerUserId ?? null,
              baseUrl: result.baseUrl ?? baseUrl ?? null,
            })
            this.qrUrl = null
            this.dbg(`login confirmed: bot=${result.botId} owner=${result.ownerUserId} base=${result.baseUrl ?? baseUrl} tokenLen=${result.botToken.length}`)
            this.events.onLogin(result.botId ?? 'ilink-bot')
            return
          }
        }
        if (result.status === 'expired') break // outer loop: fetch a fresh QR
      }
    }
  }

  /** Connected phase: notifyStart + getUpdates long-poll with cursor. */
  private async connect(token: string, baseUrl: string, signal: AbortSignal): Promise<void> {
    this.state = 'connecting'
    try {
      await this.api.notifyStart({ baseUrl, token, signal })
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: notifystart failed (continuing): ${error?.message ?? error}`)
    }
    this.state = 'connected'
    this.lastError = null
    this.dbg(`iLink connected (bot=${this.store.data.botId ?? 'unknown'}, base=${baseUrl})`)

    let failures = 0
    while (!signal.aborted) {
      let response: any
      try {
        response = await this.api.getUpdates({
          baseUrl,
          token,
          getUpdatesBuf: this.store.data.getUpdatesBuf,
          signal,
        })
      } catch (error: any) {
        if (signal.aborted) return
        failures += 1
        this.lastError = error?.message ?? String(error)
        this.logger.warn(`dsh-chatops: getupdates failed (${failures}): ${this.lastError}`)
        const backoff = Math.min(2_000 * 2 ** (failures - 1), 30_000)
        await sleep(backoff, signal)
        continue
      }

      const rejected = (response?.ret !== undefined && response.ret !== 0)
        || (response?.errcode !== undefined && response.errcode !== 0)
      if (rejected) {
        const code = response.errcode ?? response.ret
        this.dbg(`getupdates rejected: code=${code} raw=${JSON.stringify(response).slice(0, 300)}`)
        if (code === -14) {
          // Stale token: clear and fall back to the QR login flow.
          this.logger.warn('dsh-chatops: bot_token 已失效（-14），需要重新扫码绑定')
          await this.store.clearToken()
          this.events.onLogout('stale-token')
          this.state = 'idle'
          return
        }
        failures += 1
        this.lastError = `getupdates rejected (ret=${code})`
        await sleep(Math.min(2_000 * 2 ** (failures - 1), 30_000), signal)
        continue
      }

      failures = 0
      this.lastError = null // a successful batch clears any transient poll error
      for (const raw of response?.msgs ?? []) {
        this.dispatchInbound(raw)
      }
      if (typeof response?.get_updates_buf === 'string' && response.get_updates_buf) {
        this.store.setCursor(response.get_updates_buf)
      }
    }
  }

  private dispatchInbound(raw: any): void {
    try {
      // message_type 2 = the bot's own outbound echo; never loop on it.
      if (raw?.message_type === 2) return
      const id = messageId(raw)
      const fromUserId = typeof raw?.from_user_id === 'string' ? raw.from_user_id.trim() : ''
      if (!id || !fromUserId) return
      if (this.store.hasSeen(id)) return
      this.store.markSeen(id)

      const text = extractText(raw)
      if (!text) {
        this.dbg(`inbound non-text message from ${fromUserId} (skipped, types=${(raw?.item_list ?? []).map((i: any) => i?.type).join(',')})`)
        return // images/files land in phase 2
      }
      this.dbg(`inbound text from ${fromUserId}: ${text.slice(0, 80)}`)
      const windowKey = `user:${fromUserId}`
      const contextToken = typeof raw?.context_token === 'string' ? raw.context_token.trim() : ''
      if (contextToken) this.contextTokens.set(windowKey, contextToken)

      const msg: InboundMessage = {
        windowKey,
        kind: 'contact',
        talkerId: fromUserId,
        talkerName: fromUserId,
        text,
      }
      this.events.onMessage(msg)
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: inbound dispatch failed: ${error?.message ?? error}`)
    }
  }

  // -------------------------------------------------------------- outbound --

  /**
   * Two-lane outbound: interactive messages (command replies, acks,
   * approvals) must NEVER queue behind a draining bulk output (/log's dozen
   * chunks at anti-flood throttle). Bulk chunks yield whenever interactive
   * traffic is pending, so a long dump no longer stalls the conversation.
   */
  say(windowKey: string, text: string, opts?: { bulk?: boolean }): Promise<void> {
    const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6000)
    if (!opts?.bulk) {
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
        // Interactive traffic always wins: pause the bulk drain while any
        // interactive message is waiting or in flight.
        while (this.pendingInteractive > 0) await new Promise((r) => setTimeout(r, 300))
        await this.throttle(this.config.reply?.rateLimitMs ?? 1_200, 400)
        await this.sendChunk(windowKey, chunk)
      }
    })
    return this.bulkQueue
  }

  private async sendChunk(windowKey: string, chunk: string): Promise<void> {
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
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: send to ${windowKey} failed: ${error?.message ?? error}`)
    }
  }

  /**
   * Send a file/image as a native WeChat message (CDN upload + AES).
   * Images (jpg/png/webp/gif) render inline; everything else arrives as a
   * file card. Size is fenced by reply.maxFileMB before reading the file.
   */
  async sendFile(windowKey: string, filePath: string, caption?: string): Promise<void> {
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

    this.bulkQueue = this.bulkQueue.then(async () => {
      try {
        const aesKey = randomBytes(16)
        const fileKey = randomBytes(16).toString('hex')
        const file = { fileName, bytes }
        const upload = await this.api.getUploadUrl({
          baseUrl, token, toUserId, file, mediaType: isImage ? 1 : 3, aesKey, fileKey,
        })
        const downloadParam = await this.api.uploadCdn({ upload, fileKey, bytes, aesKey })
        const ciphertextSize = Math.ceil((bytes.byteLength + 1) / 16) * 16
        await this.api.sendArtifact({
          baseUrl, token, toUserId, file,
          mediaType: isImage ? 1 : 3,
          downloadParam, aesKey, ciphertextSize,
          contextToken: this.contextTokens.get(windowKey),
        })
        if (caption) await this.say(windowKey, caption)
        this.dbg(`file sent to ${toUserId}: ${fileName} (${bytes.byteLength}B, ${isImage ? 'image' : 'file'})`)
      } catch (error: any) {
        this.logger.warn(`dsh-chatops: 文件发送失败 ${fileName}: ${error?.message ?? error}`)
        await this.say(windowKey, `❌ 文件「${fileName}」发送失败：${error?.message ?? error}`)
        // Re-throw: callers (bridge → im_send_file tool) must NOT report
        // success for a failed delivery.
        throw error
      }
    })
    return this.bulkQueue
  }

  private async throttle(min: number, jitter: number): Promise<void> {
    const wait = this.lastSentAt + min + Math.floor(Math.random() * jitter) - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastSentAt = Date.now()
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
