#!/usr/bin/env python3
"""居住服务·家政频道 · SQLite 建表 + 初始数据 seed
执行：python3 juzhu/seed_jiazheng.py
"""
import json
import sqlite3
import sys
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "juzhu.db"
SCHEMA = ROOT / "jiazheng_schema.sql"

NOW = datetime.now(timezone.utc).isoformat(timespec="seconds")


def jdump(x):
    return json.dumps(x, ensure_ascii=False)


def main():
    if not DB_PATH.exists():
        print(f"❌ DB 不存在: {DB_PATH}")
        sys.exit(1)

    print(f"📦 连接数据库: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    # 1. 建表
    print("📋 建表...")
    schema_sql = SCHEMA.read_text(encoding="utf-8")
    conn.executescript(schema_sql)

    # 2. 子类目（4 类 × 6 子 = 24 个）
    print("📂 子类目...")
    CATS = [
        # cleaning
        ("cleaning", "日常保洁", "🧹"), ("cleaning", "深度清洁", "✨"),
        ("cleaning", "开荒保洁", "🏠"), ("cleaning", "玻璃清洗", "🪟"),
        ("cleaning", "油烟机清洗", "💨"), ("cleaning", "收纳整理", "📦"),
        # repair
        ("repair", "家电维修", "🔌"), ("repair", "管道疏通", "🚿"),
        ("repair", "灯具电路", "💡"), ("repair", "门窗维修", "🚪"),
        ("repair", "空调维修", "❄️"), ("repair", "水管维修", "💧"),
        # moving
        ("moving", "居民搬家", "🚚"), ("moving", "长途搬家", "🛣"),
        ("moving", "钢琴搬运", "🎹"), ("moving", "企业搬迁", "🏢"),
        ("moving", "日式搬家", "🍱"), ("moving", "搬货上下楼", "📦"),
        # nanny
        ("nanny", "住家保姆", "🏡"), ("nanny", "白班保姆", "☀️"),
        ("nanny", "钟点工", "⏱"), ("nanny", "月嫂", "🤱"),
        ("nanny", "住家育儿嫂", "👶"), ("nanny", "养老护理", "🧓"),
    ]
    conn.execute("DELETE FROM jz_orders")
    conn.execute("DELETE FROM jz_workers")
    conn.execute("DELETE FROM jz_products")
    conn.execute("DELETE FROM jz_vendors")
    conn.execute("DELETE FROM jz_categories")
    for i, (ptype, name, icon) in enumerate(CATS):
        conn.execute(
            "INSERT INTO jz_categories(parent_type, name, icon, sort_order, status) VALUES (?, ?, ?, ?, 'on')",
            (ptype, name, icon, i + 1),
        )

    # 3. 商家
    print("🏪 商家...")
    VENDORS = [
        # id, type, name, logo, address, rating, review_count, rank_type, rank_label, badges, live, start_price, unit, hours, dist
        (1, "cleaning", "春晖家政", "🏠", "西湖区文三路", 4.6, 3566, "city", "同城销量榜第 8",
         ["whitelist", "backcheck", "top10"], 0, 79.8, "2小时", "08:00-22:00", 2.4),
        (2, "cleaning", "美团自营·保洁", "🛡", "全国连锁", 4.8, 12800, "platform", "平台自营",
         ["whitelist", "insurance", "commitment"], 1, 59.8, "2小时", "07:00-23:00", 0),
        (3, "cleaning", "杭州鑫禧", "🏡", "拱墅区运河路", 4.5, 2180, None, None,
         ["backcheck", "commitment"], 0, 69.8, "2小时", "09:00-21:00", 3.1),
        (4, "cleaning", "洁先锋", "🧼", "滨江区江南大道", 4.3, 980, None, None,
         ["whitelist"], 0, 49.8, "2小时", "08:00-20:00", 5.2),
        (5, "cleaning", "永盛家政", "🏆", "滨江区星耀城", 4.7, 5420, "district", "滨江销量榜第 1",
         ["whitelist", "backcheck", "top10"], 0, 89.8, "2小时", "07:00-22:00", 4.6),
        # repair
        (11, "repair", "快修家电", "🔌", "上城区庆春路", 4.6, 2300, "district", "家电维修口碑第 1",
         ["whitelist", "backcheck"], 0, 89, "次", "07:00-22:00", 1.8),
        # moving
        (21, "moving", "蚂蚁搬家", "🚚", "下城区东新路", 4.7, 5600, "city", "同城销量榜第 2",
         ["whitelist", "backcheck", "top10"], 0, 398, "车次", "06:00-22:00", 3.5),
        # nanny
        (31, "nanny", "阿姨来了", "👶", "全国连锁", 4.8, 8800, "city", "同城口碑第 1",
         ["whitelist", "backcheck", "insurance"], 0, 8800, "月", "住家", 0),
    ]
    conn.execute("DELETE FROM jz_vendors")  # noqa 上面已清
    for v in VENDORS:
        (vid, vtype, name, logo, addr, rating, review_count, rank_type, rank_label,
         badges, live, start_price, unit, hours, dist) = v
        conn.execute(
            """INSERT INTO jz_vendors(id, type, name, logo, address, rating, review_count,
               rank_type, rank_label, badges, live, start_price, unit, hours, status,
               sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)""",
            (vid, vtype, name, logo, addr, rating, review_count, rank_type, rank_label,
             jdump(badges), live, start_price, unit, hours, vid, NOW, NOW),
        )

    # 4. 商品 SKU
    print("🛍 商品...")
    PRODUCTS = [
        # cleaning - 8 个
        (101, 1, "日常保洁 2小时", "上门除尘 · 死无死角", "日常保洁",
         2, "≤50㎡", "2小时", 79.8, 200, "4折", "今天 18:00", 2,
         53000, 4.7, ["每个角落都仔细清洁", "死无死角", "专业工具"]),
        (102, 1, "深度清洁 2小时", "3人团队 · 含厨卫去污", "深度清洁",
         2, "≤50㎡", "2小时", 99.8, 200, "5折", "明天 09:00", 2,
         16000, 4.8, ["专业团队", "深度去污", "含厨卫"]),
        (103, 1, "日常保洁 3小时", "含厨房/卫生间", "日常保洁",
         3, "51-90㎡", "3小时", 139.8, 300, "4.6折", "今天 19:00", 2,
         8000, 4.6, ["三小时更彻底", "含厨卫"]),
        (201, 2, "日常保洁 2小时", "美团直营 · 急速上门", "日常保洁",
         2, "≤60㎡", "2小时", 59.8, 180, "3.3折", "今天 18:00", 1,
         128000, 4.8, ["急速上门", "不满意重做", "百万保障"]),
        (202, 2, "深度清洁 3小时", "3人组 · 含玻璃/油烟机", "深度清洁",
         3, "≤80㎡", "3小时", 159.8, 380, "4.2折", "明天 08:00", 2,
         42000, 4.9, ["3人组", "含玻璃"]),
        (301, 3, "日常保洁 2小时", "本地团队", "日常保洁",
         2, "≤50㎡", "2小时", 69.8, 160, "4.3折", "明天 09:00", 4,
         15000, 4.5, ["本地团队"]),
        (401, 4, "日常保洁 2小时", "经济实惠", "日常保洁",
         2, "≤50㎡", "2小时", 49.8, 150, "3.3折", "今天 19:00", 2,
         6800, 4.3, ["经济实惠"]),
        (501, 5, "日常保洁 2小时", "金牌服务者", "日常保洁",
         2, "≤60㎡", "2小时", 89.8, 240, "3.7折", "今天 18:00", 2,
         31000, 4.7, ["金牌服务者", "专业工具"]),
        # repair
        (1101, 11, "空调维修", "不制冷/漏水/异响", "家电维修",
         1, "", "次", 89, 200, "4.5折", "30分钟内", 0,
         8200, 4.6, ["30分钟上门", "原厂配件", "90天质保"]),
        # moving
        (2101, 21, "居民搬家 同城", "金杯车 · 2名师傅", "居民搬家",
         1, "", "车次", 398, 680, "5.8折", "今天 19:00", 4,
         23000, 4.7, ["金杯车", "2名师傅"]),
        # nanny
        (3101, 31, "住家育儿嫂", "3年以上经验 · 持证", "住家育儿嫂",
         24, "", "月", 8800, 12000, "7.3折", "5日内", 120,
         5200, 4.8, ["持证", "3年经验", "健康证"]),
    ]
    conn.execute("DELETE FROM jz_products")  # noqa 上面已清
    for p in PRODUCTS:
        (pid, vid, title, sub, cat, dur, area, unit, price, orig, disc_label,
         earliest, adv, sales, rating, tags) = p
        conn.execute(
            """INSERT INTO jz_products(id, vendor_id, title, subtitle, category,
               duration_hours, area_range, unit, price, original_price, discount_label,
               earliest_time, advance_booking_hours, sales_count, rating, service_tags,
               status, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'on', ?)""",
            (pid, vid, title, sub, cat, dur, area, unit, price, orig, disc_label,
             earliest, adv, sales, rating, jdump(tags), pid),
        )

    # 5. 服务者
    print("👷 服务者...")
    WORKERS = [
        (1, "陈建国", "👨", "L4", 88, ["细致", "主动", "准时"], 4.9, 2317, 5, 1, 2.4, 1),
        (2, "杨秀芳", "👩", "L4", 92, ["准时", "周到", "经验丰富"], 4.8, 1820, 6, 1, 3.1, 5),
        (3, "王志强", "👨", "L3", 78, ["专业", "稳重"], 4.6, 920, 3, 1, 1.8, 1),
        (4, "刘海燕", "👩", "L3", 80, ["热情", "耐心"], 4.7, 1280, 4, 0, 5.2, 2),
    ]
    conn.execute("DELETE FROM jz_workers")  # noqa 上面已清
    for w in WORKERS:
        (wid, name, avatar, level, credit, tags, rating, completed, years, online, dist, vid) = w
        all_certs = ["id_card", "health", "skill", "insurance"] if wid in (1, 2) else ["id_card", "health", "skill"]
        conn.execute(
            """INSERT INTO jz_workers(id, name, avatar, level, credit_score, tags,
               certs, is_whitelisted, rating, completed_orders, years_experience,
               online, distance_km, vendor_id, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'active')""",
            (wid, name, avatar, level, credit, jdump(tags), jdump(all_certs),
             rating, completed, years, online, dist, vid),
        )

    conn.commit()
    conn.close()

    # 统计
    print("\n✅ Seed 完成")
    print(f"  · 子类目: {len(CATS)}")
    print(f"  · 商家: {len(VENDORS)}")
    print(f"  · 商品: {len(PRODUCTS)}")
    print(f"  · 服务者: {len(WORKERS)}")


if __name__ == "__main__":
    main()
