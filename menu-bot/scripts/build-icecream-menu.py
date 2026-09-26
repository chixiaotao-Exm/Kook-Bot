#!/usr/bin/env python3
"""Render the photograph-backed ice-cream appendix with exact bilingual text.

Requires Python 3.10+ and Pillow. No price or unclear flavor is inferred. The
separate layout sidecar records every visible text span for repeatable QA.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 1800, 3200
MARGIN = 84
BG, INK, GREEN, MUTED, LINE = "#fbfdfb", "#17271f", "#25654f", "#52685b", "#cbd9d0"
WARNING = "#856320"
PAGE_FILE = "page-9.png"
ROW_TOP, ROW_HEIGHT = 460, 322


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def visible_names(item):
    # The photograph's uncertain label must never look like an established
    # flavor. The catalog retains an explicit unresolved-name marker.
    if item.get("uncertain"):
        return "口味待确认", "Sabor por confirmar"
    return item["name"], item["originalLabel"]


def appendix_markdown(layout):
    lines = ["## 第 9 页 · 冰淇淋口味", "", "照片未标价，请询问餐厅。", "Precio no indicado. Consulte al restaurante.", ""]
    for entry in layout["entries"]:
        lines.extend([f"### {entry['key']} · {entry['chinese']}", f"{entry['spanish']} — 未标价 / Sin precio", ""])
    return lines


def render(args, update_manifest=True):
    out = args.output or args.assets
    out.mkdir(parents=True, exist_ok=True)
    catalog_path = args.assets / "catalog-icecream.json"
    catalog = read_json(catalog_path)
    items = catalog["items"]
    assert catalog["currency"] == "USD"
    assert len(items) == 7 and [item["key"] for item in items] == [f"ice:{i}" for i in range(1, 8)]
    assert all(item["priceCents"] is None for item in items), "The source photograph does not show prices"
    assert all(item["source"] == "icecream-photo-01" for item in items)
    fonts = {
        "brand": ImageFont.truetype(args.latin_bold, 31),
        "title": ImageFont.truetype(args.cjk_bold, 72),
        "subtitle": ImageFont.truetype(args.latin_font, 38),
        "section": ImageFont.truetype(args.cjk_bold, 29),
        "zh": ImageFont.truetype(args.cjk_bold, 56),
        "es": ImageFont.truetype(args.latin_font, 48),
        "code": ImageFont.truetype(args.latin_bold, 31),
        "small": ImageFont.truetype(args.cjk_font, 28),
        "latin_small": ImageFont.truetype(args.latin_font, 29),
        "page": ImageFont.truetype(args.latin_font, 24),
    }
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)

    def text(value, x, y, font, color, records, right=False):
        face, anchor = fonts[font], "rt" if right else "lt"
        box = list(draw.textbbox((x, y), value, font=face, anchor=anchor))
        assert MARGIN <= box[0] <= box[2] <= WIDTH - MARGIN + 1, (value, box)
        assert 0 <= box[1] <= box[3] <= HEIGHT, (value, box)
        draw.text((x, y), value, font=face, fill=color, anchor=anchor)
        records.append({"text": value, "font": font, "fontSize": face.size, "bbox": box})

    page_text, entries = [], []
    text("GRAN FURAMA", MARGIN, 65, "brand", GREEN, page_text)
    text("双语菜单 / Menú bilingüe", WIDTH - MARGIN, 65, "section", GREEN, page_text, True)
    text("冰淇淋口味", MARGIN, 158, "title", INK, page_text)
    text("SABORES DE HELADO", MARGIN, 263, "subtitle", MUTED, page_text)
    draw.line((MARGIN, 345, WIDTH - MARGIN, 345), fill=GREEN, width=3)
    text("按桶盖标签整理 · 西班牙语原名对照", MARGIN, 383, "small", MUTED, page_text)

    for index, item in enumerate(items):
        top = ROW_TOP + index * ROW_HEIGHT
        zh, es = visible_names(item)
        row_text = []
        color = WARNING if item.get("uncertain") else GREEN
        draw.rounded_rectangle((MARGIN, top + 37, MARGIN + 166, top + 104), radius=16, fill="#edf3ef", outline=LINE, width=1)
        text(item["key"], MARGIN + 23, top + 53, "code", color, row_text)
        text(zh, MARGIN + 226, top + 33, "zh", INK, row_text)
        text(es, MARGIN + 226, top + 122, "es", color, row_text)
        if item.get("uncertain"):
            text("右上方桶盖字样不清，请询问餐厅。", MARGIN + 226, top + 202, "small", MUTED, row_text)
        draw.line((MARGIN, top + ROW_HEIGHT - 28, WIDTH - MARGIN, top + ROW_HEIGHT - 28), fill=LINE, width=1)
        rect = [MARGIN, top, WIDTH - MARGIN, top + ROW_HEIGHT - 28]
        for span in row_text:
            left, upper, right, lower = span["bbox"]
            assert rect[0] <= left <= right <= rect[2] and rect[1] <= upper <= lower <= rect[3], (item["key"], span)
        entries.append({"key": item["key"], "rect": rect, "chinese": zh, "spanish": es,
                        "priceCents": None, "uncertain": bool(item.get("uncertain")),
                        "source": item["source"], "text": row_text})

    text("价格请询问餐厅", MARGIN, 2860, "small", GREEN, page_text)
    text("Precio no indicado. Consulte al restaurante.", MARGIN, 2911, "latin_small", MUTED, page_text)
    text("编号用于查询和选口味 · Códigos para elegir el sabor", MARGIN, HEIGHT - 81, "small", GREEN, page_text)
    text("9 / 9", WIDTH - MARGIN, HEIGHT - 80, "page", MUTED, page_text, True)
    path = out / PAGE_FILE
    image.save(path, "PNG", optimize=True)
    assert path.stat().st_size < 4 * 1024 * 1024
    metadata = {"file": PAGE_FILE, "title": "冰淇淋口味", "width": WIDTH, "height": HEIGHT,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    layout = {"version": 1, "file": PAGE_FILE, "size": [WIDTH, HEIGHT], "pageNumber": 9,
              "entryCount": len(entries), "pricedCount": 0, "unpricedCount": len(entries),
              "uncertainCount": sum(entry["uncertain"] for entry in entries),
              "catalogSha256": hashlib.sha256(catalog_path.read_bytes().replace(b"\r\n", b"\n")).hexdigest(),
              "contentBounds": [MARGIN, ROW_TOP, WIDTH - MARGIN, ROW_TOP + ROW_HEIGHT * 7],
              "entries": entries, "pageText": page_text}
    write_json(out / "icecream-layout.json", layout)
    if update_manifest:
        manifest_path = out / "menu.json"
        manifest = read_json(manifest_path) if manifest_path.exists() else {
            "title": "Gran Furama 中文菜单 · 西班牙语对照", "pages": [], "currency": "USD",
            "languages": ["zh-CN", "es"], "layoutVersion": 1}
        manifest["pages"] = [page for page in manifest["pages"] if page["file"] != PAGE_FILE] + [metadata]
        write_json(manifest_path, manifest)
        markdown_path = out / "bilingual-menu.md"
        if markdown_path.exists():
            previous = markdown_path.read_text(encoding="utf-8").split("## 第 9 页 · 冰淇淋口味", 1)[0]
            markdown_path.write_text(previous.rstrip() + "\n\n" + "\n".join(appendix_markdown(layout)).rstrip() + "\n", encoding="utf-8")
    return image, metadata, layout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=ROOT / "assets")
    parser.add_argument("--output", type=Path, default=None)
    for name, filename in [("cjk-font", "msyh.ttc"), ("cjk-bold", "msyhbd.ttc"),
                           ("latin-font", "arial.ttf"), ("latin-bold", "arialbd.ttf")]:
        parser.add_argument("--" + name, default=str(Path("C:/Windows/Fonts") / filename))
    args = parser.parse_args()
    for name in ("cjk_font", "cjk_bold", "latin_font", "latin_bold"):
        if not Path(getattr(args, name)).is_file():
            parser.error(f"Font unavailable; provide --{name.replace('_', '-')} for your system")
    _, metadata, layout = render(args)
    print(json.dumps({"page": metadata["file"], "entries": layout["entryCount"], "sha256": metadata["sha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
