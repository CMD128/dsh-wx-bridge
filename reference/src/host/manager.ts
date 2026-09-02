/**
 * ChannelManager: multi-channel registry + windowKey routing.
 *
 * The bridge talks to ONE structural channel; the manager fans outbound
 * messages out to the channel owning the windowKey prefix:
 *   user: / contact: / room: / filehelper / self  → wechat/ilink channels
 *   fsu: / fsc:                                    → feishu
 *   dsu: / dsc:                                    → dingtalk
 * Channel-specific capabilities (approval cards, progress cards) are probed
 * structurally via channelFor().
 */

export interface ManagedChannel {
  say(windowKey: string, text: string, opts?: { bulk?: boolean }): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly online: boolean
}

const PREFIXES = ['wsu:', 'wsc:', 'dsu:', 'dsc:', 'fsu:', 'fsc:', 'user:', 'contact:', 'room:', 'filehelper', 'self']

export class ChannelManager {
  private channels = new Map<string, ManagedChannel>() // prefix → channel

  register(prefixes: string[], channel: ManagedChannel): void {
    for (const prefix of prefixes) this.channels.set(prefix, channel)
  }

  channelFor(windowKey: string): ManagedChannel | null {
    for (const prefix of PREFIXES) {
      if (windowKey.startsWith(prefix)) return this.channels.get(prefix) ?? null
    }
    return null
  }

  /** Card-capable channel for this window, or null (structural probe). */
  cardsFor(windowKey: string): any | null {
    const channel: any = this.channelFor(windowKey)
    return typeof channel?.sendApprovalCard === 'function' ? channel : null
  }

  say(windowKey: string, text: string, opts?: { bulk?: boolean }): Promise<void> {
    const channel = this.channelFor(windowKey)
    if (!channel) return Promise.resolve()
    return channel.say(windowKey, text, opts)
  }

  all(): ManagedChannel[] {
    return [...new Set(this.channels.values())]
  }
}
