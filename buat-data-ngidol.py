#!/usr/bin/env python3
"""Membuat ngidol-data.js dari ../ngidol/prisma/seed.js.

Yang diambil hanya foto grup, tautan media sosial grup, serta nama dan foto
member. Deskripsi tidak ikut, karena sebagian berisi nomor kontak.
Jalankan lagi setiap kali data di proyek ngidol berubah:  python3 buat-data-ngidol.py
"""
import json, os, re

here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, "..", "ngidol", "prisma", "seed.js"), encoding="utf8").read()
i = src.index("const idols = ") + len("const idols = ")
depth, j, in_str, esc = 0, i, False, False
while True:
    c = src[j]
    if in_str:
        if esc: esc = False
        elif c == "\\": esc = True
        elif c == '"': in_str = False
    elif c == '"': in_str = True
    elif c == "[": depth += 1
    elif c == "]":
        depth -= 1
        if depth == 0: break
    j += 1
idols = json.loads(src[i:j + 1])

out = {}
for g in idols:
    key = re.sub(r"[^a-z0-9]+", "", g["name"].lower())
    out[key] = {
        "name": g["name"],
        "image": g.get("image", ""),
        "sosmeds": [u.split("?")[0] for u in g.get("sosmeds", []) if u.startswith("https://")],
        "members": [{"name": m["name"], "image": m["image"]} for m in g.get("members", []) if m.get("image")],
    }
with open(os.path.join(here, "ngidol-data.js"), "w", encoding="utf8") as f:
    f.write("/* Dibuat otomatis oleh buat-data-ngidol.py dari proyek ngidol. Jangan diedit manual. */\n")
    f.write("window.NGIDOL=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
print(len(out), "grup:", ", ".join(f'{k}({len(v["members"])})' for k, v in out.items()))
