import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  channel: Schema.union([
    Schema.const('ilink').description('微信官方 ClawBot/iLink 机器人（推荐，合规，扫码绑定）'),
    Schema.const('wechaty').description('wechaty 个人号协议（封号风险，仅限自用）'),
    Schema.const('feishu').description('飞书自建应用机器人（官方开放平台）'),
    Schema.const('dingtalk').description('钉钉企业内部应用机器人（官方开放平台，Stream 长连接）'),
    Schema.const('wecom').description('企业微信智能机器人（官方 aibot SDK，WS 长连接；仅企业内成员可见）'),
  ]).default('ilink').description('[单通道兼容项] 通道实现；channels 非空时忽略。'),
  channels: Schema.array(Schema.union([
    Schema.const('ilink'),
    Schema.const('wechaty'),
    Schema.const('feishu'),
    Schema.const('dingtalk'),
    Schema.const('wecom'),
  ])).default(['ilink']).description('启用的通道列表（可多选并行，如 [ilink, feishu, dingtalk]）。'),
  dingtalk: Schema.object({
    clientId: Schema.string().default('').description('钉钉企业内部应用 Client ID（AppKey），同时作为 robotCode。'),
    clientSecret: Schema.string().default('').description('钉钉企业内部应用 Client Secret（AppSecret）。'),
  }).default({ clientId: '', clientSecret: '' }).description('[dingtalk] 企业内部应用凭据。'),
  wecom: Schema.object({
    botId: Schema.string().default('').description('企业微信智能机器人 Bot ID。'),
    secret: Schema.string().default('').description('企业微信智能机器人 Secret。'),
  }).default({ botId: '', secret: '' }).description('[wecom] 智能机器人凭据。'),
  feishu: Schema.object({
    appId: Schema.string().default('').description('飞书自建应用 App ID。'),
    appSecret: Schema.string().default('').description('飞书自建应用 App Secret。'),
    domain: Schema.union([
      Schema.const('feishu').description('飞书（国内）'),
      Schema.const('lark').description('Lark（海外）'),
    ]).default('feishu').description('开放平台域名。'),
  }).default({ appId: '', appSecret: '', domain: 'feishu' }).description('[feishu] 自建应用凭据。'),
  puppet: Schema.string()
    .default('wechaty-puppet-wechat4u')
    .description('[wechaty] puppet (protocol impl): wechaty-puppet-wechat4u | wechaty-puppet-padlocal | wechaty-puppet-xp.'),
  puppetToken: Schema.string()
    .default('')
    .description('[wechaty] Token for paid puppets (padlocal etc.); empty for wechat4u.'),
  storagePath: Schema.string()
    .default('')
    .description('Where login state and bindings persist. Empty means $DSH_HOME/storages/dsh-chatops/.'),
  security: Schema.object({
    listenFilehelper: Schema.boolean()
      .default(true)
      .description('Respond to messages in "File Transfer" (filehelper) — the safest entry point, visible only to yourself.'),
    listenSelf: Schema.boolean()
      .default(true)
      .description('Respond to messages you send to yourself.'),
    allowContacts: Schema.array(Schema.string())
      .default([])
      .description('额外信任的私聊用户 id（ilink 用户 id 或 wechaty wxid）；扫码绑定的 owner 始终被信任。'),
    allowRooms: Schema.array(Schema.string())
      .default([])
      .description('信任的群聊（wechaty 群 topic / ilink 群 id）；群内只有 @Bot 的消息才被响应。'),
  }).default({
    listenFilehelper: true,
    listenSelf: true,
    allowContacts: [],
    allowRooms: [],
  }),
  push: Schema.object({
    onSessionComplete: Schema.boolean()
      .default(true)
      .description('Push a summary to the bound chat window when a session turn completes.'),
    onApproval: Schema.boolean()
      .default(true)
      .description('Push approval requests to the bound window; answer with /approve or /reject.'),
    approvalTimeoutSec: Schema.number()
      .default(300)
      .description('Seconds to wait for a WeChat approval decision before falling through to other answerers (GUI).'),
    longOutputAsFile: Schema.boolean()
      .default(true)
      .description('Send long /log output as a .txt file instead of many messages (file-capable channels).'),
  }).default({
    onSessionComplete: true,
    onApproval: true,
    approvalTimeoutSec: 300,
    longOutputAsFile: true,
  }),
  reply: Schema.object({
    maxChunkBytes: Schema.number()
      .default(6000)
      .description('Max bytes per outbound WeChat message; longer text is split into chunks.'),
    rateLimitMs: Schema.number()
      .default(1200)
      .description('Minimum interval between outbound messages (plus random jitter) — anti-risk-control throttling.'),
    maxFileMB: Schema.number()
      .default(100)
      .description('Max file size (MB) allowed for IM file delivery (platform may still reject oversized files).'),
  }).default({
    maxChunkBytes: 6000,
    rateLimitMs: 1200,
    maxFileMB: 100,
  }),
})
