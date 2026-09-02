/**
 * WeChat channel: owns the wechaty bot lifecycle (scan → login → message →
 * logout), login-state persistence, and a rate-limited outbound queue.
 *
 * wechaty and its puppets are OPTIONAL peer modules loaded lazily: the
 * plugin must still load (and print actionable install guidance) when they
 * are absent, so nothing here imports wechaty statically.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface InboundMessage {
  /** Stable conversation key: 'filehelper' | 'self' | contact id | room topic. */
  windowKey: string
  kind: 'filehelper' | 'self' | 'contact' | 'room'
  /** Sender display name / id (for rooms, the actual talker). */
  talkerId: string
  talkerName: string
  text: string
}

export interface ChannelEvents {
  onMessage: (msg: InboundMessage) => void
  onLogin: (userName: string) => void
  onLogout: (reason: string) => void
  /** QR string ready for scanning; consumer renders it (terminal + GUI). */
  onScan: (qrcode: string) => void
}

export class WechatChannel {
  bot: any = null
  private outQueue: Promise<void> = Promise.resolve()
  private lastSentAt = 0

  constructor(
    private config: any,
    private events: ChannelEvents,
    private logger: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  get storageDir(): string {
    return (
      this.config.storagePath ||
      join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-chatops')
    )
  }

  get online(): boolean {
    return this.bot != null && this.bot.isLoggedIn !== false
  }

  async start(): Promise<void> {
    let WechatyBuilder: any
    try {
      ;({ WechatyBuilder } = await import('wechaty'))
    } catch {
      this.logger.warn(
        'dsh-chatops: "wechaty" is not installed. Run inside the plugin directory:\n' +
          '  pnpm add wechaty wechaty-puppet-wechat4u\n' +
          '(or wechaty-puppet-padlocal for a stable paid puppet). The plugin stays loaded; WeChat features stay off.',
      )
      return
    }

    mkdirSync(this.storageDir, { recursive: true })

    let puppet: any
    try {
      const mod: any = await import(this.config.puppet)
      const PuppetImpl = mod.default ?? mod
      // wechaty's resolver accepts a puppet NAME string or a Puppet INSTANCE
      // — a bare class ("function") is rejected. Instantiate with options.
      const options = this.config.puppetToken ? { token: this.config.puppetToken } : {}
      puppet = typeof PuppetImpl === 'function' ? new PuppetImpl(options) : PuppetImpl
    } catch {
      this.logger.warn(
        `dsh-chatops: puppet "${this.config.puppet}" is not installed. ` +
          `Run: pnpm add ${this.config.puppet}`,
      )
      return
    }

    this.bot = WechatyBuilder.build({
      // wechaty persists its own memory card next to this name; we point the
      // storage dir at DSH_HOME so login survives restarts without rescanning.
      name: join(this.storageDir, 'dsh-chatops'),
      puppet,
    })

    this.bot
      .on('scan', (qrcode: string, status: number) => {
        this.logger.info(`dsh-chatops: scan QR to log in (status ${status})`)
        this.events.onScan(qrcode)
      })
      .on('login', (user: any) => {
        this.logger.info(`dsh-chatops: logged in as ${user?.name?.() ?? 'unknown'}`)
        this.events.onLogin(user?.name?.() ?? 'unknown')
      })
      .on('logout', (user: any, reason?: string) => {
        this.logger.warn(`dsh-chatops: logged out (${reason ?? 'no reason'}) — scan again to relogin`)
        this.events.onLogout(reason ?? '')
      })
      .on('message', (msg: any) => {
        // Never let a message handler throw back into wechaty.
        Promise.resolve()
          .then(() => this.handleMessage(msg))
          .catch((error) => this.logger.warn(`dsh-chatops: message handling failed: ${error?.message ?? error}`))
      })
      .on('error', (error: any) => {
        this.logger.warn(`dsh-chatops: bot error: ${error?.message ?? error}`)
      })

    await this.bot.start()
    this.logger.info('dsh-chatops: bot started, waiting for scan/login')
  }

  async stop(): Promise<void> {
    const bot = this.bot
    this.bot = null
    if (bot) {
      try {
        await bot.stop()
      } catch {
        /* already down */
      }
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    // Only plain text drives the bridge in this skeleton.
    if (msg.type?.() !== 7 /* MessageType.Text */ && msg.text?.() === undefined) return
    const text: string = (msg.text?.() ?? '').trim()
    if (!text) return

    const talker = msg.talker?.()
    const room = msg.room?.()
    const self = talker?.self?.() === true

    let inbound: InboundMessage
    if (room) {
      const topic = await room.topic?.()
      // Room messages only count when the bot is @-mentioned.
      const mentionSelf = await msg.mentionSelf?.()
      if (!mentionSelf) return
      const stripped = text.replace(/^@[^\s]+\s*/, '').trim()
      inbound = {
        windowKey: `room:${topic}`,
        kind: 'room',
        talkerId: talker?.id ?? '',
        talkerName: talker?.name?.() ?? '',
        text: stripped,
      }
    } else if (talker?.id === 'filehelper') {
      inbound = { windowKey: 'filehelper', kind: 'filehelper', talkerId: 'filehelper', talkerName: '文件传输助手', text }
    } else if (self) {
      inbound = { windowKey: 'self', kind: 'self', talkerId: 'self', talkerName: '我', text }
    } else {
      inbound = {
        windowKey: `contact:${talker?.id ?? 'unknown'}`,
        kind: 'contact',
        talkerId: talker?.id ?? '',
        talkerName: talker?.name?.() ?? '',
        text,
      }
    }
    this.events.onMessage(inbound)
  }

  /**
   * Send text to a conversation, chunked and throttled. Outbound messages go
   * through ONE serialized queue with a minimum interval plus jitter —
   * bursting messages is the fastest way to trip WeChat risk control.
   */
  say(windowKey: string, text: string): Promise<void> {
    const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6000)
    this.outQueue = this.outQueue.then(async () => {
      for (const chunk of chunks) {
        await this.throttle()
        try {
          await this.sayOnce(windowKey, chunk)
        } catch (error) {
          this.logger.warn(`dsh-chatops: send to ${windowKey} failed: ${(error as any)?.message ?? error}`)
        }
      }
    })
    return this.outQueue
  }

  private async sayOnce(windowKey: string, text: string): Promise<void> {
    const bot = this.bot
    if (!bot) return
    if (windowKey === 'filehelper') {
      const contact = await bot.Contact.find({ id: 'filehelper' })
      await contact?.say(text)
      return
    }
    if (windowKey === 'self') {
      const user = bot.currentUser ?? bot.userSelf?.()
      await user?.say(text)
      return
    }
    if (windowKey.startsWith('room:')) {
      const room = await bot.Room.find({ topic: windowKey.slice('room:'.length) })
      await room?.say(text)
      return
    }
    if (windowKey.startsWith('contact:')) {
      const contact = await bot.Contact.find({ id: windowKey.slice('contact:'.length) })
      await contact?.say(text)
    }
  }

  private async throttle(): Promise<void> {
    const min = this.config.reply?.rateLimitMs ?? 1200
    const jitter = Math.floor(Math.random() * 400)
    const wait = this.lastSentAt + min + jitter - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastSentAt = Date.now()
  }
}

/** Split text into chunks of at most maxBytes (UTF-8), breaking on newlines when possible. */
export function chunkText(text: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let rest = text
  while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
    // Rough cut by character count, then refine to fit the byte budget.
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
