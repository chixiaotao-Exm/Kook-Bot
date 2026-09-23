# Kook-Bot · Sub2API 额度看板

独立的 Sub2API 额度看板和 KOOK 机器人，提供账号额度展示、API Key 用量查询与定时图片播报。页面采用深色玻璃卡片和彩色电池，可通过 Nginx 挂载到现有站点的 `/quota/` 路径。

## 功能

- **额度总览**：平台、套餐、只读调度状态、额度窗口、重置时间、重置卡次数与到期信息。
- **Key 用量**：查询本站 API Key 的今日、近 7 天及累计请求数、Token 和实际扣费；可配置两个服务端快捷 Key。
- **KOOK 对话查询**：私聊或在指定文字频道发送 API Key，回复其用量与额度。回复仅显示 Key 末四位。
- **定时播报**：默认每半小时汇总 OpenAI 账号，用一张高清 PNG 展示。支持原生卡片模式、网页预览、播报历史及去重。
- **主动查询**：可选每半小时主动更新 OpenAI OAuth 账号额度和重置卡信息；自动用卡开启或状态不明确的账号会跳过。
- **公开访问与管理分离**：可公开看板；修改播报计划需要现有 Sub2API 管理员身份、同源请求与 CSRF 校验。
- **上游扩展**：可选接入 `api.ark717.com` 的个人查询接口，显示对应账号的余额与套餐信息。

电池表示**剩余**额度：≤30% 红色、≤50% 黄色、>50% 绿色。未知额度、缓存记录和估算值分别标注，不用缺失数据推算满额。

## 环境要求

- Node.js **22 或以上**，npm。
- 同机部署、监听 `http://127.0.0.1:8080` 的 Sub2API 实例及管理员 API Key。
- Ubuntu/Linux 推荐通过 systemd 运行、Nginx 反向代理。
- 图片播报依赖锁定版本的 `sharp`；中文绘制需要 `fontconfig`、`fonts-noto-cjk`。
- KOOK 机器人采用 WebSocket 出站连接，不需要额外的 Webhook 入站端口。

本项目对接的是 Sub2API 的具体接口和字段，不保证所有分支、历史版本均兼容。当前整个服务仅支持同机 `http://127.0.0.1:8080`：启动时创建的 Key 查询和主动查询客户端均校验此地址，关闭主动查询也不会放开远程连接。不要将 `SUB2API_URL` 改为其他主机、域名或端口。

## 快速运行

```bash
git clone https://github.com/chixiaotao-Exm/Kook-Bot.git
cd Kook-Bot/quota-dashboard
npm ci --omit=dev
cp .env.example .env
chmod 600 .env
# 使用编辑器填写 .env 中的连接信息与凭据
npm start
```

Ubuntu 图片字体：

```bash
sudo apt-get update
sudo apt-get install fontconfig fonts-noto-cjk
```

本地默认监听 `127.0.0.1:18998`。`PUBLIC_URL` 应配置为实际对外入口，例如 `https://quota.example.com/quota/`。

## 配置

配置写入私有 `.env`。不要将真实凭据填入 `.env.example`。

| 配置 | 作用 |
| --- | --- |
| `HOST` / `PORT` | 监听地址与端口，建议仅监听 `127.0.0.1` |
| `PUBLIC_URL` | 对外看板 URL，包含 `/quota/` 路径 |
| `PUBLIC_ACCESS` | `true` 允许公开查看；`false` 要求管理员登录 |
| `DATA_DIR` | 快照、查询任务状态、播报计划和去重记录目录 |
| `SUB2API_URL` | 必须为 `http://127.0.0.1:8080`，当前不支持远程实例或其他端口 |
| `SUB2API_ADMIN_KEY` | Sub2API 管理员 API Key，仅保留在服务端 |
| `REFRESH_SECONDS` | 看板刷新间隔，默认 600 秒 |
| `HIDDEN_PLATFORMS` | 要隐藏的平台，逗号分隔；留空显示全部 |
| `ACTIVE_QUOTA_ENABLED` | 是否启用每半小时主动额度查询，首次部署建议保持 `false` |
| `API_KEY_YELUOGPT` / `API_KEY_EXIAOMENGGPT` | 两个快捷查询 Key；留空不显示相应入口，标签定义在 `src/index.js` |
| `KOOK_TOKEN` | KOOK 机器人 Token |
| `KOOK_CHANNEL_ID` | 定时播报的文字频道 ID |
| `KOOK_CHANNEL_NAME` / `KOOK_BOT_NAME` | 网页显示用的频道名与机器人名 |
| `KOOK_QUERY_ENABLED` | 是否开启 KOOK 对话查询 |
| `KOOK_QUERY_CHANNEL_IDS` | 允许查询的文字频道 ID，逗号分隔；留空使用播报频道；私聊也支持查询 |
| `BROADCAST_ENABLED` | 首次创建播报计划时是否启用 |
| `BROADCAST_FORMAT` | `image` 使用图片，其他值使用原生卡片 |
| `BROADCAST_TIMES` | 每日播报时刻，逗号分隔；留空默认每小时 00、30 分 |
| `BROADCAST_TIME_ZONE` | 播报时区，默认 `Asia/Shanghai` |
| `ARK717_QUERY_KEY` | 可选上游个人查询 Key，仅发送到固定上游域名 |
| `ARK717_ACCOUNT_ID` | 将上游结果映射到对应 Sub2API 账号 ID |

播报计划首次运行后保存在 `data/broadcast.json`。此后修改环境变量不会覆盖现有计划，请通过看板的 `?manage=1` 入口修改。当前播报仅包含 OpenAI 账号；网页仍展示全部可见平台。

## Key 查询

网页的“Key 用量”支持手动输入与快捷查询。完整 Key 通过 JSON POST 提交，不写入 URL、浏览器存储、公共账号快照或定时播报。

KOOK 中支持以下格式：

```text
sk-<你的本站 API Key>
查询 sk-<你的本站 API Key>
/查询 sk-<你的本站 API Key>
```

仅查询配置的 Sub2API 实例，不接受自定义查询域名，不调用模型。Key 可能共享同一个用户钱包，显示的“账户共享余额”不是每个 Key 的独立余额。频道里发送的原始 Key 会被频道成员看到，私聊适合查询个人 Key。

## 主动查询与自动用卡

启用 `ACTIVE_QUOTA_ENABLED=true` 后，任务对齐北京时间整点和半点，启动时处理当前时段一次。符合条件的账号在调用前后都会重新检查自动用卡配置，每周期最多并发 2 个账号，并保存时段记录以避免重启后的重复请求。

主动查询使用 Sub2API 的额度刷新接口。某些 Sub2API 版本会在该接口内通知自动重置服务，因此必须保持账号自动用卡关闭。本项目不会调用重置接口或替你修改自动用卡开关；本地检查也不能消除其他管理员并发修改配置的竞争。若不能满足这个条件，请关闭主动查询，继续使用已有额度快照。

每半小时的图片播报会先等待主动查询和看板刷新。普通网页刷新与预览不会主动刷新上游额度，也不会发送 KOOK 消息。

## Linux 部署

1. 将项目部署到 `/opt/sub2api-quota-dashboard`，安装依赖和中文字体。
2. 创建无登录权限的 `quota-dashboard` 系统用户；让它拥有 `.env` 和 `data/`，`.env` 设为 `600`、`data/` 设为 `700`。
3. 检查 `deploy/quota-dashboard.service`，按实际 Node.js 路径调整 `ExecStart`，然后执行 `sudo install -m 644 deploy/quota-dashboard.service /etc/systemd/system/sub2api-quota-dashboard.service`。
4. 在你的 Nginx HTTPS 站点中引入 `deploy/nginx-quota.conf`，确保域名、HTTPS 和转发头与 `PUBLIC_URL` 一致。
5. 执行 `nginx -t` 后重载 Nginx，执行 `systemctl daemon-reload` 与 `systemctl enable --now sub2api-quota-dashboard`。

```bash
curl --fail http://127.0.0.1:18998/health
systemctl status sub2api-quota-dashboard
journalctl -u sub2api-quota-dashboard --since '10 minutes ago'
```

升级前备份私有 `.env`、整个 `data/` 和代理配置。部署更新只替换源码与依赖，保留运行数据，尤其是发送去重记录。不要把运行数据放到 `public/` 或提交到 GitHub。

## API 与数据流

浏览器访问看板自己的接口；凭据留在服务端。主要接口如下：

| 接口 | 用途 |
| --- | --- |
| `GET /quota/health` | 服务和机器人连接状态 |
| `GET /quota/api/status` | 清理后的账号快照 |
| `GET /quota/api/key-presets` | 快捷查询名称，不含 Key |
| `POST /quota/api/key-usage` | `{ "key": "sk-..." }` 或 `{ "presetId": "..." }` |
| `GET /quota/api/report-preview` | 当前播报预览；不发送消息 |

服务端读取 Sub2API 的账号、本站用量等管理员接口，以提交的 API Key 调用 `GET /v1/usage`。可选主动查询调用 `POST /api/v1/admin/openai/accounts/:id/quota/refresh`。KOOK 侧使用官方网关、资产上传、频道消息与私信接口。

账号的 5h/7d 本站费用统计与上游额度不是同一个指标。比例推算的总费用仅为估算；纯金额余额或未知额度不绘制比例电池。

## 开发与验证

```bash
npm ci
npm test
```

`test/` 使用 Node.js 内置测试框架，外部服务通过模拟接口验证，不发送真实 KOOK 测试消息。

`scripts/check-*-ui.cjs` 是额外的浏览器检查，需要单独安装 Playwright，并提供脚本指定的 Microsoft Edge 浏览器；可按本地环境调整启动选项。这些依赖不属于生产运行依赖。

```bash
node scripts/render-broadcast-image.mjs /path/to/sanitized-snapshot.json ./output/preview
```

以上命令从已清理的快照生成本地图片供检查，不上传、不播报。

主要目录：`src/` 服务端、`public/` 前端、`test/` 自动化测试、`scripts/` 验证工具、`deploy/` systemd/Nginx 示例。`.env`、`data/`、图片输出与部署记录不会提交到仓库。

## 许可

仓库尚未指定开源许可证；公开源码不自动授予再分发或商用许可。第三方依赖适用各自许可证。
