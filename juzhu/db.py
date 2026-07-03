"""新居住频道 · SQLite 读写 + 导出 data.json"""
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(__file__).resolve().parent / "juzhu.db"
JSON_PATH = Path(__file__).resolve().parent / "data.json"


def connect():
    conn = sqlite3.connect(DB_PATH)
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
    conn.commit()


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
        defaults = [("bzf", "保租房", 1), ("trade", "卖旧买新", 2)]
        for cid, label, order in defaults:
            if not conn.execute("SELECT 1 FROM channels WHERE id=?", (cid,)).fetchone():
                conn.execute(
                    "INSERT INTO channels(id, label, sort_order, enabled) VALUES (?, ?, ?, 1)",
                    (cid, label, order),
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
                "unit_count": conn.execute("SELECT COUNT(*) FROM units").fetchone()[0],
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
        }
        JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data
    finally:
        if close:
            conn.close()
