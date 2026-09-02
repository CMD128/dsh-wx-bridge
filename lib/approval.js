/**
 * ApprovalBridge: 把 DSH 的 approval/request 转成微信文字审批。
 *
 * - 监听 approval/request waterfall，仅接管绑定微信窗口的会话
 * - 微信 `/approve [码]` `/reject` 决定；超时回落 GUI answerer
 * - 授权码模式（可开关）：开启时无码不放行，需回复固定码
 */
export class ApprovalBridge {
  constructor(ctx, config, channel, auth, logger) {
    this.ctx = ctx
    this.config = config
    this.channel = channel
    this.auth = auth
    this.logger = logger
    this.pendingByWindow = new Map() // windowKey → approval
  }

  start() {
    this.ctx.on('approval/request', (req) => this.handleApproval(req))
  }

  /**
   * 处理审批请求。返回 await 的 promise：'allowed-once' | 'rejected' | undefined（不拦截）。
   */
  async handleApproval(req) {
    const sessionId = req?.agent?.session?.id
    if (!sessionId) return undefined
    const windows = this.auth.windowsForSession(sessionId)
    if (windows.length === 0) return undefined // 无微信绑定 → 不拦截

    const timeoutMs = Math.max(10, this.config.approval?.timeoutSec ?? 300) * 1000
    const decision = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingByWindow.has(windows[0])) this.dropApproval(windows[0])
        resolve(undefined) // 超时回落 GUI
      }, timeoutMs)
      const entry = { req, resolve, timer, windows }
      for (const w of windows) this.pendingByWindow.set(w, entry)
    })

    const title = req?.agent?.session?.title ?? sessionId
    const toolName = req.toolName ?? 'unknown'
    const reason = String(req.reason ?? '').slice(0, 300)
    const timeoutMin = Math.round(timeoutMs / 60000)
    const authCodeOn = Boolean(this.config.approval?.enabled && this.config.approval?.authCode)

    for (const w of windows) {
      void this.channel.say(
        w,
        `⚠️ [${title}] 审批请求\n工具: ${toolName}\n原因: ${reason}\n\n` +
          (authCodeOn
            ? `授权码模式已开启：回复 /approve <授权码> 批准，/reject 拒绝（${timeoutMin} 分钟内有效）`
            : `回复 /approve 批准，/reject 拒绝（${timeoutMin} 分钟内有效，超时转 GUI 处理）`),
      )
    }
    return decision
  }

  /**
   * 微信端决定。返回：
   *  - true/false: 授权码校验结果（false=需正确码）
   *  - undefined: 已处理（resolve 已完成）
   *  - 字符串: 提示信息（无待审批等）
   */
  decideApproval(windowKey, outcome, code) {
    const entry = this.pendingByWindow.get(windowKey)
    if (!entry) return '当前没有等待审批的请求。'

    // 授权码模式
    const authCodeOn = Boolean(this.config.approval?.enabled && this.config.approval?.authCode)
    if (authCodeOn && outcome === 'allowed-once') {
      const expected = String(this.config.approval?.authCode ?? '')
      if (!code || String(code).trim() !== expected) return false
    }

    this.clearEntry(entry)
    entry.resolve(outcome === 'allowed-once' ? 'allowed-once' : 'rejected')
    return undefined
  }

  clearEntry(entry) {
    clearTimeout(entry.timer)
    for (const w of entry.windows) this.pendingByWindow.delete(w)
  }

  dropApproval(windowKey, outcome) {
    const entry = this.pendingByWindow.get(windowKey)
    if (!entry) return
    this.clearEntry(entry)
    entry.resolve(outcome === undefined ? undefined : outcome)
  }

  /** 测试用：清空所有待审批。 */
  dropAll() {
    for (const w of [...this.pendingByWindow.keys()]) this.dropApproval(w)
  }

  /** 是否开启授权码（供 /approve 路由提示）。 */
  authCodeEnabled() {
    return Boolean(this.config.approval?.enabled && this.config.approval?.authCode)
  }
}