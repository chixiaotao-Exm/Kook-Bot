# 运行时物品与配方资料

此目录只保存数据契约说明，不含游戏数据集。测试使用虚构 ID 和虚构配方，不能用于游戏。

`catalog.py` 从运营者提供的资料构建运行时 JSON。调用方式：

```sh
python catalog.py --items /private/item-catalog.json \
  --recipes /private/recipes.json \
  --save-pal-data /private/save-pal/data/json \
  --output /var/lib/kook-palworld/catalog.json
```

构建器会校验物品与配方的游戏版本一致，记录各输入文件 SHA256 与来源信息。输出必须放在源码目录之外，不能提交 Git。需要提供如下来源文件：

- 既有物品目录：`meta.gameVersion`、`items[]`，每项含 `id/name/en/category`。它可能合并了多个来源，须保留其 `meta.sources` 和许可。
- [PalSphere](https://palsphere.app) 的 [recipes.json](https://github.com/palsphere/palsphere-data/blob/main/data/recipes.json)：包含准确内部 ID、原料数量、每批产量、解锁等级和设计图条件。其编排数据采用 **PalSphere Data License**，仅授权个人、教育、非商业用途；商业使用须另获书面许可。本项目 AGPL 许可不覆盖或重新授权该数据。许可原文见 [LICENSE.md](https://github.com/palsphere/palsphere-data/blob/main/LICENSE.md)。
- [Palworld Save Pal](https://github.com/oMaN-Rod/palworld-save-pal) 的 `items.json`、`technologies.json`、`l10n/en/buildings.json`。该项目采用 GPL-3.0；这些文件用于核对药品分类、科技前置及工作台名称，不视为当前存档已经解锁的证据。
- Palworld 游戏名称、原始游戏数据及资产权利归 Pocketpair, Inc.。

公开部署者也可以自行生成符合契约的独立资料，不需要使用上述来源。不得让语言模型生成配方后作为可信资料写入本文件。

## JSON 契约

顶层为 `schema_version: 1`、`game_version`、`sources[]`、`items[]`。

每项包含 `id`、`name`、`category`、`required_level`。未能核对的等级为 `null`，策略层会拒绝发放。`direct_basic: true` 仅用于运营者明确允许的基础材料；`disabled: true` 禁止发放。

可选 `recipe` 包含：

```json
{
  "output_quantity": 1,
  "ingredients": [{"item_id": "ExampleMaterial", "quantity": 2}],
  "source": "operator-verified-data-reference"
}
```

此例为契约示意，并非真实游戏配方。`requires_boss`、`requires_research`、`requires_technology`、`requires_blueprint`、`ancient` 会触发额外证据核验。缺失证据时拒绝；不把玩家等级当成古代科技或设计图持有证明。

## 补给规则

食物、食材、药品可直接发成品。其他成品必须有可靠配方，策略会逐项核验配方原料、解锁条件和完整批次，然后直接发放申请的成品；配方缺失或含不可核验条目时拒绝整单。拒绝不完整批次，避免四舍五入多发。已知基础材料可以直接申请。

`MindControlDrug` 支持“消除记忆药”“洗点”等中文别名；没有写数量时默认为 1 瓶。它是明确配置的特殊直接发放物品，不采用普通药品的单物品数量上限；账号每日申请次数仍由 Store 统一控制。

默认单次最多 8 种申请，基础材料每种 100，食品每种 20，药品每种 5，其他成品每种 1 个完整配方批次；发放总数最多 1,000、24 种。这些数量由 `PolicyLimits` 配置，不改变每天 3 次的成功领取规则。

`evaluate_request` 使用可信采集器给出的新鲜观测进度（180 秒内）和绑定玩家等级，取两者较低值作为补给进度。等级来自实际在线玩家的观测，是**已观察到的进度下限**；不等于完整世界存档或科技解锁表。没有直接科技等级的配方，可采用有资料的最低工作台等级作为补给策略代理，输出的 `progression_basis` 会说明来源。未知等级、古代科技、指定设计图、首领或研究缺少证据时不发。

模型负责理解需求、解释和进一步拒绝；实际发放计划必须通过 `evaluate_request`，模型不得绕过数量、进度和配方校验。日额度、事务与失败回执由存储/发放层处理；本模块不发起游戏写入。

泛称“食物”的需求会扩展到当前目录中存在的普通补给候选，优先日常莓果和简单熟食，并通过同一进度规则筛选。默认推荐偏好不覆盖目录数据或解锁证据，也不会把整个食材分类中的特殊物品随机发给玩家。搜索时忽略纯数字数量词，避免把“10份”匹配成内部 ID 中带“10”的无关物品。明确数量代表申请总量，不是每个推荐食品各领取一份相同数量。
