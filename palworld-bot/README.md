# 幻兽帕鲁 KOOK 管家

独立 KOOK 机器人，读取同机 Palworld 的实际状态，将上下线、游戏公告及有证据的死亡事件发到配置的文字频道。玩家可以用中文申请物资，`gpt-6-astra` 理解需求，程序核对目录、进度、配方和每日次数后，调用既有物品 HTTP API。

## 频道使用

- `绑定 游戏角色名`：取得验证码，在游戏聊天框输入 `!bind 验证码`。实际发言角色 UID 必须与选择的角色一致；游戏账号只能绑定一个 KOOK 用户。
- `申请木头 30 个`、`申请石头 20 个`：基础补给。
- `申请食物 10 份`：从真实目录中选择符合当前进度的普通食物，并说明选中的名称与数量，不要求玩家记住食品名。
- `有什么食物`、`推荐吃什么`：查看可用的普通食物建议，不提交发放。明确申请但未写数量时会询问数量，短期内可直接回复 `10份`；推荐浏览不会自动变成领取。
- `申请石镐 1 个`：核对真实配方、解锁条件和当前进度，直接发放石镐成品。
- `申请烤野莓 5 个`、明确名称的药品：可直接发成品，仍需符合进度和数量规则。
- `状态`、`我的次数`、`帮助`：查询世界及领取次数。

每个游戏账号每天最多 3 次，按北京时间 00:00 重置。拒绝、明确未调用库存的失败不扣次数。一次多材料申请算一次；部分发放算一次。网络超时或结果不明保留一次额度，之后只查同一请求编号，不自动重新发放。`submitted` 表示库存函数调用返回，不能证明背包实际数量或存档持久化；回复会要求核对背包。

每日次数只约束本机器人；原游戏管理员命令和其他发放入口不在其配额内。

## 进度与事件边界

世界天数、基地数和在线角色等级来自官方本机 REST。最高等级是当前世界**已观测的下限**，不是全存档科技树。申请按世界观测等级与本人等级中较低值检查；缺失古代科技、图纸、研究或首领前置证据时不自动批准。物品目录的版本必须与当前游戏版本一致。

游戏内绑定和公告需要附带的 MinimalGive 观察模块。可选死亡钩子只在取得真实受害者/攻击者玩家 UID 后报告击杀；帕鲁伤害不会猜测其主人。位置为 Unreal 世界坐标（厘米），不是地图区域名称。实际支持范围取决于服务器版本与原生事件，注册成功还需要现场验证。普通玩家聊天不会录制/转发。

配方从运营者提供的外部资料加载，不允许 AI 编造。数量策略与数据来源详见 [CATALOG.md](CATALOG.md)，游戏接入见 [bridge/README.md](bridge/README.md)。

## 部署

需要 Node.js 22+、Python 3.11+ 和系统 IANA 时区资料。Ubuntu 默认 Python 标准库即可运行；Windows 测试可 `pip install -r requirements.txt` 补充时区数据。机器人复用同仓库 `ai-bot/src/kook-gateway.js` 的重连实现，无需启动任何讨论机器人。

1. 将本目录及 `ai-bot/src/kook-gateway.js`、`ai-bot/package.json` 放在同一父目录下。
2. 复制 `.env.example` 为私有 `.env`，填入 KOOK、模型、发物品接口和外部目录路径。各 Token 不得放前端或提交 Git。
3. 提前建立私有 `data/` 目录。模板部署根目录为 `/opt/kook-palworld`。
4. 用 `bridge/install_telemetry.py /path/to/MinimalGive/Scripts` 安装观察模块；需要死亡事件时加 `--enable-deaths`。建立游戏可写的遥测目录后，协调一次游戏重启。此工具本身不重启游戏。
5. 审核并安装 `deploy/kook-palworld.service`，执行 `systemctl daemon-reload` 和 `systemctl enable --now kook-palworld`。服务只允许写自己的状态目录。

物品 HTTP 接口契约：Bearer 认证，`GET /api/v1/players`、`GET /api/v1/status`、`POST /api/v1/items/give` 和 `GET /api/v1/deliveries/{request_id}`。发放字段为 `request_id`（32位小写十六进制）、`player_uid`（32位大写十六进制）、`item_id` 和 `quantity`。响应需回显上述字段，并含 `pending/submitted/failed/unknown` 状态。客户端不跟随认证重定向。

服务状态：`systemctl status kook-palworld`，健康摘要在 `data/health.json`；`last_game_poll` 应持续更新，gateway 连接信息在 journal。SQLite 保存绑定、幂等请求、每日额度及事件游标。单实例锁避免两个进程竞争发放。

更新机器人无需重启游戏；只有首次或改动 Lua 观察模块才需要协调游戏重启。重启时所有已尝试发放只查询原记录，未尝试的剩余材料取消。备份时同时保存机器人数据库与游戏发放接口数据库；游戏回档后必须人工核对发放记录。

## 测试

```sh
cd palworld-bot
python -m unittest discover -s test -v
node --check gateway.mjs
```

可选 `lupa` 用于 Lua 模拟测试；CI 会安装并执行。测试没有真实 KOOK 消息、游戏发放或模型费用。覆盖身份绑定、持久化幂等、失败退款、未知保留、并发配额、取消恢复、世界切换、材料转换、版本校验和模型输出约束。

自有代码适用仓库 AGPL-3.0-or-later。外部游戏资料不随公开源码分发，也不被本项目重新授权。
