# Kook-Bot

KOOK 多机器人项目合集，包含双音乐源播放机器人、Sub2API 额度看板、文字 AI 对话和中文菜单图片机器人。各项目分别安装、配置和运行，可部署在同一台或不同 Linux 服务器。

| 项目 | 功能 | 文档 |
| --- | --- | --- |
| `music-bot/` | 网易云 / QQ 音乐、多机器人独立语音房间、网页点歌、多人控制与管理员登录 | [音乐机器人](music-bot/README.md) |
| `quota-dashboard/` | Sub2API 账号额度、API Key 用量查询、KOOK 对话查询与定时图片播报 | [额度看板](quota-dashboard/README.md) |
| `ai-bot/` | 文字 AI 对话、图片回复、实时进度，以及两个机器人按话题轮流互聊 | [AI 对话机器人](ai-bot/README.md) |
| `code-agent/` | 实际源码读写、隔离测试与草稿 PR，固定操作本仓库 | [仓库执行工具](code-agent/README.md) |
| `bridge-bot/` | GitHub 提交、PR 和 CI 结果的 KOOK 通知桥 | [通知桥](bridge-bot/README.md) |
| `ops-center/` | Linux 资源与服务、网站接口与证书、机器人总览、KOOK 告警和状态查询 | [运维中心](ops-center/README.md) |
| `menu-bot/` | 在指定文字频道发送“菜单”，直接回复 Gran Furama 中文菜单图片 | [中文菜单机器人](menu-bot/README.md) |
| `report-bot/` | 指定频道昵称／截图识别、本人确认、单次 PUBG 举报及回执 | [PUBG 举报助手](report-bot/README.md) |

## 快速开始

```bash
git clone https://github.com/chixiaotao-Exm/Kook-Bot.git
cd Kook-Bot
```

进入需要的子目录，按照各自 README 安装依赖、复制 `.env.example` 并填写私有配置。各项目的 `.env`、`data/`、端口、系统服务和依赖彼此独立。不要直接在仓库根目录运行 `npm start`。

- 音乐机器人：推荐 Node.js 24、Python 3.10+、FFmpeg；默认 Web 端口 `8787`。
- 额度看板：Node.js 22+，图片播报需要中文字体；默认端口 `18998`。
- AI 对话机器人：Node.js 22.16+；本机健康检查端口 `18999`。
- 中文菜单机器人：Node.js 22+，仅使用标准库；使用独立 Token 和指定文字频道，菜单来源与页码见[菜单说明](menu-bot/assets/menu-source.md)。

每个 KOOK Token 应只由一个正在运行的服务使用。完整 Token、平台 Cookie、账号密码、实际账号数据和部署记录不包含在仓库中。

## 开发验证

```bash
cd music-bot
npm ci
npm run build:web
npm test

cd ../quota-dashboard
npm ci
npm test
```

AI 对话机器人同样在子目录中执行 `npm ci` 和 `npm test`。GitHub Actions 分别验证各项目；音乐项目另检查 Python QQ 接口。自动化不会部署服务器或发送真实 KOOK 消息。

仓库中的音乐网页使用原创 SVG 渐变背景；原私人部署使用的第三方动漫海报、机器人头像和截图不随源码分发。

## 许可

本仓库尚未指定整体开源许可证。第三方依赖遵循各自许可，特别是 QQ 音乐 Python 依赖的 `GPL-3.0-or-later`，详见 [QQ 接口说明](music-bot/qq/README.md)。
