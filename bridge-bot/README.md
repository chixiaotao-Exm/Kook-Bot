# GitHub → KOOK 通知桥

独立的 Linux 服务将指定 GitHub 仓库的事件发送到固定 KOOK 文字频道，不调用模型、不启动对话机器人网关。

## 通知范围

- 分支代码推送与删除：分支、提交数量、最多 3 条提交摘要。
- PR 新建、重新打开、准备审阅、关闭和合并。
- GitHub Actions 完成结果：通过、失败、取消等；按运行 ID 与重跑次数去重，同一提交的手动、定时及 PR 独立运行各自播报。

卡片使用普通文本并提供仓库内跳转按钮。不转发 PR 正文、源码 diff、CI 日志或用户提供的任意链接。只有配置的仓库会被接收。

## 接入

使用 Node.js 22.16+，无需第三方运行依赖：

```bash
cp .env.example .env
# 填写仓库、KOOK Token、文字频道和一个新生成的随机 webhook secret。
npm test
npm start
```

GitHub 仓库 Settings → Webhooks 添加 HTTPS 地址 `/bridge/github`，Content type 选择 `application/json`，Secret 与服务端 `GITHUB_WEBHOOK_SECRET` 一致。事件只选择 **Pushes、Pull requests、Workflow runs**。保留 SSL verification。

服务只监听本机 `127.0.0.1:18997`，Nginx 示例见 `deploy/nginx-bridge.conf`。systemd 示例见 `deploy/kook-github-bridge.service`；使用无登录用户、私有 `.env` 与 `data/`，状态文件不得放进网页静态目录或提交仓库。

只发送通知时可使用现有机器人的 REST Token，不需要另开 WebSocket。通知服务与双机器人讨论服务独立启停；启动通知桥不会恢复讨论。

## 可靠性

接收端先核验原始请求体的 HMAC-SHA256 签名，再解析白名单事件；队列成功落盘后才向 GitHub 确认接收。消息发送前保存 `sending`，重启遇到该状态将标为 `uncertain`，不会盲目重发。

明确 HTTP 429 最多尝试 3 次，并等待至少 15 秒；网络超时、5xx 或无可靠消息编号都会标记送达待确认。此机制优先避免重复消息，不能保证在网络故障时每条消息都恰好送达一次。

队列最多 1,000 条，同时最多等待 32 个入队请求，终态去重记录保留 7 天；每次写盘超过 5 秒即停止队列并让健康检查返回 503，迟到的写入结果不能重新启动发送。满队列或存储失败返回 503，未接收的事件需在 GitHub Webhook Recent Deliveries 核对并按需重新投递。GitHub 本身不保证自动重投每次失败。不要删除去重状态来重试不确定送达的消息。

`GET http://127.0.0.1:18997/health` 仅供本机查看安全计数。测试模拟 GitHub/KOOK，不发送真实通知。

升级到按运行 ID 去重时保留原队列文件。旧版终态记录只有合并后的哈希，无法还原具体运行 ID；请勿批量重投旧版已成功播报的 CI 历史事件，避免因去重标识升级产生重复通知。已入队事件仍使用其原有标识发送。
