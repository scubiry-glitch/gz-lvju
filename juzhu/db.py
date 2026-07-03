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
    cols = {r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
    migrations = [
        ("rating_status", "ALTER TABLE projects ADD COLUMN rating_status TEXT NOT NULL DEFAULT 'draft'"),
        ("rating", "ALTER TABLE projects ADD COLUMN rating TEXT"),
        ("rating_submitted_at", "ALTER TABLE projects ADD COLUMN rating_submitted_at TEXT"),
        ("rating_reviewed_at", "ALTER TABLE projects ADD COLUMN rating_reviewed_at TEXT"),
        ("rating_note", "ALTER TABLE projects ADD COLUMN rating_note TEXT"),
    ]
    for col, sql in migrations:
        if col not in cols:
            conn.execute(sql)
    conn.commit()


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


def tags_to_db(tags):
    if tags is None:
        return json.dumps([], ensure_ascii=False)
    if isinstance(tags, str):
        tags = [x.strip() for x in tags.split(",") if x.strip()]
    return json.dumps(list(tags), ensure_ascii=False)


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
        conn.execute(
            """UPDATE districts SET project_count=?, unit_count=?, vacant_count=?,
               avg_price=?, has_projects=? WHERE id=?""",
            (pc, uc, uc, int(avg) if avg else None, 1 if pc else 0, did),
        )
    conn.commit()


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
            "units": parse_tags(rows("SELECT * FROM units ORDER BY project_id, sort_order")),
            "photos": rows(
                "SELECT * FROM photos ORDER BY entity_type, entity_id, sort_order"
            ),
        }
        JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data
    finally:
        if close:
            conn.close()
