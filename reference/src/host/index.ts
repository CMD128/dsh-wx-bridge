/**
 * dsh-chatops: drive DeepSeek Harness from WeChat.
 *
 * Default channel: 微信官方 ClawBot（腾讯 iLink 机器人协议）— scan a QR in
 * the browser page /wechat/qr, a bot contact appears in WeChat, chat with it
 * to drive every workspace and session. Compliant, no ban risk, token-based
 * reconnection (no rescan on restart).
 *
 * Alternative channel: wechaty personal-account bot (v1 skeleton; violates
 * WeChat ToS, use a throwaway account only).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from './config'
import { WechatChannel } from './channel'
import { ILinkChannel } from './ilink/channel'
import { qrDataUrl } from './ilink/qrimg'
import { FeishuChannel } from './feishu/channel'
import { DingTalkChannel } from './dingtalk/channel'
import { WecomChannel } from './wecom/channel'
import { ChannelManager } from './manager'
import { AuthStore } from './auth'
import { SessionBridge } from './bridge'
import { renderScanQr } from './qrcode'

export const name = 'dsh-chatops'

// agents: enumerate root agents / deliver prompts / resume cold sessions.
// sessionQuery: list + read titles of persisted (cold) sessions — cordis 拦截
// 未声明的服务访问（返回 undefined），所以必须在这里显式声明，否则 /sessions
// 只能看到已加载的活会话。sessionTitle: live 会话的折叠标题。
export const inject = ['agents', 'sessionQuery', 'sessionTitle', 'tools']

export { Config }

export function apply(ctx: any, config: any) {
  const logger = ctx.logger
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : (ctx.credentials ?? null)

  // Multi-channel: `channels` (array) wins; legacy single `channel` is the
  // fallback. One bridge serves all channels — windowKey prefixes namespace
  // them (user:/contact:/room:/filehelper → wechat, fsu:/fsc: → feishu).
  const kinds: string[] =
    Array.isArray(config.channels) && config.channels.length > 0
      ? config.channels
      : [config.channel ?? 'ilink']

  const manager = new ChannelManager()
  const channelsByKind = new Map<string, any>()
  const storageDir =
    config.storagePath ||
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-chatops')
  migrateStorage(storageDir, logger)
  const auth = new AuthStore(config, storageDir, logger)

  let ilinkChannel: ILinkChannel | null = null

  const onMessage = (msg: any) => {
    // Feishu/DingTalk first-contact owner adoption: when NO owner exists
    // yet, the first private chatter becomes the owner (audited + announced).
    // ilink owners come from QR binding and skip this entirely.
    if ((msg.windowKey.startsWith('fsu:') || msg.windowKey.startsWith('dsu:') || msg.windowKey.startsWith('wsu:')) && !auth.hasOwners()) {
      auth.addOwner(msg.talkerId)
      auth.audit('owner/adopted', { channel: msg.windowKey.split(':')[0], userId: msg.talkerId })
      void manager.say(
        msg.windowKey,
        `🤖 dsh-chatops 已上线，你已被登记为管理员（${msg.talkerId}）。回复 /help 查看指令。`,
      )
    }
    bridge.handleInbound(msg).catch((error: any) =>
      logger.warn(`dsh-chatops: inbound handling failed: ${error?.message ?? error}`),
    )
  }

  for (const kind of kinds) {
    if (kind === 'ilink') {
      ilinkChannel = new ILinkChannel(config, {
        onMessage,
        onLogin: (userName: string) => {
          auth.audit('bot/login', { userName, channel: 'ilink' })
          const owner = ilinkChannel!.store.data.ownerUserId
          if (owner) {
            auth.addOwner(owner)
            void ilinkChannel!.say(`user:${owner}`, '🤖 dsh-chatops 已上线。回复 /help 查看指令。')
          }
        },
        onLogout: (reason: string) => auth.audit('bot/logout', { reason, channel: 'ilink' }),
        onScan: () => logger.info('dsh-chatops: 微信机器人待扫码绑定，打开 /wechat/qr 页面扫码'),
      }, logger, credentials)
      manager.register(['user:'], ilinkChannel)
      channelsByKind.set('ilink', ilinkChannel)
      // The bound ilink owner from a previous run stays trusted across restarts.
      if (ilinkChannel.store.data.ownerUserId) auth.addOwner(ilinkChannel.store.data.ownerUserId)
    } else if (kind === 'wechaty') {
      const wechaty = new WechatChannel(config, {
        onMessage,
        onLogin: (userName: string) => {
          auth.audit('bot/login', { userName, channel: 'wechaty' })
          if (config.security?.listenFilehelper !== false) {
            void wechaty.say('filehelper', '🤖 dsh-chatops 已上线。回复 /help 查看指令。')
          }
        },
        onLogout: (reason: string) => auth.audit('bot/logout', { reason, channel: 'wechaty' }),
        onScan: (qrcode: string) => void renderScanQr(qrcode, logger),
      }, logger)
      manager.register(['contact:', 'room:', 'filehelper', 'self'], wechaty)
      channelsByKind.set('wechaty', wechaty)
    } else if (kind === 'feishu') {
      const feishu = new FeishuChannel(config, {
        onMessage,
        onLogin: () => {},
        onLogout: () => {},
        onScan: () => {},
        onCardAction: async (action) => {
          // Only trusted operators may decide; bridge enforces it too.
          return bridge.decideApprovalById(action.approvalId, action.outcome, action.operatorOpenId)
        },
      }, logger)
      manager.register(['fsu:', 'fsc:'], feishu)
      channelsByKind.set('feishu', feishu)
    } else if (kind === 'dingtalk') {
      const dingtalk = new DingTalkChannel(config, {
        onMessage,
        onLogin: () => {},
        onLogout: () => {},
        onScan: () => {},
      }, logger)
      manager.register(['dsu:', 'dsc:'], dingtalk)
      channelsByKind.set('dingtalk', dingtalk)
    } else if (kind === 'wecom') {
      const wecom = new WecomChannel(config, {
        onMessage,
        onLogin: () => {},
        onLogout: () => {},
        onScan: () => {},
      }, logger)
      manager.register(['wsu:', 'wsc:'], wecom)
      channelsByKind.set('wecom', wecom)
    } else {
      logger.warn(`dsh-chatops: unknown channel "${kind}", skipped`)
    }
  }

  const bridge = new SessionBridge(ctx, config, manager, auth, logger)
  bridge.start()

  // Model-initiated file delivery: the agent calls im_send_file inside a
  // session; the file goes to every IM window bound to THAT session.
  ctx.tools.register(defineTool({
    name: 'im_send_file',
    description:
      'Send a file from the current session workspace to the IM windows (WeChat/Feishu) bound to this session. ' +
      'Use when the user asks to receive a generated file (report, chart, csv, image) in their IM. ' +
      'The path must be inside the session workspace. Images (jpg/png/webp/gif) render inline; other files arrive as file cards.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative file path, e.g. reports/weekly.md.' },
      caption: { type: 'string', description: 'Optional short message sent alongside the file.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: any, exec: any) {
      const sessionId = exec?.agent?.session?.id
      if (!sessionId) return '无法确定当前会话，文件未发送。'
      return bridge.sendFileForSession(sessionId, String(args?.path ?? ''), args?.caption)
    },
  }))

  ctx.effect(() => {
    for (const channel of manager.all()) {
      channel.start().catch((error: any) =>
        logger.warn(`dsh-chatops: channel start failed: ${error?.message ?? error}`),
      )
    }
    return () => {
      for (const channel of manager.all()) void channel.stop()
    }
  })

  // Browser endpoints: QR binding page + status/verify API. Loopback only.
  ctx.inject?.(['webServer'], (webCtx: any) => {
    webCtx.effect(() => {
      const disposers = ['/chatops', '/wechat'].map((prefix) =>
        webCtx.webServer.register(
        {
          kind: 'prefix',
          path: prefix,
          handler: async (req: any, res: any) => {
            try {
              const remote = req.socket?.remoteAddress ?? ''
              const loopback =
                remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
              const rawPath = new URL(req.url ?? '/', 'http://dsh.internal').pathname
              // Legacy alias: /wechat/* keeps working after the rename.
              const pathname = rawPath.replace(/^\/wechat(?=\/|$)/, '/chatops')

              if (!loopback) {
                writeJson(res, 403, { ok: false })
                return
              }
              if (pathname === '/chatops/qr' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                res.end(QR_PAGE_HTML)
                return
              }
              if (pathname === '/chatops/api/status' && req.method === 'GET') {
                // Legacy top-level fields (QR page) come from the ilink
                // channel; every channel also reports under `channels`.
                const result: any = { kinds, channels: {} as Record<string, unknown> }
                for (const [kind, channel] of channelsByKind) {
                  result.channels[kind] = channel.statusSnapshot?.() ?? { online: channel.online }
                }
                if (ilinkChannel) {
                  Object.assign(result, ilinkChannel.statusSnapshot())
                  if (result.qrUrl) result.qrDataUrl = await qrDataUrl(result.qrUrl)
                }
                writeJson(res, 200, { ok: true, result })
                return
              }
              if (pathname === '/chatops/api/verify' && req.method === 'POST') {
                const body = await readBody(req)
                const code = String(JSON.parse(body || '{}')?.code ?? '').trim()
                if (ilinkChannel && code) {
                  ilinkChannel.submitVerifyCode(code)
                  writeJson(res, 200, { ok: true })
                } else {
                  writeJson(res, 400, { ok: false })
                }
                return
              }
              if (pathname === '/chatops/api/config' && req.method === 'GET') {
                writeJson(res, 200, { ok: true, result: config })
                return
              }
              if (pathname === '/chatops/api/config' && req.method === 'POST') {
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
              if (pathname === '/chatops/api/rebind' && req.method === 'POST') {
                // WeChat re-bind: drop the token; the lifecycle's next beat
                // falls back to the QR login flow automatically.
                if (ilinkChannel) {
                  await ilinkChannel.unbind()
                  await ilinkChannel.start()
                }
                writeJson(res, 200, { ok: true })
                return
              }
              writeJson(res, 404, { ok: false })
            } catch (error: any) {
              try {
                if (!res.headersSent) writeJson(res, 400, { ok: false, error: error?.message ?? String(error) })
                else res.end()
              } catch {
                /* socket gone */
              }
            }
          },
        },
        'dsh-chatops: im routes',
        ),
      )
      return () => disposers.forEach((d: any) => (typeof d === 'function' ? d() : d?.dispose?.()))
    })
    logger.info('dsh-chatops: QR binding page mounted at /chatops/qr (legacy /wechat/qr alias kept)')
  })

  logger.info(`dsh-chatops: loaded (channels=${kinds.join(',')})`)
}

/**
 * Rename migration from the dsh-wechat era: move the old storage dir
 * (login token, bindings, owners, audit) under the new name, and rename the
 * wechaty memory-card file to match the new bot name. One-shot, best-effort.
 */
function migrateStorage(newDir: string, logger: any): void {
  try {
    const oldDir = newDir.replace(/dsh-chatops$/, 'dsh-wechat')
    if (oldDir === newDir || !existsSync(oldDir)) return
    if (!existsSync(newDir)) {
      renameSync(oldDir, newDir)
      logger.info('dsh-chatops: migrated storage from storages/dsh-wechat')
    }
    const oldCard = join(newDir, 'dsh-wechat.memory-card.json')
    const newCard = join(newDir, 'dsh-chatops.memory-card.json')
    if (existsSync(oldCard) && !existsSync(newCard)) renameSync(oldCard, newCard)
  } catch (error: any) {
    logger.warn(`dsh-chatops: storage migration failed: ${error?.message ?? error}`)
  }
}

/**
 * Persist the full plugin config as a profile override row (id dsh-chatops)
 * in the profile's cordis.patch.yml. Patch semantics replace the row's whole
 * config, so we always write the COMPLETE merged config. Cordis watches the
 * file and hot-reloads the composition — no restart needed in normal cases.
 */
function saveProfileOverride(current: any, next: any, logger: any): void {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchPath =
    (typeof current.profilePatch === 'string' && current.profilePatch) ||
    join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const merged = { ...current, ...next }
  let rows: any[] = []
  if (existsSync(patchPath)) {
    try {
      const parsed = yaml.load(readFileSync(patchPath, 'utf8'))
      if (Array.isArray(parsed)) rows = parsed
    } catch (error: any) {
      logger.warn(`dsh-chatops: profile patch parse failed: ${error?.message ?? error}`)
    }
  }
  const index = rows.findIndex((r) => r && typeof r === 'object' && r.id === 'dsh-chatops' && !r.insert)
  const row = { id: 'dsh-chatops', name: 'dsh-chatops', config: merged }
  if (index >= 0) rows[index] = row
  else rows.push(row)
  writeFileSync(patchPath, yaml.dump(rows, { noRefs: true, lineWidth: 120 }), 'utf8')
  logger.info(`dsh-chatops: config saved to ${patchPath} (cordis hot-reloads the composition)`)
}

function writeJson(res: any, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
      if (data.length > 64 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Self-contained binding page: polls /wechat/api/status and renders the QR. */
const QR_PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-chatops 扫码绑定</title>
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
 <h2>🤖 dsh-chatops</h2>
 <div id="state" class="state muted">加载中…</div>
 <img id="qr" style="display:none" alt="微信扫码绑定">
 <div id="verify" style="display:none;margin-top:12px">
   <p class="muted">微信要求短信验证码：</p>
   <input id="code" placeholder="验证码" inputmode="numeric">
   <button onclick="submitCode()">提交</button>
 </div>
 <p class="muted" id="hint" style="display:none">用微信扫描上方二维码，确认后机器人会出现在你的聊天列表</p>
 <p class="muted" style="display:none;word-break:break-all" ><a id="link" target="_blank" rel="noopener"></a></p>
</div>
<script>
const stateEl=document.getElementById('state'),qrEl=document.getElementById('qr'),
      verifyEl=document.getElementById('verify'),hintEl=document.getElementById('hint'),
      linkEl=document.getElementById('link');
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
  linkEl.style.display=(s.state==='await_scan'&&!s.qrDataUrl&&s.qrUrl)?'block':'none';
  if(linkEl.style.display==='block'){linkEl.href=s.qrUrl;linkEl.textContent=s.qrUrl;}
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
