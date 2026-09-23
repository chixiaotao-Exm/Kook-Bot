# KOOK 文字 AI 对话机器人

在指定 KOOK 文字频道中直接与 AI 对话，默认模型为 `gpt-6-astra`，使用可配置的 Responses API。与音乐机器人、额度看板分别运行。

## 使用

- 在配置的文字频道发送文字即可提问，也支持先 @ 机器人。
- `/重置` 或 `/清空对话`：清除自己的上下文，取消正在生成的回复。
- `/模型`：查看当前模型。
- `/帮助`：查看使用说明。

提问后先出现一张进度卡，每 15 秒更新等待时间，按实际工作显示 AI 生成、渲染图片、上传和发送等阶段。完成、失败或取消时显示最终状态。进度卡展示处理状态，不包含模型的内部推理内容。

每位用户的上下文独立，最多保留最近 10 轮、20,000 字符，闲置 2 小时后过期；重启也会清空。回复在文字频道中公开可见。当前支持文本，不读取附件、私聊或其他频道的历史。

每条消息最多 4,000 字符，每位用户同时处理 1 条请求，全局同时处理 2 条；繁忙时提示稍后再试。重复事件会去重，模型请求与送达状态不明确的回复不会自动重试。完整、自包含的静态 SVG 会被安全地渲染成 PNG，直接显示在频道中，无需下载 ZIP。渲染限制画布尺寸、内存和执行时间。

长文本和其他代码仍以 ZIP 文件提供，内含完整 `answer.txt`。不完整、含主动脚本或外部引用的 SVG 仅提供文本源文件，机器人不执行脚本或获取远程资源。

模型回复保留至 32,000 字符。达到上游生成上限或本地长度上限时会明确提示未完成，不把缺失结尾的 SVG 当成完整文件。进入下一轮上下文的单条助手回复最多 6,000 字符，附件本身仍保留完整生成内容。

## 配置与运行

需要 Node.js 22.16+ 和已加入目标服务器、能查看并发送文字消息的 KOOK 机器人。开发者后台使用 WebSocket 模式。图片渲染使用锁定版本的 `sharp`；Linux 如需中文文字，请安装 `fontconfig` 和 `fonts-noto-cjk`。

```bash
cd ai-bot
npm ci
cp .env.example .env
chmod 600 .env
# 编辑 .env，填入 KOOK Token、真实文字频道 ID、API 地址和 Key
npm run doctor
npm start
```

`OPENAI_BASE_URL` 可填写 HTTPS API 地址（末尾 `/v1` 可省略）。如果本服务与 Sub2API 在同一台服务器，可使用 `http://127.0.0.1:8080/v1`。模型接口必须支持 `POST /v1/responses`，返回非流式文本；模型不会自动切换。

| 配置 | 默认值或用途 |
| --- | --- |
| `KOOK_TOKEN` | 独立机器人的 Token |
| `KOOK_CHANNEL_ID` | 允许对话的一个文字频道 ID |
| `OPENAI_BASE_URL` | Responses API 地址 |
| `OPENAI_API_KEY` | 服务端模型凭据 |
| `OPENAI_MODEL` | `gpt-6-astra` |
| `MODEL_TIMEOUT_SECONDS` | 180 秒 |
| `MAX_OUTPUT_TOKENS` | 8192；上游须支持该参数 |
| `REASONING_EFFORT` | 默认 `low`，可配置 `medium` 或 `high`；上游须支持 |
| `HOST` / `PORT` | 本机健康检查 `127.0.0.1:18999` |
| `DATA_DIR` | 去重记录目录，默认 `./data` |

`npm run doctor` 只检查配置与 KOOK 身份、频道。`npm run doctor -- --test-model` 会额外发送一次简短模型请求，按上游规则计费，不会向 KOOK 频道发送测试消息。

对话内容只在进程内存中保留；磁盘记录仅含消息 ID 和接收时间，用于重启去重。生成图片及附件上传到 KOOK，由频道卡片显示或提供下载。发送给模型的内容包含当前用户的输入与其近期对话，使用 `store: false`；第三方 API 的日志策略由该服务决定。完整密钥只保存在私密 `.env`，不写入日志或回复。错误日志只记录经过白名单过滤的错误代码和耗时，不记录提问、回复或上游原始异常。

## Linux 常驻部署

将 `ai-bot/` 的内容放入 `/opt/kook-ai-bot`，配置私密 `.env`，然后：

```bash
sudo useradd --system --home /opt/kook-ai-bot --shell /usr/sbin/nologin kook-ai
sudo install -d -o kook-ai -g kook-ai -m 700 /opt/kook-ai-bot/data
sudo chown -R root:kook-ai /opt/kook-ai-bot
sudo chown kook-ai:kook-ai /opt/kook-ai-bot/data
sudo chmod 640 /opt/kook-ai-bot/.env
sudo install -m 644 deploy/kook-ai-bot.service /etc/systemd/system/kook-ai-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now kook-ai-bot
curl --fail http://127.0.0.1:18999/health
```

按服务器实际位置调整模板中的 Node.js 路径。使用独立系统用户，进程仅能写入 `data/`；不需要额外开放入站端口。查看状态：`systemctl status kook-ai-bot`；查看仅包含状态码的日志：`journalctl -u kook-ai-bot`。

## 测试

`npm test` 覆盖上下文隔离、重置取消、去重、限流、超时、API 错误、消息格式和重连。测试使用模拟接口，不发送真实频道消息、不调用付费模型。
