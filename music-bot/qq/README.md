# QQ 音乐接口进程

使用 `qqmusic-api-python==0.7.2`（上游 GPL-3.0-or-later），代码与许可：
https://github.com/L-1124/QQMusicApi/tree/v0.7.2

Linux Python 3.10+ 独立环境安装 `requirements.txt`，将机器人配置的
`QQ_PYTHON_PATH` 指向该环境 Python。Node 端 `QQMusic` 使用 `config.qqPython`，
默认 `python3`，自动按需启动 `provider.py`；无需开启额外 HTTP 端口。

私有凭证保存到 `DATA_DIR/qq-credential.json`，文件权限 0600；设备信息保存到
`DATA_DIR/qq-device.json`。它们不属于网页静态资源，不得放进发布包。
扫码成功或刷新凭证后原子保存；刷新失败需重新扫码。

进程通过 stdin/stdout 交换 JSON 行。仅开放搜索、详情、歌单、榜单、账号状态、
扫码、退出和音源读取；SDK 日志走 stderr，父进程丢弃原始日志。
微信扫码长轮询在后台执行，`qrStatus` 立即返回缓存状态，不阻塞音源请求。

QQ 普通歌单使用数字 ID，榜单使用 `top:26` 等带前缀 ID。歌曲保留数字 ID 及
`mid`，所有歌曲与歌单携带 `source: "qq"`。不同平台的歌曲 ID 不可混用。

音源只请求服务端授权的普通 MP3 128k 文件。空音源、试听文件、加密文件和非 QQ
音频 CDN 均被拒绝；没有会员或购买权限时，不保证歌曲可播放。链接应在播放或
断点恢复时重新获取，不持久化带令牌的 URL。

验证命令：

```text
node --test test/qq-music.test.js
<QQ_PYTHON> qq/test_provider.py
```

本机已实测匿名搜索、公开歌单分页、榜单、ACG 歌单、QQ/微信二维码生成与等待状态；
实际账号扫码成功、会员完整音源及 KOOK 听音须在目标环境验证。
