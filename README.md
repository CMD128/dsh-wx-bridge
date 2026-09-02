# dsh-wx-bridge — 轻量微信桥接 DSH 插件

> 微信扫码绑定官方 ClawBot（腾讯 iLink 协议）后，**私聊即驱动 DSH 会话**：
> 发文字就是 prompt，任务完成自动推送。纯 JS（ESM）、零第三方运行时依赖、零公网部署（仅主动出站）。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![测试](https://img.shields.io/badge/tests-90%20passing-brightgreen)

---

## 功能

- 📱 **微信官方 ClawBot**：扫码绑定，普通微信里出现机器人联系人，重启免扫码（token 长效）
- 💬 **私有聊天驱动 DSH**：发文字 = prompt 发给绑定会话，完成自动推送结果
- 🔀 **会话管理**：`/sessions` 列表、`/use N` 切换、`/detail N` 查看会话详情（模型/推送/最近输出）
- 🎭 **人格切换**：`/preset <名称>` 切换会话 agent-preset（猫娘等自定义人格）
- 🧠 **模型切换**：`/model` 树状浏览/关键词搜索/能力筛选（--vision/--ctx/--effort），`/default-model` 设全局默认
- ⚠️ **危险操作审批**：DSH 危险操作转微信文字审批（`/approve` `/reject`），可配授权码二次确认
- 📁 **文件回传**：`/send <路径>` 发工作区文件，模型可主动调 `im_send_file` 回传
- ⏹ **任务控制**：`/stop` 中断、`/log` 查看完整输出
- 🛡 **安全**：单 owner 白名单、审计日志、安全提示词（高危操作 AI 自我审查）

## 快速开始

```bash
# 安装到 DSH web profile
dsh plugin --profile web add github:CMD128/dsh-wx-bridge

# 重启 DSH Web 后，打开设置 → 微信通道 → 扫码绑定
dsh web
```

微信里与机器人对话：

```
/help        → 指令帮助
/sessions    → 会话列表
/use 1       → 绑定会话
/model --vision → 切换视觉模型
/preset 猫娘 → 切换人格
直接发文字    → 作为 prompt 发给绑定会话
```

## 架构

```
微信用户 ──私聊──► ClawBot（iLink 35s 长轮询）
                      ▲ 主动出站，零公网部署
ilink-channel.js ──onMessage──► bridge.js ──followup──► DSH 会话
                    ◄──session/event── 任务完成 → 推送
```

- `lib/ilink-api.js` — iLink 协议客户端（纯 fetch，AES-128-ECB CDN 加密）
- `lib/ilink-channel.js` — 通道生命周期：扫码登录/重连/长轮询/收发
- `lib/ilink-store.js` — token 持久化（DSH credentials + 文件兜底）
- `lib/bridge.js` — DSH 会话桥接：指令路由/转发/推送/文件
- `lib/models.js` — 模型目录（llm.models + settings 视觉标记）
- `lib/approval.js` — 审批文字化 + 授权码
- `client-src/` — 设置页 GUI（源码），`npm run build:client` 构建

## 兼容性

| 项 | 要求 |
|---|---|
| DSH | 0.1.x（cordis ^4，agents/sessionQuery/sessionTitle/credentials/tools）|
| Node.js | ≥ 22（ESM）|
| 网络 | 仅主动出站 HTTPS（ilinkai.weixin.qq.com），零端口转发 |

## 开发

```bash
git clone https://github.com/CMD128/dsh-wx-bridge
cd dsh-wx-bridge
npm install
npm run build:client && node --test lib/*.test.js  # 重建 GUI + 跑测试（90 项）
```

## 致谢

- **[dsh-chatops](https://github.com/ZhuoSir/dsh-chatops)**（MIT）— iLink 协议实现与插件架构的重要参考
- **[dsh-im](https://github.com/xmanrui/dsh-im)**（MIT）— iLink 协议逆向来源
- 腾讯 iLink / ClawBot 官方机器人平台

## License

[MIT](LICENSE) © CMD128