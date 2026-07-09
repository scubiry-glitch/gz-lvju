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
    default_amenities_db,
    export_json,
    json_to_db,
    normalize_project_row,
    normalize_unit_row,
    rating_code,
    rating_to_db,
    row_to_dict,
    rows_to_list,
    summarize_rating,
    sync_district_stats,
    sync_project_unit_count,
    sync_unit_cover,
    tags_to_db,
)

import jiazheng_db as jzdb  # noqa: E402

ADMIN_PREFIX = "/api/juzhu/admin"
ASSETS_PREFIX = "assets/juzhu/sy"
ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_UPLOAD_BYTES = 15 * 1024 * 1024


def slugify(name):
    name = re.sub(r"[（(].*?[）)]", "", name or "").strip()
    return re.sub(r"\s+", "-", name) or "item"


def safe_path_name(name):
    name = re.sub(r'[<>:"/\\|?*\x00]', "", (name or "").strip())
    name = re.sub(r"\s+", "", name)
    return (name[:80] or "unnamed")


def ext_from_upload(filename, content_type):
    ext = Path(filename or "").suffix.lower()
    if ext in ALLOWED_IMAGE_EXT:
        return ext
    mapping = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    return mapping.get((content_type or "").split(";")[0].strip().lower(), ".jpg")


def parse_multipart(body, boundary):
    delim = ("--" + boundary).encode()
    fields = {}
    files = {}
    for part in body.split(delim)[1:]:
        if not part or part in (b"--", b"--\r\n"):
            continue
        chunk = part.lstrip(b"\r\n")
        if chunk.endswith(b"--"):
            chunk = chunk[:-2].rstrip(b"\r\n")
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        header_block, _, content = chunk.partition(b"\r\n\r\n")
        if content.endswith(b"\r\n"):
            content = content[:-2]
        headers = {}
        for line in header_block.decode("utf-8", errors="replace").split("\r\n"):
            if ":" in line:
                key, val = line.split(":", 1)
                headers[key.lower().strip()] = val.strip()
        cd = headers.get("content-disposition", "")
        name_m = re.search(r'name="([^"]+)"', cd)
        if not name_m:
            continue
        field = name_m.group(1)
        file_m = re.search(r'filename="([^"]*)"', cd)
        if file_m and file_m.group(1):
            files[field] = {
                "filename": file_m.group(1),
                "content_type": headers.get("content-type", "application/octet-stream"),
                "data": content,
            }
        else:
            fields[field] = content.decode("utf-8", errors="replace")
    return fields, files


def write_image_file(rel_path, data):
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError(f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 限制")
    ext = Path(rel_path).suffix.lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise ValueError("不支持的图片格式")
    full = ROOT / rel_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(data)
    return rel_path.as_posix() if isinstance(rel_path, Path) else str(rel_path).replace("\\", "/")


def project_cover_rel(conn, project_id, ext):
    row = conn.execute(
        """SELECT p.name, p.channel, d.name AS district_name
           FROM projects p LEFT JOIN districts d ON d.id=p.district_id
           WHERE p.id=?""",
        (project_id,),
    ).fetchone()
    if not row:
        raise ValueError("项目不存在")
    pname = safe_path_name(row["name"])
    channel = row["channel"] or "bzf"
    if channel == "bzf" and row["district_name"]:
        rel = Path(ASSETS_PREFIX) / "projects" / channel / safe_path_name(row["district_name"]) / f"{pname}{ext}"
    else:
        rel = Path(ASSETS_PREFIX) / "projects" / channel / f"{pname}{ext}"
    return rel


def project_cover_rel_draft(channel, district_name, project_name, ext):
    pname = safe_path_name(project_name)
    channel = channel or "bzf"
    if channel == "bzf" and district_name:
        rel = Path(ASSETS_PREFIX) / "projects" / channel / safe_path_name(district_name) / f"{pname}{ext}"
    else:
        rel = Path(ASSETS_PREFIX) / "projects" / channel / f"{pname}{ext}"
    return rel


def unit_gallery_rel(conn, unit_id, ext):
    row = conn.execute(
        """SELECT u.name AS unit_name, p.name AS project_name, p.channel
           FROM units u JOIN projects p ON p.id=u.project_id WHERE u.id=?""",
        (unit_id,),
    ).fetchone()
    if not row:
        raise ValueError("户型不存在")
    unit_name = safe_path_name(row["unit_name"])
    project_name = safe_path_name(row["project_name"])
    channel = row["channel"] or "bzf"
    prefix = unit_name + "_"
    max_n = -1
    for (fp,) in conn.execute(
        "SELECT file_path FROM photos WHERE entity_type='unit' AND entity_id=?",
        (unit_id,),
    ):
        stem = Path(fp or "").stem
        if stem.startswith(prefix):
            try:
                max_n = max(max_n, int(stem[len(prefix):]))
            except ValueError:
                pass
    rel = Path(ASSETS_PREFIX) / "units" / channel / project_name / f"{unit_name}_{max_n + 1}{ext}"
    return rel


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

    def _multipart(self):
        ct = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ct:
            return None
        m = re.search(r"boundary=(?P<b>[^\s;]+)", ct)
        if not m:
            return None
        boundary = m.group("b").strip('"')
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        fields, files = parse_multipart(body, boundary)
        return {"fields": fields, "files": files}

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

        # === 家政频道 POST 端点（非 admin 路径） ===
        if method == "POST" and path.startswith("/api/juzhu/jz"):
            return self._jiazheng_post(path, qs)

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

        if path == f"{ADMIN_PREFIX}/settings" and method == "GET":
            return self._get_settings()

        if path == f"{ADMIN_PREFIX}/settings" and method == "PUT":
            return self._update_settings()

        if path == f"{ADMIN_PREFIX}/dictionary" and method == "GET":
            return self._get_dictionary()

        if path == f"{ADMIN_PREFIX}/city" and method == "PUT":
            return self._update_city()

        if path == f"{ADMIN_PREFIX}/districts" and method == "POST":
            return self._create_district()

        m = re.match(rf"^{ADMIN_PREFIX}/districts/(\d+)$", path)
        if m:
            did = int(m.group(1))
            if method == "PUT":
                return self._update_district(did)
            if method == "DELETE":
                return self._delete_district(did)

        m = re.match(rf"^{ADMIN_PREFIX}/channels/([^/]+)$", path)
        if m and method == "PUT":
            return self._update_channel(m.group(1))

        if path == f"{ADMIN_PREFIX}/upload" and method == "POST":
            return self._upload_file()

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

        m = re.match(rf"^{ADMIN_PREFIX}/units/(\d+)/photos$", path)
        if m:
            uid = int(m.group(1))
            if method == "GET":
                return self._list_unit_photos(uid)
            if method == "POST":
                return self._create_photo(uid)

        m = re.match(rf"^{ADMIN_PREFIX}/photos/(\d+)$", path)
        if m:
            photo_id = int(m.group(1))
            if method == "PUT":
                return self._update_photo(photo_id)
            if method == "DELETE":
                return self._delete_photo(photo_id)

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

        # === 居住服务·家政频道 /api/juzhu/jz/* ===
        if path == "/api/juzhu/jz/categories":
            type_ = qs.get("type", [None])[0]
            data = jzdb.list_categories(conn, type_)
            conn.close()
            return self._json({"list": data})

        if path == "/api/juzhu/jz/vendors":
            type_ = qs.get("type", [None])[0]
            data = jzdb.list_vendors(conn, type_)
            conn.close()
            return self._json({"list": data})

        m = re.match(r"^/api/juzhu/jz/vendors/(\d+)$", path)
        if m:
            data = jzdb.get_vendor(conn, int(m.group(1)))
            conn.close()
            return self._json(data if data else {"error": "not found"}, 404 if not data else 200)

        m = re.match(r"^/api/juzhu/jz/products/(\d+)$", path)
        if m:
            data = jzdb.get_product(conn, int(m.group(1)))
            conn.close()
            return self._json(data if data else {"error": "not found"}, 404 if not data else 200)

        if path == "/api/juzhu/jz/workers":
            vendor_id = qs.get("vendor_id", [None])[0]
            if vendor_id:
                data = jzdb.list_workers_by_vendor(conn, int(vendor_id))
            else:
                data = jzdb.list_workers_online(conn)
            conn.close()
            return self._json({"list": data})

        m = re.match(r"^/api/juzhu/jz/workers/(\d+)$", path)
        if m:
            data = jzdb.get_worker(conn, int(m.group(1)))
            conn.close()
            return self._json(data if data else {"error": "not found"}, 404 if not data else 200)

        if path == "/api/juzhu/jz/orders":
            status = qs.get("status", [None])[0]
            limit = int(qs.get("limit", ["50"])[0])
            data = jzdb.list_orders(conn, status=status, limit=limit)
            conn.close()
            return self._json({"list": data})

        m = re.match(r"^/api/juzhu/jz/orders/([^/]+)$", path)
        if m:
            data = jzdb.get_order(conn, m.group(1))
            conn.close()
            return self._json(data if data else {"error": "not found"}, 404 if not data else 200)

        if path == "/api/juzhu/jz/activities":
            tag_id = qs.get("tag_id", [None])[0]
            tag_id = int(tag_id) if tag_id else None
            data = jzdb.list_activities(conn, tag_id=tag_id)
            conn.close()
            return self._json({"list": data})

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
        photos = rows_to_list(conn.execute(
            """SELECT * FROM photos WHERE entity_type='unit'
               AND entity_id IN (SELECT id FROM units WHERE project_id=?)
               ORDER BY entity_id, sort_order, id""",
            (pid,),
        ))
        conn.close()
        return self._json({"project": proj, "units": units, "photos": photos})

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

    # ====== 居住服务·家政频道 ======
    def _jiazheng_post(self, path, qs):
        """处理 /api/juzhu/jz/* POST 请求"""
        conn = connect()
        try:
            body = self._body()

            if path == "/api/juzhu/jz/orders":
                # 创建订单
                vendor = jzdb.get_vendor(conn, body.get("vendor_id"))
                product = jzdb.get_product(conn, body.get("product_id"))
                if not vendor or not product:
                    return self._json({"error": "vendor or product not found"}, 404)
                # 生成订单号
                from datetime import datetime, timezone
                seq_row = conn.execute("SELECT seq FROM jz_order_seq WHERE id=1").fetchone()
                seq = (seq_row["seq"] if seq_row else 0) + 1
                conn.execute(
                    "INSERT OR REPLACE INTO jz_order_seq(id, seq) VALUES (1, ?)",
                    (seq,),
                )
                oid = "WO-2026-" + str(80000 + seq)
                now = datetime.now(timezone.utc).isoformat(timespec="seconds")
                order = {
                    "id": oid,
                    "type": body.get("type", vendor["type"]),
                    "vendor_id": vendor["id"],
                    "product_id": product["id"],
                    "vendor_name": vendor["name"],
                    "vendor_logo": vendor["logo"],
                    "product_title": product["title"],
                    "product_sub": product["subtitle"],
                    "product_price": product["price"],
                    "address": body.get("address", ""),
                    "phone": body.get("phone", ""),
                    "scheduled_at": body.get("scheduled_at", ""),
                    "fee": body.get("fee", product["price"]),
                    "status": "pending",
                    "source": "jz",
                    "created_at": now,
                    "updated_at": now,
                }
                jzdb.create_order(conn, order)
                conn.commit()
                # 返回完整订单（包含 worker=null）
                created = jzdb.get_order(conn, oid)
                return self._json({"ok": True, "order": created})

            m = re.match(r"^/api/juzhu/jz/orders/([^/]+)/dispatch$", path)
            if m:
                # 派单（手动传 worker_id 或自动选第一名在线）
                oid = m.group(1)
                worker_id = body.get("worker_id")
                if not worker_id:
                    online = jzdb.list_workers_online(conn)
                    if online:
                        worker_id = online[0]["id"]
                jzdb.update_order_status(conn, oid, "dispatched", worker_id)
                conn.commit()
                return self._json({"ok": True, "worker_id": worker_id})

            m = re.match(r"^/api/juzhu/jz/orders/([^/]+)/status$", path)
            if m:
                # 状态推进
                oid = m.group(1)
                status = body.get("status")
                if status not in ("pending", "dispatched", "accepted", "serving", "done", "rated", "cancelled"):
                    return self._json({"error": "invalid status"}, 400)
                jzdb.update_order_status(conn, oid, status)
                conn.commit()
                return self._json({"ok": True})

            m = re.match(r"^/api/juzhu/jz/orders/([^/]+)/rate$", path)
            if m:
                # 评价
                oid = m.group(1)
                score = int(body.get("score", 5))
                tags = body.get("tags", [])
                text = body.get("text", "")
                credit_delta = 2.4 if score >= 5 else (1.2 if score >= 4 else (-1.5 if score >= 2 else -3.0))
                jzdb.rate_order(conn, oid, score, tags, text, credit_delta)
                conn.commit()
                return self._json({"ok": True, "credit_delta": credit_delta})

            return self._json({"error": "unknown route"}, 404)
        finally:
            conn.close()

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

        managed_sql = ""
        managed_params = []
        if "managed_unit_count" in b:
            val = b.get("managed_unit_count")
            managed_sql = ", managed_unit_count=?"
            managed_params.append(int(val) if val is not None and val != "" else None)

        conn.execute(
            f"""UPDATE projects SET
               name=COALESCE(?, name), slug=COALESCE(?, slug),
               address=?, cover_image=?, tags=?,
               sort_order=COALESCE(?, sort_order), price_from=?,
               is_featured=COALESCE(?, is_featured), featured_rank=?, old_house_hint=?
               {managed_sql}{rating_sql}
               WHERE id=?""",
            (name, slug, b.get("address"), b.get("cover_image"), tags,
             b.get("sort_order"), b.get("price_from"), b.get("is_featured"),
             b.get("featured_rank"), b.get("old_house_hint"), *managed_params, *rating_params, pid),
        )
        conn.commit()
        sync_project_unit_count(conn, pid)
        row = conn.execute("SELECT district_id FROM projects WHERE id=?", (pid,)).fetchone()
        if row and row[0]:
            sync_district_stats(conn, row[0])
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
            """INSERT INTO units(project_id,name,slug,area_sqm,layout_label,rent_monthly,price_total,
               tags,unit_spec,promo_price,amenities,keeper,rent_detail,sort_order,cover_image)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (pid, name, slug, b.get("area_sqm"), b.get("layout_label"),
             b.get("rent_monthly"), b.get("price_total"), tags_to_db(b.get("tags")),
             b.get("unit_spec"), b.get("promo_price"),
             json_to_db(b.get("amenities") if b.get("amenities") is not None else json.loads(default_amenities_db())), json_to_db(b.get("keeper")),
             json_to_db(b.get("rent_detail")),
             b.get("sort_order") or 999, b.get("cover_image")),
        )
        uid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        sync_project_unit_count(conn, pid)
        export_json(conn)
        unit = normalize_unit_row(conn.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone())
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
        amenities = json_to_db(b.get("amenities")) if "amenities" in b else None
        keeper = json_to_db(b.get("keeper")) if "keeper" in b else None
        rent_detail = json_to_db(b.get("rent_detail")) if "rent_detail" in b else None

        conn.execute(
            """UPDATE units SET
               name=COALESCE(?, name), slug=COALESCE(?, slug),
               area_sqm=?, layout_label=?, rent_monthly=?, price_total=?,
               tags=COALESCE(?, tags), unit_spec=?, promo_price=?,
               amenities=COALESCE(?, amenities), keeper=COALESCE(?, keeper),
               rent_detail=COALESCE(?, rent_detail),
               sort_order=COALESCE(?, sort_order), cover_image=?
               WHERE id=?""",
            (name, slug, b.get("area_sqm"), b.get("layout_label"),
             b.get("rent_monthly"), b.get("price_total"), tags,
             b.get("unit_spec"), b.get("promo_price"),
             amenities, keeper, rent_detail,
             b.get("sort_order"), b.get("cover_image"), uid),
        )
        conn.commit()
        sync_project_unit_count(conn, pid)
        export_json(conn)
        unit = normalize_unit_row(conn.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone())
        conn.close()
        return self._json({"ok": True, "unit": unit})

    def _delete_unit(self, uid):
        conn = connect()
        row = conn.execute("SELECT project_id FROM units WHERE id=?", (uid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "not found"}, 404)
        pid = row[0]
        conn.execute("DELETE FROM photos WHERE entity_type='unit' AND entity_id=?", (uid,))
        conn.execute("DELETE FROM units WHERE id=?", (uid,))
        conn.commit()
        sync_project_unit_count(conn, pid)
        export_json(conn)
        conn.close()
        return self._json({"ok": True})

    def _list_unit_photos(self, uid):
        conn = connect()
        if not conn.execute("SELECT id FROM units WHERE id=?", (uid,)).fetchone():
            conn.close()
            return self._json({"error": "unit not found"}, 404)
        photos = rows_to_list(conn.execute(
            "SELECT * FROM photos WHERE entity_type='unit' AND entity_id=? ORDER BY sort_order, id",
            (uid,),
        ))
        conn.close()
        return self._json({"photos": photos})

    def _upload_file(self):
        mp = self._multipart()
        if not mp:
            return self._json({"error": "需要 multipart/form-data 上传"}, 400)
        upload = mp["files"].get("file")
        if not upload or not upload["data"]:
            return self._json({"error": "缺少 file 字段"}, 400)
        scope = (mp["fields"].get("scope") or "").strip()
        ext = ext_from_upload(upload["filename"], upload["content_type"])
        try:
            conn = connect()
            if scope == "project_cover":
                pid = int(mp["fields"].get("project_id") or 0)
                rel = project_cover_rel(conn, pid, ext)
            elif scope == "project_cover_new":
                channel = mp["fields"].get("channel") or "bzf"
                district_name = ""
                district_id = mp["fields"].get("district_id")
                if district_id:
                    row = conn.execute(
                        "SELECT name FROM districts WHERE id=?", (int(district_id),)
                    ).fetchone()
                    district_name = row["name"] if row else ""
                project_name = mp["fields"].get("project_name") or "新项目"
                rel = project_cover_rel_draft(channel, district_name, project_name, ext)
            elif scope == "unit_gallery":
                uid = int(mp["fields"].get("unit_id") or 0)
                rel = unit_gallery_rel(conn, uid, ext)
            elif scope == "unit_photo":
                photo_id = int(mp["fields"].get("photo_id") or 0)
                row = conn.execute(
                    "SELECT file_path FROM photos WHERE id=? AND entity_type='unit'",
                    (photo_id,),
                ).fetchone()
                if not row or not row["file_path"]:
                    conn.close()
                    return self._json({"error": "图片记录不存在"}, 404)
                rel = Path(row["file_path"])
                ext = rel.suffix.lower() or ext
            elif scope == "unit_keeper":
                uid = int(mp["fields"].get("unit_id") or 0)
                if not conn.execute("SELECT id FROM units WHERE id=?", (uid,)).fetchone():
                    conn.close()
                    return self._json({"error": "unit not found"}, 404)
                rel = Path(ASSETS_PREFIX) / "keepers" / f"unit_{uid}{ext}"
            elif scope == "city_hero":
                rel = Path(ASSETS_PREFIX) / "city" / f"hero{ext}"
            else:
                conn.close()
                return self._json({"error": "未知 scope"}, 400)
            conn.close()
            file_path = write_image_file(rel, upload["data"])
            if scope == "city_hero":
                conn = connect()
                conn.execute(
                    "UPDATE cities SET hero_bg_image=? WHERE id=(SELECT id FROM cities ORDER BY id LIMIT 1)",
                    (file_path,),
                )
                conn.commit()
                export_json(conn)
                conn.close()
            return self._json({"ok": True, "file_path": file_path})
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except (TypeError, ValueError):
            return self._json({"error": "参数无效"}, 400)

    def _create_photo(self, uid):
        mp = self._multipart()
        if mp:
            return self._create_photo_multipart(uid, mp)
        b = self._body()
        conn = connect()
        if not conn.execute("SELECT id FROM units WHERE id=?", (uid,)).fetchone():
            conn.close()
            return self._json({"error": "unit not found"}, 404)
        path = (b.get("file_path") or "").strip()
        if not path:
            conn.close()
            return self._json({"error": "file_path 不能为空"}, 400)
        is_cover = 1 if b.get("is_cover") else 0
        sort_order = b.get("sort_order")
        if sort_order is None:
            sort_order = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM photos WHERE entity_type='unit' AND entity_id=?",
                (uid,),
            ).fetchone()[0]
        if is_cover:
            conn.execute(
                "UPDATE photos SET is_cover=0 WHERE entity_type='unit' AND entity_id=?",
                (uid,),
            )
        conn.execute(
            """INSERT INTO photos(entity_type, entity_id, file_path, source_path, is_cover, sort_order)
               VALUES ('unit', ?, ?, ?, ?, ?)""",
            (uid, path, b.get("source_path"), is_cover, sort_order),
        )
        photo_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        sync_unit_cover(conn, uid)
        export_json(conn)
        photo = row_to_dict(conn.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone())
        conn.close()
        return self._json({"ok": True, "photo": photo}, 201)

    def _create_photo_multipart(self, uid, mp):
        upload = mp["files"].get("file")
        if not upload or not upload["data"]:
            return self._json({"error": "缺少 file 字段"}, 400)
        conn = connect()
        if not conn.execute("SELECT id FROM units WHERE id=?", (uid,)).fetchone():
            conn.close()
            return self._json({"error": "unit not found"}, 404)
        try:
            ext = ext_from_upload(upload["filename"], upload["content_type"])
            rel = unit_gallery_rel(conn, uid, ext)
            path = write_image_file(rel, upload["data"])
        except ValueError as e:
            conn.close()
            return self._json({"error": str(e)}, 400)
        is_cover = 1 if mp["fields"].get("is_cover") in ("1", "true", "yes") else 0
        sort_order = mp["fields"].get("sort_order")
        if sort_order is None or sort_order == "":
            sort_order = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM photos WHERE entity_type='unit' AND entity_id=?",
                (uid,),
            ).fetchone()[0]
        else:
            sort_order = int(sort_order)
        if is_cover:
            conn.execute(
                "UPDATE photos SET is_cover=0 WHERE entity_type='unit' AND entity_id=?",
                (uid,),
            )
        conn.execute(
            """INSERT INTO photos(entity_type, entity_id, file_path, source_path, is_cover, sort_order)
               VALUES ('unit', ?, ?, ?, ?, ?)""",
            (uid, path, upload["filename"], is_cover, sort_order),
        )
        photo_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        sync_unit_cover(conn, uid)
        export_json(conn)
        photo = row_to_dict(conn.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone())
        conn.close()
        return self._json({"ok": True, "photo": photo, "file_path": path}, 201)

    def _update_photo(self, photo_id):
        b = self._body()
        conn = connect()
        row = conn.execute(
            "SELECT entity_id FROM photos WHERE id=? AND entity_type='unit'",
            (photo_id,),
        ).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "not found"}, 404)
        uid = row[0]
        path = b.get("file_path")
        if path is not None:
            path = path.strip()
            if not path:
                conn.close()
                return self._json({"error": "file_path 不能为空"}, 400)
        if b.get("is_cover"):
            conn.execute(
                "UPDATE photos SET is_cover=0 WHERE entity_type='unit' AND entity_id=?",
                (uid,),
            )
        conn.execute(
            """UPDATE photos SET
               file_path=COALESCE(?, file_path),
               sort_order=COALESCE(?, sort_order),
               is_cover=COALESCE(?, is_cover)
               WHERE id=?""",
            (
                path,
                b.get("sort_order"),
                1 if b.get("is_cover") else (0 if "is_cover" in b else None),
                photo_id,
            ),
        )
        conn.commit()
        sync_unit_cover(conn, uid)
        export_json(conn)
        photo = row_to_dict(conn.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone())
        conn.close()
        return self._json({"ok": True, "photo": photo})

    def _delete_photo(self, photo_id):
        conn = connect()
        row = conn.execute(
            "SELECT entity_id FROM photos WHERE id=? AND entity_type='unit'",
            (photo_id,),
        ).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "not found"}, 404)
        uid = row[0]
        conn.execute("DELETE FROM photos WHERE id=?", (photo_id,))
        conn.commit()
        sync_unit_cover(conn, uid)
        export_json(conn)
        conn.close()
        return self._json({"ok": True})

    def _get_settings(self):
        conn = connect()
        row = conn.execute("SELECT booking_phone FROM cities ORDER BY id LIMIT 1").fetchone()
        conn.close()
        return self._json({"booking_phone": row[0] if row else None})

    def _update_settings(self):
        body = self._body()
        phone = (body.get("booking_phone") or "").strip() or None
        conn = connect()
        conn.execute(
            "UPDATE cities SET booking_phone=? WHERE id=(SELECT id FROM cities ORDER BY id LIMIT 1)",
            (phone,),
        )
        conn.commit()
        export_json(conn)
        conn.close()
        return self._json({"ok": True, "booking_phone": phone})

    def _get_dictionary(self):
        conn = connect()
        city = row_to_dict(conn.execute("SELECT * FROM cities ORDER BY id LIMIT 1").fetchone())
        districts = rows_to_list(conn.execute("SELECT * FROM districts ORDER BY sort_order, id"))
        channels = rows_to_list(conn.execute("SELECT * FROM channels ORDER BY sort_order, id"))
        conn.close()
        return self._json({"city": city, "districts": districts, "channels": channels})

    def _update_city(self):
        body = self._body()
        name = (body.get("name") or "").strip()
        slug = (body.get("slug") or "").strip()
        if not name:
            return self._json({"error": "城市名称不能为空"}, 400)
        conn = connect()
        row = conn.execute("SELECT id FROM cities ORDER BY id LIMIT 1").fetchone()
        if not row:
            conn.close()
            return self._json({"error": "未找到城市"}, 404)
        cid = row[0]
        if not slug:
            slug = slugify(name)
        fields = ["name=?", "slug=?"]
        params = [name, slug]
        if "hero_bg_image" in body:
            val = (body.get("hero_bg_image") or "").strip() or None
            fields.append("hero_bg_image=?")
            params.append(val)
        params.append(cid)
        conn.execute(f"UPDATE cities SET {', '.join(fields)} WHERE id=?", params)
        conn.commit()
        export_json(conn)
        city = row_to_dict(conn.execute("SELECT * FROM cities WHERE id=?", (cid,)).fetchone())
        conn.close()
        return self._json({"ok": True, "city": city})

    def _update_district(self, did):
        body = self._body()
        conn = connect()
        if not conn.execute("SELECT id FROM districts WHERE id=?", (did,)).fetchone():
            conn.close()
            return self._json({"error": "行政区不存在"}, 404)
        fields = []
        params = []
        mapping = {
            "name": "name",
            "slug": "slug",
            "note": "note",
            "sort_order": "sort_order",
            "cover_image": "cover_image",
            "is_hot": "is_hot",
            "layout_tall": "layout_tall",
            "layout_wide": "layout_wide",
            "bg_class": "bg_class",
            "has_projects": "has_projects",
        }
        for key, col in mapping.items():
            if key in body:
                val = body[key]
                if key in ("sort_order", "is_hot", "layout_tall", "layout_wide", "has_projects"):
                    val = int(val) if val is not None and val != "" else 0
                elif isinstance(val, str):
                    val = val.strip() or None
                fields.append(f"{col}=?")
                params.append(val)
        if not fields:
            conn.close()
            return self._json({"error": "无更新字段"}, 400)
        params.append(did)
        conn.execute(f"UPDATE districts SET {', '.join(fields)} WHERE id=?", params)
        sync_district_stats(conn, did)
        conn.commit()
        export_json(conn)
        district = row_to_dict(conn.execute("SELECT * FROM districts WHERE id=?", (did,)).fetchone())
        conn.close()
        return self._json({"ok": True, "district": district})

    def _create_district(self):
        body = self._body()
        name = (body.get("name") or "").strip()
        if not name:
            return self._json({"error": "行政区名称不能为空"}, 400)
        conn = connect()
        city = conn.execute("SELECT id FROM cities ORDER BY id LIMIT 1").fetchone()
        if not city:
            conn.close()
            return self._json({"error": "请先配置城市"}, 400)
        slug = (body.get("slug") or name).strip() or name
        if conn.execute("SELECT id FROM districts WHERE city_id=? AND slug=?", (city[0], slug)).fetchone():
            conn.close()
            return self._json({"error": "slug 已存在"}, 400)
        conn.execute(
            """INSERT INTO districts(city_id,name,slug,note,sort_order,cover_image,has_projects)
               VALUES (?,?,?,?,?,?,?)""",
            (
                city[0],
                name,
                slug,
                (body.get("note") or "").strip() or None,
                int(body.get("sort_order") or 999),
                (body.get("cover_image") or "").strip() or None,
                int(body.get("has_projects") or 0),
            ),
        )
        did = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        sync_district_stats(conn, did)
        conn.commit()
        export_json(conn)
        district = row_to_dict(conn.execute("SELECT * FROM districts WHERE id=?", (did,)).fetchone())
        conn.close()
        return self._json({"ok": True, "district": district})

    def _delete_district(self, did):
        conn = connect()
        n = conn.execute("SELECT COUNT(*) FROM projects WHERE district_id=?", (did,)).fetchone()[0]
        if n:
            conn.close()
            return self._json({"error": f"该区仍有 {n} 个项目，无法删除"}, 400)
        if not conn.execute("SELECT id FROM districts WHERE id=?", (did,)).fetchone():
            conn.close()
            return self._json({"error": "行政区不存在"}, 404)
        conn.execute("DELETE FROM districts WHERE id=?", (did,))
        conn.commit()
        export_json(conn)
        conn.close()
        return self._json({"ok": True})

    def _update_channel(self, channel_id):
        body = self._body()
        conn = connect()
        if not conn.execute("SELECT id FROM channels WHERE id=?", (channel_id,)).fetchone():
            conn.close()
            return self._json({"error": "频道不存在"}, 404)
        fields = []
        params = []
        if "label" in body:
            label = (body.get("label") or "").strip()
            if not label:
                conn.close()
                return self._json({"error": "频道名称不能为空"}, 400)
            fields.append("label=?")
            params.append(label)
        if "sort_order" in body:
            fields.append("sort_order=?")
            params.append(int(body.get("sort_order") or 0))
        if "enabled" in body:
            fields.append("enabled=?")
            params.append(1 if body.get("enabled") else 0)
        if "note" in body:
            note = (body.get("note") or "").strip() or None
            fields.append("note=?")
            params.append(note)
        if not fields:
            conn.close()
            return self._json({"error": "无更新字段"}, 400)
        params.append(channel_id)
        conn.execute(f"UPDATE channels SET {', '.join(fields)} WHERE id=?", params)
        conn.commit()
        export_json(conn)
        channel = row_to_dict(conn.execute("SELECT * FROM channels WHERE id=?", (channel_id,)).fetchone())
        conn.close()
        return self._json({"ok": True, "channel": channel})


def main():
    port = 8765
    print(f"新居住服务  http://localhost:{port}")
    print(f"  前台  /juzhu-channel-v3-grid.html")
    print(f"  后台  /juzhu-admin.html")
    print(f"  API   /api/juzhu/admin/*  ·  /api/juzhu/ratings")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
