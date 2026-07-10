"""新居住频道 · SQLite 读写 + 导出 data.json"""
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(__file__).resolve().parent / "juzhu.db"
JSON_PATH = Path(__file__).resolve().parent / "data.json"

JZ_WORKERS = [
    {"name": "陈建国", "level": "L4", "tags": ["细致", "主动"]},
    {"name": "杨秀芳", "level": "L4", "tags": ["准时", "周到"]},
    {"name": "王志强", "level": "L3", "tags": ["专业", "稳重"]},
    {"name": "刘海燕", "level": "L3", "tags": ["热情", "耐心"]},
]

JZ_CATEGORY_LABELS = {
    "cleaning": "保洁",
    "repair": "维修",
    "moving": "搬家",
    "nanny": "保姆",
}

JZ_CATEGORY_ICONS = {
    "cleaning": "🧹",
    "repair": "🔧",
    "moving": "📦",
    "nanny": "👶",
}

JZ_STATUS_ORDER = ["pending", "dispatched", "accepted", "serving", "done", "rated"]

JZ_DEFAULT_CATEGORIES = [
    ("cleaning", "保洁", "🧹", 1, "日常清洁、深度清洁、家电清洗"),
    ("repair", "维修", "🔧", 2, "家电维修、管道疏通、门窗灯具"),
    ("moving", "搬家", "📦", 3, "居民搬家、长途搬家、企业搬迁"),
    ("nanny", "保姆", "👶", 4, "住家保姆、育儿嫂、月嫂、护理"),
]

JZ_DEFAULT_SKUS = [
    {
        "id": 1, "category_id": "cleaning", "name": "日常保洁 · 2小时", "slug": "cleaning-daily-2h",
        "spec": "1人上门 · 全屋除尘整理", "price_from": 128, "price_unit": "/次", "duration_min": 120,
        "tags": ["热门", "最快2小时上门"], "badges": ["神券", "全程保"], "sales_text": "已订 5.3万+",
        "rating_score": 4.8, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["客厅卧室除尘", "地面清洁", "台面整理", "基础厨卫擦拭"],
        "service_flow": ["确认地址与面积", "匹配保洁员", "按约上门", "完工验收"],
        "service_notice": ["服务前2小时可免费取消", "标准耗材已含", "超时按30分钟补差价"], "sort_order": 1,
    },
    {
        "id": 2, "category_id": "cleaning", "name": "深度清洁 · 4小时", "slug": "deep-clean-4h",
        "spec": "3人团队 · 含厨卫去污", "price_from": 268, "price_unit": "起", "duration_min": 240,
        "tags": ["爆款", "死角焕新"], "badges": ["团购爆品", "立减10"], "sales_text": "已订 1.6万+",
        "rating_score": 4.9, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["厨房油污处理", "卫生间除垢", "踢脚线与缝隙除尘", "家具表面深擦"],
        "service_flow": ["客服确认房型", "分配L3保洁员", "上门深度清洁", "拍照回传与验收"],
        "service_notice": ["50㎡以内标准价", "特殊药剂需二次确认", "完工后可申请复洁"], "sort_order": 2,
    },
    {
        "id": 3, "category_id": "cleaning", "name": "空调清洗 · 挂机", "slug": "ac-clean-wall",
        "spec": "高温蒸汽 · 拆装深度", "price_from": 89, "price_unit": "/台", "duration_min": 90,
        "tags": ["当天上门", "除菌除味"], "badges": ["会员价", "平台保障"], "sales_text": "近期好评 1000+",
        "rating_score": 4.7, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["滤网拆洗", "蒸汽除菌", "出风口清洁", "基础功能检测"],
        "service_flow": ["确认机型", "预约时段", "工程师上门", "清洗验收"],
        "service_notice": ["柜机另计", "高空外机不含", "服务后24小时内可追评"], "sort_order": 3,
    },
    {
        "id": 4, "category_id": "repair", "name": "管道疏通 · 当天", "slug": "pipe-unclog-fast",
        "spec": "30分钟响应 · 不通不收费", "price_from": 99, "price_unit": "起", "duration_min": 60,
        "tags": ["应急维修", "最快30分钟"], "badges": ["应急", "全天候"], "sales_text": "年售 2.4万+",
        "rating_score": 4.8, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["厨房下水疏通", "卫生间地漏疏通", "基础堵点判断", "作业区清洁恢复"],
        "service_flow": ["提交故障", "派发就近技师", "上门检测疏通", "完工确认"],
        "service_notice": ["超技能范围可重派", "配件费另计", "30天同故障质保"], "sort_order": 1,
    },
    {
        "id": 5, "category_id": "repair", "name": "灯具安装 · 吸顶灯", "slug": "light-install-ceiling",
        "spec": "电工持证 · 高空作业规范", "price_from": 59, "price_unit": "/盏", "duration_min": 45,
        "tags": ["持证上岗"], "badges": ["全程保"], "sales_text": "年售 6000+",
        "rating_score": 4.6, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["拆旧装新", "电路检测", "基础调试", "现场清理"],
        "service_flow": ["确认灯型", "预约上门", "安装调试", "拍照回传"],
        "service_notice": ["复杂吊灯另报价", "不含灯具材料", "电路改造需二次确认"], "sort_order": 2,
    },
    {
        "id": 6, "category_id": "moving", "name": "居民搬家 · 同城", "slug": "moving-city-standard",
        "spec": "金杯车 · 2名师傅", "price_from": 398, "price_unit": "起", "duration_min": 180,
        "tags": ["同城精选", "可加购打包"], "badges": ["省心搬", "平台保障"], "sales_text": "已搬 7800+",
        "rating_score": 4.7, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["基础搬运", "车辆运输", "大件保护包裹", "楼道清运"],
        "service_flow": ["提交清单", "客服估价", "确认车辆与人员", "按时搬运"],
        "service_notice": ["楼层费按现场核算", "超距单独计费", "贵重物品建议保价"], "sort_order": 1,
    },
    {
        "id": 7, "category_id": "moving", "name": "日式搬家 · 全包", "slug": "moving-japanese-full",
        "spec": "打包收纳 + 还原归位", "price_from": 1680, "price_unit": "起", "duration_min": 480,
        "tags": ["高端服务", "全程无忧"], "badges": ["PRO"], "sales_text": "企业家庭双适用",
        "rating_score": 4.9, "worker_min_level": "L4", "cover_image": None,
        "gallery": [], "includes": ["分类打包", "上门收纳", "新居归位", "垃圾清运"],
        "service_flow": ["顾问勘察", "确认方案", "分工搬运", "到家复原"],
        "service_notice": ["需提前1天预约", "贵重柜体单独报价", "默认含基础耗材"], "sort_order": 2,
    },
    {
        "id": 8, "category_id": "nanny", "name": "钟点工 · 3小时", "slug": "nanny-hourly-3h",
        "spec": "做饭保洁 · 灵活预约", "price_from": 128, "price_unit": "/次", "duration_min": 180,
        "tags": ["灵活用工", "做饭保洁"], "badges": ["热门"], "sales_text": "年售 1.2万+",
        "rating_score": 4.8, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["一餐制作", "基础保洁", "衣物整理", "简单采购代办"],
        "service_flow": ["选时段", "匹配阿姨", "上门服务", "结束评价"],
        "service_notice": ["食材默认用户提供", "需提前确认菜谱", "节假日价格浮动"], "sort_order": 1,
    },
    {
        "id": 9, "category_id": "nanny", "name": "育儿嫂 · 住家", "slug": "nanny-livein-babycare",
        "spec": "3年以上经验 · 持证", "price_from": 8800, "price_unit": "/月", "duration_min": 43200,
        "tags": ["住家服务", "持证育儿"], "badges": ["严选"], "sales_text": "月签 300+",
        "rating_score": 4.9, "worker_min_level": "L4", "cover_image": None,
        "gallery": [], "includes": ["婴幼儿照护", "喂养作息", "辅食制作", "成长记录"],
        "service_flow": ["顾问面谈", "筛选候选人", "试工确认", "月度服务"],
        "service_notice": ["支持视频面试", "可加购体检背调", "签约后7天可换人"], "sort_order": 2,
    },
]


def connect():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    ensure_schema(conn)
    return conn


def ensure_schema(conn):
    project_cols = {r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
    if project_cols:
        migrations = [
            ("rating_status", "ALTER TABLE projects ADD COLUMN rating_status TEXT NOT NULL DEFAULT 'draft'"),
            ("rating", "ALTER TABLE projects ADD COLUMN rating TEXT"),
            ("rating_submitted_at", "ALTER TABLE projects ADD COLUMN rating_submitted_at TEXT"),
            ("rating_reviewed_at", "ALTER TABLE projects ADD COLUMN rating_reviewed_at TEXT"),
            ("rating_note", "ALTER TABLE projects ADD COLUMN rating_note TEXT"),
        ]
        for col, sql in migrations:
            if col not in project_cols:
                conn.execute(sql)
    city_cols = {r[1] for r in conn.execute("PRAGMA table_info(cities)").fetchall()}
    if city_cols and "booking_phone" not in city_cols:
        conn.execute("ALTER TABLE cities ADD COLUMN booking_phone TEXT")
    if city_cols and "hero_bg_image" not in city_cols:
        conn.execute("ALTER TABLE cities ADD COLUMN hero_bg_image TEXT")
    district_cols = {r[1] for r in conn.execute("PRAGMA table_info(districts)").fetchall()}
    if district_cols and "managed_unit_count" not in district_cols:
        conn.execute("ALTER TABLE districts ADD COLUMN managed_unit_count INTEGER")
    if project_cols and "managed_unit_count" not in project_cols:
        conn.execute("ALTER TABLE projects ADD COLUMN managed_unit_count INTEGER")
        conn.execute(
            """UPDATE projects SET managed_unit_count=unit_count
               WHERE channel='bzf' AND managed_unit_count IS NULL"""
        )
    unit_cols = {r[1] for r in conn.execute("PRAGMA table_info(units)").fetchall()}
    if unit_cols:
        unit_migrations = [
            ("unit_spec", "ALTER TABLE units ADD COLUMN unit_spec TEXT"),
            ("promo_price", "ALTER TABLE units ADD COLUMN promo_price INTEGER"),
            ("amenities", "ALTER TABLE units ADD COLUMN amenities TEXT"),
            ("keeper", "ALTER TABLE units ADD COLUMN keeper TEXT"),
            ("rent_detail", "ALTER TABLE units ADD COLUMN rent_detail TEXT"),
        ]
        for col, sql in unit_migrations:
            if col not in unit_cols:
                conn.execute(sql)
        ensure_unit_amenities(conn)
        ensure_unit_tags(conn)
    ensure_channels(conn)
    ensure_jiazheng_schema(conn)
    ensure_jz_vendor_schema(conn)
    conn.commit()


def ensure_jz_vendor_schema(conn):
    """P/B 管理台：商家/产品/服务者/子类目（与 C 端四大类 jz_categories 分离）。"""
    schema_path = Path(__file__).resolve().parent / "jiazheng_schema.sql"
    if schema_path.exists():
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    product_cols = {r[1] for r in conn.execute("PRAGMA table_info(jz_products)").fetchall()}
    if product_cols and "channel_sku_id" not in product_cols:
        conn.execute("ALTER TABLE jz_products ADD COLUMN channel_sku_id INTEGER")


def ensure_channels(conn):
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "channels" not in tables:
        conn.executescript(
            """
            CREATE TABLE channels (
              id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              sort_order INTEGER NOT NULL DEFAULT 0,
              enabled INTEGER NOT NULL DEFAULT 1,
              note TEXT
            );
            INSERT INTO channels(id, label, sort_order, enabled) VALUES ('bzf', '保租房', 1, 1);
            INSERT INTO channels(id, label, sort_order, enabled) VALUES ('trade', '卖旧买新', 2, 1);
            """
        )
    else:
        defaults = [("bzf", "保租房", 1), ("trade", "卖旧买新", 2), ("jiazheng", "家政", 3)]
        for cid, label, order in defaults:
            if not conn.execute("SELECT 1 FROM channels WHERE id=?", (cid,)).fetchone():
                conn.execute(
                    "INSERT INTO channels(id, label, sort_order, enabled) VALUES (?, ?, ?, 1)",
                    (cid, label, order),
                )


def ensure_jiazheng_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS jz_categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          icon TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          note TEXT
        );
        CREATE TABLE IF NOT EXISTS jz_skus (
          id INTEGER PRIMARY KEY,
          category_id TEXT NOT NULL REFERENCES jz_categories(id),
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          spec TEXT,
          price_from INTEGER,
          price_unit TEXT,
          duration_min INTEGER,
          tags TEXT,
          badges TEXT,
          sales_text TEXT,
          rating_score REAL,
          worker_min_level TEXT,
          cover_image TEXT,
          gallery TEXT,
          includes TEXT,
          service_flow TEXT,
          service_notice TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS jz_orders (
          id TEXT PRIMARY KEY,
          sku_id INTEGER REFERENCES jz_skus(id),
          category_id TEXT NOT NULL REFERENCES jz_categories(id),
          type TEXT NOT NULL,
          house TEXT NOT NULL,
          phone TEXT NOT NULL,
          expect_time TEXT NOT NULL,
          desc TEXT,
          fee INTEGER NOT NULL,
          pay_status TEXT NOT NULL DEFAULT 'unpaid',
          pay_method TEXT,
          pay_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          worker_json TEXT,
          rating_json TEXT,
          source TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          log_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_jz_skus_category ON jz_skus(category_id, enabled, sort_order);
        CREATE INDEX IF NOT EXISTS idx_jz_orders_status ON jz_orders(status, pay_status, created_at);
        """
    )
    for cid, name, icon, order, note in JZ_DEFAULT_CATEGORIES:
        conn.execute(
            """INSERT INTO jz_categories(id, name, icon, sort_order, enabled, note)
               VALUES (?, ?, ?, ?, 1, ?)
               ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name,
                 icon=excluded.icon,
                 sort_order=excluded.sort_order,
                 note=excluded.note""",
            (cid, name, icon, order, note),
        )
    for sku in JZ_DEFAULT_SKUS:
        conn.execute(
            """INSERT INTO jz_skus(
                 id, category_id, name, slug, spec, price_from, price_unit, duration_min,
                 tags, badges, sales_text, rating_score, worker_min_level, cover_image,
                 gallery, includes, service_flow, service_notice, sort_order, enabled
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
               ON CONFLICT(id) DO UPDATE SET
                 category_id=excluded.category_id,
                 name=excluded.name,
                 slug=excluded.slug,
                 spec=excluded.spec,
                 price_from=excluded.price_from,
                 price_unit=excluded.price_unit,
                 duration_min=excluded.duration_min,
                 tags=excluded.tags,
                 badges=excluded.badges,
                 sales_text=excluded.sales_text,
                 rating_score=excluded.rating_score,
                 worker_min_level=excluded.worker_min_level,
                 cover_image=excluded.cover_image,
                 gallery=excluded.gallery,
                 includes=excluded.includes,
                 service_flow=excluded.service_flow,
                 service_notice=excluded.service_notice,
                 sort_order=excluded.sort_order"""
            ,
            (
                sku["id"], sku["category_id"], sku["name"], sku["slug"], sku["spec"],
                sku["price_from"], sku["price_unit"], sku["duration_min"],
                json.dumps(sku["tags"], ensure_ascii=False),
                json.dumps(sku["badges"], ensure_ascii=False),
                sku["sales_text"], sku["rating_score"], sku["worker_min_level"], sku["cover_image"],
                json.dumps(sku["gallery"], ensure_ascii=False),
                json.dumps(sku["includes"], ensure_ascii=False),
                json.dumps(sku["service_flow"], ensure_ascii=False),
                json.dumps(sku["service_notice"], ensure_ascii=False),
                sku["sort_order"],
            ),
        )


DEFAULT_AMENITY_IDS = [
    "ac", "washer", "fridge", "heater", "lock", "wifi", "tv", "hood", "microwave", "induction"
]


def default_amenities_db():
    return json.dumps(DEFAULT_AMENITY_IDS, ensure_ascii=False)


def ensure_unit_amenities(conn):
    """空设施列表的房源默认勾选全部设施"""
    default = default_amenities_db()
    conn.execute(
        """UPDATE units SET amenities=?
           WHERE amenities IS NULL OR TRIM(amenities)='' OR amenities='[]'""",
        (default,),
    )


def _tags_list(raw):
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if isinstance(raw, str):
        try:
            val = json.loads(raw)
            return _tags_list(val)
        except json.JSONDecodeError:
            return [raw.strip()] if raw.strip() else []
    return []


def build_default_unit_tags(unit, project):
    """按项目/户型生成默认房源标签（保租房演示）"""
    tags = ["政府保租房"]
    pname = (project.get("name") or project.get("project_name") or "").strip()
    addr = ((project.get("address") or "") + " " + pname).strip()

    for t in _tags_list(project.get("project_tags") or project.get("tags")):
        if t not in tags:
            tags.append(t)

    brand_rules = [
        ("建融", "建融家园"), ("CCB", "建融家园"), ("逸居", "逸居"),
        ("人才", "人才公寓"), ("龙湖", "龙湖"), ("中海", "中海"),
        ("华润", "华润"), ("惠民", "惠民保租"), ("地铁", "地铁上盖"),
    ]
    for key, label in brand_rules:
        if key in pname and label not in tags:
            tags.append(label)
            break

    subway_keys = ("地铁", "青年大街", "中街", "奥体", "北站", "沈阳站", "新市府", "工业展览", "怀远门", "铁西广场")
    if any(k in addr for k in subway_keys) and "近地铁" not in tags:
        tags.append("近地铁")

    layout = unit.get("layout_label")
    if layout and layout not in tags:
        tags.append(layout)
    else:
        area = unit.get("area_sqm")
        if area is not None:
            if area <= 35 and "精致小户型" not in tags:
                tags.append("精致小户型")
            elif area >= 80 and "宽敞大户型" not in tags:
                tags.append("宽敞大户型")

    for t in ("押一付一", "租金受控", "拎包入住"):
        if t not in tags:
            tags.append(t)

    rating = parse_rating_value(project.get("rating"))
    if project.get("rating_status") == "passed" and rating and rating.get("stars"):
        star_tag = f"好房子{rating['stars']}星"
        if star_tag not in tags:
            tags.append(star_tag)
    elif project.get("rating_status") in ("passed", "pending") and rating and rating.get("stars", 0) >= 4:
        star_tag = f"好房子{rating['stars']}星"
        if star_tag not in tags:
            tags.append(star_tag)

    if unit.get("promo_price") and "首月特惠" not in tags:
        tags.append("首月特惠")

    seen = set()
    out = []
    for t in tags:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out[:8]


def _needs_tag_refresh(existing, project_row):
    if not existing:
        return True
    if len(existing) < 4:
        return True
    pname = (project_row.get("project_name") or project_row.get("name") or "")
    if "建融" in pname and "建融家园" not in existing:
        return True
    if "逸居" in pname and not any("逸居" in t for t in existing):
        return True
    if "人才" in pname and "人才公寓" not in existing:
        return True
    return False


def ensure_unit_tags(conn):
    """保租房房源写入/刷新默认标签"""
    rows = conn.execute(
        """SELECT u.id, u.layout_label, u.area_sqm, u.promo_price, u.tags,
                  p.name AS project_name, p.address, p.tags AS project_tags,
                  p.channel, p.rating, p.rating_status
           FROM units u JOIN projects p ON p.id=u.project_id"""
    ).fetchall()
    for row in rows:
        d = dict(row)
        existing = _tags_list(d.get("tags"))
        if d.get("channel") == "trade":
            if existing:
                continue
            tags = ["卖旧买新", "以旧换新", "试点房源"]
        else:
            if not _needs_tag_refresh(existing, d):
                continue
            tags = build_default_unit_tags(d, d)
        conn.execute(
            "UPDATE units SET tags=? WHERE id=?",
            (json.dumps(tags, ensure_ascii=False), d["id"]),
        )


def rating_code(project_id):
    return "SY-BZF-" + str(project_id).zfill(5)


STAR_LABELS = ["", "基础型", "达标型", "优质型", "精品型", "示范型"]


def parse_rating_value(raw):
    if raw is None:
        return None
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return None


def rating_to_db(rating):
    if rating is None:
        return None
    if isinstance(rating, str):
        return rating
    return json.dumps(rating, ensure_ascii=False)


def summarize_rating(dims):
    vals = [dims.get(k) for k in ("comfort", "green", "tech", "safety") if dims.get(k) is not None]
    if not vals:
        return {"stars": 3, "star_label": "达标型", "score": 60}
    avg = sum(float(v) for v in vals) / len(vals)
    stars = min(5, max(1, round(avg)))
    return {
        "stars": stars,
        "star_label": STAR_LABELS[stars],
        "score": int(round(avg / 5 * 100)),
    }


def normalize_project_row(d):
    if not d:
        return d
    d = row_to_dict(d) if not isinstance(d, dict) else dict(d)
    d["rating"] = parse_rating_value(d.get("rating"))
    d.setdefault("rating_status", "draft")
    return d


def row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    if d.get("tags") and isinstance(d["tags"], str):
        try:
            d["tags"] = json.loads(d["tags"])
        except json.JSONDecodeError:
            d["tags"] = [d["tags"]] if d["tags"] else []
    return d


def rows_to_list(rows):
    return [row_to_dict(r) for r in rows]


def parse_json_field(val, default=None):
    if default is None:
        default = None
    if val is None or val == "":
        return default
    if isinstance(val, (dict, list)):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except json.JSONDecodeError:
            return default
    return default


def normalize_unit_row(d):
    if not d:
        return d
    d = row_to_dict(d) if not isinstance(d, dict) else dict(d)
    d["amenities"] = parse_json_field(d.get("amenities"), []) or []
    if not d["amenities"]:
        d["amenities"] = DEFAULT_AMENITY_IDS.copy()
    d["keeper"] = parse_json_field(d.get("keeper"), None)
    d["rent_detail"] = parse_json_field(d.get("rent_detail"), None)
    return d


def parse_tags(items, json_keys=None):
    json_keys = json_keys or ()
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
        for key in json_keys:
            default = DEFAULT_AMENITY_IDS.copy() if key == "amenities" else None
            r[key] = parse_json_field(r.get(key), default if key == "amenities" else None)
            if key == "amenities" and not r[key]:
                r[key] = DEFAULT_AMENITY_IDS.copy()
    return items


def normalize_jz_sku_row(d):
    if not d:
        return d
    d = row_to_dict(d) if not isinstance(d, dict) else dict(d)
    for key in ("tags", "badges", "gallery", "includes", "service_flow", "service_notice"):
        d[key] = parse_json_field(d.get(key), []) or []
    return d


def normalize_jz_order_row(d):
    if not d:
        return d
    d = row_to_dict(d) if not isinstance(d, dict) else dict(d)
    for key in ("worker_json", "rating_json", "log_json"):
        d[key] = parse_json_field(d.get(key), [] if key == "log_json" else None)
    return d


def jz_order_view(row, sku_name=None):
    """API / 前端统一视图（前后端分离 JSON 契约）。"""
    d = normalize_jz_order_row(row)
    if not d:
        return d
    cat_id = d.get("category_id") or ""
    worker = d.get("worker_json")
    rating = d.get("rating_json")
    name = sku_name or d.get("sku_name") or d.get("type") or "家政服务"
    created = d.get("created_at") or ""
    created_label = created.replace("T", " ").replace("Z", "")[:16] if created else ""
    return {
        "id": d["id"],
        "sku_id": d.get("sku_id"),
        "category_id": cat_id,
        "category": name,
        "type": JZ_CATEGORY_LABELS.get(cat_id, d.get("type") or "家政"),
        "icon": JZ_CATEGORY_ICONS.get(cat_id, "✨"),
        "house": d.get("house") or "",
        "phone": d.get("phone") or "",
        "expect_time": d.get("expect_time") or "",
        "expectTime": d.get("expect_time") or "",
        "desc": d.get("desc") or "",
        "fee": int(d.get("fee") or 0),
        "pay_status": d.get("pay_status") or "unpaid",
        "pay_method": d.get("pay_method"),
        "pay_at": d.get("pay_at"),
        "status": d.get("status") or "pending",
        "worker": worker,
        "rating": rating,
        "source": d.get("source") or "新居住频道",
        "created_at": created,
        "createdAt": created,
        "createdLabel": created_label,
        "updated_at": d.get("updated_at"),
        "log": d.get("log_json") or [],
        "live": True,
    }


def tags_to_db(tags):
    if tags is None:
        return json.dumps([], ensure_ascii=False)
    if isinstance(tags, str):
        tags = [x.strip() for x in tags.split(",") if x.strip()]
    return json.dumps(list(tags), ensure_ascii=False)


def json_to_db(val):
    if val is None:
        return None
    if isinstance(val, str):
        return val
    return json.dumps(val, ensure_ascii=False)


def sync_district_stats(conn, district_id=None):
    where = "WHERE id=?" if district_id else ""
    params = (district_id,) if district_id else ()
    districts = conn.execute(f"SELECT id FROM districts {where}", params).fetchall()
    for (did,) in districts:
        pc = conn.execute(
            "SELECT COUNT(*) FROM projects WHERE district_id=? AND channel='bzf'", (did,)
        ).fetchone()[0]
        uc = conn.execute(
            """SELECT COUNT(*) FROM units u
               JOIN projects p ON p.id=u.project_id
               WHERE p.district_id=? AND p.channel='bzf'""",
            (did,),
        ).fetchone()[0]
        avg = conn.execute(
            """SELECT AVG(u.rent_monthly) FROM units u
               JOIN projects p ON p.id=u.project_id
               WHERE p.district_id=? AND p.channel='bzf' AND u.rent_monthly IS NOT NULL""",
            (did,),
        ).fetchone()[0]
        managed = conn.execute(
            """SELECT COALESCE(SUM(COALESCE(managed_unit_count, unit_count)), 0)
               FROM projects WHERE district_id=? AND channel='bzf'""",
            (did,),
        ).fetchone()[0]
        conn.execute(
            """UPDATE districts SET project_count=?, unit_count=?, vacant_count=?,
               managed_unit_count=?, avg_price=?, has_projects=? WHERE id=?""",
            (pc, uc, uc, int(managed), int(avg) if avg else None, 1 if pc else 0, did),
        )
    conn.commit()


def sync_unit_cover(conn, unit_id):
    row = conn.execute(
        """SELECT file_path FROM photos WHERE entity_type='unit' AND entity_id=?
           ORDER BY is_cover DESC, sort_order, id LIMIT 1""",
        (unit_id,),
    ).fetchone()
    cover = row[0] if row else None
    conn.execute("UPDATE units SET cover_image=? WHERE id=?", (cover, unit_id))


def sync_project_unit_count(conn, project_id):
    n = conn.execute("SELECT COUNT(*) FROM units WHERE project_id=?", (project_id,)).fetchone()[0]
    rents = conn.execute(
        "SELECT MIN(rent_monthly), MIN(price_total) FROM units WHERE project_id=?",
        (project_id,),
    ).fetchone()
    price_from = rents[0] or rents[1]
    conn.execute(
        "UPDATE projects SET unit_count=?, price_from=COALESCE(?, price_from) WHERE id=?",
        (n, price_from, project_id),
    )
    proj = conn.execute("SELECT district_id FROM projects WHERE id=?", (project_id,)).fetchone()
    if proj and proj[0]:
        sync_district_stats(conn, proj[0])


def export_json(conn=None):
    close = False
    if conn is None:
        conn = connect()
        close = True
    try:
        def rows(q, params=()):
            return [dict(r) for r in conn.execute(q, params).fetchall()]

        data = {
            "city": rows("SELECT * FROM cities")[0],
            "channels": rows("SELECT * FROM channels ORDER BY sort_order, id"),
            "stats": {
                "district_count": conn.execute("SELECT COUNT(*) FROM districts").fetchone()[0],
                "project_count_bzf": conn.execute(
                    "SELECT COUNT(*) FROM projects WHERE channel='bzf'"
                ).fetchone()[0],
                "project_count_trade": conn.execute(
                    "SELECT COUNT(*) FROM projects WHERE channel='trade'"
                ).fetchone()[0],
                "unit_count": conn.execute(
                    "SELECT COALESCE(SUM(managed_unit_count), 0) FROM projects WHERE channel='bzf'"
                ).fetchone()[0],
            },
            "districts": parse_tags(rows("SELECT * FROM districts ORDER BY sort_order")),
            "projects": [normalize_project_row(p) for p in parse_tags(rows("SELECT * FROM projects ORDER BY channel, sort_order"))],
            "units": parse_tags(
                rows("SELECT * FROM units ORDER BY project_id, sort_order"),
                json_keys=("amenities", "keeper", "rent_detail"),
            ),
            "photos": rows(
                "SELECT * FROM photos ORDER BY entity_type, entity_id, sort_order"
            ),
            "jiazheng_categories": rows("SELECT * FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id"),
            "jiazheng_skus": [
                normalize_jz_sku_row(r)
                for r in rows("SELECT * FROM jz_skus WHERE enabled=1 ORDER BY category_id, sort_order, id")
            ],
        }
        JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data
    finally:
        if close:
            conn.close()
