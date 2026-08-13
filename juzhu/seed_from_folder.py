#!/usr/bin/env python3
"""从东博「新居住专区」文件夹扫描并写入 MySQL + 导出 data.json + 复制封面图。"""
import json, os, re, shutil
from pathlib import Path
from typing import List, Optional, Tuple

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
SRC = Path("/Users/scubiry/Downloads/东博项目/新居住专区")
JSON_PATH = ROOT / "data.json"
ASSETS = REPO / "assets" / "juzhu" / "sy"

import db  # noqa: E402

IMG_EXT = {".jpg", ".jpeg", ".png", ".JPG", ".JPEG", ".PNG"}
COVER_NAMES = {"店封面.jpg", "店封面 .jpg", "项目 封面.jpg", "项目封面.jpg"}


def slug(s: str) -> str:
    s = re.sub(r"[（(].*?[）)]", "", s).strip()
    s = re.sub(r"\s+", "-", s)
    return s


def parse_area(name: str) -> Optional[float]:
    m = re.search(r"(\d+(?:\.\d+)?)\s*平", name)
    if m:
        return float(m.group(1))
    m = re.search(r"^(\d+(?:\.\d+)?)$", name.strip())
    if m:
        return float(m.group(1))
    m = re.search(r"(\d+(?:\.\d+)?)", name)
    return float(m.group(1)) if m else None


def is_img(p: Path) -> bool:
    return p.suffix in IMG_EXT


def find_cover(folder: Path) -> Optional[Path]:
    for n in COVER_NAMES:
        p = folder / n
        if p.exists():
            return p
    for f in sorted(folder.iterdir()):
        if f.is_file() and is_img(f) and "封面" in f.name:
            return f
    return None


def district_cover(folder: Path) -> Optional[Path]:
    c = find_cover(folder)
    if c:
        return c
    for f in sorted(folder.iterdir()):
        if f.is_file() and is_img(f):
            return f
    return None


def copy_asset(src: Path, dest_rel: str) -> str:
    dest = REPO / dest_rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists() or dest.stat().st_size != src.stat().st_size:
        shutil.copy2(src, dest)
    return dest_rel


def unit_photos(folder: Path) -> List[Path]:
    return sorted([f for f in folder.iterdir() if f.is_file() and is_img(f)])


def main():
    if not SRC.exists():
        raise SystemExit(f"源目录不存在: {SRC}")

    if ASSETS.exists():
        shutil.rmtree(ASSETS)
    ASSETS.mkdir(parents=True, exist_ok=True)

    conn = db.connect()  # MySQL：先清空房源相关表，再全量重建
    conn.executescript((ROOT / "mysql_schema.sql").read_text())
    for table in ("cities", "districts", "projects", "units", "photos"):
        conn.execute("DELETE FROM %s" % table)

    conn.execute("INSERT INTO cities(name, slug) VALUES (?, ?)", ("沈阳", "shenyang"))
    city_id = conn.execute("SELECT id FROM cities WHERE slug='shenyang'").fetchone()[0]

    bzf_root = SRC / "保租房专区"
    trade_root = SRC / "卖旧买新专区"

    # --- 保租房：行政区 ---
    district_rows = []
    for i, dname_raw in enumerate(sorted(os.listdir(bzf_root))):
        dp = bzf_root / dname_raw
        if not dp.is_dir():
            continue
        m = re.match(r"^(.+?)(?:（(.+)）)?$", dname_raw)
        name, note = m.group(1), m.group(2)
        has_projects = note != "暂无项目"

        project_dirs = [x for x in dp.iterdir() if x.is_dir()]
        unit_total = sum(
            len([u for u in (pp / p).iterdir() if u.is_dir()])
            for p in project_dirs
            for pp in [dp]
        )
        # recount properly
        unit_total = 0
        for pd in project_dirs:
            unit_total += len([u for u in pd.iterdir() if u.is_dir()])

        cov = district_cover(dp)
        cover_rel = None
        if cov:
            cover_rel = copy_asset(cov, f"assets/juzhu/sy/districts/{slug(name)}{cov.suffix.lower()}")

        # 演示用估算租金（沈阳保租房 pilot）
        avg_map = {
            "沈河区": 1680, "和平区": 1750, "大东区": 1420, "浑南区": 1580,
            "皇姑区": 1520, "苏家屯区": 1180,
        }
        avg = avg_map.get(name, 1280 if has_projects else None)
        vacant = unit_total if has_projects else 0

        layout_tall = 1 if name == "沈河区" else 0
        layout_wide = 1 if name == "大东区" else 0
        is_hot = 1 if name in ("沈河区", "浑南区") else 0
        bg = f"g{(i % 8) + 1}"

        conn.execute(
            """INSERT INTO districts(city_id,name,slug,note,has_projects,sort_order,cover_image,
               project_count,unit_count,vacant_count,avg_price,is_hot,layout_tall,layout_wide,bg_class)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (city_id, name, slug(name), note, int(has_projects), i + 1, cover_rel,
             len(project_dirs), unit_total, vacant, avg, is_hot, layout_tall, layout_wide, bg),
        )
        did = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        if cover_rel:
            conn.execute(
                "INSERT INTO photos(entity_type,entity_id,file_path,source_path,is_cover,sort_order) VALUES (?,?,?,?,1,0)",
                ("district", did, cover_rel, str(cov)),
            )
        district_rows.append((did, name, dp, project_dirs))

    # --- 保租房：项目 & 户型 ---
    rent_base = 1200
    for did, dname, dp, project_dirs in district_rows:
        for j, pd in enumerate(sorted(project_dirs, key=lambda x: x.name)):
            pname = pd.name
            pcov = find_cover(pd)
            pcov_rel = None
            if pcov:
                pcov_rel = copy_asset(
                    pcov,
                    f"assets/juzhu/sy/projects/bzf/{slug(dname)}/{slug(pname)}{pcov.suffix.lower()}",
                )

            unit_dirs = sorted([u for u in pd.iterdir() if u.is_dir()], key=lambda x: x.name)
            tags = []
            if "CCB" in pname or "建融" in pname:
                tags.append("建融家园")
            if "逸居" in pname:
                tags.append("逸居")
            if "人才" in pname:
                tags.append("人才公寓")

            conn.execute(
                """INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
                   sort_order,unit_count,price_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (city_id, did, "bzf", pname, slug(pname), pcov_rel,
                 f"{dname} · {pname}", json.dumps(tags, ensure_ascii=False),
                 j + 1, len(unit_dirs), rent_base + j * 80),
            )
            pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            if pcov_rel:
                conn.execute(
                    "INSERT INTO photos(entity_type,entity_id,file_path,source_path,is_cover,sort_order) VALUES (?,?,?,?,1,0)",
                    ("project", pid, pcov_rel, str(pcov)),
                )

            min_rent = None
            for k, ud in enumerate(unit_dirs):
                uname = ud.name
                area = parse_area(uname)
                photos = unit_photos(ud)
                ucover_rel = None
                if photos:
                    ucover_rel = copy_asset(
                        photos[0],
                        f"assets/juzhu/sy/units/bzf/{slug(pname)}/{slug(uname)}{photos[0].suffix.lower()}",
                    )
                    for si, ph in enumerate(photos[:8]):
                        rel = copy_asset(
                            ph,
                            f"assets/juzhu/sy/units/bzf/{slug(pname)}/{slug(uname)}_{si}{ph.suffix.lower()}",
                        )
                rent = int(rent_base + (area or 40) * 8 + k * 30) if area else rent_base + k * 50
                min_rent = rent if min_rent is None else min(min_rent, rent)

                conn.execute(
                    """INSERT INTO units(project_id,name,slug,area_sqm,rent_monthly,sort_order,cover_image)
                       VALUES (?,?,?,?,?,?,?)""",
                    (pid, uname, slug(uname), area, rent, k + 1, ucover_rel),
                )
                uid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                if photos:
                    for si, ph in enumerate(photos[:8]):
                        rel = f"assets/juzhu/sy/units/bzf/{slug(pname)}/{slug(uname)}_{si}{ph.suffix.lower()}"
                        conn.execute(
                            "INSERT INTO photos(entity_type,entity_id,file_path,source_path,is_cover,sort_order) VALUES (?,?,?,?,?,?)",
                            ("unit", uid, rel, str(ph), 1 if si == 0 else 0, si),
                        )

            if min_rent:
                conn.execute("UPDATE projects SET price_from=? WHERE id=?", (min_rent, pid))

    # --- 卖旧买新 ---
    trade_prices = {"逸居锦城": 168, "中德人才社区": 95}
    for j, pname in enumerate(sorted(os.listdir(trade_root))):
        pp = trade_root / pname
        if not pp.is_dir():
            continue
        pcov = find_cover(pp)
        pcov_rel = None
        if pcov:
            pcov_rel = copy_asset(pcov, f"assets/juzhu/sy/projects/trade/{slug(pname)}{pcov.suffix.lower()}")

        unit_dirs = sorted([u for u in pp.iterdir() if u.is_dir()], key=lambda x: x.name)
        price_from = trade_prices.get(pname, 120)
        conn.execute(
            """INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
               sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint)
               VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (city_id, "trade", pname, slug(pname), pcov_rel, f"沈阳 · {pname}",
             json.dumps(["以旧换新", "东博专区"], ensure_ascii=False),
             j + 1, len(unit_dirs), price_from,
             1 if j == 0 else 0, j + 1 if j < 3 else None,
             f"旧房估价参考 {price_from - 40}万起"),
        )
        pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        if pcov_rel:
            conn.execute(
                "INSERT INTO photos(entity_type,entity_id,file_path,source_path,is_cover,sort_order) VALUES (?,?,?,?,1,0)",
                ("project", pid, pcov_rel, str(pcov)),
            )

        for k, ud in enumerate(unit_dirs):
            uname = ud.name
            area = parse_area(uname)
            photos = unit_photos(ud)
            ucover_rel = None
            price_total = int(price_from + (area or 90) * 0.35) if area else price_from
            if photos:
                ucover_rel = copy_asset(
                    photos[0],
                    f"assets/juzhu/sy/units/trade/{slug(pname)}/{slug(uname)}{photos[0].suffix.lower()}",
                )
            conn.execute(
                """INSERT INTO units(project_id,name,slug,area_sqm,price_total,sort_order,cover_image)
                   VALUES (?,?,?,?,?,?,?)""",
                (pid, uname, slug(uname), area, price_total, k + 1, ucover_rel),
            )
            uid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            if photos:
                for si, ph in enumerate(photos[:8]):
                    rel = copy_asset(
                        ph,
                        f"assets/juzhu/sy/units/trade/{slug(pname)}/{slug(uname)}_{si}{ph.suffix.lower()}",
                    )
                    conn.execute(
                        "INSERT INTO photos(entity_type,entity_id,file_path,source_path,is_cover,sort_order) VALUES (?,?,?,?,?,?)",
                        ("unit", uid, rel, str(ph), 1 if si == 0 else 0, si),
                    )

    conn.commit()

    # --- 导出 JSON ---
    def rows(q, params=()):
        return [dict(r) for r in conn.execute(q, params).fetchall()]

    def parse_tags(items):
        for r in items:
            t = r.get("tags")
            if t is None:
                r["tags"] = []
            elif isinstance(t, str):
                try:
                    r["tags"] = json.loads(t)
                except json.JSONDecodeError:
                    r["tags"] = [t] if t else []
            elif not isinstance(t, list):
                r["tags"] = []
        return items

    data = {
        "city": rows("SELECT * FROM cities")[0],
        "stats": {
            "district_count": conn.execute("SELECT COUNT(*) FROM districts").fetchone()[0],
            "project_count_bzf": conn.execute("SELECT COUNT(*) FROM projects WHERE channel='bzf'").fetchone()[0],
            "project_count_trade": conn.execute("SELECT COUNT(*) FROM projects WHERE channel='trade'").fetchone()[0],
            "unit_count": conn.execute("SELECT COUNT(*) FROM units").fetchone()[0],
        },
        "districts": parse_tags(rows("SELECT * FROM districts ORDER BY sort_order")),
        "projects": parse_tags(rows("SELECT * FROM projects ORDER BY channel, sort_order")),
        "units": parse_tags(rows("SELECT * FROM units ORDER BY project_id, sort_order")),
        "photos": rows("SELECT * FROM photos ORDER BY entity_type, entity_id, sort_order"),
    }
    JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    conn.close()

    print(f"✓ SQLite: {DB_PATH}")
    print(f"✓ JSON:   {JSON_PATH}")
    print(f"✓ Assets: {ASSETS}")
    print(f"  区 {data['stats']['district_count']} · 保租项目 {data['stats']['project_count_bzf']} · 置换项目 {data['stats']['project_count_trade']} · 户型 {data['stats']['unit_count']}")


if __name__ == "__main__":
    main()
