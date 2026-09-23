# KOOK 双 AI 互聊

频道成员与两个独立 KOOK 机器人一起讨论，随时可以提问、补充或纠正。两个机器人默认均使用 `gpt-6-astra`，推理强度 `xhigh`：机器人 A 提出观点与方案，机器人 B 审阅、质疑并给出改进。回复默认约 100—200 个汉字；人类要求“一句话”等长度或格式时优先遵守。

## 使用

已配置代码工具时，可直接发送本仓库链接和检查／修复任务，由思维1实施、思维2复核，产出草稿 PR。详见[仓库执行工具](../code-agent/README.md)。只有指定操作者可执行代码任务。

直接在互聊频道发送问题，两个机器人就会围绕它持续讨论。例如发送“如何设计一个温馨的音乐社区”。后续问题、补充和代码任务结果沿用同一话题，KOOK 回复与进度卡统一引用最初的问题。停止后继续发言也保留原始主题和近期上下文，只有明确发送“新话题”才清空并切换。

| 发送内容 | 用途 |
| --- | --- |
| 任意问题或话题 | 沿用当前话题；没有话题时建立第一个话题 |
| `停止` | 停止当前讨论，保留话题和近期上下文 |
| `先暂停` / `暂停` | 真正暂停生成和后续发言，保留上下文 |
| `继续` / `恢复` | 恢复暂停的讨论，或接着已停止的话题继续 |
| `新话题` / `新话题：新的问题` | 清空旧话题；可同时给出新问题 |
| `互聊状态` | 查看当前讨论状态 |
| `帮助` | 查看使用说明 |

默认不设总轮数或总时长限制，频道同一时间只运行一场讨论。任何频道成员均可参与，每条人类发言最多 2000 字。生成回复时收到新的人类发言，可能取消尚未发送的草稿，由同一个机器人结合补充重新生成；回复已进入发送阶段时，新发言由下一位机器人回应。讨论使用近期上下文，不会无限保留全部历史。普通机器人消息不会自行启动新讨论。

原始问题和最多 16 条、总计 24,000 字符的近期公开发言保存在私密数据目录，服务重启后仍可沿用；并非无限保存所有历史。代码任务保留同一话题上下文与先前 PR 结果，新的执行副本仍按每次任务单独验证。

每次 AI 发言会调用模型。模型请求超时、服务出错或重启会中止正在执行的操作，但不会清空话题；发送“继续”可继续处理。话题、双方回复和控制指令均在频道公开显示。

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
| `MODEL_TIMEOUT_SECONDS` | 每次模型请求最长 600 秒 |
| `DUET_MAX_OUTPUT_TOKENS` | 每次请求默认 8192，范围 128—16000，包含推理消耗 |
| `REASONING_EFFORT` | 默认 `xhigh`，也支持 `low` / `medium` / `high` |
| `HOST` / `PORT` | 本机健康检查 `127.0.0.1:19000` |
| `DATA_DIR` | 当前服务的状态目录，默认 `./data` |

模型接口使用 `POST /v1/responses`，不会自动切换模型。原始话题、近期人类发言和两位机器人的近期回复会发送给配置的模型服务；模型没有浏览网页、操作服务器或执行其他外部动作的工具。

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
