# KOOK 三音乐源多机器人

面向 Linux 部署的 KOOK 音乐机器人，支持网易云音乐、QQ 音乐及可选的汽水音乐。一个服务可管理多个 KOOK 机器人，每个机器人拥有独立语音房间、播放队列、进度与设置。

## 功能

- KOOK 文字点歌、网页搜索、跨平台联合搜索、歌曲与歌单分享链接解析。
- 歌单预览与分页、榜单导入、网易云心动推荐；最多 500 首待播。
- 暂停/恢复、切歌、上一首、进度调整、音量、循环、队列管理及最近播放历史。
- 常驻频道与静音保活；保存播放进度，重启后恢复。
- 退出失败先停音频并保存待退出频道，最多自动尝试 3 次；未确认退出时明确提示，再次停止或选择频道可手动重试。旧连接清理完成后才允许建立新连接。
- 网易云扫码及 QQ/微信扫码登录，各平台凭据独立保存在服务器。
- 汽水音乐搜索、歌单、推荐、歌词及账号授权整曲播放；使用 Linux 自建接口和 Wine 签名组件，未配置时入口禁用。部署说明见 [汽水音乐接入](qishui/README.md)。
- 多机器人状态页、歌词、自动电台、定时计划、点歌规则和故障信息。
- 用户房间大厅、专属房间、昵称点歌、本人点歌撤回与共享播放控制。
- 管理员用户名密码登录、房间 DJ/房主角色及邀请权限。

普通用户入口为 `/` 或 `/rooms`；房间入口为 `/room/<机器人ID>`。管理员从 `/admin` 登录后进入 `/admin/console`。公共成员可以切歌、暂停、调音量、调整队列，服务器与机器人配置仍由管理角色控制。

详细功能与权限见 [房间功能手册](docs/ROOM-FEATURES.md)、[多人房间手册](docs/SOCIAL-ROOMS.md)、[分享链接设计](docs/SMART_LINK_DESIGN.md)。

## 环境与 KOOK 接入

- 推荐 Node.js 24 LTS；最低 Node.js 22.16。
- FFmpeg（含 Opus 编码）、Python 3.10+。
- KOOK 应用采用 **WebSocket** 消息模式，不需要新增 Webhook 端口。
- 机器人需加入目标服务器，并获得查看频道、发送消息、连接语音和发言权限；语音接口需有可用权限与额度。

每个机器人使用不同 Token，同一 Token 不要由其他实例重复运行。频道和服务器参数使用开发者模式复制的真实数字 ID。

## 安装运行

```bash
cd music-bot
npm ci
npm run build:web
cp .env.example .env
chmod 600 .env
# 编辑 .env，填写 KOOK_TOKEN 和 ALLOWED_GUILD_IDS
python3 -m venv .venv
.venv/bin/pip install -r qq/requirements.lock.txt
npm start
```

Ubuntu 安装系统依赖：

```bash
sudo apt-get update
sudo apt-get install ffmpeg python3 python3-venv
```

将 `QQ_PYTHON_PATH` 设置为 Python 虚拟环境的绝对路径。`KOOK_TOKEN` 和 `ALLOWED_GUILD_IDS` 为必填；其余配置见 `.env.example`。默认示例音量 5%，队列上限可在 1–500 间设置。

启用网页时设置 `WEB_ENABLED=true`，默认监听 `127.0.0.1:8787`。公网访问使用 HTTPS 反向代理并设置 `WEB_SECURE_COOKIE=true`，保留原始 Host。`WEB_REQUIRE_PASSWORD=false` 只让用户房间公开，不授予匿名管理权限。

## 初始化管理员

在服务停止时，将新密码写入仅自己可读的临时文件，再运行：

```bash
node scripts/admin-login.js --username YOUR_ADMIN_NAME --password-file /private/password.txt --data-dir ./data
```

完成后删除临时密码文件。管理员配置保存在私有数据目录中。`npm run admin` 对应旧的整站入口锁，不用于 `/admin` 的账号登录。具体恢复与权限说明见 [多人房间手册](docs/SOCIAL-ROOMS.md)。

## Docker 与 systemd

项目目录内提供 `Dockerfile` 和 `compose.yaml`：

```bash
docker compose up -d --build
docker compose logs --tail=100 bot
```

Compose 将网页映射到宿主机 `127.0.0.1:8787`，音乐登录、播放与房间权限数据保存在命名卷中。升级不要删除数据卷。

systemd 模板为 `deploy/kook-music-bot.service`，默认项目目录 `/opt/kook-music-bot`、用户 `kookbot`；按自己的目录和 Node.js 路径调整。应先安装依赖、配置只读源码和仅服务用户可写的 `data/`，再启用服务。历史生产部署及修复脚本不包含在仓库内。

## 播放边界

机器人只请求账号有权获取的音源；会员、地区及版权条件由音乐平台决定。QQ 只使用可授权获取的普通音源，不使用加密、试听或空音源冒充完整播放。部分歌单、歌词和推荐可能因上游限制不可用。

暂停、跳转与切歌复用语音连接；音量使用 FFmpeg 运行时控制。连接状态与网页进度不能代替实际 KOOK 听音验收。

## 开发与验证

```bash
npm run build:web
npm test
.venv/bin/python qq/test_provider.py
```

前端源码位于 `frontend/`，构建输出在 `web/`。`npm run preview` 启动本地演示，演示不会控制真实机器人。额外的浏览器检查脚本需要自行准备 Playwright 和脚本指定的浏览器。

网页背景是 `web/assets/background.svg` 的原创渐变图；可替换为有权使用的图片。私人部署中的动漫海报和账号头像未随源码分发。

不要提交 `.env`、平台 Cookie、二维码、`data/`、截图、发布包或日志。升级前备份私有配置及完整数据目录，保留机器人、队列、音乐登录与角色权限。

## 许可

仓库尚未指定整体开源许可证。第三方依赖遵守各自许可：QQ 音乐 Python 依赖为 GPL-3.0-or-later，说明见 [qq/README.md](qq/README.md)；素材说明见 [web/assets/LICENSES.md](web/assets/LICENSES.md)。
