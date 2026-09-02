/**
 * Tencent iLink bot protocol client (微信 ClawBot / 官方机器人平台).
 *
 * Reverse-confirmed from xmanrui/dsh-im (MIT), protocol version 2.4.6.
 * Pure HTTPS JSON over fetch — zero third-party dependencies.
 *
 * Flow: beginLogin → pollLogin(wait→scaned→confirmed) → {bot_token, baseurl}
 *       → getUpdates long-poll (cursor: get_updates_buf) → sendmessage.
 */
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

export const ILINK_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/'
export const ILINK_PROTOCOL_VERSION = '2.4.6'
export const DEFAULT_BOT_TYPE = '3'

const ILINK_APP_ID = 'bot'
const ILINK_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6)
const LOGIN_TIMEOUT_MS = 10_000
const LONG_POLL_TIMEOUT_MS = 35_000
const SHORT_TIMEOUT_MS = 15_000
const CDN_UPLOAD_TIMEOUT_MS = 60_000
const CDN_UPLOAD_RETRIES = 3
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const WEIXIN_CDN_HOST = 'novac2c.cdn.weixin.qq.com'

/** AES-128-ECB (PKCS7) padded size — what iLink expects as `filesize`. */
function aesEcbPaddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16
}

function trustedCdnUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== WEIXIN_CDN_HOST) {
    throw new ILinkError('untrusted-cdn-url', '微信返回了不受信任的 CDN 地址')
  }
  return url.toString()
}

/** Login statuses returned by get_qrcode_status. */
export type LoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface LoginResult {
  status: LoginStatus
  botToken?: string
  botId?: string
  ownerUserId?: string
  baseUrl?: string
}

export interface InboundIlinkMessage {
  messageId: string
  fromUserId: string
  text: string | null
  contextToken?: string
  runId?: string
  raw: any
}

export class ILinkError extends Error {
  code: string
  status?: number
  constructor(code: string, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options)
    this.name = 'ILinkError'
    this.code = code
    this.status = options.status
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function baseInfo() {
  return {
    channel_version: ILINK_PROTOCOL_VERSION,
    bot_agent: 'DeepSeekHarness/dsh-chatops',
  }
}

function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
  }
}

function authenticatedHeaders(token: string | null) {
  const headers: Record<string, string> = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    // Random UIN header per request, mirroring the reference client.
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function requestJson(options: {
  method: 'GET' | 'POST'
  baseUrl: string
  endpoint: string
  token?: string | null
  body?: unknown
  timeoutMs?: number
  authenticated?: boolean
  signal?: AbortSignal
}): Promise<any> {
  const url = new URL(options.endpoint, options.baseUrl).toString()
  const timeout = AbortSignal.timeout(options.timeoutMs ?? SHORT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method,
      headers: options.authenticated === false ? commonHeaders() : authenticatedHeaders(options.token ?? null),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    })
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ILinkError('timeout', `iLink request timed out: ${options.endpoint}`, { cause: error })
    }
    // undici's "fetch failed" TypeError hides the real reason on error.cause
    // (ECONNRESET / ENOTFOUND / UND_ERR_* / CERT_*) — surface it explicitly.
    const cause = error?.cause
    const detail = cause
      ? `${cause.code ?? ''}${cause.code ? ' ' : ''}${cause.message ?? cause}`.trim()
      : 'no-cause'
    throw new ILinkError(
      'network-error',
      `iLink request failed: ${error?.message ?? error} [${detail}] (${options.endpoint})`,
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new ILinkError('http-error', `iLink HTTP ${response.status}: ${options.endpoint}`, { status: response.status })
  }
  try {
    return await response.json()
  } catch (error) {
    throw new ILinkError('invalid-response', `iLink returned non-JSON: ${options.endpoint}`, { cause: error })
  }
}

/** Extract first text/voice-transcript item from an inbound message. */
export function extractText(message: any): string | null {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim()
      if (text) return text
    }
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim()
      if (text) return text
    }
  }
  return null
}

export function messageId(message: any): string | null {
  if (message?.message_id !== undefined && message?.message_id !== null) return String(message.message_id)
  return nonEmpty(message?.client_id)
}

export function createILinkApi() {
  return Object.freeze({
    /** Step ①: request a binding QR. Returns the qrcode token + QR image URL. */
    async beginLogin({ localTokens = [] as string[], botType = DEFAULT_BOT_TYPE, signal }: {
      localTokens?: string[]
      botType?: string
      signal?: AbortSignal
    } = {}) {
      const response = await requestJson({
        method: 'POST',
        baseUrl: ILINK_QR_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: { local_token_list: localTokens.slice(-10) },
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal,
      })
      const qrcode = nonEmpty(response?.qrcode)
      if (!qrcode) throw new ILinkError('invalid-qr', 'iLink 没有返回二维码令牌')
      return { qrcode, qrcodeUrl: nonEmpty(response?.qrcode_img_content) }
    },

    /** Step ②: long-poll the scan status (35s). */
    async pollLogin({ qrcode, baseUrl = ILINK_QR_BASE_URL, verifyCode, signal }: {
      qrcode: string
      baseUrl?: string
      verifyCode?: string
      signal?: AbortSignal
    }): Promise<LoginResult> {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
      if (nonEmpty(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode!.trim())}`
      const response = await requestJson({
        method: 'GET',
        baseUrl,
        endpoint,
        timeoutMs: LONG_POLL_TIMEOUT_MS + 5_000,
        signal,
        authenticated: false,
      })
      const status = response?.status as LoginStatus
      const result: LoginResult = { status }
      if (status === 'confirmed') {
        result.botToken = nonEmpty(response?.bot_token) ?? undefined
        result.botId = nonEmpty(response?.ilink_bot_id) ?? undefined
        result.ownerUserId = nonEmpty(response?.ilink_user_id) ?? undefined
        result.baseUrl = nonEmpty(response?.baseurl) ?? undefined
      }
      // Redirect statuses carry a new baseurl to continue polling against.
      const redirectBase = nonEmpty(response?.baseurl)
      if (redirectBase && !result.baseUrl) result.baseUrl = redirectBase
      return result
    },

    /** Step ④: long-poll inbound messages. Timeout returns an empty batch. */
    async getUpdates({ baseUrl, token, getUpdatesBuf = '', signal }: {
      baseUrl: string
      token: string
      getUpdatesBuf?: string
      signal?: AbortSignal
    }) {
      try {
        return await requestJson({
          method: 'POST',
          baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
          token,
          timeoutMs: LONG_POLL_TIMEOUT_MS + 5_000,
          signal,
        })
      } catch (error) {
        // A long-poll timeout is a normal idle beat, not a failure.
        if (error instanceof ILinkError && error.code === 'timeout') {
          return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
        }
        throw error
      }
    },

    /** Step ⑤: send a text message. contextToken keeps the conversation context. */
    async sendText({ baseUrl, token, toUserId, text, contextToken, runId, signal }: {
      baseUrl: string
      token: string
      toUserId: string
      text: string
      contextToken?: string
      runId?: string
      signal?: AbortSignal
    }) {
      const response = await requestJson({
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: `dsh-chatops-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text } }],
            ...(nonEmpty(contextToken) ? { context_token: contextToken!.trim() } : {}),
            ...(nonEmpty(runId) ? { run_id: runId!.trim() } : {}),
          },
          base_info: baseInfo(),
        },
      })
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new ILinkError('send-rejected', 'iLink 拒绝了回复消息')
      }
      return true
    },

    /** File/image step ①: request a CDN upload slot. */
    async getUploadUrl({ baseUrl, token, toUserId, file, mediaType, aesKey, fileKey, signal }: {
      baseUrl: string
      token: string
      toUserId: string
      file: { fileName: string; bytes: Buffer }
      mediaType: 1 | 3 // 1=image, 3=file
      aesKey: Buffer
      fileKey: string
      signal?: AbortSignal
    }) {
      const response = await requestJson({
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/getuploadurl',
        token,
        signal,
        body: {
          filekey: fileKey,
          media_type: mediaType,
          to_user_id: toUserId,
          rawsize: file.bytes.byteLength,
          rawfilemd5: createHash('md5').update(file.bytes).digest('hex'),
          filesize: aesEcbPaddedSize(file.bytes.byteLength),
          no_need_thumb: true,
          aeskey: aesKey.toString('hex'),
          base_info: baseInfo(),
        },
      })
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new ILinkError('upload-url-rejected', `微信拒绝了文件上传请求 (ret=${response.ret})`)
      }
      return response
    },

    /** Step ②+③: AES-128-ECB encrypt and upload to the WeChat CDN. */
    async uploadCdn({ upload, fileKey, bytes, aesKey, signal }: {
      upload: any
      fileKey: string
      bytes: Buffer
      aesKey: Buffer
      signal?: AbortSignal
    }): Promise<string> {
      let url: string
      const full = nonEmpty(upload?.upload_full_url)
      if (full) {
        url = trustedCdnUrl(full)
      } else {
        const param = nonEmpty(upload?.upload_param)
        if (!param) throw new ILinkError('missing-upload-url', '微信没有返回文件上传地址')
        const u = new URL(`${WEIXIN_CDN_BASE_URL}/upload`)
        u.searchParams.set('encrypted_query_param', param)
        u.searchParams.set('filekey', fileKey)
        url = trustedCdnUrl(u.toString())
      }
      const cipher = createCipheriv('aes-128-ecb', aesKey, null)
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])

      let lastError: unknown
      for (let attempt = 1; attempt <= CDN_UPLOAD_RETRIES; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array(ciphertext),
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(CDN_UPLOAD_TIMEOUT_MS)])
              : AbortSignal.timeout(CDN_UPLOAD_TIMEOUT_MS),
            redirect: 'error',
          })
          if (response.status !== 200) {
            throw new ILinkError('upload-failed', `微信 CDN 上传失败（HTTP ${response.status}）`, { status: response.status })
          }
          const downloadParam = response.headers.get('x-encrypted-param')
          await response.body?.cancel?.().catch(() => undefined)
          if (!downloadParam) throw new ILinkError('missing-download-param', 'CDN 未返回下载凭证')
          return downloadParam
        } catch (error) {
          lastError = error
        }
      }
      throw lastError instanceof Error ? lastError : new ILinkError('upload-failed', String(lastError))
    },

    /** Step ④: send the uploaded artifact as a file/image message. */
    async sendArtifact({ baseUrl, token, toUserId, file, mediaType, downloadParam, aesKey, ciphertextSize, contextToken, signal }: {
      baseUrl: string
      token: string
      toUserId: string
      file: { fileName: string; bytes: Buffer }
      mediaType: 1 | 3
      downloadParam: string
      aesKey: Buffer
      ciphertextSize: number
      contextToken?: string
      signal?: AbortSignal
    }) {
      const media = {
        encrypt_query_param: downloadParam,
        aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
        encrypt_type: 1,
      }
      const item = mediaType === 1
        ? { type: 2, image_item: { media, mid_size: ciphertextSize } }
        : { type: 4, file_item: { media, file_name: file.fileName, len: String(file.bytes.byteLength) } }
      const response = await requestJson({
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: `dsh-chatops-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [item],
            ...(nonEmpty(contextToken) ? { context_token: contextToken!.trim() } : {}),
          },
          base_info: baseInfo(),
        },
      })
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new ILinkError('send-rejected', `微信拒绝了文件消息 (ret=${response.ret})`)
      }
      return true
    },

    /** Bot-online notification, called once when the poll loop starts. */
    async notifyStart({ baseUrl, token, signal }: { baseUrl: string; token: string; signal?: AbortSignal }) {
      return requestJson({
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystart',
        token,
        signal,
        timeoutMs: LOGIN_TIMEOUT_MS,
        body: { base_info: baseInfo() },
      })
    },

    /** Bot-offline notification, best-effort on shutdown. */
    async notifyStop({ baseUrl, token, signal }: { baseUrl: string; token: string; signal?: AbortSignal }) {
      return requestJson({
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystop',
        token,
        signal,
        timeoutMs: LOGIN_TIMEOUT_MS,
        body: { base_info: baseInfo() },
      })
    },
  })
}

export type ILinkApi = ReturnType<typeof createILinkApi>
