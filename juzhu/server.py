#!/usr/bin/env python3
"""新居住频道 API + 静态文件 + 编辑后台接口。启动：python3 juzhu/server.py"""
import json
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from datetime import datetime, timezone

from db import (  # noqa: E402
    connect,
    export_json,
    normalize_project_row,
    rating_code,
    rating_to_db,
    row_to_dict,
    rows_to_list,
    summarize_rating,
    sync_district_stats,
    sync_project_unit_count,
    tags_to_db,
)

ADMIN_PREFIX = "/api/juzhu/admin"


def slugify(name):
    name = re.sub(r"[（(].*?[）)]", "", name or "").strip()
    return re.sub(r"\s+", "-", name) or "item"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        p = urlparse(self.path)
        if p.path.startswith("/api/juzhu"):
            return self._route(p, "GET")
        return super().do_GET()

    def do_POST(self):
        p = urlparse(self.path)
        if p.path.startswith("/api/juzhu"):
            return self._route(p, "POST")
        self._json({"error": "not found"}, 404)

    def do_PUT(self):
        p = urlparse(self.path)
        if p.path.startswith(ADMIN_PREFIX):
            return self._route(p, "PUT")
        self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        p = urlparse(self.path)
        if p.path.startswith(ADMIN_PREFIX):
            return self._route(p, "DELETE")
        self._json({"error": "not found"}, 404)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def _route(self, p, method):
        path = p.path.rstrip("/")
        qs = parse_qs(p.query)

        if method == "GET" and not path.startswith(ADMIN_PREFIX):
            return self._public_get(path, qs)

        if path == f"{ADMIN_PREFIX}/districts" and method == "GET":
            conn = connect()
            data = rows_to_list(conn.execute("SELECT * FROM districts ORDER BY sort_order"))
            conn.close()
            return self._json(data)

        if path == f"{ADMIN_PREFIX}/projects" and method == "GET":
            conn = connect()
            sql = """SELECT p.*, d.name AS district_name FROM projects p
                     LEFT JOIN districts d ON d.id=p.district_id WHERE 1=1"""
            params = []
            if qs.get("channel"):
                sql += " AND p.channel=?"
                params.append(qs["channel"][0])
            if qs.get("district_id"):
                sql += " AND p.district_id=?"
                params.append(int(qs["district_id"][0]))
            if qs.get("q"):
                sql += " AND p.name LIKE ?"
                params.append("%" + qs["q"][0] + "%")
            sql += " ORDER BY p.channel, p.sort_order, p.id"
            data = rows_to_list(conn.execute(sql, params))
            conn.close()
            return self._json(data)

        if path == f"{ADMIN_PREFIX}/projects" and method == "POST":
            return self._create_project()

        if path == f"{ADMIN_PREFIX}/export" and method == "POST":
            conn = connect()
            sync_district_stats(conn)
            data = export_json(conn)
            conn.close()
            return self._json({"ok": True, "stats": data["stats"]})

        m = re.match(rf"^{ADMIN_PREFIX}/projects/(\d+)/rating/submit$", path)
        if m and method == "POST":
            return self._submit_rating(int(m.group(1)))

        m = re.match(rf"^{ADMIN_PREFIX}/ratings/([^/]+)/review$", path)
        if m and method == "POST":
            return self._review_rating(m.group(1))

        m = re.match(rf"^{ADMIN_PREFIX}/projects/(\d+)$", path)
        if m:
            pid = int(m.group(1))
            if method == "GET":
                return self._get_project(pid)
            if method == "PUT":
                return self._update_project(pid)
            if method == "DELETE":
                return self._delete_project(pid)

        m = re.match(rf"^{ADMIN_PREFIX}/projects/(\d+)/units$", path)
        if m and method == "POST":
            return self._create_unit(int(m.group(1)))

        m = re.match(rf"^{ADMIN_PREFIX}/units/(\d+)$", path)
        if m:
            uid = int(m.group(1))
            if method == "PUT":
                return self._update_unit(uid)
            if method == "DELETE":
                return self._delete_unit(uid)

        return self._json({"error": "unknown route", "path": path}, 404)

    def _public_get(self, path, qs):
        conn = connect()
        if path == "/api/juzhu/stats":
            d = conn.execute("SELECT COUNT(*) c FROM districts").fetchone()[0]
            pb = conn.execute("SELECT COUNT(*) c FROM projects WHERE channel='bzf'").fetchone()[0]
            pt = conn.execute("SELECT COUNT(*) c FROM projects WHERE channel='trade'").fetchone()[0]
            u = conn.execute("SELECT COUNT(*) c FROM units").fetchone()[0]
            conn.close()
            return self._json({"districts": d, "projects_bzf": pb, "projects_trade": pt, "units": u})

        if path == "/api/juzhu/districts":
            data = rows_to_list(conn.execute("SELECT * FROM districts ORDER BY sort_order"))
            conn.close()
            return self._json(data)

        if path == "/api/juzhu/ratings":
            conn.close()
            return self._list_ratings(qs)

        m = re.match(r"^/api/juzhu/ratings/([^/]+)$", path)
        if m:
            conn.close()
            return self._get_rating(m.group(1))

        if path.startswith("/api/juzhu/districts/") and path.endswith("/projects"):
            slug = path.split("/")[4]
            dist = row_to_dict(conn.execute("SELECT * FROM districts WHERE slug=?", (slug,)).fetchone())
            if not dist:
                conn.close()
                return self._json({"error": "not found"}, 404)
            projs = rows_to_list(conn.execute(
                "SELECT * FROM projects WHERE district_id=? AND channel='bzf' ORDER BY sort_order",
                (dist["id"],),
            ))
            conn.close()
            return self._json({"district": dist, "projects": projs})

        if path.startswith("/api/juzhu/projects/"):
            parts = path.split("/")
            slug = parts[4] if len(parts) > 4 else ""
            if len(parts) > 5 and parts[5] == "units":
                proj = row_to_dict(conn.execute("SELECT * FROM projects WHERE slug=?", (slug,)).fetchone())
                if not proj:
                    conn.close()
                    return self._json({"error": "not found"}, 404)
                units = rows_to_list(conn.execute(
                    "SELECT * FROM units WHERE project_id=? ORDER BY sort_order", (proj["id"],)
                ))
                photos = rows_to_list(conn.execute(
                    """SELECT * FROM photos WHERE entity_type='unit'
                       AND entity_id IN (SELECT id FROM units WHERE project_id=?)
                       ORDER BY entity_id, sort_order""",
                    (proj["id"],),
                ))
                conn.close()
                return self._json({"project": proj, "units": units, "photos": photos})
            proj = row_to_dict(conn.execute("SELECT * FROM projects WHERE slug=?", (slug,)).fetchone())
            conn.close()
            return self._json(proj if proj else {"error": "not found"}, 404 if not proj else 200)

        if path == "/api/juzhu/trade":
            data = rows_to_list(conn.execute(
                "SELECT * FROM projects WHERE channel='trade' ORDER BY is_featured DESC, featured_rank, sort_order"
            ))
            conn.close()
            return self._json({"listings": data})

        conn.close()
        return self._json({"error": "unknown route"}, 404)

    def _get_project(self, pid):
        conn = connect()
        proj = normalize_project_row(conn.execute(
            """SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?""",
            (pid,),
        ).fetchone())
        if not proj:
            conn.close()
            return self._json({"error": "not found"}, 404)
        units = rows_to_list(conn.execute(
            "SELECT * FROM units WHERE project_id=? ORDER BY sort_order", (pid,)
        ))
        conn.close()
        return self._json({"project": proj, "units": units})

    def _project_by_rating_code(self, conn, code):
        pid = None
        if code.startswith("SY-BZF-"):
            try:
                pid = int(code.rsplit("-", 1)[-1])
            except ValueError:
                pid = None
        if pid is not None:
            row = conn.execute(
                """SELECT p.*, d.name AS district_name FROM projects p
                   LEFT JOIN districts d ON d.id=p.district_id
                   WHERE p.id=? AND p.channel='bzf'""",
                (pid,),
            ).fetchone()
            if row:
                return normalize_project_row(row)
        rows = conn.execute(
            """SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id
               WHERE p.channel='bzf'"""
        ).fetchall()
        for row in rows:
            proj = normalize_project_row(row)
            if (proj.get("rating") or {}).get("code") == code:
                return proj
        return None

    def _list_ratings(self, qs):
        conn = connect()
        status = (qs.get("status") or [None])[0]
        sql = """SELECT p.*, d.name AS district_name FROM projects p
                 LEFT JOIN districts d ON d.id=p.district_id
                 WHERE p.channel='bzf'"""
        params = []
        if status:
            sql += " AND p.rating_status=?"
            params.append(status)
        else:
            sql += " AND p.rating_status IN ('pending','passed','rejected')"
        sql += " ORDER BY COALESCE(p.rating_submitted_at, '') DESC, p.id"
        rows = [normalize_project_row(r) for r in conn.execute(sql, params).fetchall()]
        conn.close()
        return self._json({"items": rows})

    def _get_rating(self, code):
        conn = connect()
        proj = self._project_by_rating_code(conn, code)
        conn.close()
        if not proj:
            return self._json({"error": "not found"}, 404)
        return self._json({"project": proj})

    def _submit_rating(self, pid):
        conn = connect()
        row = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "not found"}, 404)
        proj = dict(row)
        if proj["channel"] != "bzf":
            conn.close()
            return self._json({"error": "仅保租房项目可提交好房子评级"}, 400)
        if proj.get("rating_status") == "pending":
            conn.close()
            return self._json({"error": "已在复核队列中"}, 400)

        rating = {}
        existing = proj.get("rating")
        if existing:
            try:
                rating = json.loads(existing) if isinstance(existing, str) else dict(existing)
            except json.JSONDecodeError:
                rating = {}
        dims = rating.get("dims") or {}
        if not all(dims.get(k) is not None for k in ("comfort", "green", "tech", "safety")):
            conn.close()
            return self._json({"error": "请先保存四维度自评分"}, 400)

        summary = summarize_rating(dims)
        rating.update(summary)
        rating["code"] = rating_code(pid)
        rating.setdefault("checked", rating.get("checked") or 47)
        rating.setdefault("total", rating.get("total") or 55)
        rating["confidence"] = rating.get("confidence") or 0.9
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        conn.execute(
            """UPDATE projects SET rating=?, rating_status='pending',
               rating_submitted_at=?, rating_note=NULL WHERE id=?""",
            (rating_to_db(rating), now, pid),
        )
        conn.commit()
        export_json(conn)
        proj = normalize_project_row(conn.execute(
            """SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?""",
            (pid,),
        ).fetchone())
        conn.close()
        return self._json({"ok": True, "project": proj})

    def _review_rating(self, code):
        b = self._body()
        action = b.get("action")
        if action not in ("pass", "reject"):
            return self._json({"error": "action 须为 pass 或 reject"}, 400)

        conn = connect()
        proj = self._project_by_rating_code(conn, code)
        if not proj:
            conn.close()
            return self._json({"error": "not found"}, 404)
        if proj.get("rating_status") != "pending":
            conn.close()
            return self._json({"error": "当前状态不可复核"}, 400)

        rating = proj.get("rating") or {}
        dims = b.get("dims") or rating.get("dims") or {}
        if action == "pass" and dims:
            rating["dims"] = dims
            rating.update(summarize_rating(dims))
        if b.get("checked") is not None:
            rating["checked"] = b.get("checked")
        if b.get("total") is not None:
            rating["total"] = b.get("total")
        rating["code"] = rating_code(proj["id"])
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        status = "passed" if action == "pass" else "rejected"

        conn.execute(
            """UPDATE projects SET rating=?, rating_status=?, rating_reviewed_at=?, rating_note=?
               WHERE id=?""",
            (rating_to_db(rating), status, now, b.get("note"), proj["id"]),
        )
        conn.commit()
        export_json(conn)
        proj = normalize_project_row(conn.execute(
            """SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?""",
            (proj["id"],),
        ).fetchone())
        conn.close()
        return self._json({"ok": True, "project": proj})

    def _update_project(self, pid):
        b = self._body()
        conn = connect()
        if not conn.execute("SELECT id FROM projects WHERE id=?", (pid,)).fetchone():
            conn.close()
            return self._json({"error": "not found"}, 404)

        name = b.get("name")
        slug = b.get("slug") or (slugify(name) if name else None)
        tags = tags_to_db(b.get("tags"))

        rating_sql = ""
        rating_params = []
        if "rating" in b:
            row = conn.execute("SELECT rating_status FROM projects WHERE id=?", (pid,)).fetchone()
            if row and row[0] in ("draft", "rejected", None):
                rating = b.get("rating") or {}
                dims = rating.get("dims") or {}
                if dims:
                    rating.update(summarize_rating(dims))
                rating["code"] = rating_code(pid)
                rating_sql = ", rating=?"
                rating_params.append(rating_to_db(rating))

        conn.execute(
            f"""UPDATE projects SET
               name=COALESCE(?, name), slug=COALESCE(?, slug),
               address=?, cover_image=?, tags=?,
               sort_order=COALESCE(?, sort_order), price_from=?,
               is_featured=COALESCE(?, is_featured), featured_rank=?, old_house_hint=?
               {rating_sql}
               WHERE id=?""",
            (name, slug, b.get("address"), b.get("cover_image"), tags,
             b.get("sort_order"), b.get("price_from"), b.get("is_featured"),
             b.get("featured_rank"), b.get("old_house_hint"), *rating_params, pid),
        )
        conn.commit()
        sync_project_unit_count(conn, pid)
        export_json(conn)
        proj = normalize_project_row(conn.execute(
            """SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?""",
            (pid,),
        ).fetchone())
        conn.close()
        return self._json({"ok": True, "project": proj})

    def _unique_project_slug(self, conn, channel, name, slug=None):
        base = slug or slugify(name)
        candidate = base
        n = 1
        while conn.execute(
            "SELECT id FROM projects WHERE channel=? AND slug=?", (channel, candidate)
        ).fetchone():
            candidate = f"{base}-{n}"
            n += 1
        return candidate

    def _create_project(self):
        b = self._body()
        name = (b.get("name") or "").strip()
        channel = b.get("channel") or "bzf"
        if not name:
            return self._json({"error": "项目名称不能为空"}, 400)
        if channel not in ("bzf", "trade"):
            return self._json({"error": "channel 须为 bzf 或 trade"}, 400)

        conn = connect()
        city = conn.execute("SELECT id FROM cities LIMIT 1").fetchone()
        if not city:
            conn.close()
            return self._json({"error": "未配置城市"}, 500)
        city_id = city[0]

        district_id = b.get("district_id")
        if channel == "bzf":
            if not district_id:
                conn.close()
                return self._json({"error": "保租房项目须选择行政区"}, 400)
            if not conn.execute("SELECT id FROM districts WHERE id=?", (district_id,)).fetchone():
                conn.close()
                return self._json({"error": "行政区不存在"}, 400)
        else:
            district_id = None

        slug = self._unique_project_slug(conn, channel, name, b.get("slug"))
        dist = conn.execute("SELECT name FROM districts WHERE id=?", (district_id,)).fetchone() if district_id else None
        address = b.get("address") or (f"{dist[0]} · {name}" if dist else f"沈阳 · {name}")

        conn.execute(
            """INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
               sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint)
               VALUES (?,?,?,?,?,?,?,?,?,0,?,COALESCE(?,0),?,?)""",
            (
                city_id, district_id, channel, name, slug,
                b.get("cover_image"), address, tags_to_db(b.get("tags")),
                b.get("sort_order") or 999, b.get("price_from"),
                b.get("is_featured"), b.get("featured_rank"), b.get("old_house_hint"),
            ),
        )
        pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        if district_id:
            sync_district_stats(conn, district_id)
        export_json(conn)
        proj = row_to_dict(conn.execute(
            """SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?""",
            (pid,),
        ).fetchone())
        conn.close()
        return self._json({"ok": True, "project": proj}, 201)

    def _delete_project(self, pid):
        conn = connect()
        row = conn.execute("SELECT district_id FROM projects WHERE id=?", (pid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "not found"}, 404)
        did = row[0]
        conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        conn.commit()
        if did:
            sync_district_stats(conn, did)
        export_json(conn)
        conn.close()
        return self._json({"ok": True})

    def _create_unit(self, pid):
        b = self._body()
        conn = connect()
        if not conn.execute("SELECT id FROM projects WHERE id=?", (pid,)).fetchone():
            conn.close()
            return self._json({"error": "project not found"}, 404)
        name = b.get("name") or "新户型"
        slug = b.get("slug") or slugify(name)
        conn.execute(
            """INSERT INTO units(project_id,name,slug,area_sqm,layout_label,rent_monthly,price_total,tags,sort_order,cover_image)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (pid, name, slug, b.get("area_sqm"), b.get("layout_label"),
             b.get("rent_monthly"), b.get("price_total"), tags_to_db(b.get("tags")),
             b.get("sort_order") or 999, b.get("cover_image")),
        )
        uid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        sync_project_unit_count(conn, pid)
        export_json(conn)
        unit = row_to_dict(conn.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone())
        conn.close()
        return self._json({"ok": True, "unit": unit}, 201)

    def _update_unit(self, uid):
        b = self._body()
        conn = connect()
        row = conn.execute("SELECT project_id FROM units WHERE id=?", (uid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "not found"}, 404)
        pid = row[0]
        name = b.get("name")
        slug = b.get("slug") or (slugify(name) if name else None)
        tags = tags_to_db(b.get("tags")) if "tags" in b else None

        conn.execute(
            """UPDATE units SET
               name=COALESCE(?, name), slug=COALESCE(?, slug),
               area_sqm=?, layout_label=?, rent_monthly=?, price_total=?,
               tags=COALESCE(?, tags), sort_order=COALESCE(?, sort_order), cover_image=?
               WHERE id=?""",
            (name, slug, b.get("area_sqm"), b.get("layout_label"),
             b.get("rent_monthly"), b.get("price_total"), tags,
             b.get("sort_order"), b.get("cover_image"), uid),
        )
        conn.commit()
        sync_project_unit_count(conn, pid)
        export_json(conn)
        unit = row_to_dict(conn.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone())
        conn.close()
        return self._json({"ok": True, "unit": unit})

    def _delete_unit(self, uid):
        conn = connect()
        row = conn.execute("SELECT project_id FROM units WHERE id=?", (uid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "not found"}, 404)
        pid = row[0]
        conn.execute("DELETE FROM units WHERE id=?", (uid,))
        conn.commit()
        sync_project_unit_count(conn, pid)
        export_json(conn)
        conn.close()
        return self._json({"ok": True})


def main():
    port = 8765
    print(f"新居住服务  http://localhost:{port}")
    print(f"  前台  /juzhu-channel-v3-grid.html")
    print(f"  后台  /juzhu-admin.html")
    print(f"  API   /api/juzhu/admin/*  ·  /api/juzhu/ratings")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
