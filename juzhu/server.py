#!/usr/bin/env python3
"""新居住频道 SQLite API（stdlib only）— 配合 python3 juzhu/server.py 启动。"""
import json, sqlite3
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
DB = Path(__file__).resolve().parent / "juzhu.db"


def q(sql, params=()):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    conn.close()
    for r in rows:
        if r.get("tags") and isinstance(r["tags"], str):
            r["tags"] = json.loads(r["tags"])
    return rows


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def do_GET(self):
        p = urlparse(self.path)
        if p.path.startswith("/api/juzhu"):
            return self._api(p)
        return super().do_GET()

    def _json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _api(self, p):
        qs = parse_qs(p.query)
        path = p.path.rstrip("/")

        if path == "/api/juzhu/stats":
            d = q("SELECT COUNT(*) c FROM districts")[0]["c"]
            pb = q("SELECT COUNT(*) c FROM projects WHERE channel='bzf'")[0]["c"]
            pt = q("SELECT COUNT(*) c FROM projects WHERE channel='trade'")[0]["c"]
            u = q("SELECT COUNT(*) c FROM units")[0]["c"]
            return self._json({"districts": d, "projects_bzf": pb, "projects_trade": pt, "units": u})

        if path == "/api/juzhu/districts":
            return self._json(q("SELECT * FROM districts ORDER BY sort_order"))

        if path.startswith("/api/juzhu/districts/") and path.endswith("/projects"):
            slug = path.split("/")[4]
            dist = q("SELECT * FROM districts WHERE slug=?", (slug,))
            if not dist:
                return self._json({"error": "not found"}, 404)
            did = dist[0]["id"]
            projs = q("SELECT * FROM projects WHERE district_id=? AND channel='bzf' ORDER BY sort_order", (did,))
            return self._json({"district": dist[0], "projects": projs})

        if path.startswith("/api/juzhu/projects/"):
            parts = path.split("/")
            if len(parts) >= 5 and parts[4]:
                slug = parts[4]
                if len(parts) > 5 and parts[5] == "units":
                    proj = q("SELECT * FROM projects WHERE slug=?", (slug,))
                    if not proj:
                        return self._json({"error": "not found"}, 404)
                    pid = proj[0]["id"]
                    units = q("SELECT * FROM units WHERE project_id=? ORDER BY sort_order", (pid,))
                    photos = q(
                        "SELECT * FROM photos WHERE entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?) ORDER BY entity_id,sort_order",
                        (pid,),
                    )
                    return self._json({"project": proj[0], "units": units, "photos": photos})
                proj = q("SELECT * FROM projects WHERE slug=?", (slug,))
                return self._json(proj[0] if proj else {"error": "not found"}, 404 if not proj else 200)

        if path == "/api/juzhu/trade":
            featured = q("SELECT * FROM projects WHERE channel='trade' ORDER BY is_featured DESC, featured_rank, sort_order")
            return self._json({"listings": featured})

        return self._json({"error": "unknown route"}, 404)


def main():
    port = 8765
    print(f"Serving {ROOT} + /api/juzhu/* on http://localhost:{port}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
