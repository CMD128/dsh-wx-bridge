# dsh-wechat — SPEC v2（行为规范）

> v2：2026-09-01 第二轮 grill 后更新（MVP 已验证，纳入设置页 GUI/模型切换/审批/文件/媒体等需求）。
> 本文件是 tickets 与测试的依据；与代码冲突时以本文件为准（先改本文件再改代码）。

## 1. 目标

让用户（单 owner）在微信私聊里驱动本机 DSH（DeepSeek Harness）的会话：
扫码绑定官方 ClawBot（iLink 协议）后，发文字即 prompt，任务完成自动推送结果；
并提供 DSH 设置页 GUI 管理连接/会话/推送/授权码/模型。

## 2. 版本范围

### MVP（已完成并验证）
- [x] 扫码绑定（/chatops/qr）、收发文字、`/sessions` `/use`、任务完成推送、token 持久化、owner 白名单

### v2（本 spec 范围，按 D5 优先级）
1. **设置页 GUI（P0）**：设置 → 微信通道面板（连接状态/重新扫码/默认会话/推送开关/授权码/模型选择器）
2. **会话管理（P1）**：默认对接会话、会话列表→详情（模型/推送开关/最近输出）、推送开关按会话
3. **审批与授权码（P2）**：微信端文字化审批（DSH GUI 选择转微信文字选项）、授权码机制（可开关，固定码）、安全提示词
4. **模型切换（P3）**：`/model`（会话级）+ `/default-model`（全局）+ 树状/筛选/搜索选择 UX
5. **文件（P4）**：`/send <路径>`、`/files`（列工作区目录）、`im_send_file` 工具回传
6. **媒体（P5）**：图片接收（查会话模型 inputModalities 支持才转发）、语音接收（转文字）
7. **中断与日志（P6）**：`/stop`（sessions.cancel）、`/log`（环形缓冲）
8. **跨会话指派（P7，待定）**：`@编号 任务` 格式，暂缓实现

## 3. 非目标（持续明确不做）

- 多通道（飞书/钉钉/企微/wechaty）
- 群聊、多用户、多租户
- wechaty 个人号（封号风险）

## 4. 用户故事（v2 新增）

| ID | 故事 |
|---|---|
| US6 | 作为用户，我能在 DSH 设置页的"微信通道"面板看到连接状态、重新扫码、配置默认会话/推送/授权码 |
| US7 | 作为用户，我能在微信 `/sessions` 列表后选一个会话看详情（模型/推送/最近输出） |
| US8 | 作为用户，DSH 危险操作在 GUI 弹窗时，我能在微信收到文字选项并用 `/approve` `/reject` 决定 |
| US9 | 作为用户，开启授权码后，危险操作需我在微信回复固定码才放行 |
| US10 | 作为用户，我能用 `/model` 切换当前会话模型、`/default-model` 设全局默认（树状/筛选/搜索） |
| US11 | 作为用户，我能用 `/send` 让机器人发工作区文件给我，模型也能主动回传文件 |
| US12 | 作为用户，我能发图片给机器人（会话模型支持多模态时转发），发语音转文字 |
| US13 | 作为用户，我能用 `/stop` 中断长任务，`/log` 查看完整输出 |
| US14 | 作为用户，高危操作（如重启 DSH）时 AI 会自我审查并报告风险 |

## 5. 模型选择 UX（US10）

```
/model                    → 一级：提供商列表（编号/名称/模型数/是否含视觉）
/model 2                  → 二级：该提供商模型（编号/id/ctx/视觉标记/effort 范围）
/model "k3"               → 关键词模糊搜索（id/name 匹配）
/model --vision           → 按能力筛选（仅 input 含 image）
/model --ctx 100k         → 按上下文筛选（contextWindow ≥ 值）
/model 2/1                → 快捷路径（提供商2第1个模型）
```
- 微信列表 **每页 10 条**，可 `/model 更多` 翻页
- 变更后**回显确认**：`✅ 已切换：gpt-5.6-sol [ctx 1M] [视觉✓]`
- `/model` 反映当前会话模型；`/use N` 切换后模型选择跟随会话
- 模型数据源：`llm.providers` RPC（id/name/contextWindow/input/reasoningEfforts）

## 6. 授权码机制（US9）

- 设置页可开关；**默认关**（关 = 直接允许 /approve 即放行）
- 开 = 固定 4-6 位码（用户自设）→ 危险操作时微信回复该码才放行
- **安全提示词**：注入会话 system prompt 片段，让 AI 对高危操作（重启 DSH、删文件、改系统配置等）自我审查并明确报告风险再执行

## 7. 审批文字化（US8）

- 监听 `approval/request` waterfall
- GUI 弹窗仍正常（不拦截）；同时向绑定该会话的微信窗口推文字：
  `⚠️ [会话] 审批请求\n工具: xxx\n原因: xxx\n\n回复 /approve 批准，/reject 拒绝（N 分钟内有效）`
- 超时回落到 GUI answerer

## 8. 架构变更（v2）

```
index.js            装配 + webServer（/chatops/* API 扩展：config 读写）
lib/ilink-api.js    协议层（不变）
lib/ilink-channel.js 通道层（不变 + 文件/图片发送接线）
lib/ilink-store.js  持久化（不变）
lib/bridge.js       桥接（+ /model /stop /log /send /files /approve /reject /assign待定）
lib/auth.js         权限（不变 + 授权码校验）
lib/models.js       [新] 模型目录：llm.providers 读取 + 树状/筛选/搜索
lib/approval.js     [新] 审批：文字化 + 授权码 + 超时回落
lib/client.js       [新] 设置页 GUI（client 插件，settings.section 插槽）
```

## 9. 测试策略（seams 更新）

**已确认的测试接缝**：

| Seam | 测什么 |
|---|---|
| bridge | 指令路由（含 /model /stop /log /send /files /approve）、推送格式 |
| models | 目录解析、树状/筛选/搜索、分页 |
| approval | 文字化推送、授权码校验、超时回落 |
| auth | 授权码开关与校验 |
| ilink-api/channel/store | 不变（既有测试） |

**不测**：真实微信收发（真机手动）、文件上传 CDN（平台侧验证）、设置页 GUI 视觉（肉眼）。

## 10. 验收标准（v2）

1. [ ] 设置页可见"微信通道"面板；能看状态/重新扫码/改默认会话/推送开关/授权码/模型
2. [ ] 微信 `/model` 树状/筛选/搜索切换会话模型；`/default-model` 设全局；变更回显确认
3. [ ] 危险操作触发时微信收到文字审批；开授权码后需回复码放行
4. [ ] `/stop` 中断任务；`/log` 显示完整输出
5. [ ] `/send` `/files` 文件回传；模型可调 `im_send_file`
6. [ ] 发图片给机器人：支持多模态的会话转图，否则提示；语音转文字
7. [ ] 既有 MVP 功能无回归（45 测试全绿）