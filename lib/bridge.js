/**
 * SessionBridge: routes WeChat messages to DSH sessions and back.
 *
 * 参考 dsh-chatops bridge.ts（MIT），MVP 精简：/help /sessions /use /bind +
 * 转发 prompt + 任务完成推送。审批/文件回传在 Phase 2。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as yaml from 'js-yaml'
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const LOG_RING_SIZE = 50

export class SessionBridge {
  constructor(ctx, config, channel, auth, logger) {
    this.ctx = ctx
    this.config = config
    this.channel = channel
    this.auth = auth
    this.logger = logger
    this.logRings = new Map()
    this.turnStatus = new Map()
    this.lastActiveRoot = null
    this.lastList = []
  }

  // ------------------------------------------------------------ lifecycle --

  start() {
    this.ctx.on('agent/created', ({ agent }) => {
      if (this.rootIds().includes(agent?.session?.id)) this.lastActiveRoot = agent
    })
    this.ctx.on('agent/status', ({ agent }) => {
      if (agent && this.rootIds().includes(agent?.session?.id)) this.lastActiveRoot = agent
    })
    this.ctx.on('session/event', (session, event) => {
      try {
        this.onSessionEvent(session, event)
      } catch (error) {
        this.logger.warn(`dsh-wechat: session/event handling failed: ${error?.message ?? error}`)
      }
    })
  }

  rootIds() {
    try {
      return this.ctx.agents.roots().map((a) => a?.session?.id).filter(Boolean)
    } catch {
      return []
    }
  }

  roots() {
    try {
      return this.ctx.agents.roots()
    } catch {
      return []
    }
  }

  liveAgentOf(sessionId) {
    try {
      return this.ctx.agents.get?.(sessionId) ?? null
    } catch {
      return null
    }
  }

  query() {
    try {
      return this.ctx.sessionQuery ?? this.ctx.get?.('sessionQuery') ?? null
    } catch {
      return null
    }
  }

  titleOf(session) {
    try {
      const svc = this.ctx.sessionTitle ?? this.ctx.get?.('sessionTitle')
      const snap = svc?.get?.(session)
      if (snap?.title) return snap.title
    } catch {
      /* fall through */
    }
    try {
      let title = null
      let firstUser = null
      for (const event of session?.events ?? []) {
        if (event?.type === 'session/title' && event?.data?.title) {
          title = event.data.title
        } else if (!firstUser && event?.type === 'user/message') {
          const text = messageText(event.data?.message ?? event.data)
          if (text) firstUser = text
        }
      }
      if (title) return title
      if (firstUser) return firstUser.slice(0, 30) + (firstUser.length > 30 ? '…' : '')
    } catch {
      /* fall through */
    }
    return session?.id ?? '未命名会话'
  }

  seedAgentOptions() {
    try {
      const svc = this.ctx.agentDefaultModel ?? this.ctx.get?.('agentDefaultModel')
      const sel = svc?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch {
      /* resume without options */
    }
    return undefined
  }

  /** 归档会话 id 集合（storages/workspace.json）。 */
  archivedIds() {
    try {
      const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const raw = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
      const set = new Set(raw?.global?.archivedSessionIds ?? [])
      this._archived = set
      return set
    } catch {
      return this._archived ?? new Set()
    }
  }

  /** 该 SessionRecord 是否应出现在微信会话列表。 */
  isListable(r) {
    // 兼容两种结构：活会话 { id, title, header:{cwd, delegationDepth} }
    // 冷记录 { header:{ id, cwd, delegationDepth } }
    const id = r?.id ?? r?.header?.id
    if (!id) return false
    // 归档会话不列
    if (this.archivedIds().has(id)) return false
    // 子代理（delegationDepth > 0）不列
    const dep = r?.header?.delegationDepth ?? r?.delegationDepth ?? 0
    if (dep > 0) return false
    // 排除配置指定的工作区（如 QQ 机器人目录）——微信只驱动主工作区会话。
    // 默认不排除任何目录；如需排除其他 agent 体系，在 config.hiddenWorkspacePatterns 配置。
    const cwd = r?.header?.cwd ?? r?.cwd ?? ''
    if (cwd && this.config?.hiddenWorkspacePatterns?.length) {
      for (const pat of this.config.hiddenWorkspacePatterns) {
        if (cwd.includes(pat)) return false
      }
    }
    return true
  }

  async allSessions({ force = false } = {}) {
    // 缓存 10s：设置页每 3s 轮询，避免反复全量扫描 + 逐个 readTitle（慢）
    if (!force && this._sessionsCache && Date.now() - this._sessionsCache.t < 10_000) {
      return this._sessionsCache.list
    }
    const out = []
    const seen = new Set()
    for (const agent of this.roots()) {
      const s = agent?.session
      if (!s?.id || seen.has(s.id)) continue
      if (!this.isListable(s)) continue // 归档或子代理不列
      seen.add(s.id)
      out.push({ id: s.id, title: this.titleOf(s), live: true, agent })
    }
    const q = this.query()
    if (q?.listSessions) {
      let records = []
      try {
        records = await q.listSessions()
      } catch {
        records = []
      }
      const cold = records.filter((r) => {
        const h = r?.header ?? r
        return h?.id && !seen.has(h.id) && this.isListable(r)
      })
      await Promise.all(cold.map(async (r) => {
        const h = r.header ?? r
        let title = null
        try {
          const t = await q.readTitle?.(h.id)
          title = typeof t === 'string' ? t : (t?.title ?? null)
        } catch {
          /* ignore */
        }
        const liveAgent = this.liveAgentOf(h.id)
        out.push({
          id: h.id,
          title: title ?? (liveAgent ? this.titleOf(liveAgent.session) : null) ?? h.id.slice(0, 12),
          live: Boolean(liveAgent),
          agent: liveAgent ?? undefined,
        })
      }))
    }
    this.lastList = out
    this._sessionsCache = { t: Date.now(), list: out }
    return out
  }

  /** 使会话列表缓存失效（会话创建/归档变化后调用）。 */
  invalidateSessions() {
    this._sessionsCache = null
  }

  // --------------------------------------------------------------- events --

  onSessionEvent(session, event) {
    const sessionId = session?.id
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
      const wasRunning = this.turnStatus.get(sessionId) === 'running'
      this.turnStatus.set(sessionId, 'idle')
      if (!wasRunning) return
      if (this.pushEnabledFor(sessionId)) {
        const kind = data.reason?.kind ?? 'unknown'
        const ring = this.logRings.get(sessionId) ?? []
        const last = ring[ring.length - 1]
        const excerpt = last ? last.slice(0, 300) : '(无文本输出)'
        for (const windowKey of this.auth.windowsForSession(sessionId)) {
          const icon = kind === 'completed' ? '✅' : '⚠️'
          void this.channel.say(
            windowKey,
            `${icon} [${this.titleOf(session)}] 任务${kind === 'completed' ? '完成' : `结束(${kind})`}：\n${excerpt}`,
          )
        }
      }
    }
  }

  // -------------------------------------------------------------- messages --

  async handleInbound(msg) {
    if (!this.auth.isAllowed(msg.windowKey, msg.kind)) {
      this.auth.audit('ignored/message', { windowKey: msg.windowKey, talkerId: msg.talkerId })
      return
    }
    // 图片消息提示（当前版本不接收图片内容）
    if (msg.imageNotice) {
      await this.channel.say(msg.windowKey, '📷 收到图片，但当前版本不支持图片识别。请用文字描述，或切换支持视觉的会话模型（/model --vision）。')
      return
    }
    const text = (msg.text ?? '').trim()
    if (!text) return
    this.auth.audit('command/inbound', { windowKey: msg.windowKey, text: text.slice(0, 200) })

    if (text.startsWith('/')) {
      const reply = await this.runCommand(msg, text)
      if (reply) await this.channel.say(msg.windowKey, reply)
      return
    }
    await this.forwardPrompt(msg, text)
  }

  async runCommand(msg, text) {
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
      case '/model':
        return await this.modelCommand(msg.windowKey, arg, false)
      case '/default-model':
        return await this.modelCommand(msg.windowKey, arg, true)
      case '/approve':
        return await this.approveCommand(msg.windowKey, arg, 'allowed-once')
      case '/reject':
        return await this.approveCommand(msg.windowKey, arg, 'rejected')
      case '/stop':
        return await this.stopCommand(msg.windowKey)
      case '/log':
        return this.showLog(msg.windowKey, Number.parseInt(arg, 10) || 3)
      case '/send':
        return await this.sendFileCommand(msg.windowKey, arg)
      case '/files':
        return await this.filesCommand(msg.windowKey, arg)
      case '/detail':
        return await this.detailCommand(msg.windowKey, arg)
      case '/preset':
        return await this.presetCommand(msg.windowKey, arg)
      default:
        return `未知指令 ${cmd}，回复 /help 查看可用指令。`
    }
  }

  // -------------------------------------------------------------- detail --

  /** /detail N：列出会话列表后，看某个会话详情（标题/状态/模型/最近输出/推送设置）。 */
  async detailCommand(windowKey, arg) {
    const idx = Number.parseInt(arg, 10)
    if (!Number.isFinite(idx) || idx < 1) return '用法：/detail <编号>（先 /sessions 看编号）'
    const list = this.lastList.length > 0 ? this.lastList : await this.allSessions()
    const entry = list[idx - 1]
    if (!entry) return `找不到编号 #${idx}。回复 /sessions 查看列表。`
    const lines = [`📋 ${entry.title}`]
    lines.push(`状态：${entry.live ? (this.turnStatus.get(entry.id) === 'running' ? '🔄运行中' : '💤空闲') : '📦未加载'}`)
    lines.push(`ID：${entry.id}`)

    // 当前模型（活会话才可查）
    if (entry.live) {
      try {
        const apiProxy = this.ctx.apiProxy ?? this.ctx.get?.('apiProxy')
        const r = await apiProxy.sessions.models({ sessionId: entry.id })
        if (r?.ok && r.value?.selected) {
          const sel = r.value.selected
          lines.push(`模型：${sel.provider}/${sel.model}${sel.reasoningEffort ? ` [${sel.reasoningEffort}]` : ''}`)
        }
      } catch {
        /* models 不可用则跳过 */
      }
    }

    // 推送设置：全局开关 + 会话级覆盖（R3）
    const pushOn = this.pushEnabledFor(entry.id)
    lines.push(`推送：${pushOn ? '✅ 开' : '⛔ 关'}`)

    // 最近输出（环形缓冲）
    const ring = this.logRings.get(entry.id) ?? []
    if (ring.length > 0) {
      lines.push(`最近输出：${ring[ring.length - 1].slice(0, 100)}`)
    } else {
      lines.push('最近输出：（缓冲区暂无，/log 查看完整记录）')
    }

    lines.push(`\n回复 /use ${idx} 绑定此会话`)
    return lines.join('\n')
  }

  /** 会话级推送开关（R3）：config.push.sessionOn 的 Map 覆盖全局。 */
  pushEnabledFor(sessionId) {
    const globalOn = this.config.push?.onSessionComplete !== false
    const overrides = this.config.push?.sessionOn ?? {}
    return overrides[sessionId] ?? globalOn
  }

  // --------------------------------------------------------------- preset --

  /** /preset [名称]：列出可用 persona preset，或切换当前会话的 preset（人格）。 */
  async presetCommand(windowKey, arg) {
    const apiProxy = this.ctx.apiProxy ?? this.ctx.get?.('apiProxy')
    if (!apiProxy?.agentPresets) return '人格预设服务不可用（agentPresets 未暴露）。'
    try {
      const listR = await apiProxy.agentPresets.list({})
      const presets = listR?.value?.presets ?? []
      if (!arg) {
        if (presets.length === 0) return '当前没有任何人格预设。可在 DSH 里创建（agent-presets）。'
        const lines = presets.map((p) => `- ${p.id}${p.name && p.name !== p.id ? `（${p.name}）` : ''}`)
        return `🎭 可用人格预设：\n${lines.join('\n')}\n\n回复 /preset <名称> 切换当前会话人格`
      }
      const target = presets.find((p) => p.id === arg || p.name === arg)
      if (!target) return `找不到人格预设 "${arg}"。回复 /preset 查看列表。`
      const sessionId = this.auth.getBinding(windowKey)?.sessionId
      if (!sessionId) return '当前未绑定会话。先 /use 绑定再切换人格。'
      const r = await apiProxy.agentPresets.select({ sessionId, agentPreset: target.id })
      if (!r?.ok) return `❌ 切换失败：${r?.error?.message ?? r?.result?.error?.message ?? 'unknown'}`
      const name = target.name && target.name !== target.id ? target.name : target.id
      return `🎭 已切换当前会话人格：${name}`
    } catch (error) {
      return `❌ 人格操作失败：${error?.message ?? error}`
    }
  }

  // --------------------------------------------------------------- files --

  /** 当前绑定会话的工作区绝对路径（无则 null）。 */
  workspaceOf(sessionId) {
    const agent = this.liveAgentOf(sessionId)
    return agent?.session?.header?.cwd ?? null
  }

  /** 解析工作区内相对路径；拒绝逃逸 + 校验存在。 */
  resolveWorkspaceFile(sessionId, relPath) {
    const cwd = this.workspaceOf(sessionId)
    if (!cwd) return { error: '会话未加载，无法确定工作区。请 /use 重新绑定。' }
    const abs = resolve(cwd, relPath)
    if (abs !== cwd && !abs.startsWith(cwd + sep)) {
      return { error: '只允许访问当前会话工作区内的文件。' }
    }
    if (!existsSync(abs)) return { error: `文件不存在：${relPath}` }
    return { path: abs }
  }

  /** /send <路径>：发送工作区内文件给微信用户。 */
  async sendFileCommand(windowKey, arg) {
    if (!arg) return '用法：/send <工作区内文件路径>（如 /send reports/weekly.md）'
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    if (!sessionId) return '未绑定会话。回复 /sessions + /use <编号> 先绑定。'
    const resolved = this.resolveWorkspaceFile(sessionId, arg)
    if ('error' in resolved) return resolved.error
    if (typeof this.channel.sendFile !== 'function') return '当前通道不支持文件发送。'
    try {
      await this.channel.sendFile(windowKey, resolved.path, `📎 ${basename(resolved.path)}`)
      return `📤 文件「${basename(resolved.path)}」发送中…`
    } catch (error) {
      return `❌ 发送失败：${error?.message ?? error}`
    }
  }

  /** /files [子目录]：列出工作区目录。 */
  async filesCommand(windowKey, arg) {
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    if (!sessionId) return '未绑定会话。回复 /sessions + /use <编号> 先绑定。'
    const cwd = this.workspaceOf(sessionId)
    if (!cwd) return '会话未加载，无法确定工作区。'
    let target = cwd
    if (arg) {
      const r = this.resolveWorkspaceFile(sessionId, arg)
      if ('error' in r) return r.error
      target = r.path
    }
    let entries = []
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch (error) {
      return `❌ 无法读取目录：${error?.message ?? error}`
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    const lines = entries.slice(0, 30).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    const prefix = target === cwd ? '' : `${target === cwd ? '' : target.replace(cwd + sep, '')}/`
    return `📁 ${target === cwd ? '.' : prefix}\n${lines.join('\n') || '（空目录）'}`
  }

  /**
   * 模型工具 im_send_file 入口：把会话工作区文件发给绑定该会话的微信窗口。
   * 供 index.js 的 defineTool 调用。
   */
  async sendFileForSession(sessionId, relPath, caption) {
    const resolved = this.resolveWorkspaceFile(sessionId, relPath)
    if ('error' in resolved) return `发送失败：${resolved.error}`
    const windows = this.auth.windowsForSession(sessionId)
    if (windows.length === 0) return '发送失败：该会话没有绑定任何微信窗口（在微信里 /use 绑定后再试）。'
    if (typeof this.channel.sendFile !== 'function') return '发送失败：当前通道不支持文件发送。'
    let sent = 0
    let lastError = null
    for (const w of windows) {
      try {
        await this.channel.sendFile(w, resolved.path, caption ?? `📎 ${basename(resolved.path)}`)
        sent++
      } catch (error) {
        lastError = error?.message ?? String(error)
      }
    }
    if (sent === 0 && lastError) return `发送失败：${lastError}`
    return sent > 0 ? `文件「${basename(resolved.path)}」已发送到 ${sent} 个微信窗口。` : '发送失败：未发送成功。'
  }

  // ----------------------------------------------------------- approval --

  /**
   * /approve [授权码] 批准；/reject 拒绝。交给 ApprovalBridge（懒加载装配）。
   */
  async approveCommand(windowKey, arg, outcome) {
    if (!this.approvalBridge) {
      return '审批服务未启用（稍后重试或检查日志）。'
    }
    const code = arg.trim() || undefined
    const result = this.approvalBridge.decideApproval(windowKey, outcome, code)
    if (result === undefined) {
      return outcome === 'allowed-once' ? '✅ 已批准，继续执行。' : '❌ 已拒绝。'
    }
    if (result === false) return '❌ 授权码错误或缺失。授权码模式已开启，请回复 /approve <授权码>。'
    return result // 字符串提示
  }

  // ------------------------------------------------------------ stop/log --

  /** /stop：中断绑定会话的当前任务（sessions.cancel）。 */
  async stopCommand(windowKey) {
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    if (!sessionId) return '当前未绑定会话。先 /use 绑定再中断。'
    try {
      const apiProxy = this.ctx.apiProxy ?? this.ctx.get?.('apiProxy')
      const r = await apiProxy.sessions.cancel({ sessionId })
      if (!r?.ok) return `❌ 中断失败：${r?.error?.message ?? 'unknown'}`
      return '⏹ 已中断当前任务。'
    } catch (error) {
      return `❌ 中断失败：${error?.message ?? error}`
    }
  }

  /** /log [n]：最近 n 条 assistant 输出（环形缓冲）。 */
  showLog(windowKey, count) {
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    if (!sessionId) return '未绑定会话。回复 /sessions + /use <编号> 先绑定。'
    const ring = this.logRings.get(sessionId) ?? []
    if (ring.length === 0) return '暂无输出记录（缓冲区仅保留插件加载后的新输出）。'
    const items = ring.slice(-Math.min(count, 10))
    const body = items.map((t, i) => `--- ${i + 1}/${items.length} ---\n${t}`).join('\n')
    return `📄 最近 ${items.length} 条输出（完整）：\n${body}`
  }

  // -------------------------------------------------------------- models --

  /** 获取模型目录（懒加载，注入或从 apiProxy 读取） */
  async modelCatalog() {
    if (!this.models) {
      const { ModelCatalog } = await import('./models.js')
      const apiProxy = this.ctx.apiProxy ?? this.ctx.get?.('apiProxy')
      const visionLoader = {
        visionModels: () => this.loadVisionMap(),
      }
      this.models = new ModelCatalog(apiProxy, visionLoader, this.logger)
    }
    return this.models
  }

  /** 视觉模型 map：从 settings.yaml 读模型 input 含 image 的（带 60s 缓存）。 */
  loadVisionMap() {
    if (this._visionCache && Date.now() - this._visionCache.t < 60_000) return this._visionCache.map
    const map = {}
    try {
      const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const raw = readFileSync(join(dshHome, 'settings.yaml'), 'utf8')
      const settings = this._parseYaml ? this._parseYaml(raw) : parseYamlLoose(raw)
      const providers = settings?.llmPiAi?.providers ?? settings?.['llm-pi-ai']?.providers ?? {}
      for (const [pname, p] of Object.entries(providers)) {
        for (const m of p?.models ?? []) {
          if ((m?.input ?? []).includes('image')) {
            map[`${pname}/${m.id}`] = true
          }
        }
      }
    } catch {
      /* settings 不可读时视觉标记为空 */
    }
    this._visionCache = { t: Date.now(), map }
    return map
  }

  /**
   * /model [expr] 会话级；/default-model [expr] 全局。
   * expr: 空=列提供商 | N=列模型 | "关键词" | --vision | --ctx N | --effort X | N/M 快捷切换
   */
  async modelCommand(windowKey, arg, globalDefault) {
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    const catalog = await this.modelCatalog()
    const PAGE = 10

    // 翻页：/model 更多 → 下一页
    if (arg === '更多' || arg === 'more' || arg === 'next') {
      return this.modelNextPage(windowKey, globalDefault)
    }

    // 无参数 → 提供商列表（树状一级，分页）
    if (!arg) {
      const providers = await catalog.providers()
      if (providers.length === 0) return '模型目录不可用（llm.models 无数据）'
      this._modelNav = { windowKey, providers, models: null, page: 0 }
      return this.renderProviderPage(providers, 0)
    }

    // 快捷路径 N/M → 直接切换
    const shortcut = await catalog.resolveShortcut(arg)
    if (shortcut) return this.switchModel(windowKey, shortcut, globalDefault)

    // 筛选参数
    const filters = {}
    let rest = arg
    const visionMatch = rest.match(/--vision/)
    if (visionMatch) { filters.vision = true; rest = rest.replace('--vision', '').trim() }
    const ctxMatch = rest.match(/--ctx\s+(\d+)\s*([km]?)/i)
    if (ctxMatch) {
      const n = Number(ctxMatch[1])
      const unit = ctxMatch[2].toLowerCase()
      filters.minCtx = unit === 'm' ? n * 1024 * 1024 : unit === 'k' ? n * 1024 : n
      rest = rest.replace(ctxMatch[0], '').trim()
    }
    const effortMatch = rest.match(/--effort\s+(\S+)/)
    if (effortMatch) { filters.effort = effortMatch[1]; rest = rest.replace(effortMatch[0], '').trim() }

    // 纯数字 → 提供商模型列表（树状二级，分页）
    if (/^\d+$/.test(rest)) {
      const providers = await catalog.providers()
      const p = providers[Number(rest) - 1]
      if (!p) return `找不到提供商 #${rest}。回复 /model 查看列表。`
      const models = await catalog.modelsOf(p.id)
      if (models.length === 0) return `提供商「${p.name}」暂无模型数据`
      this._modelNav = { windowKey, providers, models, page: 0, providerName: p.name, providerNo: Number(rest) }
      return this.renderModelPage(models, 0, p.name, Number(rest))
    }

    // 关键词搜索（剩余非空）→ 列出命中，若仅 1 个命中直接切换
    const query = rest.trim()
    if (query) {
      const hits = await catalog.search(query, filters)
      if (hits.length === 0) return `没有找到匹配 "${query}" 的模型`
      if (hits.length === 1) return this.switchModel(windowKey, hits[0], globalDefault)
      this._modelNav = { windowKey, providers: null, models: hits, page: 0, isSearch: true }
      return this.renderModelPage(hits, 0, `搜索 "${query}"`, null)
    }

    // 只有筛选无 query → 列出筛选结果
    const hits = await catalog.search('', filters)
    if (hits.length === 0) return '没有匹配筛选条件的模型'
    this._modelNav = { windowKey, providers: null, models: hits, page: 0, isSearch: true }
    return this.renderModelPage(hits, 0, `筛选`, null)
  }

  /** 渲染提供商列表页（每页 10 条）。 */
  renderProviderPage(providers, page) {
    const PAGE = 10
    const start = page * PAGE
    const slice = providers.slice(start, start + PAGE)
    const lines = slice.map((p, i) => `${start + i + 1}. ${p.name} (${p.modelCount})${p.hasVision ? ' ⚡视觉' : ''}`)
    const more = providers.length > start + PAGE ? `\n\n回复 /model 更多 看下一页（${start + PAGE + 1}-${Math.min(providers.length, start + 2 * PAGE)}）` : ''
    return `🗂 提供商（${providers.length} 个）：\n${lines.join('\n')}${more}\n\n回复 /model <编号> 看模型，/model "关键词" 搜索，/model 2/1 快捷切换`
  }

  /** 渲染模型列表页（每页 10 条）。 */
  renderModelPage(models, page, title, providerNo) {
    const PAGE = 10
    const start = page * PAGE
    const slice = models.slice(start, start + PAGE)
    const lines = slice.map((m, i) => {
      const tags = this.models?.describeTags(m) ?? ''
      return `${start + i + 1}. ${m.id}${tags ? ' ' + tags : ''}`
    })
    const more = models.length > start + PAGE ? `\n\n回复 /model 更多 看下一页（${start + PAGE + 1}-${Math.min(models.length, start + 2 * PAGE)}）` : ''
    const hint = providerNo ? `\n\n回复 /model ${providerNo}/<编号> 切换` : `\n\n回复 /model <完整 id> 切换`
    return `📦 ${title}（${models.length} 个）：\n${lines.join('\n')}${more}${hint}`
  }

  /** /model 更多 → 翻页。 */
  modelNextPage(windowKey, globalDefault) {
    const nav = this._modelNav
    if (!nav || nav.windowKey !== windowKey) return '没有浏览上下文。先回复 /model 开始浏览。'
    const next = nav.page + 1
    if (nav.providers) {
      if (next * 10 >= nav.providers.length) return '已经是最后一页了。'
      nav.page = next
      return this.renderProviderPage(nav.providers, next)
    }
    if (nav.models) {
      if (next * 10 >= nav.models.length) return '已经是最后一页了。'
      nav.page = next
      return this.renderModelPage(nav.models, next, nav.providerName ?? (nav.isSearch ? '搜索' : '模型'), nav.providerNo)
    }
    return '没有可翻页的列表。'
  }

  /** 执行模型切换（会话级或全局）并回显确认 */
  async switchModel(windowKey, model, globalDefault) {
    const sessionId = this.auth.getBinding(windowKey)?.sessionId
    const tags = this.models?.describeTags(model) ?? ''
    try {
      if (globalDefault) {
        const svc = this.ctx.agentDefaultModel ?? this.ctx.get?.('agentDefaultModel')
        if (!svc?.saveSelection) return '全局默认模型服务不可用'
        await svc.saveSelection({ provider: model.provider, model: model.id })
        return `✅ 已设为全局默认：${model.id}${tags ? ' ' + tags : ''}`
      }
      const apiProxy = this.ctx.apiProxy ?? this.ctx.get?.('apiProxy')
      if (!sessionId) return '当前未绑定会话。先 /use 绑定再切换模型。'
      const r = await apiProxy.sessions.selectModel({ sessionId, provider: model.provider, model: model.id })
      if (!r?.ok) return `❌ 切换失败：${r?.error?.message ?? 'unknown'}`
      return `✅ 已切换：${model.id}${tags ? ' ' + tags : ''}`
    } catch (error) {
      return `❌ 切换失败：${error?.message ?? error}`
    }
  }

  async listSessions() {
    const all = await this.allSessions()
    if (all.length === 0) return '当前没有任何会话。请先在 DSH GUI 中创建一个会话。'
    const lines = all.map((s, i) => {
      const status = s.live
        ? this.turnStatus.get(s.id) === 'running' ? '🔄运行中' : '💤空闲'
        : '📦未加载'
      return `${i + 1}. ${s.title} ${status}`
    })
    return `📋 会话列表（${all.length} 个）：\n${lines.join('\n')}\n\n回复 /use <编号> 切换（📦会话会自动唤醒）`
  }

  async useSession(windowKey, arg) {
    if (!arg) return '用法：/use <编号或会话id>'
    const list = this.lastList.length > 0 ? this.lastList : await this.allSessions()
    let entry = null
    const index = Number.parseInt(arg, 10)
    if (Number.isFinite(index) && index >= 1 && index <= list.length) {
      entry = list[index - 1]
    } else {
      entry = list.find((s) => s.id === arg || s.id.startsWith(arg)) ?? null
    }
    if (!entry) return `找不到会话 "${arg}"。回复 /sessions 查看列表。`
    const liveAgent = entry.agent ?? this.liveAgentOf(entry.id)
    if (!liveAgent) {
      try {
        const handle = await this.ctx.agents.resume({ resumeSessionId: entry.id, agentOptions: this.seedAgentOptions() })
        entry.agent = handle?.agent ?? handle
        entry.live = true
      } catch {
        return `⚠️ 会话「${entry.title}」尚未加载，自动唤醒失败。\n请先在 GUI 中打开它，再 /use 绑定。`
      }
    }
    this.auth.setBinding(windowKey, entry.id)
    return `✅ 已绑定会话：${entry.title}\n直接发消息即作为 prompt 发送。`
  }

  showBinding(windowKey) {
    const binding = this.auth.getBinding(windowKey)
    if (!binding?.sessionId) return '当前窗口未绑定会话。回复 /sessions 查看列表，/use <编号> 绑定。'
    const agent = this.liveAgentOf(binding.sessionId)
    return `当前绑定：${agent ? this.titleOf(agent.session) : binding.sessionId}${agent ? '' : '（会话已关闭，请重新 /use）'}`
  }

  /** 默认会话 agent（config.defaultSessionId 配置，设置页可改）。冷会话尝试唤醒。 */
  async defaultAgent() {
    const defaultId = this.config?.defaultSessionId
    if (!defaultId) return null
    const live = this.liveAgentOf(defaultId)
    if (live) return live
    try {
      const handle = await this.ctx.agents.resume({ resumeSessionId: defaultId, agentOptions: this.seedAgentOptions() })
      return handle?.agent ?? handle ?? null
    } catch {
      return null
    }
  }

  // --------------------------------------------------------------- prompt --

  async forwardPrompt(msg, text) {
    const windowKey = msg.windowKey
    let sessionId = this.auth.getBinding(windowKey)?.sessionId
    let agent = sessionId ? this.liveAgentOf(sessionId) : null

    // 绑定的是冷会话（未加载）：先尝试唤醒
    if (!agent && sessionId) {
      try {
        await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: this.seedAgentOptions() })
        agent = this.liveAgentOf(sessionId)
      } catch {
        /* fall through to recent-active fallback */
      }
    }

    // Fallback: 默认会话（设置页配置）→ 最近活跃 root
    if (!agent) {
      const defAgent = await this.defaultAgent()
      agent = defAgent
        ?? (this.lastActiveRoot && this.roots().includes(this.lastActiveRoot) ? this.lastActiveRoot : null)
        ?? this.roots()[this.roots().length - 1]
      if (!agent) {
        await this.channel.say(windowKey, '当前没有打开的会话。请先在 DSH GUI 中打开一个会话。')
        return
      }
      this.auth.setBinding(windowKey, agent.session.id)
      const hint = defAgent === agent ? '默认会话' : '最近活跃的会话'
      await this.channel.say(windowKey, `🔗 已自动绑定到${hint}：${this.titleOf(agent.session)}`)
    }

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-wechat' },
      })
      agent.followup(message)
      this.turnStatus.set(agent.session.id, 'running')
      await this.channel.say(windowKey, `🚀 已发送给 [${this.titleOf(agent.session)}]，完成后通知你。`)
    } catch (error) {
      this.logger.warn(`dsh-wechat: followup failed: ${error?.message ?? error}`)
      await this.channel.say(windowKey, `❌ 发送失败：${error?.message ?? error}`)
    }
  }
}

export const HELP_TEXT = `🤖 dsh-wechat 指令：
/sessions — 会话列表
/use <编号> — 绑定会话
/model [提供商/关键词/筛选] — 切换会话模型
/default-model — 设全局默认模型
/files [子目录] — 列工作区文件
/send <路径> — 发工作区文件给你
/approve [授权码] /reject — 审批
/stop — 中断任务
/log [n] — 最近 n 条输出
/detail <编号> — 会话详情
/preset [名称] — 会话人格（猫娘等 preset）
/bind — 查看当前绑定
直接发送其他文字 = 作为 prompt 发给绑定会话`


/** 宽松 YAML 解析（js-yaml 同步 load，失败退回空对象）。 */
function parseYamlLoose(raw) {
  try {
    return (yaml.load ?? yaml.default?.load)?.(raw) ?? {}
  } catch {
    return {}
  }
}

function messageText(message) {
  if (!message) return ''
  if (typeof message === 'string') return message
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}