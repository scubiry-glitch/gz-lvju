#!/usr/bin/env python3
"""新居住频道 API + 静态文件 + 编辑后台接口。启动：python3 juzhu/server.py"""
import hashlib
import hmac
import json
import os
import posixpath
import re
import sys
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from datetime import datetime, timezone

from db import (  # noqa: E402
    JZ_CATEGORY_ICONS,
    JZ_CATEGORY_LABELS,
    JZ_STATUS_ORDER,
    JZ_WORKERS,
    connect,
    default_amenities_db,
    export_json,
    json_to_db,
    jz_order_view,
    normalize_jz_order_row,
    normalize_jz_sku_row,
    normalize_project_row,
    normalize_unit_row,
    rating_code,
    rating_to_db,
    row_to_dict,
    rows_to_list,
    strip_contact_phone,
    summarize_rating,
    sync_district_stats,
    sync_project_unit_count,
    sync_unit_cover,
    tags_to_db,
)

import jiazheng_db as jzdb  # noqa: E402
import jiazheng_api           # noqa: E402
from tp_client import TpError, alloc_virtual_phone, load_dotenv, mask_phone, validate_real_phone  # noqa: E402

ADMIN_PREFIX = "/api/juzhu/admin"
ASSETS_PREFIX = "assets/juzhu/sy"
ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
API_KEY_ENV = "JUZHU_API_KEY"
DEFAULT_API_KEY = "dev-juzhu-key"  # 历史默认值：任何环境均不得再当作有效密钥
ADMIN_PASSWORD_ENV = "JUZHU_ADMIN_PASSWORD"
DEFAULT_ADMIN_PASSWORD = "dongbo2026"
ADMIN_TOKEN_TTL_SEC = 30 * 24 * 3600
ADMIN_TOKEN_SALT = b"juzhu-admin-session-v1"

# 静态文件：默认不暴露源码/密钥/数据库。/juzhu/ 仅白名单（前端 data 层依赖）。
# 与仓库根 app.js 的 isPublicStatic 保持同口径（Node 为线上入口）。
_SENSITIVE_NAMES = {
    ".env",
    ".env.local",
    ".env.example",
    ".env.prod",
    ".env.test",
    ".git",
    ".gitignore",
    ".DS_Store",
    "__pycache__",
    "config.ini",
    "server.log",
    "api_doc.md",
    "api-document.html",
    "hmac_secret.key",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "scf_bootstrap",
    "moma_build.sh",
    "moma_deploy.js",
    "CLAUDE.md",
    "README.md",
    "VERIFICATION.md",
}
_SENSITIVE_SUFFIXES = (
    ".py",
    ".pyc",
    ".pyo",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".sql",
    ".ini",
    ".log",
    ".key",
    ".pem",
    ".crt",
    ".p12",
    ".pfx",
    ".sh",
    ".md",
)
_API_DOC_BASENAMES = {
    "api-document.html",
    "xjz-api.html",
    "prd-document.html",
    "xjz-prd.html",
}
_ROOT_BLOCKED_FILES = {
    "app.js",
    "server.js",
    "package.json",
    "package-lock.json",
    "scf_bootstrap",
    "moma_build.sh",
    "moma_deploy.js",
    "api_doc.md",
    "README.md",
    "CLAUDE.md",
}
_JUZHU_PUBLIC_FILES = {
    "app.js",
    "cities.json",
    "data.json",
}
_JUZHU_PUBLIC_PREFIXES = ("data-",)
_JUZHU_PUBLIC_SUFFIXES = (".json",)
_BLOCKED_TOP_DIRS = {"node_modules", "scripts", ".git"}


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


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def order_id():
    stamp = datetime.now(timezone.utc).strftime("%y%m%d%H%M%S%f")[-12:]
    return f"WO-{stamp}"


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


# ====== 家政频道 城市解析辅助 ======
def _resolve_city_id(conn, city_name):
    """城市名 → city_id；不存在返回 None，city_name 为空返回 None"""
    if not city_name:
        return None
    row = conn.execute(
        "SELECT id FROM cities WHERE name=?", (city_name,)
    ).fetchone()
    return row[0] if row else None


def _url_parts(url_path):
    path = url_path.split("?", 1)[0].split("#", 1)[0]
    path = posixpath.normpath(unquote(path))
    return [p for p in path.split("/") if p and p not in (os.curdir, os.pardir)]


_SENSITIVE_NAMES_LOWER = {n.lower() for n in _SENSITIVE_NAMES}
_ROOT_BLOCKED_LOWER = {n.lower() for n in _ROOT_BLOCKED_FILES}


def _is_sensitive_part(name):
    lower = (name or "").lower()
    if lower in _SENSITIVE_NAMES_LOWER or name in _SENSITIVE_NAMES:
        return True
    if lower in _API_DOC_BASENAMES:
        return True
    if lower.startswith(".env"):
        return True
    # 隐藏文件 / 目录（.git、.env*、.DS_Store 等）一律不对外
    if lower.startswith(".") and lower not in (".", ".."):
        return True
    if lower.endswith(_SENSITIVE_SUFFIXES):
        return True
    return False


def is_public_static(url_path):
    """是否允许作为静态资源对外提供。API 路由不走此函数。"""
    parts = _url_parts(url_path)
    if not parts:
        return True  # / → index；目录列表另由 list_directory 关掉
    # 生产禁用 /docs/ 整目录（含历史 API 文档入口）
    env = (os.environ.get("JUZHU_ENV") or "").strip().lower()
    if parts[0] == "docs" and env in ("prod", "production"):
        return False
    # /juzhu/ 白名单优先（其中 app.js 是前端脚本，与根目录 Node 入口同名）
    if parts[0] == "juzhu":
        if len(parts) != 2:
            return False
        name = parts[1]
        if name in _JUZHU_PUBLIC_FILES:
            return True
        if name.startswith(_JUZHU_PUBLIC_PREFIXES) and name.endswith(_JUZHU_PUBLIC_SUFFIXES):
            return True
        return False
    if parts[0] in _BLOCKED_TOP_DIRS:
        return False
    if any(_is_sensitive_part(p) for p in parts):
        return False
    if len(parts) == 1 and parts[0].lower() in _ROOT_BLOCKED_LOWER:
        return False
    # 仓库根其它路径：允许 html/css/js/图片等业务静态页
    return True



class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        """Python 3.6 无 directory 参数，自定义静态根目录为仓库 ROOT。"""
        parts = _url_parts(path)
        out = str(ROOT)
        for part in parts:
            out = os.path.join(out, part)
        return out

    def list_directory(self, path):
        """禁止目录浏览，避免枚举源码与数据文件。"""
        self.send_error(404, "Not found")
        return None

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        p = urlparse(self.path)
        if p.path in ("/favicon.ico", "/favicon.svg"):
            # 无专用图标时静默 204，避免控制台 404 噪音
            self.send_response(204)
            self.end_headers()
            return
        if p.path.startswith("/api/juzhu"):
            return self._route(p, "GET")
        if not is_public_static(p.path):
            self.send_error(404, "Not found")
            return
        return super().do_GET()

    def do_HEAD(self):
        p = urlparse(self.path)
        if p.path in ("/favicon.ico", "/favicon.svg"):
            self.send_response(204)
            self.end_headers()
            return
        if p.path.startswith("/api/juzhu"):
            return self._route(p, "GET")
        if not is_public_static(p.path):
            self.send_error(404, "Not found")
            return
        return super().do_HEAD()

    def do_POST(self):
        p = urlparse(self.path)
        if p.path.startswith("/api/juzhu"):
            return self._route(p, "POST")
        self._json({"error": "not found"}, 404)

    def do_PUT(self):
        p = urlparse(self.path)
        if p.path.startswith(ADMIN_PREFIX) or p.path.startswith("/api/juzhu/jz"):
            return self._route(p, "PUT")
        self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        p = urlparse(self.path)
        if p.path.startswith(ADMIN_PREFIX) or p.path.startswith("/api/juzhu/jz"):
            return self._route(p, "DELETE")
        self._json({"error": "not found"}, 404)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key")

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

    def _is_production(self):
        return (os.environ.get("JUZHU_ENV") or "").strip().lower() in ("prod", "production")

    def _expected_api_key(self):
        # 唯一来源：环境变量 / .env.local（load_dotenv）；代码内不再写死有效密钥
        key = (os.environ.get(API_KEY_ENV) or "").strip()
        # 空密钥 / 历史开发默认密钥一律无效（文档泄露不再等于未授权）
        if not key or key == DEFAULT_API_KEY:
            return ""
        return key

    def _expected_admin_password(self):
        pwd = (os.environ.get(ADMIN_PASSWORD_ENV) or "").strip()
        if self._is_production():
            if not pwd or pwd == DEFAULT_ADMIN_PASSWORD:
                return ""
            return pwd
        # 开发允许默认密码仅用于本地门禁；API Key 仍须显式配置
        return pwd or DEFAULT_ADMIN_PASSWORD

    def _admin_token_secret(self):
        pwd = self._expected_admin_password().encode("utf-8")
        return hmac.new(ADMIN_TOKEN_SALT, pwd, hashlib.sha256).digest()

    def _issue_admin_token(self):
        exp = int(time.time()) + ADMIN_TOKEN_TTL_SEC
        payload = str(exp)
        sig = hmac.new(self._admin_token_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
        return f"{payload}.{sig}", datetime.fromtimestamp(exp, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _verify_admin_token(self, token):
        if not token or "." not in token:
            return None
        payload, sig = token.rsplit(".", 1)
        try:
            exp = int(payload)
        except ValueError:
            return None
        expect = hmac.new(self._admin_token_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expect, sig):
            return None
        if exp < int(time.time()):
            return None
        return datetime.fromtimestamp(exp, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _provided_bearer(self):
        auth = self.headers.get("Authorization", "").strip()
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return ""

    def _provided_api_key(self):
        bearer = self._provided_bearer()
        if bearer:
            return bearer
        return (self.headers.get("X-API-Key") or "").strip()

    def _require_api_key(self):
        expected = self._expected_api_key()
        provided = self._provided_api_key()
        # 空 expected / 空 provided 一律拒绝，避免 "" == "" 旁路
        ok = bool(expected) and bool(provided) and hmac.compare_digest(
            hashlib.sha256(provided.encode("utf-8")).digest(),
            hashlib.sha256(expected.encode("utf-8")).digest(),
        )
        if ok:
            return True
        self._json(
            {
                "error": "unauthorized",
                "message": f"请通过 Authorization: Bearer <{API_KEY_ENV}> 或 X-API-Key 传入有效 API Key",
            },
            401,
        )
        return False

    def _admin_login(self):
        body = self._body() or {}
        password = (body.get("password") or "").strip()
        expected = self._expected_admin_password()
        # 生产未配置密码时拒绝登录；先哈希再 compare，避免不同长度触发 ValueError / 时序旁路
        ok = bool(expected) and bool(password) and hmac.compare_digest(
            hashlib.sha256(password.encode("utf-8")).digest(),
            hashlib.sha256(expected.encode("utf-8")).digest(),
        )
        if not ok:
            return self._json({"error": "unauthorized", "message": "密码错误"}, 401)
        token, expires_at = self._issue_admin_token()
        return self._json({"token": token, "expires_at": expires_at})

    def _admin_auth_check(self):
        expires_at = self._verify_admin_token(self._provided_bearer())
        if not expires_at:
            return self._json({"error": "unauthorized", "message": "登录已失效，请重新登录"}, 401)
        return self._json({"ok": True, "expires_at": expires_at})

    def _route(self, p, method):
        path = p.path.rstrip("/")
        qs = parse_qs(p.query)

        # === 页面登录门禁（无需 API Key） ===
        if path == f"{ADMIN_PREFIX}/auth/login" and method == "POST":
            return self._admin_login()
        if path == f"{ADMIN_PREFIX}/auth/check" and method == "GET":
            return self._admin_auth_check()

        # === 家政频道 POST 端点（非 admin 路径） ===
        if method in ("POST", "PUT", "DELETE") and path.startswith("/api/juzhu/jz"):
            return self._jiazheng_post(path, qs, method)

        # /api/juzhu/admin/* 全方法（含 GET）均需 API Key；此前仅写接口鉴权 → 读接口未授权
        if path.startswith(ADMIN_PREFIX):
            if not self._require_api_key():
                return
        # wechat-link 为 C 端预约入口，匿名可调（与评价类似）；写单/派单等仍需 API Key
        elif method != "GET" and (
            path == "/api/juzhu/jiazheng/orders"
            or re.match(r"^/api/juzhu/jiazheng/orders/[^/]+/(pay|quote|dispatch|advance)$", path)
        ):
            if not self._require_api_key():
                return

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
            if qs.get("city_id"):
                sql += " AND p.city_id=?"
                params.append(int(qs["city_id"][0]))
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
            return self._get_dictionary(qs)

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
            if method == "GET":
                return self._get_unit(uid)
            if method == "PUT":
                return self._update_unit(uid)
            if method == "DELETE":
                return self._delete_unit(uid)

        if path == "/api/juzhu/jiazheng/orders" and method == "POST":
            return self._create_jz_order()

        m = re.match(r"^/api/juzhu/jiazheng/orders/([^/]+)/pay$", path)
        if m and method == "POST":
            return self._pay_jz_order(m.group(1))

        m = re.match(r"^/api/juzhu/jiazheng/orders/([^/]+)/quote$", path)
        if m and method == "POST":
            return self._quote_jz_order(m.group(1))

        m = re.match(r"^/api/juzhu/jiazheng/orders/([^/]+)/dispatch$", path)
        if m and method == "POST":
            return self._dispatch_jz_order(m.group(1))

        m = re.match(r"^/api/juzhu/jiazheng/orders/([^/]+)/advance$", path)
        if m and method == "POST":
            return self._advance_jz_order(m.group(1))

        m = re.match(r"^/api/juzhu/jiazheng/orders/([^/]+)/rate$", path)
        if m and method == "POST":
            return self._rate_jz_order(m.group(1))

        # === 生成微信小程序 URL Link（需 API Key） ===
        if path == "/api/juzhu/jiazheng/wechat-link" and method == "POST":
            body = self._body()
            return jiazheng_api.handle_wechat_link(self, body)

        # === 生活服务 API 桥接 /api/juzhu/life/* + /api/juzhu/callback + /api/juzhu/jiazheng/vendor/* ===
        if path.startswith("/api/juzhu/life/") or path == "/api/juzhu/callback" or path.startswith("/api/juzhu/jiazheng/vendor/"):
            body = self._body() if method in ("POST", "PUT") else {}
            if jiazheng_api.handle_request(self, method, path, qs, body):
                return

        return self._json({"error": "unknown route", "path": path}, 404)

    def _city_id(self, conn, qs):
        """可选 ?city= 参数（城市名或 slug）→ city_id；未传或未匹配返回 None（= 全部城市）"""
        vals = qs.get("city") or []
        if not vals or not vals[0]:
            return None
        row = conn.execute("SELECT id FROM cities WHERE name=? OR slug=?", (vals[0], vals[0])).fetchone()
        return row[0] if row else None

    def _public_get(self, path, qs):
        conn = connect()
        city_id = self._city_id(conn, qs)
        def city_filter(col="city_id"):
            return f" AND {col}=?" if city_id else ""
        def city_params():
            return (city_id,) if city_id else ()
        if path == "/api/juzhu/cities":
            data = rows_to_list(conn.execute("SELECT * FROM cities ORDER BY id"))
            conn.close()
            return self._json(data)

        if path == "/api/juzhu/stats":
            d = conn.execute("SELECT COUNT(*) c FROM districts" + (" WHERE city_id=?" if city_id else ""), city_params()).fetchone()[0]
            pb = conn.execute("SELECT COUNT(*) c FROM projects WHERE channel='bzf'" + city_filter(), city_params()).fetchone()[0]
            pt = conn.execute("SELECT COUNT(*) c FROM projects WHERE channel='trade'" + city_filter(), city_params()).fetchone()[0]
            u = conn.execute("SELECT COALESCE(SUM(managed_unit_count), 0) c FROM projects WHERE channel='bzf'" + city_filter(), city_params()).fetchone()[0]
            conn.close()
            return self._json({"districts": d, "projects_bzf": pb, "projects_trade": pt, "units": u})

        if path == "/api/juzhu/settings":
            settings = {r[0]: r[1] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
            if city_id:
                row = conn.execute("SELECT booking_phone FROM cities WHERE id=?", (city_id,)).fetchone()
            else:
                row = conn.execute("SELECT booking_phone FROM cities ORDER BY id LIMIT 1").fetchone()
            conn.close()
            return self._json({
                "booking_phone": row[0] if row else None,
                "show_city_switcher": settings.get("show_city_switcher", "1") == "1",
                "show_life_service": settings.get("show_life_service", "1") == "1",
            })

        if path == "/api/juzhu/districts":
            data = rows_to_list(conn.execute("SELECT * FROM districts" + (" WHERE city_id=?" if city_id else "") + " ORDER BY sort_order", city_params()))
            conn.close()
            return self._json(data)

        if path == "/api/juzhu/ratings":
            conn.close()
            return self._list_ratings(qs)

        m = re.match(r"^/api/juzhu/ratings/([^/]+)$", path)
        if m:
            conn.close()
            return self._get_rating(m.group(1))

        # 项目虚拟号：每次实时绑号，不做缓存；须在 slug 路由之前匹配
        m = re.match(r"^/api/juzhu/projects/(\d+)/virtual-phone$", path)
        if m:
            conn.close()
            return self._project_virtual_phone(int(m.group(1)))

        if path.startswith("/api/juzhu/districts/") and path.endswith("/projects"):
            slug = path.split("/")[4]
            dist = row_to_dict(conn.execute("SELECT * FROM districts WHERE slug=?" + (" AND city_id=?" if city_id else ""), (slug,) + city_params()).fetchone())
            if not dist:
                conn.close()
                return self._json({"error": "not found"}, 404)
            projs = [
                strip_contact_phone(row_to_dict(r))
                for r in conn.execute(
                    "SELECT * FROM projects WHERE district_id=? AND channel='bzf' ORDER BY sort_order",
                    (dist["id"],),
                )
            ]
            conn.close()
            return self._json({"district": dist, "projects": projs})

        if path.startswith("/api/juzhu/projects/"):
            parts = path.split("/")
            slug = parts[4] if len(parts) > 4 else ""
            if len(parts) > 5 and parts[5] == "units":
                proj = strip_contact_phone(row_to_dict(conn.execute("SELECT * FROM projects WHERE slug=?" + (" AND city_id=?" if city_id else ""), (slug,) + city_params()).fetchone()))
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
            proj = strip_contact_phone(row_to_dict(conn.execute("SELECT * FROM projects WHERE slug=?" + (" AND city_id=?" if city_id else ""), (slug,) + city_params()).fetchone()))
            conn.close()
            return self._json(proj if proj else {"error": "not found"}, 404 if not proj else 200)

        if path == "/api/juzhu/trade":
            data = [
                strip_contact_phone(row_to_dict(r))
                for r in conn.execute(
                    "SELECT * FROM projects WHERE channel='trade'" + city_filter() + " ORDER BY is_featured DESC, featured_rank, sort_order",
                    city_params(),
                )
            ]
            conn.close()
            return self._json({"listings": data})

        # === 居住服务·家政频道 /api/juzhu/jz/*（P/B 管理台：商家/产品/服务者） ===
        if path == "/api/juzhu/jz/categories":
            type_ = qs.get("type", [None])[0]
            if qs.get("all", ["0"])[0] == "1":
                data = jzdb.list_categories_all(conn)
            else:
                data = jzdb.list_categories(conn, type_)
            conn.close()
            return self._json({"list": data})

        # SPU（平台标准品 = jz_skus）全量列表，供 P 端 SPU 管理台
        if path == "/api/juzhu/jz/spu":
            data = jzdb.list_skus_admin(conn)
            conn.close()
            return self._json({"list": data})

        # 排班档期列表（B 端排班台，按商家 SKU/product 查）
        if path == "/api/juzhu/jz/slots":
            product_id = qs.get("product_id", [None])[0]
            data = jzdb.list_slots_by_product(conn, int(product_id)) if product_id else []
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

        if path == "/api/juzhu/jz/products":
            vendor_id = qs.get("vendor_id", [None])[0]
            type_ = qs.get("type", [None])[0]
            status = qs.get("status", [None])[0]
            data = jzdb.list_products(conn, vendor_id=int(vendor_id) if vendor_id else None,
                                       type_=type_, status=status)
            conn.close()
            return self._json({"list": data})

        if path == "/api/juzhu/jz/workers":
            vendor_id = qs.get("vendor_id", [None])[0]
            if qs.get("all", ["0"])[0] == "1":
                data = jzdb.list_workers(conn, vendor_id=int(vendor_id) if vendor_id else None)
            elif vendor_id:
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

        if path == "/api/juzhu/jz/orders/overview":
            return self._jz_order_overview(conn)

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

        # === 家政 C 端工单流 /api/juzhu/jiazheng/*（SKU + 订单闭环） ===
        if path == "/api/juzhu/jiazheng/categories":
            city_id = _resolve_city_id(conn, qs.get("city", [None])[0])
            if city_id is not None:
                rows = rows_to_list(conn.execute(
                    """SELECT DISTINCT c.* FROM jz_categories c
WHERE c.enabled=1
  AND EXISTS (
    SELECT 1 FROM jz_skus s
    JOIN jz_products p ON p.channel_sku_id=s.id AND p.status='on'
    JOIN jz_vendors v ON v.id=p.vendor_id AND v.status='active'
    WHERE s.category_id=c.id
      AND (
        v.city_ids IS NULL OR TRIM(v.city_ids)=''
        OR (',' || v.city_ids || ',') LIKE '%,' || ? || ',%'
      )
  )
ORDER BY c.sort_order, c.id""", (str(city_id),)
                ))
            else:
                rows = rows_to_list(conn.execute(
                    "SELECT * FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id"
                ))
            conn.close()
            return self._json({"items": rows})

        if path == "/api/juzhu/jiazheng/workers":
            conn.close()
            return self._json({"items": JZ_WORKERS})

        if path == "/api/juzhu/jiazheng/orders/stats":
            if self._provided_api_key() != self._expected_api_key():
                conn.close()
                return self._json({"error": "unauthorized"}, 401)
            return self._jz_order_stats(conn)

        if path == "/api/juzhu/jiazheng/orders":
            if qs.get("phone"):
                return self._list_jz_orders(qs, conn=conn)
            if self._provided_api_key() == self._expected_api_key():
                return self._list_jz_orders(qs, conn=conn)
            conn.close()
            return self._json({"error": "需要 phone 查询参数或有效 API Key"}, 401)

        m = re.match(r"^/api/juzhu/jiazheng/orders/([^/]+)$", path)
        if m:
            row = conn.execute(
                """SELECT o.*, s.name AS sku_name
                   FROM jz_orders o LEFT JOIN jz_products p ON p.id=o.sku_id
                   LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
                   WHERE o.id=?""",
                (m.group(1),),
            ).fetchone()
            if not row:
                conn.close()
                return self._json({"error": "not found"}, 404)
            order = jz_order_view(row, row["sku_name"] if row else None)
            conn.close()
            return self._json({"order": order})

        if path == "/api/juzhu/jiazheng/skus":
            sql = """SELECT s.*, c.name AS category_name, c.icon AS category_icon,
                            (SELECT MIN(p.price) FROM jz_products p
                             WHERE p.channel_sku_id=s.id AND p.status='on') AS product_min_price
                     FROM jz_skus s JOIN jz_categories c ON c.id=s.category_id
                     WHERE s.enabled=1 AND c.enabled=1
                       AND EXISTS (SELECT 1 FROM jz_products p
                                   WHERE p.channel_sku_id=s.id AND p.status='on')"""
            params = []
            # 城市过滤：仅展示在该城市有上架商家的 SPU
            city_id = _resolve_city_id(conn, qs.get("city", [None])[0])
            if city_id is not None:
                sql += """ AND EXISTS (
                        SELECT 1 FROM jz_products p2
                        JOIN jz_vendors v2 ON v2.id=p2.vendor_id
                        WHERE p2.channel_sku_id=s.id AND p2.status='on'
                          AND v2.status='active'
                          AND (
                            v2.city_ids IS NULL OR TRIM(v2.city_ids)=''
                            OR (',' || v2.city_ids || ',') LIKE '%,' || ? || ',%'
                          )
                    )"""
                params.append(str(city_id))
            if qs.get("category"):
                sql += " AND s.category_id=?"
                params.append(qs["category"][0])
            if qs.get("q"):
                q = "%" + qs["q"][0] + "%"
                sql += " AND (s.name LIKE ? OR s.spec LIKE ?)"
                params.extend([q, q])
            sql += " ORDER BY s.category_id, s.sort_order, s.id"
            rows = [normalize_jz_sku_row(r) for r in conn.execute(sql, params).fetchall()]
            conn.close()
            return self._json({"items": rows})

        # C 端：某 SKU 的可约档期（按日期分组由前端处理）
        m = re.match(r"^/api/juzhu/jiazheng/skus/([^/]+)/slots$", path)
        if m:
            srow = conn.execute(
                "SELECT id FROM jz_skus WHERE slug=? AND enabled=1", (m.group(1),)
            ).fetchone()
            vendor_id = qs.get("vendor", [None])[0]
            slots = []
            if srow:
                pid = jzdb.resolve_channel_sku_product_id(conn, srow[0], vendor_id)
                if pid:
                    jzdb.ensure_rolling_slots(conn, pid)  # 滚动排期：始终保有未来 5 天
                    slots = jzdb.list_available_slots_for_product(conn, pid)
            conn.close()
            return self._json({"slots": slots})

        m = re.match(r"^/api/juzhu/jiazheng/skus/([^/]+)$", path)
        if m:
            row = conn.execute(
                """SELECT s.*, c.name AS category_name, c.icon AS category_icon,
                          (SELECT MIN(p.price) FROM jz_products p
                           WHERE p.channel_sku_id=s.id AND p.status='on') AS product_min_price
                   FROM jz_skus s JOIN jz_categories c ON c.id=s.category_id
                   WHERE s.slug=? AND s.enabled=1 AND c.enabled=1""",
                (m.group(1),),
            ).fetchone()
            if not row:
                conn.close()
                return self._json({"error": "not found"}, 404)
            item = normalize_jz_sku_row(row)
            related = [
                normalize_jz_sku_row(r)
                for r in conn.execute(
                    """SELECT * FROM jz_skus
                       WHERE enabled=1 AND category_id=? AND slug<>?
                       ORDER BY sort_order, id LIMIT 4""",
                    (item["category_id"], item["slug"]),
                ).fetchall()
            ]
            vendor_id = qs.get("vendor", [None])[0]
            city_id = _resolve_city_id(conn, qs.get("city", [None])[0])
            detail_context = jzdb.get_detail_context_by_channel_sku(
                conn, item["id"], item.get("category_id"), vendor_id, city_id) or {}
            vendors = jzdb.list_channel_sku_vendors(conn, item["id"], city_id)
            conn.close()
            return self._json({
                "item": item,
                "related": related,
                "product": detail_context.get("product"),
                "vendor": detail_context.get("vendor"),
                "vendors": vendors,          # 多商家同款（比价/切换）
                "workers": detail_context.get("workers") or [],
                "reviews": detail_context.get("reviews") or [],
                "merchant_intro": detail_context.get("merchant_intro"),
            })

        # === 生活服务 API 桥接 /api/juzhu/life/*（GET 请求） ===
        if path.startswith("/api/juzhu/life/"):
            if jiazheng_api.handle_request(self, "GET", path, qs, {}):
                return

        conn.close()
        return self._json({"error": "unknown route"}, 404)

    def _create_jz_order(self):
        b = self._body()
        product_id = b.get("product_id") or b.get("sku_id")  # 兼容旧字段名
        expect_time = (b.get("expectTime") or b.get("expect_time") or "").strip()
        house = (b.get("house") or "").strip()
        phone = (b.get("phone") or "").strip()
        if not product_id or not house or not phone or not expect_time:
            return self._json({"error": "product_id / house / phone / expectTime 为必填"}, 400)

        conn = connect()
        row = conn.execute(
            """SELECT p.*, s.category_id, s.name AS sku_name, c.name AS category_name
               FROM jz_products p
               JOIN jz_skus s ON s.id=p.channel_sku_id
               JOIN jz_categories c ON c.id=s.category_id
               WHERE p.id=? AND p.status='on' AND s.enabled=1 AND c.enabled=1""",
            (int(product_id),),
        ).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "product not found"}, 404)
        product = dict(row)
        # 兼容旧代码：sku 变量用于 fee 兜底
        sku = {"id": product["id"], "price_from": product.get("price"),
               "category_id": product["category_id"], "category_name": product["category_name"]}
        oid = order_id()
        now = now_iso()
        fee = int(b.get("fee") or sku.get("price_from") or 0)
        log = [{"s": "pending", "at": now, "by": "user"}]
        # 客户下单时的档期/首选服务者（来自 SKU 排班或绑定的服务者）
        worker_json = None
        slot_meta = None
        slot_id = b.get("slot_id")
        if slot_id:
            # 下单只「记录档期意向」并做软校验，不占名额——名额在支付时才占用
            # （见 _pay_jz_order 的 book_slot），避免弃单/未支付订单永久泄漏档期座位。
            slot_id = int(slot_id)
            srow = conn.execute(
                """SELECT s.slot_date, s.start_time, s.end_time, s.status, s.booked, s.capacity,
                          w.id AS wid, w.name AS wname, w.level AS wlevel, w.avatar AS wavatar
                   FROM jz_sku_slots s LEFT JOIN jz_workers w ON w.id=s.worker_id
                   WHERE s.id=?""",
                (slot_id,),
            ).fetchone()
            if not srow:
                conn.close()
                return self._json({"error": "档期不存在"}, 404)
            if srow["status"] != "open" or (srow["booked"] or 0) >= (srow["capacity"] or 0):
                conn.close()
                return self._json({"error": "该档期已约满，请重选时间"}, 409)
            slot_meta = {"date": srow["slot_date"], "start": srow["start_time"], "end": srow["end_time"]}
            if srow["wid"]:
                worker = {"id": srow["wid"], "name": srow["wname"],
                          "level": srow["wlevel"], "avatar": srow["wavatar"]}
                worker_json = json_to_db({"preferred": worker, "slot": slot_meta})
            else:
                worker_json = json_to_db({"slot": slot_meta})
        if worker_json is None:
            pref_id = b.get("worker_id") or b.get("preferred_worker_id")
            if pref_id:
                wrow = conn.execute(
                    "SELECT id, name, level, avatar FROM jz_workers WHERE id=?",
                    (int(pref_id),),
                ).fetchone()
                if wrow:
                    worker_json = json_to_db({"preferred": dict(wrow)})
        conn.execute(
            """INSERT INTO jz_orders(
                 id, sku_id, category_id, type, house, phone, expect_time, desc, fee,
                 pay_status, status, slot_id, source, created_at, updated_at, log_json, worker_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'pending', ?, ?, ?, ?, ?, ?)""",
            (
                oid,
                sku["id"],
                sku["category_id"],
                sku["category_name"],
                house,
                phone,
                expect_time,
                b.get("desc"),
                fee,
                slot_id,
                b.get("source") or "新居住频道",
                now,
                now,
                json_to_db(log),
                worker_json,
            ),
        )
        conn.commit()
        order = jz_order_view(
            conn.execute(
                """SELECT o.*, s.name AS sku_name FROM jz_orders o
                   LEFT JOIN jz_products p ON p.id=o.sku_id
                   LEFT JOIN jz_skus s ON s.id=p.channel_sku_id WHERE o.id=?""",
                (oid,),
            ).fetchone()
        )
        conn.close()
        return self._json({"ok": True, "order": order, "sku": sku}, 201)

    def _list_jz_orders(self, qs, conn=None):
        close = conn is None
        if close:
            conn = connect()
        sql = """SELECT o.*, s.name AS sku_name FROM jz_orders o
                 LEFT JOIN jz_products p ON p.id=o.sku_id
                 LEFT JOIN jz_skus s ON s.id=p.channel_sku_id WHERE 1=1"""
        params = []
        if qs.get("phone"):
            sql += " AND o.phone=?"
            params.append(qs["phone"][0].strip())
        if qs.get("pay_status"):
            sql += " AND o.pay_status=?"
            params.append(qs["pay_status"][0])
        if qs.get("status"):
            statuses = [s.strip() for s in qs["status"][0].split(",") if s.strip()]
            if statuses:
                sql += " AND o.status IN (" + ",".join("?" * len(statuses)) + ")"
                params.extend(statuses)
        sql += " ORDER BY o.created_at DESC"
        limit = min(int(qs["limit"][0]), 200) if qs.get("limit") else 100
        sql += " LIMIT ?"
        params.append(limit)
        items = [
            jz_order_view(r, r["sku_name"] if "sku_name" in r.keys() else None)
            for r in conn.execute(sql, params).fetchall()
        ]
        conn.close()
        return self._json({"items": items})

    def _jz_order_stats(self, conn):
        def cnt(where, params=()):
            return conn.execute(f"SELECT COUNT(*) FROM jz_orders WHERE {where}", params).fetchone()[0]

        stats = {
            "pending": cnt("pay_status='paid' AND status='pending'"),
            "dispatched": cnt("status='dispatched'"),
            "accepted": cnt("status='accepted'"),
            "serving": cnt("status='serving'"),
            "done": cnt("status='done'"),
            "rated": cnt("status='rated'"),
            "unpaid": cnt("pay_status='unpaid'"),
            "pool": cnt("pay_status='paid' AND status IN ('pending','dispatched','accepted','serving')"),
            "today_done": cnt("status IN ('done','rated')"),
        }
        conn.close()
        return self._json({"stats": stats})

    def _jz_order_overview(self, conn):
        """订单概览：今日漏斗 + 近15天按日 + 近12月按月（gr_orders 表）"""
        statuses = ["pending", "paid", "assigned", "serving", "completed", "cancelled"]
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        # 今日各状态漏斗
        funnel = {}
        for s in statuses:
            funnel[s] = conn.execute(
                "SELECT COUNT(*) FROM gr_orders WHERE status=? AND date(created_at)=?",
                (s, today),
            ).fetchone()[0]

        # 近15天按日统计
        daily = []
        for i in range(14, -1, -1):
            day = conn.execute(
                "SELECT date('now','localtime','-' || ? || ' days')", (i,)
            ).fetchone()[0]
            row = {"date": day}
            for s in statuses:
                row[s] = conn.execute(
                    "SELECT COUNT(*) FROM gr_orders WHERE status=? AND date(created_at)=?",
                    (s, day),
                ).fetchone()[0]
            daily.append(row)

        # 近12个月按月统计
        monthly = []
        for i in range(11, -1, -1):
            month_label = conn.execute(
                "SELECT strftime('%Y-%m', 'now','localtime','-' || ? || ' months')", (i,)
            ).fetchone()[0]
            row = {"month": month_label}
            for s in statuses:
                row[s] = conn.execute(
                    "SELECT COUNT(*) FROM gr_orders WHERE status=? AND strftime('%Y-%m', created_at)=?",
                    (s, month_label),
                ).fetchone()[0]
            monthly.append(row)

        conn.close()
        return self._json({"funnel": funnel, "daily": daily, "monthly": monthly})

    def _dispatch_jz_order(self, oid):
        b = self._body()
        conn = connect()
        row = conn.execute("SELECT * FROM jz_orders WHERE id=?", (oid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "order not found"}, 404)
        order = normalize_jz_order_row(row)
        if order["pay_status"] != "paid":
            conn.close()
            return self._json({"error": "订单未支付，不可派单"}, 400)
        if order["status"] != "pending":
            conn.close()
            return self._json({"error": "仅待派单状态可派单"}, 400)
        # 客户在档位/详情已选定的首选服务者与档期
        existing = order.get("worker_json") if isinstance(order.get("worker_json"), dict) else {}
        pref = existing.get("preferred") if existing else None
        slot = existing.get("slot") if existing else None
        worker = b.get("worker")
        if not worker:
            if pref and pref.get("name"):
                # 尊重客户选择：直接指派其在档位选定的服务者
                worker = dict(pref)
                worker["from_customer"] = True
            else:
                assigned = conn.execute(
                    "SELECT COUNT(*) FROM jz_orders WHERE status IN ('dispatched','accepted','serving','done','rated')"
                ).fetchone()[0]
                worker = dict(JZ_WORKERS[assigned % len(JZ_WORKERS)])
        # 保留客户预约的档期，便于进度页与服务者履约展示
        if slot and "slot" not in worker:
            worker["slot"] = slot
        now = now_iso()
        log = order.get("log_json") or []
        log.append({"s": "dispatched", "at": now, "by": "platform",
                    "worker": worker.get("name"),
                    "honored": bool(worker.get("from_customer"))})
        conn.execute(
            """UPDATE jz_orders
               SET status='dispatched', worker_json=?, updated_at=?, log_json=?
               WHERE id=?""",
            (json_to_db(worker), now, json_to_db(log), oid),
        )
        conn.commit()
        view = jz_order_view(
            conn.execute(
                """SELECT o.*, s.name AS sku_name FROM jz_orders o
                   LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?""",
                (oid,),
            ).fetchone()
        )
        conn.close()
        return self._json({"ok": True, "order": view})

    def _advance_jz_order(self, oid):
        conn = connect()
        row = conn.execute("SELECT * FROM jz_orders WHERE id=?", (oid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "order not found"}, 404)
        order = normalize_jz_order_row(row)
        try:
            idx = JZ_STATUS_ORDER.index(order["status"])
        except ValueError:
            conn.close()
            return self._json({"error": "invalid status"}, 400)
        if idx < 0 or idx >= len(JZ_STATUS_ORDER) - 1:
            conn.close()
            return self._json({"ok": True, "order": jz_order_view(row)})
        nxt = JZ_STATUS_ORDER[idx + 1]
        if nxt == "rated":
            conn.close()
            return self._json({"error": "评价只能由客户提交"}, 400)
        if order["status"] == "pending":
            conn.close()
            return self._json({"error": "请先由中台派单"}, 400)
        now = now_iso()
        log = order.get("log_json") or []
        log.append({"s": nxt, "at": now, "by": "worker"})
        conn.execute(
            "UPDATE jz_orders SET status=?, updated_at=?, log_json=? WHERE id=?",
            (nxt, now, json_to_db(log), oid),
        )
        conn.commit()
        view = jz_order_view(
            conn.execute(
                """SELECT o.*, s.name AS sku_name FROM jz_orders o
                   LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?""",
                (oid,),
            ).fetchone()
        )
        conn.close()
        return self._json({"ok": True, "order": view})

    def _rate_jz_order(self, oid):
        b = self._body()
        score = int(b.get("score") or 0)
        if score < 1 or score > 5:
            return self._json({"error": "score 须为 1-5"}, 400)
        conn = connect()
        row = conn.execute("SELECT * FROM jz_orders WHERE id=?", (oid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "order not found"}, 404)
        order = normalize_jz_order_row(row)
        if order["status"] != "done":
            conn.close()
            return self._json({"error": "仅已完成待评价订单可评价"}, 400)
        rating = {
            "score": score,
            "tags": b.get("tags") or [],
            "text": (b.get("text") or "").strip(),
        }
        now = now_iso()
        log = order.get("log_json") or []
        log.append({"s": "rated", "at": now, "by": "user", "score": score})
        conn.execute(
            """UPDATE jz_orders
               SET status='rated', rating_json=?, updated_at=?, log_json=?
               WHERE id=?""",
            (json_to_db(rating), now, json_to_db(log), oid),
        )
        conn.commit()
        view = jz_order_view(
            conn.execute(
                """SELECT o.*, s.name AS sku_name FROM jz_orders o
                   LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?""",
                (oid,),
            ).fetchone()
        )
        conn.close()
        return self._json({"ok": True, "order": view})

    def _pay_jz_order(self, oid):
        b = self._body()
        conn = connect()
        row = conn.execute("SELECT * FROM jz_orders WHERE id=?", (oid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "order not found"}, 404)
        order = normalize_jz_order_row(row)
        if order["pay_status"] == "paid":
            # 幂等：已支付也返回与正常分支一致的 jz_order_view 形状（含 worker/expectTime/
            # icon/type 等前端契约字段），避免消费者拿到缺字段的原始行。
            view = jz_order_view(
                conn.execute(
                    """SELECT o.*, s.name AS sku_name FROM jz_orders o
                       LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?""",
                    (oid,),
                ).fetchone()
            )
            conn.close()
            return self._json({"ok": True, "order": view})
        now = now_iso()
        # 名额在支付时才占用：占不到（档期已满/已关）则支付失败，订单保持 unpaid，
        # 让用户改期——避免下单即占、弃单不释放导致的档期座位永久泄漏。
        slot_id = row["slot_id"]
        if slot_id:
            booked = jzdb.book_slot(conn, int(slot_id))
            if not booked.get("ok"):
                conn.close()
                return self._json({"error": booked.get("error") or "该档期已约满，请重选时间"}, 409)
        log = order.get("log_json") or []
        log.append({"s": "paid", "at": now, "by": "user"})
        conn.execute(
            """UPDATE jz_orders
               SET pay_status='paid', pay_method=?, pay_at=?, updated_at=?, log_json=?
               WHERE id=?""",
            (b.get("pay_method") or "贝壳支付", now, now, json_to_db(log), oid),
        )
        conn.commit()
        order = jz_order_view(
            conn.execute(
                """SELECT o.*, s.name AS sku_name FROM jz_orders o
                   LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?""",
                (oid,),
            ).fetchone()
        )
        conn.close()
        return self._json({"ok": True, "order": order})

    def _quote_jz_order(self, oid):
        b = self._body()
        conn = connect()
        row = conn.execute("SELECT * FROM jz_orders WHERE id=?", (oid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "order not found"}, 404)
        order = normalize_jz_order_row(row)
        if order["category_id"] != "repair":
            conn.close()
            return self._json({"error": "仅维修单支持报价"}, 400)
        quote_items = b.get("quote_items") or []
        extra_fee = sum(int(item.get("price") or 0) for item in quote_items)
        now = now_iso()
        log = order.get("log_json") or []
        log.append({"s": "quoted", "at": now, "by": "platform", "extra_fee": extra_fee})
        desc = (order.get("desc") or "").strip()
        if b.get("quote_note"):
            desc = (desc + "\n\n报价说明：" + str(b["quote_note"]).strip()).strip()
        conn.execute(
            """UPDATE jz_orders
               SET fee=?, desc=?, updated_at=?, log_json=?
               WHERE id=?""",
            (int(order["fee"] or 0) + extra_fee, desc, now, json_to_db(log), oid),
        )
        conn.commit()
        order = normalize_jz_order_row(conn.execute("SELECT * FROM jz_orders WHERE id=?", (oid,)).fetchone())
        conn.close()
        return self._json({"ok": True, "order": order, "quote_items": quote_items})

    def _get_project(self, pid):
        conn = connect()
        proj = normalize_project_row(conn.execute(
            """SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?""",
            (pid,),
        ).fetchone(), include_contact_phone=True)
        if not proj:
            conn.close()
            return self._json({"error": "not found"}, 404)
        units = [normalize_unit_row(u) for u in rows_to_list(conn.execute(
            "SELECT * FROM units WHERE project_id=? ORDER BY sort_order", (pid,)
        ))]
        photos = rows_to_list(conn.execute(
            """SELECT * FROM photos WHERE entity_type='unit'
               AND entity_id IN (SELECT id FROM units WHERE project_id=?)
               ORDER BY entity_id, sort_order, id""",
            (pid,),
        ))
        conn.close()
        return self._json({"project": proj, "units": units, "photos": photos})

    def _project_virtual_phone(self, pid):
        """C 端实时取虚拟号：查项目真实号 → TP alloc → 只回虚拟号字段。"""
        conn = connect()
        row = conn.execute(
            "SELECT id, contact_phone, name FROM projects WHERE id=?", (pid,)
        ).fetchone()
        conn.close()
        if not row:
            return self._json({"error": "not found"}, 404)
        real = (row["contact_phone"] or "").strip()
        if not real:
            return self._json({"error": "未配置联系电话"}, 400)
        try:
            result = alloc_virtual_phone(real, app_call_id=f"juzhu-project-{pid}")
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except TpError as e:
            print(
                f"[tp] project={pid} phone={mask_phone(real)} errno={e.errno} err={e}",
                flush=True,
            )
            return self._json({"error": "暂时无法接通，请稍后重试"}, 502)
        return self._json({
            "virtual_phone": result["virtual_phone"],
            "display": result["display"],
            "tel": result["tel"],
        })

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
    def _jiazheng_post(self, path, qs, method_alt="POST"):
        """处理 /api/juzhu/jz/* POST/PUT/DELETE 请求"""
        # 家政 P/B 管理台的全部写接口（类目/SPU/档期/商家 SKU/服务者/订单状态）均需
        # API Key——此前路由在鉴权块之前就 return，导致这些接口可匿名调用（CLAUDE.md 规则 9）。
        if not self._require_api_key():
            return
        conn = connect()
        try:
            body = self._body()

            if path == "/api/juzhu/jz/orders":
                product_id = body.get("product_id") or body.get("sku_id")  # 兼容旧字段名
                if not product_id:
                    return self._json(
                        {"error": "需要 product_id"},
                        400,
                    )
                house = (body.get("address") or body.get("house") or "").strip()
                phone = (body.get("phone") or "").strip()
                expect_time = (body.get("scheduled_at") or body.get("expectTime") or "").strip()
                if not house or not phone or not expect_time:
                    return self._json({"error": "address / phone / scheduled_at 为必填"}, 400)
                row = conn.execute(
                    """SELECT p.*, s.category_id, c.name AS category_name
                       FROM jz_products p
                       JOIN jz_skus s ON s.id=p.channel_sku_id
                       JOIN jz_categories c ON c.id=s.category_id
                       WHERE p.id=? AND p.status='on' AND s.enabled=1 AND c.enabled=1""",
                    (int(product_id),),
                ).fetchone()
                if not row:
                    return self._json({"error": "product not found"}, 404)
                product = dict(row)
                oid = order_id()
                now = now_iso()
                fee = int(body.get("fee") or product.get("price") or 0)
                log = [{"s": "pending", "at": now, "by": "user"}]
                conn.execute(
                    """INSERT INTO jz_orders(
                         id, sku_id, category_id, type, house, phone, expect_time, desc, fee,
                         pay_status, status, source, created_at, updated_at, log_json
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'pending', ?, ?, ?, ?)""",
                    (
                        oid,
                        product["id"],
                        product["category_id"],
                        product["category_name"],
                        house,
                        phone,
                        expect_time,
                        body.get("desc") or body.get("product_title"),
                        fee,
                        body.get("source") or "B端产品",
                        now,
                        now,
                        json_to_db(log),
                    ),
                )
                conn.commit()
                created = jzdb.get_order(conn, oid)
                return self._json({"ok": True, "order": created}, 201)

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
                try:
                    score = int(body.get("score", 5))
                except (TypeError, ValueError):
                    return self._json({"error": "score 须为 1-5 的整数"}, 400)
                if not 1 <= score <= 5:
                    return self._json({"error": "score 须在 1-5 之间"}, 400)
                tags = body.get("tags", [])
                text = body.get("text", "")
                credit_delta = 2.4 if score >= 5 else (1.2 if score >= 4 else (-1.5 if score >= 2 else -3.0))
                jzdb.rate_order(conn, oid, score, tags, text, credit_delta)
                conn.commit()
                return self._json({"ok": True, "credit_delta": credit_delta})

            # === P 端·类目管理 CRUD ===
            if path == "/api/juzhu/jz/categories" and method_alt == "POST":
                cid = jzdb.create_category(conn, body)
                conn.commit()
                return self._json({"ok": True, "id": cid})
            m = re.match(r"^/api/juzhu/jz/categories/(\d+)$", path)
            if m and method_alt == "PUT":
                ok = jzdb.update_category(conn, int(m.group(1)), body)
                conn.commit()
                return self._json({"ok": ok})
            if m and method_alt == "DELETE":
                result = jzdb.delete_category(conn, int(m.group(1)))
                conn.commit()
                return self._json(result, 200 if result.get("ok") else 400)

            # === P 端·SPU 管理 CRUD（平台标准品，操作 jz_skus）===
            if path == "/api/juzhu/jz/spu" and method_alt == "POST":
                sid = jzdb.create_sku(conn, body)
                conn.commit()
                return self._json({"ok": True, "id": sid})
            m = re.match(r"^/api/juzhu/jz/spu/(\d+)$", path)
            if m and method_alt == "PUT":
                ok = jzdb.update_sku(conn, int(m.group(1)), body)
                conn.commit()
                return self._json({"ok": ok})
            if m and method_alt == "DELETE":
                result = jzdb.delete_sku(conn, int(m.group(1)))
                conn.commit()
                return self._json(result, 200 if result.get("ok") else 400)

            # === B 端·排班档期 CRUD ===
            if path == "/api/juzhu/jz/slots/generate" and method_alt == "POST":
                n = jzdb.generate_slots(
                    conn, int(body["product_id"]), body.get("worker_ids") or [],
                    body.get("dates") or [], body.get("times") or [],
                    int(body.get("capacity", 1) or 1),
                )
                conn.commit()
                return self._json({"ok": True, "created": n})
            if path == "/api/juzhu/jz/slots" and method_alt == "POST":
                sid = jzdb.create_slot(conn, body)
                conn.commit()
                return self._json({"ok": True, "id": sid})
            m = re.match(r"^/api/juzhu/jz/slots/(\d+)$", path)
            if m and method_alt == "PUT":
                result = jzdb.set_slot_status(conn, int(m.group(1)), body.get("status"))
                conn.commit()
                return self._json(result)
            if m and method_alt == "DELETE":
                result = jzdb.delete_slot(conn, int(m.group(1)))
                conn.commit()
                return self._json(result, 200 if result.get("ok") else 400)

            # === B 端·产品管理 CRUD ===
            if path == "/api/juzhu/jz/products" and method_alt == "POST":
                pid = jzdb.create_product(conn, body)
                conn.commit()
                return self._json({"ok": True, "id": pid})
            m = re.match(r"^/api/juzhu/jz/products/(\d+)$", path)
            if m and method_alt == "PUT":
                ok = jzdb.update_product(conn, int(m.group(1)), body)
                conn.commit()
                return self._json({"ok": ok})
            if m and method_alt == "DELETE":
                result = jzdb.delete_product(conn, int(m.group(1)))
                conn.commit()
                return self._json(result)

            # === B 端·服务者管理 CRUD ===
            if path == "/api/juzhu/jz/workers" and method_alt == "POST":
                wid = jzdb.create_worker(conn, body)
                conn.commit()
                return self._json({"ok": True, "id": wid})
            m = re.match(r"^/api/juzhu/jz/workers/(\d+)$", path)
            if m and method_alt == "PUT":
                ok = jzdb.update_worker(conn, int(m.group(1)), body)
                conn.commit()
                return self._json({"ok": ok})
            if m and method_alt == "DELETE":
                result = jzdb.delete_worker(conn, int(m.group(1)))
                conn.commit()
                return self._json(result)

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

        # 局部更新：只写「请求体里出现过的字段」，缺失字段保持原值不动。
        # 修复：前端项目表单只发 name/address/tags/sort/price/cover 与 old_house_hint
        # 或 managed_unit_count，从不发 is_featured/featured_rank；旧逻辑用「=?」硬写
        # featured_rank，会把精选排序抹成 NULL（is_featured 却因 COALESCE 保留，精选态错位）。
        sets, vals = [], []

        def put(col, val):
            sets.append(col + "=?")
            vals.append(val)

        if "name" in b:
            name = b.get("name")
            put("name", name)
            put("slug", b.get("slug") or (slugify(name) if name else None))
        elif "slug" in b:
            put("slug", b.get("slug"))
        for col in ("address", "cover_image", "sort_order", "price_from",
                    "is_featured", "featured_rank", "old_house_hint"):
            if col in b:
                put(col, b.get(col))
        if "contact_phone" in b:
            try:
                put("contact_phone", validate_real_phone(b.get("contact_phone")))
            except ValueError as e:
                conn.close()
                return self._json({"error": str(e)}, 400)
        if "tags" in b:
            put("tags", tags_to_db(b.get("tags")))
        if "managed_unit_count" in b:
            val = b.get("managed_unit_count")
            put("managed_unit_count", int(val) if val is not None and val != "" else None)
        if "rating" in b:
            row = conn.execute("SELECT rating_status FROM projects WHERE id=?", (pid,)).fetchone()
            if row and row[0] in ("draft", "rejected", None):
                rating = b.get("rating") or {}
                dims = rating.get("dims") or {}
                if dims:
                    rating.update(summarize_rating(dims))
                rating["code"] = rating_code(pid)
                put("rating", rating_to_db(rating))

        if sets:
            vals.append(pid)
            conn.execute("UPDATE projects SET " + ", ".join(sets) + " WHERE id=?", vals)
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
        ).fetchone(), include_contact_phone=True)
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

    def _unique_unit_slug(self, conn, project_id, name, slug=None, exclude_id=None):
        # 户型 slug 在项目内需唯一：slugify 不转写中文，两个同名（或都用默认名）户型会
        # 生成相同 slug，详情页 unitBySlug 用 find 命中首个 → 第二个户型不可达/串数据。
        base = slug or slugify(name) or "unit"
        candidate = base
        n = 1
        while conn.execute(
            "SELECT id FROM units WHERE project_id=? AND slug=? AND id IS NOT ?",
            (project_id, candidate, exclude_id),
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
        city_id = b.get("city_id")
        if not city_id:
            city = conn.execute("SELECT id FROM cities LIMIT 1").fetchone()
            city_id = city[0] if city else None
        if not city_id:
            conn.close()
            return self._json({"error": "未配置城市"}, 500)

        district_id = b.get("district_id")
        if channel == "bzf":
            if not district_id:
                conn.close()
                return self._json({"error": "保租房项目须选择行政区"}, 400)
            if not conn.execute("SELECT id FROM districts WHERE id=? AND city_id=?", (district_id, city_id)).fetchone():
                conn.close()
                return self._json({"error": "行政区不存在或不属于当前城市"}, 400)
        else:
            district_id = None

        slug = self._unique_project_slug(conn, channel, name, b.get("slug"))
        dist = conn.execute("SELECT name FROM districts WHERE id=?", (district_id,)).fetchone() if district_id else None
        address = b.get("address") or (f"{dist[0]} · {name}" if dist else f"沈阳 · {name}")

        try:
            contact_phone = validate_real_phone(b.get("contact_phone")) if "contact_phone" in b else None
        except ValueError as e:
            conn.close()
            return self._json({"error": str(e)}, 400)

        conn.execute(
            """INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
               sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint,contact_phone)
               VALUES (?,?,?,?,?,?,?,?,?,0,?,COALESCE(?,0),?,?,?)""",
            (
                city_id, district_id, channel, name, slug,
                b.get("cover_image"), address, tags_to_db(b.get("tags")),
                b.get("sort_order") or 999, b.get("price_from"),
                b.get("is_featured"), b.get("featured_rank"), b.get("old_house_hint"),
                contact_phone,
            ),
        )
        pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        if district_id:
            sync_district_stats(conn, district_id)
        export_json(conn)
        proj = normalize_project_row(conn.execute(
            """SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?""",
            (pid,),
        ).fetchone(), include_contact_phone=True)
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
        slug = self._unique_unit_slug(conn, pid, name, b.get("slug"))
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

    def _get_unit(self, uid):
        conn = connect()
        unit = normalize_unit_row(conn.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone())
        if not unit:
            conn.close()
            return self._json({"error": "not found"}, 404)
        photos = rows_to_list(conn.execute(
            "SELECT * FROM photos WHERE entity_type='unit' AND entity_id=? ORDER BY sort_order",
            (uid,),
        ))
        conn.close()
        return self._json({"unit": unit, "photos": photos})

    def _update_unit(self, uid):
        b = self._body()
        conn = connect()
        row = conn.execute("SELECT project_id FROM units WHERE id=?", (uid,)).fetchone()
        if not row:
            conn.close()
            return self._json({"error": "not found"}, 404)
        pid = row[0]

        # 局部更新：只写「请求体里出现过的字段」，缺失字段保持原值不动。
        sets, vals = [], []

        def put(col, val):
            sets.append(col + "=?")
            vals.append(val)

        if "name" in b:
            name = b.get("name")
            put("name", name)
            put("slug", self._unique_unit_slug(conn, pid, name, b.get("slug"), exclude_id=uid))
        elif "slug" in b:
            put("slug", self._unique_unit_slug(conn, pid, None, b.get("slug"), exclude_id=uid))
        for col in ("area_sqm", "layout_label", "rent_monthly", "price_total",
                    "unit_spec", "promo_price", "sort_order", "cover_image"):
            if col in b:
                put(col, b.get(col))
        if "tags" in b:
            put("tags", tags_to_db(b.get("tags")))
        if "amenities" in b:
            put("amenities", json_to_db(b.get("amenities")))
        if "keeper" in b:
            put("keeper", json_to_db(b.get("keeper")))
        if "rent_detail" in b:
            put("rent_detail", json_to_db(b.get("rent_detail")))

        if sets:
            vals.append(uid)
            conn.execute("UPDATE units SET " + ", ".join(sets) + " WHERE id=?", vals)
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
            elif scope == "unit_cover":
                uid = int(mp["fields"].get("unit_id") or 0)
                if not conn.execute("SELECT id FROM units WHERE id=?", (uid,)).fetchone():
                    conn.close()
                    return self._json({"error": "unit not found"}, 404)
                row = conn.execute(
                    "SELECT u.name AS unit_name, p.name AS project_name, p.channel "
                    "FROM units u JOIN projects p ON p.id=u.project_id WHERE u.id=?",
                    (uid,),
                ).fetchone()
                unit_name = safe_path_name(row["unit_name"]) if row else f"unit_{uid}"
                rel = Path(ASSETS_PREFIX) / "units" / (row["channel"] or "bzf") / safe_path_name(row["project_name"] or "project") / f"{unit_name}{ext}"
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
        conn.commit()  # 关键：确保 cover_image 同步被提交，避免连接关闭时回滚
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
        conn.commit()  # 关键：确保 cover_image 同步被提交，避免连接关闭时回滚
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
        conn.commit()  # 关键：确保 cover_image 同步被提交，避免连接关闭时回滚
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
        conn.commit()  # 关键：确保 cover_image 同步被提交，避免连接关闭时回滚
        export_json(conn)
        conn.close()
        return self._json({"ok": True})

    def _get_settings(self):
        conn = connect()
        row = conn.execute("SELECT booking_phone FROM cities ORDER BY id LIMIT 1").fetchone()
        settings = {r[0]: r[1] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
        conn.close()
        return self._json({
            "booking_phone": row[0] if row else None,
            "show_city_switcher": settings.get("show_city_switcher", "1") == "1",
            "show_life_service": settings.get("show_life_service", "1") == "1",
        })

    def _update_settings(self):
        body = self._body()
        phone = (body.get("booking_phone") or "").strip() or None
        conn = connect()
        if phone is not None:
            cid = body.get("city_id")
            if cid:
                conn.execute("UPDATE cities SET booking_phone=? WHERE id=?", (phone, cid))
            else:
                conn.execute(
                    "UPDATE cities SET booking_phone=? WHERE id=(SELECT id FROM cities ORDER BY id LIMIT 1)",
                    (phone,),
                )
        bool_keys = ["show_city_switcher", "show_life_service"]
        for k in bool_keys:
            if k in body:
                v = "1" if body.get(k) else "0"
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (k, v),
                )
        conn.commit()
        export_json(conn)
        conn.close()
        return self._json({"ok": True, "booking_phone": phone})

    def _get_dictionary(self, qs=None):
        conn = connect()
        qs = qs or {}
        city_id = self._city_id(conn, qs)
        if city_id:
            city = row_to_dict(conn.execute("SELECT * FROM cities WHERE id=?", (city_id,)).fetchone())
            districts = rows_to_list(conn.execute("SELECT * FROM districts WHERE city_id=? ORDER BY sort_order, id", (city_id,)))
        else:
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
        cid = body.get("city_id")
        if not cid:
            row = conn.execute("SELECT id FROM cities ORDER BY id LIMIT 1").fetchone()
            cid = row[0] if row else None
        if not cid:
            conn.close()
            return self._json({"error": "未找到城市"}, 404)
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
        city_id = body.get("city_id")
        if not city_id:
            city = conn.execute("SELECT id FROM cities ORDER BY id LIMIT 1").fetchone()
            city_id = city[0] if city else None
        if not city_id:
            conn.close()
            return self._json({"error": "请先配置城市"}, 400)
        slug = (body.get("slug") or name).strip() or name
        if conn.execute("SELECT id FROM districts WHERE city_id=? AND slug=?", (city_id, slug)).fetchone():
            conn.close()
            return self._json({"error": "slug 已存在"}, 400)
        conn.execute(
            """INSERT INTO districts(city_id,name,slug,note,sort_order,cover_image,has_projects)
               VALUES (?,?,?,?,?,?,?)""",
            (
                city_id,
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
    loaded = load_dotenv()
    port = 8765
    print(f"新居住服务  http://localhost:{port}")
    print(f"  前台  /index.html")
    print(f"  后台  /juzhu-admin.html")
    print(f"  API   /api/juzhu/admin/*  ·  /api/juzhu/jiazheng/*")
    if loaded:
        print("  env   " + ", ".join(str(p.name) for p in loaded))
    else:
        print("  env   （未找到 .env.local / .env；TP_* 需已 export）")
    tp_ready = bool(os.environ.get("TP_APP_ID") and os.environ.get("TP_APP_KEY"))
    print(f"  TP    {'已配置' if tp_ready else '未配置（拨号虚拟号不可用）'}  BASE={os.environ.get('TP_BASE') or 'http://tp-test.lianjia.com'}")
    env_name = (os.environ.get("JUZHU_ENV") or "dev").strip().lower()
    api_key = (os.environ.get(API_KEY_ENV) or "").strip()
    admin_pwd = (os.environ.get(ADMIN_PASSWORD_ENV) or "").strip()
    api_set = bool(api_key)
    admin_set = bool(admin_pwd)
    print(f"  mode  JUZHU_ENV={env_name}  API_KEY={'已配置' if api_set and api_key != DEFAULT_API_KEY else '未配置/无效'}  ADMIN_PWD={'已配置' if admin_set else '使用开发默认'}")
    print("  auth  /api/juzhu/admin/* 全方法需 API Key（auth/login|check 除外）；禁止历史默认密钥")
    print("  static 已拦截 .env / *.py / *.db / *.md / api 文档页；生产禁用 /docs/")
    if not api_set or api_key == DEFAULT_API_KEY:
        print(f"  WARN  未配置有效 {API_KEY_ENV}（禁止 {DEFAULT_API_KEY}）— admin API 将全部 401")
    if env_name in ("prod", "production"):
        bad = []
        if not api_set or api_key == DEFAULT_API_KEY:
            bad.append(f"{API_KEY_ENV}（须显式配置且不得为开发示例 {DEFAULT_API_KEY}）")
        if not admin_set or admin_pwd == DEFAULT_ADMIN_PASSWORD:
            bad.append(f"{ADMIN_PASSWORD_ENV}（须显式配置且不得为开发默认值）")
        if bad:
            print("  FATAL 生产环境拒绝启动：" + "；".join(bad))
            sys.exit(1)
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
