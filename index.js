/**
 * dsh-wechat: drive DeepSeek Harness from WeChat.
 *
 * 通道：微信官方 ClawBot（腾讯 iLink 机器人协议）— 扫码绑定，私聊驱动 DSH 会话。
 * 只保留 ilink 通道 + 单 owner（MVP）。参考 dsh-chatops index.ts（MIT）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createILinkApi } from './lib/ilink-api.js'
import { ILinkChannel } from './lib/ilink-channel.js'
import { ILinkStore } from './lib/ilink-store.js'
import { AuthStore } from './lib/auth.js'
import { SessionBridge } from './lib/bridge.js'

export const name = 'dsh-wechat'

// agents: enumerate root agents / deliver prompts / resume cold sessions.
// sessionQuery: list + read titles of persisted (cold) sessions.
// sessionTitle: live 会话的折叠标题。
// credentials: DSH 凭据存储（bot token 优先存这里）。
export const inject = ['agents', 'sessionQuery', 'sessionTitle', 'credentials', 'tools']

export async function apply(ctx, config) {
  const logger = ctx.logger
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : (ctx.credentials ?? null)

  const storageDir =
    config.storagePath ||
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-wechat')

  const auth = new AuthStore(config, storageDir, logger)
  const store = new ILinkStore(storageDir, credentials, logger)

  // 历史 owner（上次扫码绑定者）跨重启保持受信
  if (store.data.ownerUserId) auth.addOwner(store.data.ownerUserId)

  const bridge = new SessionBridge(ctx, config, null, auth, logger)

  // bridge 的 channel 延迟绑定（ilinkChannel 创建后注入）
  const ilinkChannel = new ILinkChannel(
    config,
    {
      onMessage: (msg) => {
        bridge.handleInbound(msg).catch((error) =>
          logger.warn(`dsh-wechat: inbound handling failed: ${error?.message ?? error}`),
        )
      },
      onLogin: (userName) => {
        auth.audit('bot/login', { userName, channel: 'ilink' })
        const owner = ilinkChannel.store.data.ownerUserId
        if (owner) {
          auth.addOwner(owner)
          void ilinkChannel.say(`user:${owner}`, '🤖 dsh-wechat 已上线。回复 /help 查看指令。')
        }
      },
      onLogout: (reason) => auth.audit('bot/logout', { reason, channel: 'ilink' }),
      onScan: () => logger.info('dsh-wechat: 微信机器人待扫码绑定，打开 /wechat/qr 页面扫码'),
    },
    logger,
    createILinkApi(),
    store,
  )
  bridge.channel = ilinkChannel
  bridge.start()

  // 安全提示词：高危操作 AI 自我审查（微信驱动场景增强）。config.safetyPrompt !== false 时注入。
  if (config.safetyPrompt !== false) {
    try {
      const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
      systemPrompt?.section?.({
        name: 'dsh-wechat-safety',
        order: 50,
        text: SAFETY_PROMPT_TEXT,
      })
    } catch (error) {
      logger.warn(`dsh-wechat: safety prompt injection failed: ${error?.message ?? error}`)
    }
  }

  // 审批：监听 approval/request waterfall，微信文字审批 + 授权码。
  const { ApprovalBridge } = await import('./lib/approval.js')
  bridge.approvalBridge = new ApprovalBridge(ctx, config, ilinkChannel, auth, logger)
  bridge.approvalBridge.start()

  // 模型工具：会话内模型可主动把工作区文件回传微信（im_send_file）。
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  ctx.tools.register(defineTool({
    name: 'im_send_file',
    description:
      'Send a file from the current session workspace to the WeChat window bound to this session. ' +
      'Use when the user asks to receive a generated file (report, chart, csv, image) in WeChat. ' +
      'The path must be inside the session workspace.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative file path, e.g. reports/weekly.md.' },
      caption: { type: 'string', description: 'Optional short message sent alongside the file.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      if (!sessionId) return '无法确定当前会话，文件未发送。'
      return bridge.sendFileForSession(sessionId, String(args?.path ?? ''), args?.caption)
    },
  }))

  // 生命周期：跟随插件启停
  ctx.effect(() => {
    ilinkChannel.start().catch((error) =>
      logger.warn(`dsh-wechat: channel start failed: ${error?.message ?? error}`),
    )
    return () => ilinkChannel.stop()
  })

  // 扫码页 + 状态 API（loopback only）
  ctx.get?.('webServer')?.register?.({
    kind: 'prefix',
    path: '/chatops',
    handler: async (req, res) => {
      try {
        const remote = req.socket?.remoteAddress ?? ''
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
        const rawPath = new URL(req.url ?? '/', 'http://dsh.internal').pathname

        if (!loopback) {
          writeJson(res, 403, { ok: false })
          return
        }
        if (rawPath === '/chatops/qr' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(QR_PAGE_HTML)
          return
        }
        if (rawPath === '/chatops/api/status' && req.method === 'GET') {
          const s = ilinkChannel.statusSnapshot()
          const result = { ...s }
          // iLink 的 qrcode_img_content 不是图片，是一个微信验证网页 URL。
          // 正确做法：把这个 URL 编码成二维码 data URL（微信扫码后打开绑定流程）。
          if (s.qrUrl) {
            result.qrDataUrl = await qrDataUrl(s.qrUrl)
          }
          writeJson(res, 200, { ok: true, result })
          return
        }
        if (rawPath === '/chatops/api/verify' && req.method === 'POST') {
          const body = await readBody(req)
          const code = String(JSON.parse(body || '{}')?.code ?? '').trim()
          if (code) {
            ilinkChannel.submitVerifyCode(code)
            writeJson(res, 200, { ok: true })
          } else {
            writeJson(res, 400, { ok: false })
          }
          return
        }
        if (rawPath === '/chatops/api/sessions' && req.method === 'GET') {
          // 供设置页默认会话下拉：列出可绑定的未归档根会话。
          const all = await bridge.allSessions()
          writeJson(res, 200, { ok: true, result: { sessions: all.map((s) => ({ id: s.id, title: s.title, live: s.live })) } })
          return
        }
        if (rawPath === '/chatops/api/config' && req.method === 'GET') {
          writeJson(res, 200, { ok: true, result: await readProfileConfig(config, logger) })
          return
        }
        if (rawPath === '/chatops/api/config' && req.method === 'POST') {
          const body = await readBody(req)
          const next = JSON.parse(body || '{}')?.config
          if (!next || typeof next !== 'object') {
            writeJson(res, 400, { ok: false, error: 'config object required' })
            return
          }
          saveProfileOverride(config, next, logger)
          writeJson(res, 200, { ok: true, result: { hotReload: true } })
          return
        }
        if (rawPath === '/chatops/api/rebind' && req.method === 'POST') {
          // 微信重新绑定：丢弃 token，生命周期下一拍自动回落扫码流程。
          await ilinkChannel.unbind()
          await ilinkChannel.start()
          writeJson(res, 200, { ok: true })
          return
        }
        writeJson(res, 404, { ok: false })
      } catch (error) {
        try {
          if (!res.headersSent) writeJson(res, 400, { ok: false, error: error?.message ?? String(error) })
          else res.end()
        } catch {
          /* socket gone */
        }
      }
    },
  }, 'dsh-wechat: qr routes')

  logger.info('dsh-wechat: loaded')
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * 读取最新持久化配置：以闭包 config 为默认，覆盖 profile patch 文件中
 * dsh-wechat 行的配置（cordis 热重载可能已更新文件，闭包仍是旧的）。
 */
async function readProfileConfig(current, logger) {
  const yaml = await import('js-yaml')
  const { existsSync, readFileSync } = await import('node:fs')
  const patchPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(patchPath)) return current
  try {
    const rows = yaml.load(readFileSync(patchPath, 'utf8'))
    if (!Array.isArray(rows)) return current
    const row = rows.find((r) => r && typeof r === 'object' && r.id === 'dsh-wechat' && !r.insert)
    if (row?.config && typeof row.config === 'object') {
      return { ...current, ...row.config }
    }
  } catch (error) {
    logger.warn(`dsh-wechat: config read failed: ${error?.message ?? error}`)
  }
  return current
}

/**
 * 把完整插件配置持久化为 profile override 行（id dsh-wechat）写入 profile 的
 * cordis.patch.yml。patch 语义整行替换，故总是写完整合并配置。
 * cordis 监听文件热重载，无需重启。
 */
async function saveProfileOverride(current, next, logger) {
  const yaml = await import('js-yaml')
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
  const patchPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml')
  const merged = { ...current, ...next }
  let rows = []
  if (existsSync(patchPath)) {
    try {
      const parsed = yaml.load(readFileSync(patchPath, 'utf8'))
      if (Array.isArray(parsed)) rows = parsed
    } catch (error) {
      logger.warn(`dsh-wechat: profile patch parse failed: ${error?.message ?? error}`)
    }
  }
  const index = rows.findIndex((r) => r && typeof r === 'object' && r.id === 'dsh-wechat' && !r.insert)
  const row = { id: 'dsh-wechat', name: 'dsh-wechat', config: merged }
  if (index >= 0) rows[index] = row
  else rows.push(row)
  writeFileSync(patchPath, yaml.dump(rows, { noRefs: true, lineWidth: 120 }), 'utf8')
  logger.info('dsh-wechat: config saved (cordis hot-reloads composition)')
}

/**
 * 把 iLink 二维码网页 URL 编码成 PNG data URL（本地生成，无第三方往返）。
 * 缓存按 URL 去重：页面每 2s 轮询不会重复生成。
 */
let qrCache = { url: '', dataUrl: '' }
async function qrDataUrl(url) {
  if (qrCache.url === url && qrCache.dataUrl) return qrCache.dataUrl
  try {
    const mod = await import('qrcode')
    const QRCode = mod.default ?? mod
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 })
    qrCache = { url, dataUrl }
    return dataUrl
  } catch {
    return null // 页面退回显示原始链接
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Self-contained binding page: polls /chatops/api/status and renders the QR. */
const QR_PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-wechat 扫码绑定</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#222}
 .card{border:1px solid #e5e5e5;border-radius:12px;padding:24px;text-align:center}
 #qr{max-width:280px;width:100%;border-radius:8px}
 .state{font-size:15px;margin:12px 0}
 .ok{color:#07c160}.warn{color:#fa9d3b}.err{color:#e6432d}
 input{padding:8px;font-size:16px;width:140px}button{padding:8px 16px;font-size:15px}
 .muted{color:#888;font-size:13px}
</style></head><body>
<div class="card">
 <h2>🤖 dsh-wechat</h2>
 <div id="state" class="state muted">加载中…</div>
 <img id="qr" style="display:none" alt="微信扫码绑定">
 <div id="verify" style="display:none;margin-top:12px">
   <p class="muted">微信要求短信验证码：</p>
   <input id="code" placeholder="验证码" inputmode="numeric">
   <button onclick="submitCode()">提交</button>
 </div>
 <p class="muted" id="hint" style="display:none">用微信扫描上方二维码，确认后机器人会出现在你的聊天列表</p>
</div>
<script>
const stateEl=document.getElementById('state'),qrEl=document.getElementById('qr'),
      verifyEl=document.getElementById('verify'),hintEl=document.getElementById('hint');
const LABELS={idle:'未连接',await_scan:'请用微信扫码',scanned:'已扫码，请在手机上确认',
 need_verifycode:'需要短信验证码',connecting:'连接中…',connected:'✅ 已连接，回到微信和机器人聊天即可',error:'连接出错'};
async function tick(){
 try{
  const r=await fetch('/chatops/api/status');const j=await r.json();const s=j.result||{};
  stateEl.textContent=LABELS[s.state]||s.state||'未知状态';
  stateEl.className='state '+(s.state==='connected'?'ok':s.state==='error'?'err':'warn');
  const showQr=s.state==='await_scan'&&s.qrDataUrl;
  qrEl.style.display=showQr?'block':'none'; if(showQr&&qrEl.src!==s.qrDataUrl)qrEl.src=s.qrDataUrl;
  hintEl.style.display=showQr?'block':'none';
  verifyEl.style.display=s.state==='need_verifycode'?'block':'none';
  if(s.lastError&&s.state==='error')stateEl.textContent+='：'+s.lastError;
 }catch(e){stateEl.textContent='状态查询失败';stateEl.className='state err'}
}
async function submitCode(){
 const code=document.getElementById('code').value.trim();if(!code)return;
 await fetch('/chatops/api/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
 document.getElementById('code').value='';tick();
}
tick();setInterval(tick,2000);
</script></body></html>`
/** 安全提示词：微信驱动场景下，高危操作要求 AI 自我审查并明确报告风险。 */
const SAFETY_PROMPT_TEXT = `[微信通道安全规则]
本会话可能通过微信被远程驱动。执行以下操作前，必须先在回复中明确说明风险并征求确认：
- 重启/停止/安装/卸载系统服务或软件（如 systemctl、apt、npm 全局安装）
- 删除或覆盖关键文件（配置文件、备份、数据库）
- 修改网络/路由/防火墙配置（如 nmcli、iptables）
- 执行涉及凭据、密码、密钥的读取或修改
- 批量/递归删除（rm -rf）或格式化
对上述操作：1) 简要说明将执行什么；2) 列出风险；3) 等待用户明确确认后再执行。用户未确认前不要执行。`
