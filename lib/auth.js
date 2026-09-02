/**
 * AuthStore: owner 白名单 + 窗口↔会话绑定 + 审计。
 *
 * 参考 dsh-chatops auth.ts（MIT），MVP 精简（无 allowRooms 群聊）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class AuthStore {
  constructor(config, storageDir, logger = { info() {}, warn() {} }) {
    this.config = config
    this.logger = logger
    this.bindings = new Map()
    this.ownerIds = new Set()
    mkdirSync(storageDir, { recursive: true })
    this.bindingsFile = join(storageDir, 'bindings.json')
    this.auditFile = join(storageDir, 'audit.jsonl')
    this.load()
  }

  /** Mark a user id as a binding owner (always trusted). */
  addOwner(userId) {
    if (userId && !this.ownerIds.has(userId)) {
      this.ownerIds.add(userId)
      this.save()
    }
  }

  hasOwners() {
    return this.ownerIds.size > 0
  }

  /** Is this conversation window allowed to drive DSH at all? */
  isAllowed(windowKey, kind) {
    const sec = this.config.security ?? {}
    switch (kind) {
      case 'contact': {
        // windowKey: `user:{id}` (ilink)
        const id = windowKey.replace(/^(user|contact|fsu|dsu|wsu):/, '')
        if (this.ownerIds.has(id)) return true
        return (sec.allowContacts ?? []).includes(id)
      }
      case 'room': {
        const id = windowKey.replace(/^(room|fsc|dsc|wsc):/, '')
        return (sec.allowRooms ?? []).includes(id)
      }
      default:
        return false
    }
  }

  /** For room messages the actual talker must additionally be trusted. */
  isRoomTalkerAllowed(talkerId) {
    const sec = this.config.security ?? {}
    if (this.ownerIds.has(talkerId)) return true
    return (sec.allowContacts ?? []).length === 0 || (sec.allowContacts ?? []).includes(talkerId)
  }

  getBinding(windowKey) {
    return this.bindings.get(windowKey)
  }

  setBinding(windowKey, sessionId) {
    const binding = { sessionId, boundAt: Date.now() }
    this.bindings.set(windowKey, binding)
    this.save()
    return binding
  }

  /** Which windows currently point at this session (for push routing). */
  windowsForSession(sessionId) {
    const out = []
    for (const [key, b] of this.bindings) if (b.sessionId === sessionId) out.push(key)
    return out
  }

  /** One JSON line per security-relevant event. */
  audit(event, data) {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...data })
    try {
      appendFileSync(this.auditFile, line + '\n')
    } catch (error) {
      this.logger.warn(`dsh-wechat: audit write failed: ${error?.message ?? error}`)
    }
  }

  // ---------------------------------------------------------- persistence --

  load() {
    if (!existsSync(this.bindingsFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.bindingsFile, 'utf8'))
      if (Array.isArray(raw?.owners)) this.ownerIds = new Set(raw.owners)
      if (raw?.bindings && typeof raw.bindings === 'object') {
        for (const [k, v] of Object.entries(raw.bindings)) this.bindings.set(k, v)
      }
    } catch (error) {
      this.logger.warn(`dsh-wechat: auth load failed: ${error?.message ?? error}`)
    }
  }

  save() {
    const raw = {
      owners: [...this.ownerIds],
      bindings: Object.fromEntries(this.bindings),
    }
    try {
      writeFileSync(this.bindingsFile, JSON.stringify(raw, null, 2), { mode: 0o600 })
    } catch (error) {
      this.logger.warn(`dsh-wechat: auth save failed: ${error?.message ?? error}`)
    }
  }
}