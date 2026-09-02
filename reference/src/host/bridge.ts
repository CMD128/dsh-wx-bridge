/**
 * SessionBridge: routes WeChat messages to DSH sessions and back.
 *
 * Command surface (`/` prefix; anything else goes to the bound session as a
 * prompt):
 *   /help            指令帮助
 *   /sessions        列出会话（编号 + 标题 + 状态）
 *   /use <n|id>      切换当前窗口绑定的会话
 *   /bind            查看当前绑定
 *   /status          当前会话运行状态
 *   /log [n]         最近 n 条 assistant 输出（内存环形缓冲）
 *   /approve /reject 响应待审批请求
 *   /stop            中断当前会话（TODO: 依赖 agent 中断 API，见下）
 *   /new <prompt>    新建会话（TODO: 依赖会话创建 API，见下）
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InboundMessage } from './channel'
import type { AuthStore } from './auth'

/** Structural channel contract: every channel (and the manager) satisfies it. */
export interface BridgeChannel {
  say(windowKey: string, text: string, opts?: { bulk?: boolean }): Promise<void>
  /** Card-capable channel for this window (feishu), or null. */
  cardsFor?(windowKey: string): any | null
}

const LOG_RING_SIZE = 50
/** Max chars /log will emit in one go (≈8 WeChat messages after chunking). */
const LOG_TOTAL_CAP = 12_000
/** /log output longer than this is sent as a .txt file (file-capable channels). */
const LONG_OUTPUT_FILE_THRESHOLD = 4_000

interface PendingApproval {
  id: string
  req: any
  resolve: (outcome: 'allowed-once' | 'rejected' | undefined) => void
  sessionId: string | undefined
  windows: string[]
  cardData: { approvalId: string; sessionTitle: string; toolName: string; reason: string; timeoutMin: number }
  timer: NodeJS.Timeout
}

export class SessionBridge {
  /** sessionId → recent assistant text snippets (ring buffer). */
  private logRings = new Map<string, string[]>()
  /** Latest turn status per session: running | idle. */
  private turnStatus = new Map<string, string>()
  /** Approvals currently waiting on an IM decision. */
  private pendingApprovals = new Map<string, PendingApproval>() // windowKey → approval
  /** The same approvals keyed by approval id (card-button callbacks carry ids). */
  private pendingById = new Map<string, PendingApproval>()
  /** sessionId|windowKey → streaming progress card (feishu). */
  private progressCards = new Map<string, { messageId: string; prompt: string; sessionTitle: string }>()
  /** Last active root agent, mirrors dsh-cron's delivery heuristic. */
  private lastActiveRoot: any = null
  /** Last listing shown by /sessions, so /use <编号> maps to the same order. */
  private lastList: Array<{ id: string; title: string; live: boolean; agent?: any }> = []

  constructor(
    private ctx: any,
    private config: any,
    private channel: BridgeChannel,
    private auth: AuthStore,
    private logger: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  /**
   * Human-readable session name: the folded `session/title` event via the
   * sessionTitle service (auto-generated after the first turn), falling back
   * to a direct scan of `session/title` events, then the first user message,
   * and finally the raw id.
   */
  private titleOf(session: any): string {
    try {
      const svc = this.ctx.sessionTitle ?? this.ctx.get?.('sessionTitle')
      const snap = svc?.get?.(session)
      if (snap?.title) return snap.title
    } catch {
      /* service absent or session not live — fall through */
    }
    try {
      let title: string | null = null
      let firstUser: string | null = null
      for (const event of session?.events ?? []) {
        if (event?.type === 'session/title' && event?.data?.title) {
          title = event.data.title // 保留最后一次折叠出的标题
        } else if (!firstUser && event?.type === 'user/message') {
          const text = messageText(event.data?.message ?? event.data)
          if (text) firstUser = text
        }
      }
      if (title) return title
      if (firstUser) return firstUser.slice(0, 30) + (firstUser.length > 30 ? '…' : '')
    } catch {
      /* events not enumerable — fall through */
    }
    return session?.id ?? '未命名会话'
  }

  /** sessionQuery 服务（已在 inject 声明；防御性获取兜底 headless profile）。 */
  private query(): any {
    try {
      return this.ctx.sessionQuery ?? this.ctx.get?.('sessionQuery') ?? null
    } catch {
      return null
    }
  }

  /** 诊断：上一次冷会话读取的状态（无服务/异常/记录数）。 */
  private coldDiag = '未执行'

  /**
   * Seed model options for resume, mirroring the API proxy: sessions that
   * already logged a model selection keep it; this fills the blank that
   * otherwise breaks the persona assembly (prompt variable "{{model}}").
   */
  private seedAgentOptions(): { provider: string; model: string } | undefined {
    try {
      const svc = this.ctx.agentDefaultModel ?? this.ctx.get?.('agentDefaultModel')
      const sel = svc?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch {
      /* service absent — resume without options */
    }
    return undefined
  }

  /** GUI 的归档集合（storages/workspace.json），归档会话与 GUI 保持一致地隐藏。 */
  private archivedIds(): Set<string> {
    try {
      const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const raw = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
      return new Set(raw?.global?.archivedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  /**
   * 全量顶层会话：live roots 在前（可交互），其后是持久化里的冷会话。
   * 结果缓存到 lastList，供 /use <编号> 按同一顺序取。
   */
  private async allSessions(): Promise<Array<{ id: string; title: string; live: boolean; agent?: any }>> {
    const out: Array<{ id: string; title: string; live: boolean; agent?: any }> = []
    const seen = new Set<string>()
    for (const agent of this.roots()) {
      const s = agent?.session
      if (!s?.id || seen.has(s.id)) continue
      seen.add(s.id)
      out.push({ id: s.id, title: this.titleOf(s), live: true, agent })
    }
    const q = this.query()
    if (!q?.listSessions) {
      this.coldDiag = 'sessionQuery 服务不可用'
    } else {
      let records: any[] = []
      try {
        records = await q.listSessions()
        this.coldDiag = `冷记录 ${records.length} 条`
      } catch (e: any) {
        records = []
        this.coldDiag = `listSessions 异常: ${e?.message ?? e}`
      }
      // 与 GUI 口径一致：唯一过滤条件是"未归档"（continuable 子会话 GUI 也显示，不排除）
      // SessionRecord 结构: { header: { id, cwd, parentSession? }, live, persisted }
      const archived = this.archivedIds()
      const cold = records.filter((r) => {
        const h = r?.header ?? r
        return h?.id && !seen.has(h.id) && !archived.has(h.id)
      })
      let titleFails = 0
      await Promise.all(cold.map(async (r) => {
        const h = r.header ?? r
        let title: string | null = null
        try {
          const t = await q.readTitle?.(h.id)
          title = typeof t === 'string' ? t : (t?.title ?? null)
        } catch (e: any) {
          titleFails++
          if (titleFails === 1) this.coldDiag += `；readTitle 异常: ${e?.message ?? e}`
        }
        const cwdName = typeof h.cwd === 'string' ? (h.cwd.split('/').filter(Boolean).pop() ?? '') : ''
        // 活会话但非 root（如 continuable 子会话）：同样可直接绑定，无需 resume
        const liveAgent = this.liveAgentOf(h.id)
        out.push({
          id: h.id,
          title: title ?? (liveAgent ? this.titleOf(liveAgent.session) : null) ?? (cwdName ? `[${cwdName}] ` : '') + `${String(h.id).slice(8, 14)}…`,
          live: Boolean(liveAgent),
          agent: liveAgent ?? undefined,
        })
      }))
      this.coldDiag += `；进入列表 ${cold.length} 条`
    }
    this.lastList = out
    return out
  }

  start(): void {
    this.ctx.on('agent/created', ({ agent }: any) => {
      if (this.ctx.agents.roots().includes(agent)) this.lastActiveRoot = agent
    })
    this.ctx.on('agent/status', ({ agent }: any) => {
      if (agent && this.ctx.agents.roots().includes(agent)) this.lastActiveRoot = agent
    })

    // Mirror the session event stream for /log, /status, and completion push.
    this.ctx.on('session/event', (session: any, event: any) => {
      try {
        this.onSessionEvent(session, event)
      } catch (error: any) {
        this.logger.warn(`dsh-chatops: session/event handling failed: ${error?.message ?? error}`)
      }
    })

    // Approval answerer: joins the approval/request waterfall. We only claim
    // requests whose session is bound to a WeChat window; everything else
    // falls through to the GUI answerer untouched.
    // TODO(verify): cordis waterfall pass-through semantics — returning
    // `undefined` must leave the chain to other answerers. Verify against
    // @deepseek-ai/dsh-user-approval decide() before relying on it.
    this.ctx.on('approval/request', (req: any) => this.onApprovalRequest(req))
  }

  // ---------------------------------------------------------------- events --

  private onSessionEvent(session: any, event: any): void {
    const sessionId: string | undefined = session?.id
    if (!sessionId) return
    const data = event?.data ?? {}

    if (event.type === 'assistant/message') {
      const text = messageText(data.message)
      if (text) {
        const ring = this.logRings.get(sessionId) ?? []
        ring.push(text)
        if (ring.length > LOG_RING_SIZE) ring.shift()
        this.logRings.set(sessionId, ring)
      }
      return
    }
    if (event.type === 'turn/start') {
      this.turnStatus.set(sessionId, 'running')
      return
    }
    if (event.type === 'turn/end') {
      // Only push turns we actually OBSERVED running (via turn/start or our
      // own prompt delivery). A turn/end replayed at host restart — an
      // interrupted turn from before the plugin loaded — has no matching
      // start and no output, and pushing it is pure noise
      // ("任务结束(error)：(无文本输出)").
      const wasRunning = this.turnStatus.get(sessionId) === 'running'
      this.turnStatus.set(sessionId, 'idle')
      if (!wasRunning) return
      if (this.config.push?.onSessionComplete !== false) {
        const kind = data.reason?.kind ?? 'unknown'
        const ring = this.logRings.get(sessionId) ?? []
        const last = ring[ring.length - 1]
        const excerpt = last ? last.slice(0, 300) : '(无文本输出)'
        for (const windowKey of this.auth.windowsForSession(sessionId)) {
          // A streaming progress card (feishu) is patched to its final state
          // instead of sending a separate completion text.
          const cardKey = `${sessionId}|${windowKey}`
          const progress = this.progressCards.get(cardKey)
          if (progress) {
            this.progressCards.delete(cardKey)
            const cards = this.channel.cardsFor?.(windowKey)
            if (cards?.completeProgressCard) {
              void cards.completeProgressCard(progress.messageId, progress.sessionTitle, progress.prompt, kind, last ?? '(无文本输出)')
              continue
            }
          }
          const icon = kind === 'completed' ? '✅' : '⚠️'
          void this.channel.say(
            windowKey,
            `${icon} [${this.titleOf(session)}] 任务${kind === 'completed' ? '完成' : `结束(${kind})`}：\n${excerpt}\n\n回复 /log 1 查看完整输出`,
          )
        }
      }
    }
  }

  private async onApprovalRequest(req: any): Promise<'allowed-once' | 'rejected' | undefined> {
    if (this.config.push?.onApproval === false) return undefined
    const session = req.agent?.session
    const sessionId: string | undefined = session?.id
    if (!sessionId) return undefined
    const windows = this.auth.windowsForSession(sessionId)
    if (windows.length === 0) return undefined // not a WeChat-managed session

    const timeoutMs = Math.max(10, this.config.push?.approvalTimeoutSec ?? 300) * 1000
    const approvalId = `appr-${randomUUID().slice(0, 8)}`
    const cardData = {
      approvalId,
      sessionTitle: this.titleOf(session),
      toolName: req.toolName ?? 'unknown',
      reason: String(req.reason ?? '').slice(0, 300),
      timeoutMin: Math.round(timeoutMs / 60000),
    }
    const decision = new Promise<'allowed-once' | 'rejected' | undefined>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingById.get(approvalId)
        if (pending) this.dropApproval(pending)
        resolve(undefined) // fall through to GUI answerer on timeout
      }, timeoutMs)
      const pending: PendingApproval = { id: approvalId, req, resolve, sessionId, windows, cardData, timer }
      for (const w of windows) this.pendingApprovals.set(w, pending)
      this.pendingById.set(approvalId, pending)
    })

    this.auth.audit('approval/asked', {
      sessionId,
      toolName: req.toolName,
      reason: String(req.reason ?? '').slice(0, 200),
    })
    for (const windowKey of windows) {
      // Card-capable channels (feishu) get an interactive button card;
      // everyone else gets the /approve text fallback.
      const cards = this.channel.cardsFor?.(windowKey)
      if (cards) {
        void cards.sendApprovalCard(windowKey, cardData)
      } else {
        void this.channel.say(
          windowKey,
          `⚠️ [${cardData.sessionTitle}] 审批请求\n` +
            `工具: ${cardData.toolName}\n` +
            `原因: ${cardData.reason}\n\n` +
            `回复 /approve 批准，/reject 拒绝（${cardData.timeoutMin} 分钟内有效，超时转 GUI 处理）`,
        )
      }
    }
    return decision
  }

  private dropApproval(pending: PendingApproval): void {
    clearTimeout(pending.timer)
    for (const [key, value] of this.pendingApprovals) if (value === pending) this.pendingApprovals.delete(key)
    this.pendingById.delete(pending.id)
  }

  /**
   * Card-button decision (feishu card.action.trigger). Returns the terminal
   * card to swap into the message, or null when the approval is unknown or
   * the operator is not trusted.
   */
  async decideApprovalById(
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
    operatorId: string,
  ): Promise<object | null> {
    const pending = this.pendingById.get(approvalId)
    if (!pending) return null
    if (!this.auth.isAllowed(`fsu:${operatorId}`, 'contact')) {
      this.auth.audit('approval/denied-operator', { approvalId, operatorId })
      return null
    }
    this.dropApproval(pending)
    this.auth.audit('approval/decided', {
      sessionId: pending.sessionId,
      toolName: pending.req?.toolName,
      outcome,
      operator: operatorId,
      via: 'card',
    })
    pending.resolve(outcome)
    const { approvalResultCard } = await import('./feishu/cards')
    return approvalResultCard(pending.cardData, outcome, operatorId)
  }

  // -------------------------------------------------------------- messages --

  async handleInbound(msg: InboundMessage): Promise<void> {
    if (!this.auth.isAllowed(msg.windowKey, msg.kind)) {
      this.auth.audit('ignored/message', { windowKey: msg.windowKey, kind: msg.kind, talkerId: msg.talkerId })
      return
    }
    if (msg.kind === 'room' && !this.auth.isRoomTalkerAllowed(msg.talkerId)) {
      this.auth.audit('ignored/room-talker', { windowKey: msg.windowKey, talkerId: msg.talkerId })
      return
    }

    const text = msg.text
    this.auth.audit('command/inbound', { windowKey: msg.windowKey, text: text.slice(0, 200) })

    if (text.startsWith('/')) {
      const reply = await this.runCommand(msg, text)
      // /log dumps are bulk traffic: they must not stall interactive replies
      // behind the anti-flood throttle (and vice versa). Long dumps go out as
      // a .txt FILE when the channel supports it — no message flooding.
      const cmd = text.split(/\s+/)[0]
      if (cmd === '/log' && reply && reply.length > LONG_OUTPUT_FILE_THRESHOLD
          && this.config.push?.longOutputAsFile !== false) {
        const channel: any = (this.channel as any).channelFor?.(msg.windowKey) ?? null
        if (typeof channel?.sendFile === 'function') {
          const dir = mkdtempSync(join(tmpdir(), 'dsh-chatops-'))
          const file = join(dir, `session-log-${Date.now()}.txt`)
          writeFileSync(file, reply)
          await channel.sendFile(msg.windowKey, file, '📄 输出较长，已转为文件发送')
          return
        }
      }
      if (reply) await this.channel.say(msg.windowKey, reply, { bulk: cmd === '/log' })
      return
    }
    await this.forwardPrompt(msg, text)
  }

  private async runCommand(msg: InboundMessage, text: string): Promise<string> {
    const [cmd, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (cmd) {
      case '/help':
        return HELP_TEXT
      case '/sessions':
        return await this.listSessions()
      case '/use':
        return await this.useSession(msg.windowKey, arg)
      case '/bind':
        return this.showBinding(msg.windowKey)
      case '/status':
        return this.showStatus(msg.windowKey)
      case '/log':
        return this.showLog(msg.windowKey, Number.parseInt(arg, 10) || 3)
      case '/send':
        return await this.sendFileCommand(msg.windowKey, arg)
      case '/approve':
        return this.decideApproval(msg.windowKey, 'allowed-once')
      case '/reject':
        return this.decideApproval(msg.windowKey, 'rejected')
      case '/stop':
        // TODO(verify): agent interruption API (GUI uses an interrupt path;
        // find it in @deepseek-ai/dsh-agent before enabling this).
        return '⏳ /stop 尚未接入：中断 API 待确认（GUI 侧 interrupt 路径）。'
      case '/new':
        // TODO(verify): programmatic session creation (ctx.agents.create?),
        // then bind this window to the new session id.
        return '⏳ /new 尚未接入：会话创建 API 待确认。请先在 GUI 新建会话后用 /use 绑定。'
      default:
        return `未知指令 ${cmd}，回复 /help 查看可用指令。`
    }
  }

  // ------------------------------------------------------------- commands ---

  private roots(): any[] {
    try {
      return this.ctx.agents.roots()
    } catch {
      return []
    }
  }

  /** 按 sessionId 找活 agent——覆盖非 root 的活会话（continuable 子会话 resume 后不是 root）。 */
  private liveAgentOf(sessionId: string): any {
    try {
      return this.ctx.agents.get?.(sessionId) ?? null
    } catch {
      return null
    }
  }

  private async listSessions(): Promise<string> {
    const all = await this.allSessions()
    if (all.length === 0) return '当前没有任何会话。请先在 DSH GUI 中创建一个会话。'
    const lines = all.map((s, i) => {
      const status = s.live
        ? this.turnStatus.get(s.id) === 'running' ? '🔄运行中' : '💤空闲'
        : '📦未加载'
      return `${i + 1}. ${s.title} ${status}\n   id: ${shortId(s.id)}`
    })
    return `📋 会话列表（${all.length} 个）：\n${lines.join('\n')}\n\n[诊断] ${this.coldDiag}\n回复 /use <编号> 切换（📦会话会自动唤醒）`
  }

  private async useSession(windowKey: string, arg: string): Promise<string> {
    if (!arg) return '用法：/use <编号或会话id>'
    const list = this.lastList.length > 0 ? this.lastList : await this.allSessions()
    let entry: { id: string; title: string; live: boolean; agent?: any } | null = null
    const index = Number.parseInt(arg, 10)
    if (Number.isFinite(index) && index >= 1 && index <= list.length) {
      entry = list[index - 1]
    } else {
      entry = list.find((s) => s.id === arg || s.id.startsWith(arg)) ?? null
    }
    if (!entry) return `找不到会话 "${arg}"。回复 /sessions 查看列表。`
    // 活会话（含非 root 的 continuable 子会话）直接绑定；真冷会话才 resume
    const liveAgent = entry.agent ?? this.liveAgentOf(entry.id)
    if (!liveAgent) {
      try {
        const handle = await this.ctx.agents.resume({ resumeSessionId: entry.id, agentOptions: this.seedAgentOptions() })
        entry.agent = handle?.agent ?? handle
        entry.live = true
      } catch (error: any) {
        const msg = String(error?.message ?? error)
        if (msg.includes('while it is live')) {
          // 竞态：查询与绑定之间会话被别人打开了——直接重查并绑定
          const again = this.liveAgentOf(entry.id)
          if (again) {
            this.auth.setBinding(windowKey, entry.id)
            return `✅ 已绑定会话：${entry.title}\n直接发消息即作为 prompt 发送。`
          }
        }
        return `⚠️ 会话「${entry.title}」尚未加载，自动唤醒失败：${msg}\n请先在 GUI 中打开它，再 /use 绑定。`
      }
    }
    this.auth.setBinding(windowKey, entry.id)
    return `✅ 已绑定会话：${entry.title}\n直接发消息即作为 prompt 发送。`
  }

  private showBinding(windowKey: string): string {
    const binding = this.auth.getBinding(windowKey)
    if (!binding?.sessionId) return '当前窗口未绑定会话。回复 /sessions 查看列表，/use <编号> 绑定。'
    const agent = this.liveAgentOf(binding.sessionId)
    return `当前绑定：${agent ? this.titleOf(agent.session) : binding.sessionId}${agent ? '' : '（会话已关闭，请重新 /use）'}`
  }

  private showStatus(windowKey: string): string {
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    if (!sessionId) return '未绑定会话。回复 /sessions + /use <编号> 先绑定。'
    const status = this.turnStatus.get(sessionId) ?? 'idle'
    return status === 'running' ? '🔄 当前会话正在执行中…' : '💤 当前会话空闲，可以直接发消息。'
  }

  private showLog(windowKey: string, count: number): string {
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    if (!sessionId) return '未绑定会话。回复 /sessions + /use <编号> 先绑定。'
    const ring = this.logRings.get(sessionId) ?? []
    if (ring.length === 0) return '暂无输出记录（缓冲区仅保留插件加载后的新输出）。'
    const items = ring.slice(-Math.min(count, 10))
    // Full text per item — the channel chunks it into multiple messages.
    // A total guard keeps one huge turn from flooding the chat.
    let body = items.map((t, i) => `--- ${i + 1}/${items.length} ---\n${t}`).join('\n')
    if (body.length > LOG_TOTAL_CAP) {
      body = body.slice(-LOG_TOTAL_CAP)
      body = `（内容过长，仅显示最近 ${LOG_TOTAL_CAP} 字符，完整内容请在 GUI 查看）\n…${body}`
    }
    return `📄 最近 ${items.length} 条输出（完整）：\n${body}`
  }

  private decideApproval(windowKey: string, outcome: 'allowed-once' | 'rejected'): string {
    const pending = this.pendingApprovals.get(windowKey)
    if (!pending) return '当前没有等待审批的请求。'
    this.dropApproval(pending)
    this.auth.audit('approval/decided', {
      sessionId: pending.sessionId,
      toolName: pending.req?.toolName,
      outcome,
      windowKey,
    })
    pending.resolve(outcome)
    return outcome === 'allowed-once' ? '✅ 已批准，继续执行。' : '❌ 已拒绝。'
  }

  // ----------------------------------------------------------- file send ---

  /** /send <path>: push a workspace file to the bound IM window. */
  private async sendFileCommand(windowKey: string, arg: string): Promise<string> {
    if (!arg) return '用法：/send <工作区内文件路径>（如 /send reports/weekly.md）'
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    if (!sessionId) return '未绑定会话。回复 /sessions + /use <编号> 先绑定。'
    const resolved = this.resolveWorkspaceFile(sessionId, arg)
    if ('error' in resolved) return resolved.error
    const ok = await this.sendFileToWindow(windowKey, resolved.path, `📎 ${basename(resolved.path)}`)
    return ok
      ? `📤 文件「${basename(resolved.path)}」发送中…`
      : '当前通道不支持文件发送（微信 ilink / 飞书支持；wechaty 通道暂不支持）。'
  }

  /**
   * Tool entry: the model calls im_send_file inside a session; the file goes
   * to every IM window bound to THAT session (never to a stranger's window).
   */
  async sendFileForSession(sessionId: string, relPath: string, caption?: string): Promise<string> {
    const resolved = this.resolveWorkspaceFile(sessionId, relPath)
    if ('error' in resolved) {
      this.auth.audit('file/send-failed', { sessionId, relPath, reason: resolved.error })
      return `发送失败：${resolved.error}`
    }
    const windows = this.auth.windowsForSession(sessionId)
    if (windows.length === 0) {
      this.auth.audit('file/send-failed', { sessionId, relPath, reason: 'no-bound-window' })
      return '发送失败：该会话没有绑定任何 IM 窗口（在微信/飞书里 /use 绑定后再试）。'
    }
    let sent = 0
    let lastError: string | null = null
    for (const windowKey of windows) {
      try {
        if (await this.sendFileToWindow(windowKey, resolved.path, caption ?? `📎 ${basename(resolved.path)}`)) sent++
        else lastError = '通道不支持文件发送'
      } catch (error: any) {
        lastError = error?.message ?? String(error)
      }
    }
    if (sent === 0 && lastError) {
      this.auth.audit('file/send-failed', { sessionId, relPath, reason: lastError })
      return `发送失败：${lastError}`
    }
    this.auth.audit('file/send', {
      sessionId,
      path: resolved.path,
      windows,
      sent,
    })
    return sent > 0
      ? `文件「${basename(resolved.path)}」已发送到 ${sent} 个 IM 窗口。`
      : '发送失败：绑定的通道不支持文件发送。'
  }

  /** Resolve relPath inside the session workspace; refuse escapes. */
  private resolveWorkspaceFile(sessionId: string, relPath: string): { path: string } | { error: string } {
    const agent = this.liveAgentOf(sessionId)
    const cwd = agent?.session?.header?.cwd
    if (!cwd) return { error: '会话未加载，无法确定工作区。请 /use 重新绑定（📦会话会自动唤醒）。' }
    const abs = resolve(cwd, relPath)
    if (abs !== cwd && !abs.startsWith(cwd + sep)) {
      this.auth.audit('file/escape-blocked', { sessionId, relPath })
      return { error: '只允许发送当前会话工作区内的文件。' }
    }
    if (!existsSync(abs)) return { error: `文件不存在：${relPath}` }
    try {
      if (!statSync(abs).isFile()) return { error: `不是文件：${relPath}` }
    } catch {
      return { error: `无法读取：${relPath}` }
    }
    return { path: abs }
  }

  /** Send via the channel owning this window, when it supports file send. */
  private async sendFileToWindow(windowKey: string, path: string, caption?: string): Promise<boolean> {
    const channel: any = (this.channel as any).channelFor?.(windowKey) ?? null
    if (typeof channel?.sendFile !== 'function') return false
    await channel.sendFile(windowKey, path, caption)
    return true
  }

  // --------------------------------------------------------------- prompt ---

  private async forwardPrompt(msg: InboundMessage, text: string): Promise<void> {
    const windowKey = msg.windowKey
    let sessionId = this.auth.getBinding(windowKey)?.sessionId
    let agent = sessionId ? this.liveAgentOf(sessionId) : null

    // 绑定的是冷会话（未加载）：先尝试从持久化日志唤醒
    if (!agent && sessionId) {
      try {
        await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: this.seedAgentOptions() })
        agent = this.liveAgentOf(sessionId)
      } catch {
        /* 唤醒失败则走下面的最近活跃兜底 */
      }
    }

    // Fallback: deliver to the most recently active root (same heuristic as
    // dsh-cron) and bind this window to it, so the first message "just works".
    if (!agent) {
      agent = this.lastActiveRoot && this.roots().includes(this.lastActiveRoot)
        ? this.lastActiveRoot
        : this.roots()[this.roots().length - 1]
      if (!agent) {
        await this.channel.say(windowKey, '当前没有打开的会话。请先在 DSH GUI 中打开一个会话。')
        return
      }
      this.auth.setBinding(windowKey, agent.session.id)
      await this.channel.say(windowKey, `🔗 已自动绑定到最近活跃的会话：${this.titleOf(agent.session)}`)
    }

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-chatops' },
      })
      // Queues an ordinary turn and wakes the driver; a busy agent queues the
      // turn behind the current one, so WeChat prompts never overlap.
      agent.followup(message)
      this.turnStatus.set(agent.session.id, 'running')
      const cards = this.channel.cardsFor?.(windowKey)
      if (cards?.sendProgressCard) {
        const sessionTitle = this.titleOf(agent.session)
        const messageId = await cards.sendProgressCard(windowKey, sessionTitle, text)
        if (messageId) {
          this.progressCards.set(`${agent.session.id}|${windowKey}`, { messageId, prompt: text, sessionTitle })
        } else {
          await this.channel.say(windowKey, `🚀 已发送给 [${sessionTitle}]，完成后通知你。`)
        }
      } else {
        await this.channel.say(windowKey, `🚀 已发送给 [${this.titleOf(agent.session)}]，完成后通知你。`)
      }
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: followup failed: ${error?.message ?? error}`)
      await this.channel.say(windowKey, `❌ 发送失败：${error?.message ?? error}`)
    }
  }
}

export const HELP_TEXT = `🤖 dsh-chatops 指令：
/sessions — 会话列表
/use <编号> — 绑定会话
/bind — 查看当前绑定
/status — 会话运行状态
/log [n] — 最近 n 条完整输出
/approve /reject — 审批
/send <路径> — 回传工作区文件
直接发送其他文字 = 作为 prompt 发给绑定会话`

// ------------------------------------------------------------------ helpers --

function shortId(id: unknown): string {
  const text = typeof id === 'string' ? id : '?'
  return text.length > 24 ? text.slice(0, 24) + '…' : text
}

function messageText(message: any): string {
  if (!message) return ''
  if (typeof message === 'string') return message
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n')
  }
  return ''
}

