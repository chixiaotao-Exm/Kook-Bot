#!/usr/bin/env python3
"""Render the eight bilingual PNG menus from the audited application catalog.

Requires Python 3.10+ and Pillow. Prices/names are never inferred. Run from any
directory. On Linux pass --cjk-font, --cjk-bold, --latin-font and --latin-bold.
The sidecar records source keys, prices and actual text bounds for QA.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 1800, 3200
MARGIN, GAP = 84, 68
COL_WIDTH = (WIDTH - MARGIN * 2 - GAP) // 2
CONTENT_TOP, CONTENT_BOTTOM = 305, HEIGHT - 256
BG = "#fbfdfb"
INK = "#17271f"
GREEN = "#25654f"
MUTED = "#52685b"
LINE = "#cbd9d0"
WARNING = "#856320"

PAGE_SPECS = [
    ("套餐", "套餐", "COMBOS", "combo", 1, 10),
    ("饮品与菜单一 1–20", "饮品与单点菜单一", "BEBIDAS · MENÚ 1", "m1", 1, 20),
    ("菜单一 21–64", "单点菜单一", "MENÚ 1 · 21–64", "m1", 21, 64),
    ("菜单一 65–89", "单点菜单一", "MENÚ 1 · 65–89", "m1", 65, 89),
    ("菜单二 1–41", "单点菜单二", "MENÚ 2 · 1–41", "m2", 1, 41),
    ("菜单二 42–87", "单点菜单二", "MENÚ 2 · 42–87", "m2", 42, 87),
    ("菜单二 88–116", "单点菜单二", "MENÚ 2 · 88–116", "m2", 88, 116),
    ("菜单二 117–151", "单点菜单二", "MENÚ 2 · 117–151", "m2", 117, 151),
]
SECTIONS = {
    "combo": [(1, 10, "套餐 · COMBOS")],
    "drink": [(1, 19, "饮品 · BEBIDAS")],
    "m1": [(1, 9, "前菜 · APERITIVOS"), (10, 14, "冷盘与沙拉 · ENSALADAS"),
           (15, 20, "汤类 · SOPAS"), (21, 27, "炒饭 · ARROZ FRITO"),
           (28, 34, "什锦炒杂菜 · CHOP SUEY"), (35, 41, "炒面 · CHOW MEIN"),
           (42, 48, "捞面 · LO MEIN"), (49, 54, "糖醋类 · DULCE Y AGRIO"),
           (55, 59, "芙蓉煎蛋 · FU YUNG"), (60, 64, "鸡肉 · POLLO"),
           (65, 74, "海鲜 · MARISCOS"), (75, 82, "牛肉 · CARNE"),
           (83, 87, "猪肉 · CERDO"), (88, 89, "甜品 · POSTRES")],
    "m2": [(1, 13, "小吃与拼盘 · ENTREMESES"), (14, 29, "汤类 · SOPAS"),
           (30, 41, "炒饭 · ARROZ FRITO"), (42, 87, "海鲜 · MARISCOS"),
           (88, 100, "牛肉 · CARNE"), (101, 116, "鸡肉 · POLLO"),
           (117, 137, "铁板热盘 · BANDEJA CALIENTE"),
           (138, 147, "铁板面 · FIDEOS EN BANDEJA"),
           (148, 151, "面条与米粉 · FIDEOS")],
}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def money(cents):
    if cents is None:
        return "未标价 / Sin precio"
    return f"${cents / 100:.2f}".rstrip("0").rstrip(".")


def group_num(item):
    prefix, number = item["key"].split(":", 1)
    return prefix, int(re.match(r"\d+", number).group())


def section(item):
    prefix, number = group_num(item)
    return next(title for start, end, title in SECTIONS[prefix] if start <= number <= end)


def wrap(text, font, max_width):
    """Wrap CJK per character and Latin on words without losing source text."""
    tokens = re.findall(r"[\u3400-\u9fff\uff00-\uffef]|[^\s\u3400-\u9fff\uff00-\uffef]+|\s+", text)
    result, current = [], ""
    for token in tokens:
        candidate = current + token
        if font.getlength(candidate) <= max_width:
            current = candidate
            continue
        if current.strip():
            result.append(current.strip())
            current = ""
        if font.getlength(token.strip()) <= max_width:
            current = token.lstrip()
            continue
        for char in token.strip():
            if current and font.getlength(current + char) > max_width:
                result.append(current)
                current = ""
            current += char
    if current.strip():
        result.append(current.strip())
    # Avoid orphan closing punctuation such as a one-character ')' line.
    for index in range(1, len(result)):
        if result[index] and result[index][0] in "）)]］，、。；：!?！？":
            previous = result[index - 1]
            if len(previous) > 1:
                take = min(3, len(previous) - 1) if len(result[index]) == 1 else 1
                moved = previous[-take:]
                if moved[0] in "，、。；：" and take + 2 < len(previous):
                    take += 2
                    moved = previous[-take:]
                if font.getlength(moved + result[index]) <= max_width:
                    result[index - 1] = previous[:-take].rstrip()
                    result[index] = (moved + result[index]).lstrip()
    return result or [""]


class Renderer:
    def __init__(self, args):
        self.fonts = {
            "title": ImageFont.truetype(args.cjk_bold, 62),
            "brand": ImageFont.truetype(args.latin_bold, 31),
            "subtitle": ImageFont.truetype(args.latin_font, 33),
            "section": ImageFont.truetype(args.cjk_bold, 29),
            "zh": ImageFont.truetype(args.cjk_font, 32),
            "es": ImageFont.truetype(args.latin_font, 26),
            "price": ImageFont.truetype(args.latin_bold, 33),
            "small": ImageFont.truetype(args.cjk_font, 23),
            "latin_small": ImageFont.truetype(args.latin_font, 24),
            "code": ImageFont.truetype(args.latin_font, 24),
            "combo": ImageFont.truetype(args.cjk_font, 31),
        }

    def text(self, draw, value, x, y, font, color, records, align="left"):
        f = self.fonts[font]
        anchor = "rt" if align == "right" else "lt"
        bounds = list(draw.textbbox((x, y), value, font=f, anchor=anchor))
        draw.text((x, y), value, font=f, fill=color, anchor=anchor)
        records.append({"text": value, "font": font, "fontSize": f.size, "bbox": bounds})
        return bounds

    def lines(self, text, font, width):
        return wrap(text, self.fonts[font], width)

    def item_layout(self, item, combo=None):
        # Number, Chinese name, and price share the first line. Spanish gets
        # the remaining column width below so it stays comfortably readable.
        indent = 110 if group_num(item)[0] in ("drink", "combo") else 62
        price_font = self.fonts["small"] if item["priceCents"] is None else self.fonts["price"]
        price_width = int(price_font.getlength(money(item["priceCents"]))) + 20
        zh = self.lines(item["name"], "zh", COL_WIDTH - indent - price_width - 14)
        es = self.lines(item["spanish"], "es", COL_WIDTH - indent)
        details = []
        if combo:
            for chinese, spanish in zip(combo["chinese"], combo["spanish"], strict=True):
                details.append((self.lines(chinese, "combo", COL_WIDTH - 23),
                                self.lines(spanish, "es", COL_WIDTH - 23)))
        height = len(zh) * 40 + 6 + len(es) * 31 + 16
        if item.get("uncertain"):
            height += 34
        if details:
            height += 19 + sum(len(zh_lines) * 39 + len(es_lines) * 31 + 10 for zh_lines, es_lines in details)
        return {"height": height, "zh": zh, "es": es, "details": details, "indent": indent}

    def column_height(self, rows, layouts):
        current_section, height = None, 0
        for item in rows:
            s = section(item)
            if s != current_section:
                height += 61
                current_section = s
            height += layouts[item["key"]]["height"]
        return height

    def render(self, number, spec, rows, details, out):
        image = Image.new("RGB", (WIDTH, HEIGHT), BG)
        draw = ImageDraw.Draw(image)
        records, entry_records = [], []
        self.text(draw, "GRAN FURAMA", MARGIN, 65, "brand", GREEN, records)
        self.text(draw, "双语菜单 / Menú bilingüe", WIDTH - MARGIN, 65, "section", GREEN, records, "right")
        self.text(draw, spec[1], MARGIN, 130, "title", INK, records)
        self.text(draw, spec[2], MARGIN, 218, "subtitle", MUTED, records)
        self.text(draw, "USD · 美元", WIDTH - MARGIN, 223, "section", GREEN, records, "right")
        draw.line((MARGIN, 278, WIDTH - MARGIN, 278), fill=GREEN, width=3)
        layouts = {item["key"]: self.item_layout(item, details.get(item["key"])) for item in rows}
        splits = []
        for index in range(1, len(rows)):
            heights = [self.column_height(rows[:index], layouts), self.column_height(rows[index:], layouts)]
            splits.append((max(heights), abs(heights[0] - heights[1]), index, heights))
        _, _, split_at, heights = min(splits)
        if max(heights) > CONTENT_BOTTOM - CONTENT_TOP:
            raise ValueError(f"Page {number} content too tall: {heights}; adjust layout, never truncate")
        for column, column_rows in enumerate((rows[:split_at], rows[split_at:])):
            x, y = MARGIN + column * (COL_WIDTH + GAP), CONTENT_TOP
            current_section = None
            for item in column_rows:
                s = section(item)
                if s != current_section:
                    self.text(draw, s, x, y + 8, "section", GREEN, records)
                    y += 61
                    current_section = s
                info, top = layouts[item["key"]], y
                row_records = []
                code_label = item["key"] if group_num(item)[0] in ("drink", "combo") else item["code"]
                self.text(draw, code_label, x, y + 1, "code", MUTED, row_records)
                if item["priceCents"] is None:
                    self.text(draw, "未标价 / Sin precio", x + COL_WIDTH, y, "small", MUTED, row_records, "right")
                else:
                    self.text(draw, money(item["priceCents"]), x + COL_WIDTH, y - 2, "price", GREEN, row_records, "right")
                for line in info["zh"]:
                    self.text(draw, line, x + info["indent"], y, "zh", INK, row_records)
                    y += 40
                y += 6
                for line in info["es"]:
                    self.text(draw, line, x + info["indent"], y, "es", MUTED, row_records)
                    y += 31
                if item.get("uncertain"):
                    self.text(draw, "原文待确认 / Texto por confirmar", x, y + 5, "small", WARNING, row_records)
                    y += 34
                if info["details"]:
                    y += 19
                    for chinese_lines, spanish_lines in info["details"]:
                        draw.ellipse((x + 2, y + 11, x + 9, y + 18), fill=GREEN)
                        for line in chinese_lines:
                            self.text(draw, line, x + 23, y, "combo", INK, row_records)
                            y += 39
                        for line in spanish_lines:
                            self.text(draw, line, x + 23, y, "es", MUTED, row_records)
                            y += 31
                        y += 10
                y += 16
                draw.line((x, y - 6, x + COL_WIDTH, y - 6), fill=LINE, width=1)
                assert y - top == info["height"]
                rect = [x, top - 2, x + COL_WIDTH, y - 2]
                for text in row_records:
                    left, upper, right, lower = text["bbox"]
                    assert rect[0] <= left <= right <= rect[2] + 1, (item["key"], text)
                    assert rect[1] <= upper <= lower <= rect[3], (item["key"], text)
                entry_records.append({"key": item["key"], "column": column, "rect": rect,
                                      "chinese": item["name"], "spanish": item["spanish"],
                                      "priceCents": item["priceCents"], "uncertain": bool(item.get("uncertain")),
                                      "source": item["source"], "text": row_records})
        footer_y = HEIGHT - 199
        draw.line((MARGIN, footer_y - 22, WIDTH - MARGIN, footer_y - 22), fill=LINE, width=2)
        if number == 1:
            footer = ["套餐价格含 IVA；组成保留原文缩写。", "Combos con IVA incluido. Se conservan las abreviaturas originales."]
        elif number == 2:
            footer = ["饮品 drink:n 为查询编号；两份单点菜单分别编号。", "drink:n = código de consulta. Menú 1 y Menú 2 tienen numeración independiente."]
        else:
            footer = ["未标价与待确认项目请询问餐厅；不推算价格。", "Consulte al restaurante los precios omitidos y los textos por confirmar."]
        self.text(draw, footer[0], MARGIN, footer_y, "small", MUTED, records)
        self.text(draw, footer[1], MARGIN, footer_y + 36, "latin_small", MUTED, records)
        self.text(draw, "全部价格以美元 USD 结算 · Precios en USD", MARGIN, HEIGHT - 81, "small", GREEN, records)
        self.text(draw, f"{number} / 8", WIDTH - MARGIN, HEIGHT - 80, "code", MUTED, records, "right")
        for text in records:
            left, top, right, bottom = text["bbox"]
            assert 0 <= left <= right <= WIDTH and 0 <= top <= bottom <= HEIGHT, text
        path = out / f"page-{number}.png"
        image.save(path, "PNG", optimize=True)
        assert path.stat().st_size < 4 * 1024 * 1024, path
        return image, {"file": path.name, "title": spec[0], "width": WIDTH, "height": HEIGHT,
                       "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}, {
                           "file": path.name, "size": [WIDTH, HEIGHT], "columnHeights": heights,
                           "contentBounds": [MARGIN, CONTENT_TOP, WIDTH - MARGIN, CONTENT_BOTTOM],
                           "entries": entry_records, "pageText": records,
                       }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=ROOT / "assets")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--preview", type=Path, default=ROOT / "release" / "bilingual-contact-sheet.png")
    for name, filename in [("cjk-font", "msyh.ttc"), ("cjk-bold", "msyhbd.ttc"),
                           ("latin-font", "arial.ttf"), ("latin-bold", "arialbd.ttf")]:
        parser.add_argument("--" + name, default=str(Path("C:/Windows/Fonts") / filename))
    args = parser.parse_args()
    for name in ("cjk_font", "cjk_bold", "latin_font", "latin_bold"):
        if not Path(getattr(args, name)).is_file():
            parser.error(f"Font unavailable; provide --{name.replace('_', '-')} for your system")
    out = args.output or args.assets
    out.mkdir(parents=True, exist_ok=True)
    items = sum((read_json(args.assets / filename)["items"] for filename in ("catalog-basic.json", "catalog-extended.json")), [])
    assert len(items) == 272 and len({item["key"] for item in items}) == 272
    assert sum(item["priceCents"] is None for item in items) == 88
    assert sum(bool(item.get("uncertain")) for item in items) == 8
    details = {item["key"]: item for item in read_json(args.assets / "menu-combo-details.json")["items"]}
    assert set(details) == {f"combo:{i}" for i in range(1, 11)}
    renderer = Renderer(args)
    metadata, pages, seen, previews = [], [], [], []
    markdown = ["# Gran Furama 中文菜单 · 西班牙语对照", "", "全部价格以美元 USD 结算。未标价不推算；待确认原文请询问餐厅。", "", "Precios en USD. Consulte al restaurante los precios omitidos y textos por confirmar.", ""]
    for number, spec in enumerate(PAGE_SPECS, 1):
        rows = [item for item in items if group_num(item)[0] == spec[3] and spec[4] <= group_num(item)[1] <= spec[5]]
        if number == 2:
            rows = [item for item in items if group_num(item)[0] == "drink"] + rows
        image, meta, page = renderer.render(number, spec, rows, details, out)
        metadata.append(meta)
        pages.append(page)
        seen.extend(item["key"] for item in rows)
        preview = image.copy()
        preview.thumbnail((360, 600), Image.Resampling.LANCZOS)
        previews.append(preview)
        markdown.extend([f"## 第 {number} 页 · {spec[0]}", ""])
        for item in rows:
            markdown.extend([f"### {item['key']} · {item['name']}", f"{item['spanish']} — {money(item['priceCents'])}", ""])
            if item["key"] in details:
                detail = details[item["key"]]
                for zh, es in zip(detail["chinese"], detail["spanish"], strict=True):
                    markdown.append(f"- {zh} / {es}")
                markdown.extend(["", "价格含 IVA / IVA incluido.", ""])
            if item.get("uncertain"):
                markdown.extend([f"原文待确认 / Texto por confirmar：{item.get('note', '')}", ""])
    assert len(seen) == 272 and set(seen) == {item["key"] for item in items}
    assert len(seen) == len(set(seen)), "Every source entry must appear exactly once"
    write_json(out / "menu.json", {"title": "Gran Furama 中文菜单 · 西班牙语对照", "pages": metadata, "currency": "USD", "languages": ["zh-CN", "es"], "layoutVersion": 1})
    write_json(out / "bilingual-layout.json", {"version": 1, "entryCount": len(seen), "pricedCount": 184, "unpricedCount": 88, "uncertainCount": 8, "pages": pages})
    (out / "bilingual-menu.md").write_text("\n".join(markdown) + "\n", encoding="utf-8")
    sheet = Image.new("RGB", (360 * 4, 600 * 2), "#e4ece7")
    for index, preview in enumerate(previews):
        sheet.paste(preview, ((index % 4) * 360, (index // 4) * 600))
    args.preview.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.preview, "PNG", optimize=True)
    total_bytes = sum((out / page["file"]).stat().st_size for page in metadata)
    assert total_bytes < 32 * 1024 * 1024
    print(json.dumps({"pages": len(pages), "entries": len(seen), "totalBytes": total_bytes, "preview": str(args.preview)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
