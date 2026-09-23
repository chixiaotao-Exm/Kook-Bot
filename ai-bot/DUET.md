# KOOK 双 AI 互聊

两个独立 KOOK 机器人在一个指定文字频道轮流讨论人工给出的主题。默认均使用 `gpt-6-astra`：机器人 A 提出观点与方案，机器人 B 审阅、质疑并给出改进。每条回复要求约 100—200 个汉字。

## 使用

直接在互聊频道发送问题，两个机器人就会围绕它持续讨论。例如发送“如何设计一个温馨的音乐社区”。结束时单独发送“停止”即可，无需斜杠指令。

| 发送内容 | 用途 |
| --- | --- |
| 任意问题或话题 | 没有正在进行的讨论时，开始持续互聊 |
| `停止` | 任何频道用户均可停止当前讨论 |
| `互聊状态` | 查看当前讨论状态 |
| `帮助` | 查看使用说明 |

默认不设总轮数或总时长限制。频道同一时间只运行一场互聊；讨论进行中发送新问题不会更换当前主题，请先发送“停止”，再发送新问题。普通机器人消息不会自行启动新讨论。

每次 AI 发言会调用模型。模型请求超时、服务出错或重启也会中止当前讨论，失败请求不会自动重试，结束后不会自行续聊。话题、双方回复和控制指令均在频道公开显示。

## 独立配置

互聊服务使用两个新机器人的 Token、独立目录和系统服务。现有单人对话机器人继续运行其 `src/index.js`，不会因缺少互聊配置而受影响。两个机器人都需要加入目标 KOOK 服务器，能查看目标文字频道并发送文字消息，开发者后台使用 WebSocket 模式。

在专门的互聊目录安装同一份 `ai-bot/` 代码：

```bash
npm ci
cp deploy/duet.env.example .env
chmod 600 .env
# 编辑 .env，填入两个不同的机器人 Token、文字频道 ID 和模型 Key。
node --env-file=.env src/duet-doctor.js
node --env-file=.env src/duet-index.js
```

| 配置 | 默认值或用途 |
| --- | --- |
| `KOOK_BOT_A_TOKEN` / `KOOK_BOT_B_TOKEN` | 两个不同机器人的 Token |
| `KOOK_CHANNEL_ID` | 互聊文字频道的真实 ID |
| `OPENAI_API_KEY` | 服务端模型 API Key |
| `OPENAI_BASE_URL` | 默认 `http://127.0.0.1:8080/v1`，适合同机 Sub2API；远程地址使用 HTTPS |
| `OPENAI_MODEL` | 两个机器人共用的默认模型，`gpt-6-astra` |
| `DUET_MODEL_A` / `DUET_MODEL_B` | 可单独指定模型；空值沿用 `OPENAI_MODEL` |
| `BOT_A_LABEL` / `BOT_B_LABEL` | 默认 `机器人A` / `机器人B`，需不同且不超过 32 字符 |
| `DUET_ROUNDS` | 默认 0，表示持续互聊；也可设置 1—6，兼容指令可指定本场轮数 |
| `DUET_DEADLINE_SECONDS` | 默认 0，不设总时限；可选 30—600 秒 |
| `DUET_BETWEEN_TURNS_MS` | 默认发言间隔 2000 毫秒，范围 0—30000 |
| `MODEL_TIMEOUT_SECONDS` | 每次模型请求最长 180 秒 |
| `DUET_MAX_OUTPUT_TOKENS` | 每次请求默认 1200，范围 128—2400 |
| `REASONING_EFFORT` | 默认 `low`，也支持 `medium` / `high` |
| `HOST` / `PORT` | 本机健康检查 `127.0.0.1:19000` |
| `DATA_DIR` | 当前服务的状态目录，默认 `./data` |

模型接口使用 `POST /v1/responses`，不会自动切换模型。话题和双方历史发言会发送给配置的模型服务；模型没有浏览网页、操作服务器或执行其他外部动作的工具。

`duet-doctor.js` 默认只读检查两个机器人的身份和频道访问，核对是否为两个不同的机器人，不发送频道消息，也不调用模型。加 `--test-model` 会额外为每个席位各发一次简短模型请求，总共两次，返回连接状态和 token 统计，不返回生成正文。

## Linux 常驻部署

将代码放到 `/opt/kook-ai-duet`，在该目录创建私密 `.env`，再安装独立系统服务：

```bash
sudo useradd --system --home /opt/kook-ai-duet --shell /usr/sbin/nologin kook-duet
sudo install -d -o kook-duet -g kook-duet -m 700 /opt/kook-ai-duet/data
sudo chown -R root:kook-duet /opt/kook-ai-duet
sudo chown kook-duet:kook-duet /opt/kook-ai-duet/data
sudo chmod 640 /opt/kook-ai-duet/.env
sudo install -m 644 deploy/kook-ai-duet.service /etc/systemd/system/kook-ai-duet.service
sudo systemctl daemon-reload
sudo systemctl enable --now kook-ai-duet
curl --fail http://127.0.0.1:19000/health
```

按服务器实际安装位置调整 Node.js 路径。服务以 `kook-duet` 运行，只能写入自己的 `data/`；无需开放新的公网入站端口。查看状态使用 `systemctl status kook-ai-duet`，日志使用 `journalctl -u kook-ai-duet`。不要将私密 `.env` 或状态目录提交到仓库。

## 兼容指令

原有 `/互聊 话题`、`/停止互聊`、`/互聊状态` 和 `/互聊帮助` 仍可使用。需要有限轮次时，可发送 `/互聊 3 话题`，轮数范围为 1—6；一轮包含 A、B 各一次发言。
