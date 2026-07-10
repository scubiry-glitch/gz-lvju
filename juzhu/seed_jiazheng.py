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

    # 3. 商家（沈阳 · 东博专区）
    print("🏪 商家...")
    VENDORS = [
        # id, type, name, logo, address, rating, review_count, rank_type, rank_label, badges, live, start_price, unit, hours, dist
        (1, "cleaning", "春晖家政", "🏠", "和平区中华路", 4.6, 3566, "city", "沈阳销量榜第 8",
         ["whitelist", "backcheck", "top10"], 0, 79.8, "2小时", "08:00-22:00", 2.4),
        (2, "cleaning", "美团自营·保洁", "🛡", "沈河区青年大街", 4.8, 12800, "platform", "平台自营",
         ["whitelist", "insurance", "commitment"], 1, 59.8, "2小时", "07:00-23:00", 0),
        (3, "cleaning", "沈阳鑫禧", "🏡", "皇姑区北陵大街", 4.5, 2180, None, None,
         ["backcheck", "commitment"], 0, 69.8, "2小时", "09:00-21:00", 3.1),
        (4, "cleaning", "洁先锋", "🧼", "浑南区新市府", 4.3, 980, None, None,
         ["whitelist"], 0, 49.8, "2小时", "08:00-20:00", 5.2),
        (5, "cleaning", "永盛家政", "🏆", "浑南区星耀城", 4.7, 5420, "district", "浑南销量榜第 1",
         ["whitelist", "backcheck", "top10"], 0, 89.8, "2小时", "07:00-22:00", 4.6),
        # repair
        (11, "repair", "快修家电", "🔌", "大东区东边街", 4.6, 2300, "district", "家电维修口碑第 1",
         ["whitelist", "backcheck"], 0, 89, "次", "07:00-22:00", 1.8),
        (12, "repair", "沈城水电通", "🚿", "铁西区兴华街", 4.5, 1680, None, None,
         ["whitelist", "backcheck"], 0, 79, "次", "08:00-21:00", 2.6),
        # moving
        (21, "moving", "蚂蚁搬家", "🚚", "和平区太原街", 4.7, 5600, "city", "沈阳销量榜第 2",
         ["whitelist", "backcheck", "top10"], 0, 398, "车次", "06:00-22:00", 3.5),
        (22, "moving", "顺达搬运", "📦", "于洪区沈辽路", 4.4, 920, None, None,
         ["backcheck"], 0, 299, "车次", "07:00-20:00", 6.8),
        # nanny
        (31, "nanny", "阿姨来了", "👶", "沈河区中街", 4.8, 8800, "city", "沈阳口碑第 1",
         ["whitelist", "backcheck", "insurance"], 0, 8800, "月", "住家", 0),
        (32, "nanny", "好月嫂家政", "🤱", "皇姑区塔湾", 4.7, 3200, "district", "皇姑口碑第 1",
         ["whitelist", "insurance"], 0, 12800, "月", "住家", 0),
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
        (1102, 11, "管道疏通", "30分钟上门 · 不通不收费", "管道疏通",
         1, "", "次", 99, 220, "4.5折", "30分钟内", 0,
         5600, 4.7, ["30分钟上门", "不通不收费", "原厂配件"]),
        (1103, 11, "灯具电路", "断路/短路/跳闸 维修", "灯具电路",
         1, "", "次", 79, 180, "4.4折", "30分钟内", 0,
         3200, 4.5, ["30分钟上门", "持证电工", "原厂配件"]),
        (1104, 11, "门窗维修", "门窗变形/锁具损坏", "门窗维修",
         1, "", "次", 89, 200, "4.5折", "30分钟内", 0,
         2100, 4.4, ["30分钟上门", "品牌锁具", "90天质保"]),
        (1105, 11, "空调清洗", "挂机/柜机 拆装深度", "空调维修",
         1, "", "台", 89, 200, "4.5折", "今天 19:00", 0,
         9100, 4.6, ["拆装深度", "高温蒸汽", "30分钟上门"]),
        (1106, 11, "水管维修", "水管渗漏/爆裂 应急", "水管维修",
         1, "", "次", 99, 240, "4.1折", "30分钟内", 0,
         2800, 4.5, ["30分钟上门", "原厂配件", "持证水工"]),
        (1201, 12, "灯具电路", "跳闸/短路/灯具安装", "灯具电路",
         1, "", "次", 69, 150, "4.6折", "30分钟内", 0,
         1900, 4.4, ["持证电工", "30分钟上门"]),
        (1202, 12, "管道疏通", "厨房/卫生间 不通不收费", "管道疏通",
         1, "", "次", 89, 200, "4.5折", "30分钟内", 0,
         3400, 4.6, ["不通不收费", "30分钟上门"]),
        # moving
        (2101, 21, "居民搬家 同城", "金杯车 · 2名师傅", "居民搬家",
         1, "", "车次", 398, 680, "5.8折", "今天 19:00", 4,
         23000, 4.7, ["金杯车", "2名师傅"]),
        (2102, 21, "居民搬家 跨城", "厢式车 · 3名师傅", "长途搬家",
         1, "", "车次", 1200, 2200, "5.5折", "明天 09:00", 24,
         8200, 4.6, ["厢式车", "3名师傅", "300km+"]),
        (2103, 21, "钢琴搬运", "专业 · 三角钢琴可接", "钢琴搬运",
         1, "", "次", 800, 1500, "5.3折", "明天 14:00", 48,
         1200, 4.9, ["专业团队", "原厂包装", "保险"]),
        (2104, 21, "日式搬家", "全包服务 · 不动手", "日式搬家",
         1, "", "次", 1580, 2800, "5.6折", "明天 08:00", 48,
         3100, 4.8, ["全包服务", "不动手", "100% 还原"]),
        (2201, 22, "居民搬家 同城", "小面车 · 1名师傅", "居民搬家",
         1, "", "车次", 299, 580, "5.2折", "今天 20:00", 4,
         1800, 4.3, ["经济实惠", "小面车"]),
        # nanny
        (3101, 31, "住家育儿嫂", "3年以上经验 · 持证", "住家育儿嫂",
         24, "", "月", 8800, 12000, "7.3折", "5日内", 120,
         5200, 4.8, ["持证", "3年经验", "健康证"]),
        (3102, 31, "月嫂 26天", "5年以上经验 · 三甲护", "月嫂",
         24, "", "月", 12800, 18000, "7.1折", "30日内", 720,
         2100, 4.9, ["持证", "三甲护", "5年经验"]),
        (3103, 31, "钟点工 3小时", "做饭保洁 · 灵活预约", "钟点工",
         3, "", "次", 128, 220, "5.8折", "今天 18:00", 4,
         12800, 4.7, ["做饭保洁", "灵活预约", "3小时"]),
        (3201, 32, "月嫂 26天", "医护背景 · 催乳师", "月嫂",
         24, "", "月", 13800, 19800, "7.0折", "15日内", 720,
         860, 4.9, ["医护背景", "催乳师", "5年经验"]),
        (3202, 32, "住家育儿嫂", "0-3岁 · 辅食早教", "住家育儿嫂",
         24, "", "月", 7800, 11000, "7.1折", "7日内", 168,
         1420, 4.7, ["持证", "辅食早教"]),
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

    # 5. 服务者（覆盖 4 大类 · 每商家 2-4 人）
    print("👷 服务者...")
    # id, vendor_id, name, avatar, level, credit, tags, rating, completed, years, online, dist, certs, whitelist_id, status
    WORKERS = [
        # —— 保洁 ——
        (101, 1, "陈建国", "👨", "L4", 88, ["细致", "主动", "准时", "日常保洁"], 4.9, 2317, 5, 1, 2.4,
         ["id_card", "health", "skill", "insurance"], 2401, "active"),
        (102, 1, "杨秀芳", "👩", "L4", 92, ["周到", "经验丰富", "深度清洁"], 4.8, 1820, 6, 1, 3.1,
         ["id_card", "health", "skill", "insurance"], 2402, "active"),
        (103, 1, "李明", "👨", "L3", 78, ["稳重", "开荒保洁"], 4.6, 920, 3, 0, 4.2,
         ["id_card", "health", "skill"], None, "active"),
        (201, 2, "张美玲", "👩", "L5", 95, ["平台金牌", "极速上门", "日常保洁"], 4.9, 4102, 7, 1, 0.8,
         ["id_card", "health", "skill", "insurance"], 2403, "active"),
        (202, 2, "赵丽", "👩", "L4", 90, ["专业工具", "玻璃清洗"], 4.8, 2680, 5, 1, 1.2,
         ["id_card", "health", "skill", "insurance"], 2404, "active"),
        (203, 2, "王芳", "👩", "L3", 82, ["油烟机清洗", "耐心"], 4.7, 1540, 4, 0, 2.0,
         ["id_card", "health", "skill"], None, "active"),
        (301, 3, "刘桂兰", "👩", "L3", 76, ["本地团队", "收纳整理"], 4.5, 680, 3, 1, 3.8,
         ["id_card", "health", "skill"], None, "active"),
        (302, 3, "孙小红", "👩", "L2", 72, ["日常保洁", "热情"], 4.4, 420, 2, 0, 5.1,
         ["id_card", "health"], None, "active"),
        (401, 4, "马强", "👨", "L2", 70, ["经济实惠", "日常保洁"], 4.3, 560, 2, 1, 5.6,
         ["id_card", "health", "skill"], None, "active"),
        (501, 5, "周洁", "👩", "L5", 94, ["金牌服务者", "深度清洁", "团队长"], 4.9, 3560, 8, 1, 4.6,
         ["id_card", "health", "skill", "insurance"], 2405, "active"),
        (502, 5, "吴敏", "👩", "L4", 86, ["专业工具", "细致"], 4.7, 1980, 5, 1, 3.9,
         ["id_card", "health", "skill", "insurance"], 2406, "active"),
        (503, 5, "郑小燕", "👩", "L3", 80, ["开荒保洁", "主动"], 4.6, 1120, 4, 0, 6.2,
         ["id_card", "health", "skill"], None, "paused"),
        # —— 维修 ——
        (1101, 11, "赵德明", "👨", "L5", 91, ["持证电工", "30分钟响应", "灯具电路"], 4.8, 1680, 9, 1, 1.8,
         ["id_card", "health", "skill", "insurance"], 2411, "active"),
        (1102, 11, "孙海波", "👨", "L4", 85, ["管道疏通", "不通不收费"], 4.7, 1420, 6, 1, 2.2,
         ["id_card", "health", "skill", "insurance"], 2412, "active"),
        (1103, 11, "李建军", "👨", "L4", 83, ["家电维修", "空调清洗"], 4.6, 980, 5, 0, 3.0,
         ["id_card", "health", "skill"], None, "active"),
        (1104, 11, "陈师傅", "👨", "L3", 77, ["水管维修", "门窗维修"], 4.5, 640, 4, 0, 4.1,
         ["id_card", "health", "skill"], None, "active"),
        (1201, 12, "王电工", "👨", "L4", 84, ["持证电工", "跳闸检修"], 4.6, 820, 7, 1, 2.6,
         ["id_card", "health", "skill", "insurance"], 2413, "active"),
        (1202, 12, "张水工", "👨", "L3", 79, ["管道疏通", "应急维修"], 4.5, 560, 5, 0, 3.4,
         ["id_card", "health", "skill"], None, "active"),
        # —— 搬家 ——
        (2101, 21, "刘师傅", "👨", "L4", 87, ["居民搬家", "队长", "准时到达"], 4.8, 1260, 8, 1, 3.5,
         ["id_card", "health", "skill", "insurance"], 2421, "active"),
        (2102, 21, "张师傅", "👨", "L3", 81, ["长途搬家", "厢式车"], 4.6, 680, 5, 1, 4.8,
         ["id_card", "health", "skill"], None, "active"),
        (2103, 21, "王师傅", "👨", "L5", 93, ["钢琴搬运", "专业团队"], 4.9, 380, 10, 0, 5.2,
         ["id_card", "health", "skill", "insurance"], 2422, "active"),
        (2201, 22, "赵搬运", "👨", "L3", 74, ["居民搬家", "小面车"], 4.4, 420, 3, 1, 6.8,
         ["id_card", "health", "skill"], None, "active"),
        # —— 保姆 / 月嫂 ——
        (3101, 31, "王淑芬", "👩", "L6", 96, ["金牌月嫂", "医护背景", "26天套餐"], 4.9, 286, 12, 1, 0,
         ["id_card", "health", "skill", "insurance"], 2431, "active"),
        (3102, 31, "李春华", "👩", "L5", 92, ["住家育儿嫂", "辅食早教"], 4.8, 412, 8, 1, 0,
         ["id_card", "health", "skill", "insurance"], 2432, "active"),
        (3103, 31, "张桂英", "👩", "L5", 90, ["月嫂", "催乳师", "42天套餐"], 4.9, 198, 10, 0, 0,
         ["id_card", "health", "skill", "insurance"], 2433, "active"),
        (3104, 31, "陈阿姨", "👩", "L4", 85, ["钟点工", "做饭保洁"], 4.7, 860, 6, 1, 0,
         ["id_card", "health", "skill"], None, "active"),
        (3105, 31, "赵阿姨", "👩", "L4", 83, ["养老护理", "耐心细致"], 4.6, 320, 7, 0, 0,
         ["id_card", "health", "skill", "insurance"], 2434, "active"),
        (3201, 32, "刘月嫂", "👩", "L6", 94, ["尊享月嫂", "三甲经验"], 4.9, 156, 11, 1, 0,
         ["id_card", "health", "skill", "insurance"], 2435, "active"),
        (3202, 32, "周育儿嫂", "👩", "L5", 88, ["住家育儿嫂", "0-3岁"], 4.7, 240, 7, 0, 0,
         ["id_card", "health", "skill"], None, "active"),
    ]
    conn.execute("DELETE FROM jz_workers")  # noqa 上面已清
    for w in WORKERS:
        (wid, vid, name, avatar, level, credit, tags, rating, completed, years, online, dist,
         certs, whitelist_id, status) = w
        conn.execute(
            """INSERT INTO jz_workers(id, name, avatar, level, credit_score, tags,
               certs, is_whitelisted, rating, completed_orders, years_experience,
               online, distance_km, vendor_id, whitelist_id, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (wid, name, avatar, level, credit, jdump(tags), jdump(certs),
             1 if whitelist_id else 0, rating, completed, years, online, dist, vid,
             whitelist_id, status),
        )

    # 6. 示例订单（含服务者派单，便于演示工单闭环）
    print("📋 示例订单...")
    SAMPLE_ORDERS = [
        ("JZ20260710001", "cleaning", 1, 101, "春晖家政", "🏠", "日常保洁 2小时", "上门除尘 · 死无死角", 79.8,
         "和平区中华路 · 东博公寓 3-1202", "138****5678", "2026-07-11 14:00", 79.8, "dispatched", 101, NOW, NOW),
        ("JZ20260710002", "repair", 11, 1102, "快修家电", "🔌", "管道疏通", "30分钟上门 · 不通不收费", 99,
         "浑南区新市府 · 万科城 8-501", "139****1234", "2026-07-10 18:30", 99, "accepted", 1102, NOW, NOW),
        ("JZ20260710003", "moving", 21, 2101, "蚂蚁搬家", "🚚", "居民搬家 同城", "金杯车 · 2名师傅", 398,
         "沈河区青年大街 · 保租房试点小区", "137****8899", "2026-07-12 09:00", 398, "pending", None, NOW, NOW),
        ("JZ20260710004", "nanny", 31, 3102, "阿姨来了", "👶", "月嫂 26天", "5年以上经验 · 三甲护", 12800,
         "皇姑区北陵大街 · 华润置地", "136****4455", "2026-07-20 08:00", 12800, "serving", 3101, NOW, NOW),
    ]
    conn.execute("DELETE FROM jz_orders")
    for o in SAMPLE_ORDERS:
        (oid, otype, vid, pid, vname, vlogo, ptitle, psub, pprice, addr, phone, sched, fee, status, worker_id, created_at, updated_at) = o
        conn.execute(
            """INSERT INTO jz_orders(id, type, vendor_id, product_id, vendor_name, vendor_logo,
               product_title, product_sub, product_price, address, phone, scheduled_at, fee,
               status, worker_id, source, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jz', ?, ?)""",
            (oid, otype, vid, pid, vname, vlogo, ptitle, psub, pprice, addr, phone, sched, fee, status, worker_id, created_at, updated_at),
        )

    conn.commit()
    conn.close()

    # 统计
    print("\n✅ Seed 完成")
    print(f"  · 子类目: {len(CATS)}")
    print(f"  · 商家: {len(VENDORS)}")
    print(f"  · 商品: {len(PRODUCTS)}")
    print(f"  · 服务者: {len(WORKERS)}（在线 {sum(1 for w in WORKERS if w[10])} · 白名单 {sum(1 for w in WORKERS if w[13])}）")
    print(f"  · 示例订单: {len(SAMPLE_ORDERS)}")


if __name__ == "__main__":
    main()
