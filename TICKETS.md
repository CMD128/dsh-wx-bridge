# dsh-wechat — Tickets

> 由 SPEC.md 拆分。每张 ticket 一个垂直切片：红（测试）→ 绿（实现）。按序执行，完成勾选。

## v1（已全部完成 ✅）
- [x] T1 ilink-api 协议层（13 测试）
- [x] T2 ilink-store 持久化（9 测试）
- [x] T3 ilink-channel 状态机（7 测试）
- [x] T4 bridge 会话桥接（8 测试）
- [x] T5 auth 权限（8 测试）
- [x] T6 index.js 装配 + 扫码页（已运行）
- [x] T7 真机验证（扫码/收发/绑定/推送/重启免扫码 全通）

## v2（按 D5 优先级）

### T8 — 模型目录（lib/models.js）【P3 基础】
- [x] 读取 `llm.providers` RPC 缓存目录（provider → models，含 id/name/ctx/input/efforts）
- [ ] 树状：`/model` 一级提供商列表（分页 10 条）；`/model N` 二级模型列表
- [ ] 筛选：`--vision` / `--ctx N` / `--effort X`；搜索：关键词模糊匹配
- [ ] 快捷路径 `/model 2/1`
- 测试位置：lib/models.test.js（mock llm.providers）

### T9 — 模型切换命令（bridge 扩展）【P3】
- [x] `/model` 会话级切换（sessions.selectModel）+ 回显确认
- [ ] `/default-model` 全局默认（agentDefaultModel.set）
- [ ] `/use N` 后 `/model` 反映会话当前模型
- 测试位置：lib/bridge.test.js 扩展（mock sessions/agentDefaultModel）

### T10 — 审批文字化（lib/approval.js）【P2】
- [x] approval/request waterfall → 微信文字推送（工具/原因/超时）
- [ ] `/approve` `/reject` 决定；超时回落 GUI answerer
- [ ] 授权码：开关（默认关）、固定码校验（开启时需回复码才放行）
- 测试位置：lib/approval.test.js

### T11 — 设置页 GUI（lib/client.js + index.js）【P0】
- [x] client 插件注入 settings.section；index.js 暴露 /chatops/api/config 读写
- [ ] 面板内容：连接状态 + 状态灯；重新扫码按钮；默认会话选择；推送开关（全局/按会话）；授权码设置（开关+码值）；模型选择器（搜索+筛选）
- [ ] cordis.patch.yml 配置持久化（profile override 热重载）
- 测试位置：人工验证（页面 + 日志）

### T12 — 中断与日志 `/stop` `/log`【P6】
- [x] `/stop` 调 sessions.cancel({sessionId}) 中断当前任务
- [ ] `/log [n]` 环形缓冲输出（已实现于 bridge，补命令路由）
- 测试位置：lib/bridge.test.js 扩展

### T13 — 文件回传 `/send` `/files` + im_send_file【P4】
- [x] `/files` 列会话工作区目录（路径围栏）
- [ ] `/send <路径>` 发送文件（channel sendFile：CDN 上传 + AES）
- [ ] im_send_file 工具注册（defineTool），模型主动回传
- 测试位置：lib/bridge.test.js + lib/channel 扩展测试

### T14 — 媒体接收（图片/语音）【P5】
- [x] 收图：iLink 图片消息（提示降级） → CDN 下载 + AES 解密 → 查会话模型 inputModalities 含 image → 转发给会话（附件），否则提示不支持
- [ ] 语音：type=3 voice_item.text 已有，补分发
- 测试位置：lib/ilink-channel.test.js 扩展（mock 下载/解密）

### T15 — 安全提示词【P2 附属】
- [x] 高危操作 system prompt 注入（重启 DSH/删文件/改系统配置 自我审查报告）
- [ ] 授权码开关联动微信端确认流程
- 测试位置：不测（人工验证）—— 或 bridge 注入逻辑单测

### T16 — 跨会话指派 `@编号 任务`【P7 待定】
- [ ] 设计确认后实施（当前暂缓）

---

### Phase 3（远期 backlog）
- 群聊支持
- 多通道（大概率不做）
- 定时任务调度（DSH schedule 集成）
## R 系列（code-review 后续需求，已完成）
- [x] R1 默认会话选择器（GUI）
- [x] R2 `/detail N` 会话详情
- [x] R3 按会话推送开关（push.sessionOn）
- [x] R4 安全提示词（systemPrompt.section 注入）
- [x] R5/R6 图片提示 + 语音透传
