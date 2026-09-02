/**
 * iLink account state: bot token (via DSH credential store when available,
 * file fallback), connection metadata, long-poll cursor, and a dedup ring
 * of recently seen message ids. One JSON file + one credential ref.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CREDENTIAL_REF = 'DSH_CHATOPS_ILINK_BOT_TOKEN'
/** Pre-rename credential ref; checked as a fallback so old logins survive. */
const LEGACY_CREDENTIAL_REF = 'DSH_WECHAT_ILINK_BOT_TOKEN'
const STATE_VERSION = 1
const SEEN_RING_SIZE = 200

export interface ILinkState {
  botId: string | null
  ownerUserId: string | null
  baseUrl: string | null
  getUpdatesBuf: string
  seenMessageIds: string[]
}

export class ILinkStore {
  private state: ILinkState = {
    botId: null,
    ownerUserId: null,
    baseUrl: null,
    getUpdatesBuf: '',
    seenMessageIds: [],
  }
  private tokenCache: string | null = null
  private readonly stateFile: string

  constructor(
    storageDir: string,
    /** ctx.credentials when the profile provides it; null → file fallback. */
    private credentials: any,
    private logger: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    mkdirSync(storageDir, { recursive: true })
    this.stateFile = join(storageDir, 'ilink-state.json')
    this.load()
    // Prime the in-memory cache so the token survives save() calls and is
    // available immediately after startup without a file round-trip.
    this.tokenCache = this.readFileToken()
  }

  get data(): Readonly<ILinkState> {
    return this.state
  }

  // ------------------------------------------------------------ bot token --

  async getToken(): Promise<string | null> {
    if (this.tokenCache) return this.tokenCache
    if (this.credentials) {
      for (const ref of [CREDENTIAL_REF, LEGACY_CREDENTIAL_REF]) {
        try {
          const resolved = await this.credentials.resolve(ref)
          const value = typeof resolved === 'string' ? resolved : resolved?.value
          if (typeof value === 'string' && value.trim()) {
            this.tokenCache = value.trim()
            return this.tokenCache
          }
        } catch (error: any) {
          this.logger.warn(`dsh-chatops: credential resolve failed: ${error?.message ?? error}`)
        }
      }
    }
    this.tokenCache = this.readFileToken()
    return this.tokenCache
  }

  async setToken(token: string): Promise<void> {
    this.tokenCache = token
    if (this.credentials) {
      try {
        await this.credentials.set(CREDENTIAL_REF, token)
      } catch (error: any) {
        this.logger.warn(`dsh-chatops: credential set failed, using file fallback: ${error?.message ?? error}`)
        this.writeFileToken(token)
      }
    } else {
      this.writeFileToken(token)
    }
  }

  async clearToken(): Promise<void> {
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

  async bindAccount(info: { botId: string | null; ownerUserId: string | null; baseUrl: string | null }): Promise<void> {
    this.state.botId = info.botId
    this.state.ownerUserId = info.ownerUserId
    this.state.baseUrl = info.baseUrl
    this.state.getUpdatesBuf = ''
    this.state.seenMessageIds = []
    this.save()
  }

  async unbind(): Promise<void> {
    await this.clearToken()
    this.state = { botId: null, ownerUserId: null, baseUrl: null, getUpdatesBuf: '', seenMessageIds: [] }
    this.save()
  }

  setCursor(buf: string): void {
    if (buf && buf !== this.state.getUpdatesBuf) {
      this.state.getUpdatesBuf = buf
      this.save()
    }
  }

  hasSeen(messageId: string): boolean {
    return this.state.seenMessageIds.includes(messageId)
  }

  markSeen(messageId: string): void {
    this.state.seenMessageIds.push(messageId)
    if (this.state.seenMessageIds.length > SEEN_RING_SIZE) {
      this.state.seenMessageIds = this.state.seenMessageIds.slice(-SEEN_RING_SIZE)
    }
    this.save()
  }

  // ---------------------------------------------------------- persistence --

  private load(): void {
    if (!existsSync(this.stateFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (raw?.version === STATE_VERSION && raw.state) {
        this.state = { ...this.state, ...raw.state }
      }
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: ilink state load failed: ${error?.message ?? error}`)
    }
  }

  private save(): void {
    // Merge-write: preserve the fileToken key that writeFileToken manages —
    // overwriting the file with only {version, state} would wipe the token
    // right after login (this bug bounced the channel back to the QR flow).
    let raw: any = {}
    try {
      if (existsSync(this.stateFile)) raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      /* corrupted file gets rewritten */
    }
    raw.version = STATE_VERSION
    raw.state = this.state
    try {
      writeFileSync(this.stateFile, JSON.stringify(raw, null, 2), { mode: 0o600 })
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: ilink state save failed: ${error?.message ?? error}`)
    }
  }

  private readFileToken(): string | null {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      return typeof raw?.fileToken === 'string' && raw.fileToken ? raw.fileToken : null
    } catch {
      return null
    }
  }

  private writeFileToken(token: string | null): void {
    let raw: any = {}
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
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: token file save failed: ${error?.message ?? error}`)
    }
  }
}
