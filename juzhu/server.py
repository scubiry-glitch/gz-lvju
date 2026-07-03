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

from db import (  # noqa: E402
    connect,
    export_json,
    row_to_dict,
    rows_to_list,
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
        proj = row_to_dict(conn.execute(
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

    def _update_project(self, pid):
        b = self._body()
        conn = connect()
        if not conn.execute("SELECT id FROM projects WHERE id=?", (pid,)).fetchone():
            conn.close()
            return self._json({"error": "not found"}, 404)

        name = b.get("name")
        slug = b.get("slug") or (slugify(name) if name else None)
        tags = tags_to_db(b.get("tags"))

        conn.execute(
            """UPDATE projects SET
               name=COALESCE(?, name), slug=COALESCE(?, slug),
               address=?, cover_image=?, tags=?,
               sort_order=COALESCE(?, sort_order), price_from=?,
               is_featured=COALESCE(?, is_featured), featured_rank=?, old_house_hint=?
               WHERE id=?""",
            (name, slug, b.get("address"), b.get("cover_image"), tags,
             b.get("sort_order"), b.get("price_from"), b.get("is_featured"),
             b.get("featured_rank"), b.get("old_house_hint"), pid),
        )
        conn.commit()
        sync_project_unit_count(conn, pid)
        export_json(conn)
        proj = row_to_dict(conn.execute(
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
    print(f"  API   /api/juzhu/admin/*")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
