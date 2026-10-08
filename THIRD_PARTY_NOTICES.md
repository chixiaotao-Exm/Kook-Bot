# 第三方代码与素材说明

根目录 [LICENSE](LICENSE) 的 `AGPL-3.0-or-later` 授权适用于本项目有权授权的自有代码。第三方代码、依赖和素材保留原许可证及版权声明；不会因放入本仓库、构建产物或部署镜像而统一改为 AGPL。

## 随仓库提供的第三方代码

`music-bot/qishui/signer/` 来自 [sodahub-org/libmssdk](https://github.com/sodahub-org/libmssdk)，包版本为 `0.1.0`，采用 MIT License。原声明 `Copyright (c) 2026 ZephyrCheung` 和完整许可证保留在该目录的 [LICENSE](music-bot/qishui/signer/LICENSE) 中。本项目对该子目录代码的修改同样按 MIT 提供；该目录是根目录 AGPL 授权的例外。

该签名服务的开源授权仅覆盖其封装代码，不覆盖汽水音乐官方客户端的 `bdms.node` 等原生组件。本仓库不提供这些官方二进制文件；自行取得、安装或使用时应遵守其权利人的条款。

## 主要依赖与部署组件

以下按本仓库锁文件、上游对应版本的许可文件及包元数据整理。依赖通过包管理器或基础镜像取得，未将它们重新授权。此表列出主要组件，不替代完整依赖树中各组件的许可文件。

| 组件 / 锁定版本 | 许可 | 上游与使用范围 |
| --- | --- | --- |
| `@neteasecloudmusicapienhanced/api` 4.40.1 | MIT | [网易云音乐 API](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，音乐接口 |
| `@unblockneteasemusic/server` 0.28.0 | LGPL-3.0-only | [UnblockNeteaseMusic/server](https://github.com/UnblockNeteaseMusic/server)，网易云 API 的传递依赖 |
| `qqmusic-api-python` 0.7.2 | GPL-3.0-or-later | [QQMusicApi v0.7.2](https://github.com/L-1124/QQMusicApi/tree/v0.7.2)，独立 Python 音乐接口进程 |
| `ws` 8.21.3 | MIT | [websockets/ws](https://github.com/websockets/ws)，音乐机器人 WebSocket |
| `qrcode` 1.5.4 | MIT | [soldair/node-qrcode](https://github.com/soldair/node-qrcode)，二维码生成 |
| `esbuild` 0.28.2 | MIT | [evanw/esbuild](https://github.com/evanw/esbuild)，前端构建 |
| `lucide` 1.41.0 | ISC；源于 Feather 的部分图标为 MIT | [Lucide](https://lucide.dev/license)，前端图标及已构建网页中的图标代码；完整声明见 [LUCIDE-LICENSE.txt](music-bot/web/assets/LUCIDE-LICENSE.txt) |
| `sharp` 0.35.4 | Apache-2.0 | [lovell/sharp](https://github.com/lovell/sharp)，AI 与额度播报图片渲染 |
| `@img/sharp-libvips-*` 1.3.3 预编译包 | LGPL-3.0-or-later | [lovell/sharp-libvips](https://github.com/lovell/sharp-libvips)，按平台安装；包内 libvips 及其他图像库另保留各自声明 |
| `tough-cookie` 6.0.2 / 4.1.4 | BSD-3-Clause | [salesforce/tough-cookie](https://github.com/salesforce/tough-cookie)，举报机器人 / 音乐接口的传递依赖 |
| FlareSolverr 3.5.2 | 顶层项目为 MIT；内嵌组件另有许可 | [FlareSolverr v3.5.2](https://github.com/FlareSolverr/FlareSolverr/tree/v3.5.2)，举报浏览器容器；实际镜像摘要固定在 [Dockerfile](report-bot/browser/Dockerfile) |
| FlareSolverr 内嵌 `undetected_chromedriver` 3.5.5 | GPL-3.0 | [undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver)，不能将整个 FlareSolverr 镜像视为仅 MIT |

构建或分发依赖、浏览器容器、Python 环境、FFmpeg 及系统字体时，应一并保留所用发行包的版权和许可文件，并履行其对应源码或修改说明等要求；具体依赖版本分别见各项目的 `package-lock.json`、`music-bot/qq/requirements.lock.txt` 和容器配置。

单独分发本项目子目录、二进制或镜像时，也应随包提供适用的根目录许可证、第三方声明和对应源码获取方式，不能只保留 `package.json` 中的许可名称。

## 菜单、音乐及其他素材

- `menu-bot/assets/` 中的餐厅菜单图片、菜名、价格、冰淇淋口味、转录与翻译内容不因本项目的代码许可证获得第三方权利授权。其原始内容、照片、标识等权利仍归相应权利人；详见该目录的素材说明。
- 音乐音频、歌词、专辑及歌单封面，以及用户自行配置的背景图片和角色素材，均不按根目录 AGPL 授权。音乐网页素材另见 [music-bot/web/assets/LICENSES.md](music-bot/web/assets/LICENSES.md)。
- 使用 KOOK、音乐平台、PUBG 客服、OCR、模型及邮箱等第三方服务，还须遵守相应 API、账号和内容使用条款；开源代码许可证本身不授予第三方账号、商标、数据或内容的使用权。
