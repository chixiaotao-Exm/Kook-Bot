# 冰淇淋照片识别与菜单

用户提供一张冰柜照片，并要求整理菜单、识别口味。六个清晰标签为 Oreo、Mantecado、Choco Oreo、Toddy、Parchita、Torta Suiza。中文分别采用奥利奥、奶油风味、巧克力奥利奥、Toddy 可可风味、百香果、瑞士蛋糕口味；品牌及风味名称不等于完整配方说明。

右上角桶盖字样不清。早期预览误作 Brownie，放大复核后撤回；用户选择“先标为口味待确认”。正式目录与菜单使用通用待确认文字，不保存猜测口味作为可点选名称。照片无价格，不沿用旧菜单通用 HELADO 的标价。

第九页延续原菜单的白底深绿版式，原始标签作为西语显示，点餐回复使用 HELADO DE + 标签构成完整名称。生成脚本与坐标审计使每行文字可复查。内置 image_gen 用于版式预览；正式项目图片以核对后的目录精确排版保存为 `page-9.png`，不使用生成的食材或冰淇淋外观。

最终内置 image_gen 提示词：

> Correct the ice-cream menu preview generated in the previous turn. Keep the same elegant off-white and forest-green portrait menu design, Chinese and Spanish bilingual typography, and seven flavor rows. IMPORTANT correction: the freezer's top-right label is not readable, so the prior '布朗尼 / Brownie' row was unverified and MUST be replaced by '口味待确认' / 'Sabor por confirmar'. Do not show Brownie, Praliné or Pastelado anywhere. The six confirmed pairs, in this order, are '奥利奥' / 'Oreo'; '奶油风味' / 'Mantecado'; '巧克力奥利奥' / 'Choco Oreo'; 'Toddy 可可风味' / 'Toddy'; then the fifth row '口味待确认' / 'Sabor por confirmar'; sixth '百香果' / 'Parchita'; seventh '瑞士蛋糕风味' / 'Torta Suiza'. Replace ALL realistic scoop/ingredient pictures with the same small, simple forest-green line drawing of a generic ice-cream cup; no colored ingredients, no nuts, no pistachios and no fabricated product appearance. Title '冰淇淋口味' / 'SABORES DE HELADO'. Footer '照片未标价格，请向店家确认。' / 'Precio no indicado. Consulte al restaurante.' No prices or amounts. All text must be exact, large and cleanly readable.
