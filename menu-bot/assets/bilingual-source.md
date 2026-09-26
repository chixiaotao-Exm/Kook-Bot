# 双语图片制作记录

用户最终要求：直接修改菜单图片，同一道菜同时列出中文及原西班牙语，而不是制作两套独立语言菜单。

排版规格：保留原白底深绿色配色及八页顺序，统一 1800 × 3200 像素。中文字号 32 像素，西语字号 26 像素，长菜名自动换行；金额独立对齐。272 个项目各出现一次，184 个标价与原数值完全一致，88 个未标价，8 个原文存在歧义的项目保留提示。10 个套餐的 28 组组成逐项中西对照。

数据来源：`catalog-basic.json`、`catalog-extended.json` 及原菜单第一张照片核对所得的 `menu-combo-details.json`。`bilingual-layout.json` 记录每项实际绘制文本、字号、坐标与金额，`bilingual-menu.md` 提供可复制的双语文字。使用 `../scripts/build-bilingual-menu.py` 和 Pillow 重建图片，不修改定价目录。

本轮曾调用内置 image_gen 请求无字背景模板，但工具未返回可用本地图片；最终资产由已存在的菜单配色与上述精确排版源生成。未调用图像 API 或 CLI 后备方案。

内置图像工具提示词：

> Edit the menu image shown above into a clean reusable bilingual-menu background for the same Gran Furama menu project. Preserve its quiet off-white paper background and dark forest green / near-black restrained typography style and portrait aspect ratio. Remove all existing dish names, prices, notes and page numbers completely. Retain only the exact brand wordmark 'GRAN FURAMA' near the upper left, and add a very thin forest-green horizontal divider below the header near the top. Leave a very large plain empty off-white central area for precise typesetting of Chinese and Spanish menu entries later. No invented dish text, no prices, no decorative food photos, no illustration, no pattern, no watermark. This is the background layer for eight final bilingual menu images, and all real menu text and prices will be typeset from verified structured menu data in a separate deterministic step. Make the background visually clean and highly legible, suitable for printing.
