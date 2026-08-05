#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""南京 / 贵阳 演示数据种子脚本
- 城市 + 行政区 + 保租/置换项目 + 户型 + 图片引用（复用 assets/juzhu/sy 占位图）
- 幂等：重复执行会先清空这两个城市的旧演示数据再重建
- 执行后自动 export_json() 生成 data-nanjing.json / data-guiyang.json / cities.json
"""
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / "juzhu.db"
sys.path.insert(0, str(ROOT))
import db  # noqa: E402

KEEPER_AVATAR = "assets/juzhu/sy/keepers/unit_1.jpeg"
SY_UNIT_PHOTOS = [  # 复用沈阳户型图做占位（真实存在的路径）
    "assets/juzhu/sy/units/bzf/CCB建融家园中华路店/30平_0.jpeg",
    "assets/juzhu/sy/units/bzf/CCB建融家园中华路店/30平_1.jpeg",
    "assets/juzhu/sy/units/bzf/CCB建融家园中华路店/40平_0.jpeg",
    "assets/juzhu/sy/units/bzf/CCB建融家园中华路店/40平_1.jpeg",
    "assets/juzhu/sy/units/bzf/CCB建融家园中华路店/56平_0.jpg",
    "assets/juzhu/sy/units/bzf/CCB建融家园中华路店/56平_1.jpg",
]
BZF_COVERS = [  # 沈阳真实保租项目封面，按序轮换给演示城市用
    "assets/juzhu/sy/projects/bzf/和平区/CCB建融家园中华路店.jpg",
    "assets/juzhu/sy/projects/bzf/和平区/逸居雪莲店.jpg",
    "assets/juzhu/sy/projects/bzf/大东区/新东人才住房.jpg",
    "assets/juzhu/sy/projects/bzf/大东区/观泉店.jpg",
    "assets/juzhu/sy/projects/bzf/大东区/逸居望花丽景店.jpg",
    "assets/juzhu/sy/projects/bzf/沈河区/CCB建融家园青年大街店.jpg",
    "assets/juzhu/sy/projects/bzf/沈河区/中金启城.jpg",
    "assets/juzhu/sy/projects/bzf/沈河区/庆余家园.jpg",
    "assets/juzhu/sy/projects/bzf/沈河区/惠民馨苑.jpg",
    "assets/juzhu/sy/projects/bzf/浑南区/CCB建融家园新市府店.jpg",
    "assets/juzhu/sy/projects/bzf/浑南区/中海润山府.jpg",
    "assets/juzhu/sy/projects/bzf/浑南区/凤凰居人才公寓.jpg",
    "assets/juzhu/sy/projects/bzf/皇姑区/逸居中海寰宇店.jpg",
    "assets/juzhu/sy/projects/bzf/皇姑区/逸居学樘府店.jpg",
    "assets/juzhu/sy/projects/bzf/皇姑区/逸居崇山路店.jpg",
    "assets/juzhu/sy/projects/bzf/苏家屯区/九里店.jpg",
    "assets/juzhu/sy/projects/bzf/苏家屯区/地铁云杉里.jpeg",
]
TRADE_COVERS = [
    "assets/juzhu/sy/projects/trade/中德人才社区.jpg",
    "assets/juzhu/sy/projects/trade/逸居锦城.jpg",
]
SY_DIST_COVER = "assets/juzhu/sy/districts/{}.jpg"

AMENITIES = ["ac", "washer", "fridge", "heater", "lock", "wifi", "tv", "hood", "induction"]
TAGS = ["政府保租房", "近地铁", "精致小户型", "押一付一", "租金受控", "拎包入住"]

CITIES = [
    {
        "name": "南京",
        "slug": "nanjing",
        "booking_phone": "13951880001",
        "hero_bg_image": "assets/juzhu/sy/city/hero.jpg",
        "districts": ["鼓楼区", "玄武区", "秦淮区", "建邺区", "栖霞区", "雨花台区", "江宁区", "浦口区"],
        "projects": [
            {"district": "建邺区", "name": "CCB建融家园河西店", "address": "建邺区江东中路", "price_from": 2400,
             "cover": BZF_COVERS[0],
             "units": [("30 平", 30, 2400), ("45 平", 45, 3300), ("60 平", 60, 4200), ("70 平", 70, 5000)]},
            {"district": "鼓楼区", "name": "安居·紫金公馆", "address": "鼓楼区虎踞北路", "price_from": 2600,
             "cover": BZF_COVERS[1],
             "units": [("35 平", 35, 2600), ("50 平", 50, 3600), ("65 平", 65, 4500)]},
            {"district": "鼓楼区", "name": "宁慧·石头城青年社区", "address": "鼓楼区石头城路", "price_from": 2200,
             "cover": BZF_COVERS[2],
             "units": [("28 平", 28, 2200), ("40 平", 40, 3000), ("55 平", 55, 3900)]},
            {"district": "秦淮区", "name": "安居·老门东里", "address": "秦淮区中华路", "price_from": 2500,
             "cover": BZF_COVERS[3],
             "units": [("32 平", 32, 2500), ("46 平", 46, 3400), ("58 平", 58, 4100)]},
            {"district": "玄武区", "name": "宁慧·玄武湖畔寓", "address": "玄武区龙蟠路", "price_from": 2300,
             "cover": BZF_COVERS[4],
             "units": [("30 平", 30, 2300), ("44 平", 44, 3200)]},
            {"district": "江宁区", "name": "安居·百家湖青年家", "address": "江宁区双龙大道", "price_from": 1900,
             "cover": BZF_COVERS[5],
             "units": [("35 平", 35, 1900), ("52 平", 52, 2700), ("68 平", 68, 3500)]},
            {"district": "栖霞区", "name": "宁慧·仙林学仕里", "address": "栖霞区文苑路", "price_from": 1800,
             "cover": BZF_COVERS[6],
             "units": [("28 平", 28, 1800), ("42 平", 42, 2600)]},
        ],
        "trade": {
            "name": "宁聚·旧房焕新计划", "address": "鼓楼区中山北路",
            "cover": TRADE_COVERS[0],
            "old_house_hint": "旧房免费评估 · 卖旧买新一站式服务",
            "price_from": 180,
            "units": [("85 平", 85, 260), ("105 平", 105, 330), ("130 平", 130, 420)],
        },
    },
    {
        "name": "贵阳",
        "slug": "guiyang",
        "booking_phone": "13985120001",
        "hero_bg_image": "assets/juzhu/sy/city/hero.jpg",
        "districts": ["云岩区", "南明区", "观山湖区", "花溪区", "乌当区", "白云区"],
        "projects": [
            {"district": "南明区", "name": "CCB建融家园甲秀楼店", "address": "南明区西湖路", "price_from": 1500,
             "cover": BZF_COVERS[0],
             "units": [("30 平", 30, 1500), ("45 平", 45, 2100), ("60 平", 60, 2700)]},
            {"district": "云岩区", "name": "黔居·黔灵青年寓", "address": "云岩区枣山路", "price_from": 1400,
             "cover": BZF_COVERS[1],
             "units": [("28 平", 28, 1400), ("40 平", 40, 1950), ("55 平", 55, 2500)]},
            {"district": "观山湖区", "name": "黔居·观山湖人才公寓", "address": "观山湖区长岭北路", "price_from": 1600,
             "cover": BZF_COVERS[2],
             "units": [("35 平", 35, 1600), ("50 平", 50, 2300), ("65 平", 65, 2900), ("80 平", 80, 3600)]},
            {"district": "观山湖区", "name": "CCB建融家园金融城店", "address": "观山湖区金朱东路", "price_from": 1700,
             "cover": BZF_COVERS[3],
             "units": [("32 平", 32, 1700), ("48 平", 48, 2400)]},
            {"district": "花溪区", "name": "黔居·花溪大学城寓", "address": "花溪区花溪大道", "price_from": 1200,
             "cover": BZF_COVERS[4],
             "units": [("30 平", 30, 1200), ("42 平", 42, 1750)]},
            {"district": "乌当区", "name": "黔居·乌当温泉青年家", "address": "乌当区新添大道", "price_from": 1100,
             "cover": BZF_COVERS[5],
             "units": [("35 平", 35, 1100), ("50 平", 50, 1650)]},
        ],
        "trade": {
            "name": "黔焕·旧房换新居计划", "address": "云岩区中华北路",
            "cover": TRADE_COVERS[1],
            "old_house_hint": "旧房免费评估 · 卖旧买新一站式服务",
            "price_from": 90,
            "units": [("88 平", 88, 130), ("110 平", 110, 165), ("140 平", 140, 210)],
        },
    },
]

# 从现有库里取沈阳的区封面 / 项目封面真实存在的文件，保证演示图可显示
def pick_cover(pool, idx):
    return pool[idx % len(pool)]

def rent_detail(unit_name, area, rent):
    return {
        "room_label": f"{unit_name} {area}㎡",
        "long_term": {
            "range": "可租4个月-1年",
            "plan": {"pay": "季付", "rent": rent, "service_fee": None, "service_note": "一次收取", "deposit": rent},
        },
        "short_term": {
            "range": "可租1个月-3个月",
            "plan": {"pay": "月付", "rent": rent, "service_fee": None, "service_note": "一次收取", "deposit": rent},
        },
        "other_fees": [
            {"name": "水费", "value": "—元/吨"},
            {"name": "电费", "value": "—元/度"},
            {"name": "宽带费", "value": "—元/月"},
            {"name": "物业费", "value": "—元/月"},
            {"name": "供暖费", "value": "—元/方"},
        ],
    }


def slugify(name):
    return name.replace(" ", "-")


def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    conn.execute("PRAGMA foreign_keys = ON")

    for city in CITIES:
        # 城市（幂等：存在则更新，不存在则插入）
        row = cur.execute("SELECT id FROM cities WHERE slug=?", (city["slug"],)).fetchone()
        if row:
            cid = row["id"]
            cur.execute("UPDATE cities SET name=?, booking_phone=?, hero_bg_image=? WHERE id=?",
                        (city["name"], city["booking_phone"], city["hero_bg_image"], cid))
            # 清掉该城市旧演示数据
            cur.execute("DELETE FROM photos WHERE entity_type IN ('district','project') AND entity_id IN "
                        "(SELECT id FROM districts WHERE city_id=?)", (cid,))
            cur.execute("DELETE FROM photos WHERE entity_type='unit' AND entity_id IN "
                        "(SELECT id FROM units WHERE project_id IN (SELECT id FROM projects WHERE city_id=?))", (cid,))
            cur.execute("DELETE FROM units WHERE project_id IN (SELECT id FROM projects WHERE city_id=?)", (cid,))
            cur.execute("DELETE FROM projects WHERE city_id=?", (cid,))
            cur.execute("DELETE FROM districts WHERE city_id=?", (cid,))
            conn.commit()
        else:
            cur.execute("INSERT INTO cities(name, slug, booking_phone, hero_bg_image) VALUES (?,?,?,?)",
                        (city["name"], city["slug"], city["booking_phone"], city["hero_bg_image"]))
            cid = cur.lastrowid

        # 行政区
        dist_ids = {}
        for i, dname in enumerate(city["districts"]):
            cur.execute(
                "INSERT INTO districts(city_id,name,slug,note,sort_order,cover_image,has_projects,is_hot,bg_class) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (cid, dname, dname, None, i + 1, SY_DIST_COVER.format(dname), 0, 0, f"g{i % 3 + 1}"),
            )
            dist_ids[dname] = cur.lastrowid
            cur.execute("INSERT INTO photos(entity_type,entity_id,file_path,is_cover,sort_order) VALUES ('district',?,?,1,0)",
                        (dist_ids[dname], SY_DIST_COVER.format(dname)))

        # 保租项目 + 户型
        photo_idx = 0
        for p in city["projects"]:
            did = dist_ids[p["district"]]
            cur.execute(
                "INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,sort_order,"
                "unit_count,managed_unit_count,price_from,is_featured,rating_status) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (cid, did, "bzf", p["name"], slugify(p["name"]), p["cover"], p["address"],
                 json.dumps([], ensure_ascii=False), 1, len(p["units"]), len(p["units"]) * 40, p["price_from"], 0, "draft"),
            )
            pid = cur.lastrowid
            cur.execute("INSERT INTO photos(entity_type,entity_id,file_path,is_cover,sort_order) VALUES ('project',?,?,1,0)",
                        (pid, p["cover"]))
            for j, (uname, area, rent) in enumerate(p["units"]):
                spec = f"{area // 15 + 1 if area >= 30 else 1}室1厅 | {area}㎡ | 南/北 | 立即入住"
                cur.execute(
                    "INSERT INTO units(project_id,name,slug,area_sqm,layout_label,rent_monthly,tags,unit_spec,"
                    "amenities,keeper,rent_detail,sort_order,cover_image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (pid, uname, slugify(uname), float(area), f"{area // 15 + 1 if area >= 30 else 1}居", rent,
                     json.dumps(TAGS, ensure_ascii=False), spec,
                     json.dumps(AMENITIES, ensure_ascii=False),
                     json.dumps({"name": f"管家{'小'+('宁' if city['slug']=='nanjing' else '筑')}", "avatar": KEEPER_AVATAR,
                                "phone": city["booking_phone"]}, ensure_ascii=False),
                     json.dumps(rent_detail(uname, area, rent), ensure_ascii=False),
                     j + 1, None),
                )
                uid = cur.lastrowid
                cur.execute("INSERT INTO photos(entity_type,entity_id,file_path,is_cover,sort_order) VALUES ('unit',?,?,0,?)",
                            (uid, SY_UNIT_PHOTOS[photo_idx % len(SY_UNIT_PHOTOS)], 0))
                photo_idx += 1

        # 置换项目（trade）
        t = city["trade"]
        cur.execute(
            "INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,sort_order,"
            "unit_count,managed_unit_count,price_from,is_featured,featured_rank,old_house_hint,rating_status) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, None, "trade", t["name"], slugify(t["name"]), t["cover"], t["address"],
             json.dumps([], ensure_ascii=False), 1, len(t["units"]), 0, t["price_from"], 1, 1, t["old_house_hint"], "draft"),
        )
        tpid = cur.lastrowid
        cur.execute("INSERT INTO photos(entity_type,entity_id,file_path,is_cover,sort_order) VALUES ('project',?,?,1,0)",
                    (tpid, t["cover"]))
        for j, (uname, area, price) in enumerate(t["units"]):
            cur.execute(
                "INSERT INTO units(project_id,name,slug,area_sqm,layout_label,price_total,tags,unit_spec,"
                "amenities,keeper,rent_detail,sort_order,cover_image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (tpid, uname, slugify(uname), float(area), f"{area // 25 + 1 if area >= 80 else 2}居", price,
                 json.dumps(["卖旧买新", "学区置换", "拎包入住"], ensure_ascii=False),
                 f"{area // 25 + 1 if area >= 80 else 2}室2厅 | {area}㎡ | 南北通透 | 现房",
                 json.dumps(AMENITIES, ensure_ascii=False),
                 json.dumps({"name": "置换顾问", "avatar": KEEPER_AVATAR, "phone": city["booking_phone"]}, ensure_ascii=False),
                 "{}", j + 1, None),
            )
            uid = cur.lastrowid
            cur.execute("INSERT INTO photos(entity_type,entity_id,file_path,is_cover,sort_order) VALUES ('unit',?,?,0,?)",
                        (uid, SY_UNIT_PHOTOS[photo_idx % len(SY_UNIT_PHOTOS)], 0))
            photo_idx += 1

        print(f"✓ {city['name']}({city['slug']}): {len(city['districts'])} 区 / "
              f"{len(city['projects'])} 保租项目 + 1 置换 / {sum(len(p['units']) for p in city['projects']) + len(city['trade']['units'])} 户型")

    conn.commit()
    conn.close()

    # 导出：data.json(沈阳) + data-nanjing.json + data-guiyang.json + cities.json
    db.export_json()
    print("✓ 已导出 data.json / data-nanjing.json / data-guiyang.json / cities.json")


if __name__ == "__main__":
    main()
