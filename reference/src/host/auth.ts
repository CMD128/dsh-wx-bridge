/**
 * Source filtering and window↔session binding store.
 *
 * 来源过滤是个人号方案的第一道命：默认只响应 filehelper / self / 显式白名单，
 * 其余一切消息（陌生人私聊、被拉进的群）静默忽略并记审计日志。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WindowBinding {
  /** DSH session id this window currently talks to. */
  sessionId: string | null
  /** Optional workspace hint for /new (reserved; session creation is TODO). */
  workspace: string | null
  boundAt: number
}

export class AuthStore {
  private bindings = new Map<string, WindowBinding>()
  /** Users always trusted: the scan-binding owner(s). Persisted, survives restarts. */
  private ownerIds = new Set<string>()
  private readonly bindingsFile: string
  private readonly auditFile: string

  constructor(
    private config: any,
    storageDir: string,
    private logger: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    mkdirSync(storageDir, { recursive: true })
    this.bindingsFile = join(storageDir, 'bindings.json')
    this.auditFile = join(storageDir, 'audit.jsonl')
    this.load()
  }

  /** Mark a user id as a binding owner (always trusted). */
  addOwner(userId: string): void {
    if (userId && !this.ownerIds.has(userId)) {
      this.ownerIds.add(userId)
      this.save()
    }
  }

  /** Whether any owner has been adopted/configured yet. */
  hasOwners(): boolean {
    return this.ownerIds.size > 0
  }

  /** Is this conversation window allowed to drive DSH at all? */
  isAllowed(windowKey: string, kind: string): boolean {
    const sec = this.config.security ?? {}
    switch (kind) {
      case 'filehelper':
        return sec.listenFilehelper !== false
      case 'self':
        return sec.listenSelf !== false
      case 'contact': {
        // windowKey: `user:{id}` (ilink) / `contact:{wxid}` (wechaty)
        // / `fsu:{open_id}` (feishu) / `dsu:{staffId}` (dingtalk) / `wsu:{userid}` (wecom).
        const id = windowKey.replace(/^(user|contact|fsu|dsu|wsu):/, '')
        if (this.ownerIds.has(id)) return true
        return (sec.allowContacts ?? []).includes(id)
      }
      case 'room': {
        // `room:{topic}` (wechaty) / `fsc:{chat_id}` (feishu)
        // / `dsc:{conversationId}` (dingtalk) / `wsc:{chatid}` (wecom).
        const id = windowKey.replace(/^(room|fsc|dsc|wsc):/, '')
        return (sec.allowRooms ?? []).includes(id)
      }
      default:
        return false
    }
  }

  /** For room messages the actual talker must additionally be trusted. */
  isRoomTalkerAllowed(talkerId: string): boolean {
    const sec = this.config.security ?? {}
    if (this.ownerIds.has(talkerId)) return true
    // Empty allowContacts in a trusted room means "anyone in this trusted room".
    return (sec.allowContacts ?? []).length === 0 || (sec.allowContacts ?? []).includes(talkerId)
  }

  getBinding(windowKey: string): WindowBinding | undefined {
    return this.bindings.get(windowKey)
  }

  setBinding(windowKey: string, sessionId: string | null, workspace: string | null = null): WindowBinding {
    const binding: WindowBinding = { sessionId, workspace, boundAt: Date.now() }
    this.bindings.set(windowKey, binding)
    this.save()
    return binding
  }

  /** Which windows currently point at this session (for push routing). */
  windowsForSession(sessionId: string): string[] {
    const out: string[] = []
    for (const [key, b] of this.bindings) if (b.sessionId === sessionId) out.push(key)
    return out
  }

  /** One JSON line per security-relevant event: ignored sources, commands, approvals. */
  audit(event: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...data })
    try {
      appendFileSync(this.auditFile, line + '\n')
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: audit write failed: ${error?.message ?? error}`)
    }
  }

  private load(): void {
    if (!existsSync(this.bindingsFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.bindingsFile, 'utf8'))
      for (const [key, value] of Object.entries(raw.bindings ?? {})) {
        this.bindings.set(key, value as WindowBinding)
      }
      for (const id of raw.owners ?? []) {
        if (typeof id === 'string' && id) this.ownerIds.add(id)
      }
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: bindings load failed: ${error?.message ?? error}`)
    }
  }

  private save(): void {
    try {
      writeFileSync(
        this.bindingsFile,
        JSON.stringify(
          { version: 1, owners: [...this.ownerIds], bindings: Object.fromEntries(this.bindings) },
          null,
          2,
        ),
      )
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: bindings save failed: ${error?.message ?? error}`)
    }
  }
}
