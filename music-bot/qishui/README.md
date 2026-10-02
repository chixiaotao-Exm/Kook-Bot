# 汽水音乐 Linux 自建接入

这一路径全程运行在 Linux，无需常驻 Windows 电脑。音乐机器人通过私有 API 读取目录及音频；签名组件通过 Docker/Wine 加载自己官方客户端安装包中的原生文件。官方组件、账号 Cookie 和 API Token 不在仓库中。

## 组成与配置

- `catalog.js`：固定汽水官方接口的匿名搜索、歌单及歌词，19 位 ID 保持字符串，目录最多 500 首。
- 热歌目录优先搜索“抖音热歌”和“抖音热歌榜”，按照标题、简介的相关程度选择歌单；自动补歌与热歌按钮共用此目录，歌单之间去重。这里是汽水搜索出的歌单，不代表抖音官方实时榜单。
- `playback.js`：使用自有账号和本地签名器获取授权曲目，拒绝试听或无权限响应；下载到私有短期缓存，FFmpeg 解码为 MP3，并用 ffprobe 验证实际时长。
- `server.js`：仅绑定回环端口，API 需要强 Bearer Token，音频通过随机、1 小时有效的 capability 路径提供 Range 请求。最多 12 个缓存，启动及定期清理。签名、原音源 URL、Cookie 不传给网页。
- `signer/`：基于 MIT `sodahub-org/libmssdk` 固定提交 `865f7840d548f88ebd1debf154b2f0f434fee6ed`，修复无 Token 放行、错误回显、目标地址和响应边界。仅 API `/sign` 用于播放。

音乐机器人 `.env`：

```dotenv
QISHUI_API_URL=http://127.0.0.1:19094/_qishui
QISHUI_API_TOKEN=请生成独立随机长令牌
```

API 容器 `.env`（私有权限 0600）：

```dotenv
QISHUI_API_TOKEN=与音乐机器人相同的令牌
QISHUI_SIGNER_TOKEN=独立的签名器令牌
QISHUI_PUBLIC_URL=http://127.0.0.1:19094/_qishui
QISHUI_CREDENTIALS_FILE=/data/credentials.json
```

`credentials.json` 由本次账号登录流程写入，包含 `cookie`、`deviceId`、`installId`；目录 0700、文件 0600。账号状态从官方 `/luna/pc/me` 的 `my_info` 查询。上游网络故障与登录失效分别处理。

## 构建与运行

API 从 `music-bot` 目录构建：`docker build -f qishui/Dockerfile -t kook-qishui-api .`。容器需要访问同机签名器 `127.0.0.1:19096`；在 Linux 使用 host 网络，但 API 自身只监听 `127.0.0.1:19095`。限制 CPU/内存、丢弃 capabilities、只读根目录，仅 `/data` 可写。运行用户 UID/GID 为 10003。

签名器从 `qishui/signer` 目录构建 `deploy/Dockerfile`。镜像不含官方二进制；从自己取得的官方 3.8.0 x64 安装器**只解包** `resources/app.asar.unpacked/bdms.node` 与同目录 `metasecml.dll`，挂载到 `/client:ro`。必须使用同目录的一对文件，不要混用另一个 `mssdk` 目录中的 DLL。

官方安装器的 SHA256（来源 Microsoft WinGet 3.8.0 清单）：`b68e652e180c6938393468a847490baa490e3457e46cd90710dca1bef6d6a840`。原生模块不属于 MIT，不能放入仓库或随镜像分发。

签名器容器配置 `LIBMSSDK_TOKEN`，只映射 `127.0.0.1:19096:8899`，持久化独立 `/wine`、`/state`；使用 `tty:true`、UID/GID 10001、1 CPU/1 GiB、`cap-drop ALL`、`no-new-privileges`。首次自检先用 `--network none ... selftest`；文件存在或 `/healthz` 成功不代表签名成功。

如果 API 与音乐机器人位于不同 Linux 服务器，使用专属公钥 SSH 隧道 `127.0.0.1:19094 → 远端127.0.0.1:19095`。SSH 账号只准转发这个目标、禁止终端及远程转发。API Token 仍必需，不公开签名服务或 Cookie。

## 登录与功能边界

汽水登录不同于网易云/QQ，目前由管理员在服务器完成，控制台只展示账号状态，不提供会误操作其他平台的扫码/退出按钮。登录原型采用隔离 Chromium 和官方二维码；实际修复包括轮询 `is_frontier=false`，以及从官方 HTTP `Set-Cookie` 回收浏览器未写入 Cookie jar 的会话。只有官方明确 confirmed 并取得本次会话才持久化。若触发官方二次验证，需要人工完成，不能假报成功。

前台可选择汽水、联合搜索、导入歌单、使用热门歌单及自动电台。支持官方完整分享地址 `https://music.douyin.com/qishui/share/track?track_id=...` 和 `/playlist?playlist_id=...`；短链接、我的收藏和心动模式暂未支持。某些曲目版权/账号权益仍不可用，返回明确提示或跳过，不用试听假装整曲。

## 来源与验证

签名包装代码 MIT 许可见 `signer/LICENSE`；音频响应密钥解析算法改写自 `guowenye/qishui-api`，许可见 `licenses/qishui-api-MIT.txt`。仅处理账号实际获得的完整播放响应，不使用第三方公共解析站或他人凭据。

测试包含预览拒绝、实际时长、固定官方域、重定向拒绝、响应上限、FFmpeg 限制、缓存清理、关闭竞态、账号故障区别、三来源路由和前端能力显示。生产听音仍需 KOOK 频道人工确认；网页进度不是听音验收。
