/**
 * iLink account state: bot token (via DSH credential store when available,
 * file fallback), connection metadata, long-poll cursor, and a dedup ring
 * of recently seen message ids. One JSON file + one credential ref.
 *
 * 参考 dsh-chatops store.ts（MIT）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CREDENTIAL_REF = 'DSH_WECHAT_ILINK_BOT_TOKEN'
const STATE_VERSION = 1
const SEEN_RING_SIZE = 200

export class ILinkStore {
  constructor(storageDir, credentials = null, logger = { info() {}, warn() {} }) {
    this.credentials = credentials
    this.logger = logger
    this.state = {
      botId: null,
      ownerUserId: null,
      baseUrl: null,
      getUpdatesBuf: '',
      seenMessageIds: [],
    }
    this.tokenCache = null
    mkdirSync(storageDir, { recursive: true })
    this.stateFile = join(storageDir, 'ilink-state.json')
    this.load()
    // Prime the in-memory cache so the token survives save() calls.
    this.tokenCache = this.readFileToken()
  }

  get data() {
    return this.state
  }

  // ------------------------------------------------------------ bot token --

  async getToken() {
    if (this.tokenCache) return this.tokenCache
    if (this.credentials) {
      try {
        const resolved = await this.credentials.resolve(CREDENTIAL_REF)
        const value = typeof resolved === 'string' ? resolved : resolved?.value
        if (typeof value === 'string' && value.trim()) {
          this.tokenCache = value.trim()
          return this.tokenCache
        }
      } catch (error) {
        this.logger.warn(`dsh-wechat: credential resolve failed: ${error?.message ?? error}`)
      }
    }
    this.tokenCache = this.readFileToken()
    return this.tokenCache
  }

  async setToken(token) {
    this.tokenCache = token
    if (this.credentials) {
      try {
        await this.credentials.set(CREDENTIAL_REF, token)
        return
      } catch (error) {
        this.logger.warn(`dsh-wechat: credential set failed, using file fallback: ${error?.message ?? error}`)
      }
    }
    this.writeFileToken(token)
  }

  async clearToken() {
    this.tokenCache = null
    if (this.credentials) {
      try {
        await this.credentials.unset(CREDENTIAL_REF)
      } catch {
        /* best effort */
      }
    }
    this.writeFileToken(null)
  }

  // ------------------------------------------------------------- metadata --

  async bindAccount(info) {
    this.state.botId = info.botId
    this.state.ownerUserId = info.ownerUserId
    this.state.baseUrl = info.baseUrl
    this.state.getUpdatesBuf = ''
    this.state.seenMessageIds = []
    this.save()
  }

  async unbind() {
    await this.clearToken()
    this.state = { botId: null, ownerUserId: null, baseUrl: null, getUpdatesBuf: '', seenMessageIds: [] }
    this.save()
  }

  setCursor(buf) {
    if (buf && buf !== this.state.getUpdatesBuf) {
      this.state.getUpdatesBuf = buf
      this.save()
    }
  }

  hasSeen(messageId) {
    return this.state.seenMessageIds.includes(messageId)
  }

  markSeen(messageId) {
    this.state.seenMessageIds.push(messageId)
    if (this.state.seenMessageIds.length > SEEN_RING_SIZE) {
      this.state.seenMessageIds = this.state.seenMessageIds.slice(-SEEN_RING_SIZE)
    }
    this.save()
  }

  // ---------------------------------------------------------- persistence --

  load() {
    if (!existsSync(this.stateFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (raw?.version === STATE_VERSION && raw.state) {
        this.state = { ...this.state, ...raw.state }
      }
    } catch (error) {
      this.logger.warn(`dsh-wechat: ilink state load failed: ${error?.message ?? error}`)
    }
  }

  save() {
    // Merge-write: preserve the fileToken key that writeFileToken manages.
    let raw = {}
    try {
      if (existsSync(this.stateFile)) raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      /* corrupted file gets rewritten */
    }
    raw.version = STATE_VERSION
    raw.state = this.state
    try {
      writeFileSync(this.stateFile, JSON.stringify(raw, null, 2), { mode: 0o600 })
    } catch (error) {
      this.logger.warn(`dsh-wechat: ilink state save failed: ${error?.message ?? error}`)
    }
  }

  readFileToken() {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      return typeof raw?.fileToken === 'string' && raw.fileToken ? raw.fileToken : null
    } catch {
      return null
    }
  }

  writeFileToken(token) {
    let raw = {}
    try {
      if (existsSync(this.stateFile)) raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      /* corrupted file gets rewritten */
    }
    if (token) raw.fileToken = token
    else delete raw.fileToken
    raw.version = STATE_VERSION
    raw.state = this.state
    try {
      writeFileSync(this.stateFile, JSON.stringify(raw, null, 2), { mode: 0o600 })
    } catch (error) {
      this.logger.warn(`dsh-wechat: token file save failed: ${error?.message ?? error}`)
    }
  }
}