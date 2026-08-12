"""话务平台 TP 绑定虚拟号客户端（仅服务端）。

规范：docs/tp-sign-and-call.md
环境变量：TP_BASE / TP_APP_ID / TP_APP_KEY
本地可写在 juzhu/.env.local（gitignore），由 load_dotenv() 注入。
默认 Base：http://tp-test.lianjia.com（测试）；线上 http://i.tp.lianjia.com（内网）
本业务约定：不传 port；不做虚拟号缓存。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_TP_BASE = "http://tp-test.lianjia.com"
ONLINE_TP_BASE = "http://i.tp.lianjia.com"
_ENV_DIR = Path(__file__).resolve().parent
_ENV_FILES = (_ENV_DIR / ".env.local", _ENV_DIR / ".env")


def load_dotenv(*, override: bool = False) -> list[Path]:
    """加载 juzhu/.env.local、juzhu/.env（后者可作回退）。

    默认不覆盖已在进程环境中的变量。返回实际读入的文件列表。
    """
    loaded: list[Path] = []
    for path in _ENV_FILES:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            if not key:
                continue
            val = val.strip()
            if (val.startswith('"') and val.endswith('"')) or (
                val.startswith("'") and val.endswith("'")
            ):
                val = val[1:-1]
            if not override and key in os.environ and os.environ.get(key, "") != "":
                continue
            os.environ[key] = val
        loaded.append(path)
    return loaded



class TpError(Exception):
    def __init__(self, message: str, *, errno=None, http_status=None):
        super().__init__(message)
        self.errno = errno
        self.http_status = http_status


def tp_config() -> dict:
    return {
        "base": (os.environ.get("TP_BASE") or DEFAULT_TP_BASE).strip().rstrip("/"),
        "app_id": (os.environ.get("TP_APP_ID") or "").strip(),
        "app_key": (os.environ.get("TP_APP_KEY") or "").strip(),
    }


def mask_phone(phone: str | None) -> str:
    digits = re.sub(r"\D", "", str(phone or ""))
    if len(digits) < 7:
        return "***"
    return digits[:3] + "****" + digits[-4:]


def validate_real_phone(phone: str | None) -> str | None:
    """空 → None；非法 → ValueError。返回纯数字真实号。"""
    if phone is None:
        return None
    raw = str(phone).strip()
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if not digits.isdigit() or not (11 <= len(digits) <= 13):
        raise ValueError("联系电话须为 11–13 位数字")
    if digits.startswith("400"):
        raise ValueError("请填写真实号码，勿填 400 虚拟号")
    return digits


def generate_sign(params: dict, app_key: str) -> str:
    data = {
        k: v
        for k, v in params.items()
        if k != "sign" and v is not None and str(v).strip() != ""
    }
    items = sorted((str(k).strip(), str(v).strip()) for k, v in data.items())
    raw = "&".join(f"{k}={v}" for k, v in items) + f"&app_key={app_key}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def format_virtual_phone(raw: str) -> dict:
    """4008891279-0355 → display / tel。"""
    virtual = (raw or "").strip()
    if not virtual:
        raise TpError("话务未返回虚拟号")
    main, _, ext = virtual.partition("-")
    main_digits = re.sub(r"\D", "", main)
    ext_digits = re.sub(r"\D", "", ext)
    if len(main_digits) >= 10:
        display_main = f"{main_digits[:3]} {main_digits[3:6]} {main_digits[6:]}"
    else:
        display_main = main_digits or main
    display = display_main + (f" 转 {ext_digits}" if ext_digits else "")
    tel = "tel:" + main_digits + (f",{ext_digits}" if ext_digits else "")
    return {
        "virtual_phone": virtual,
        "display": display,
        "tel": tel,
    }


def call_alloc(*, number: str, app_call_id: str | None = None) -> dict:
    """实时请求 /bundling/alloc，不做缓存。返回 format_virtual_phone 结果。"""
    cfg = tp_config()
    if not cfg["app_id"] or not cfg["app_key"]:
        raise TpError("TP_APP_ID/TP_APP_KEY 未配置")

    real = validate_real_phone(number)
    if not real:
        raise TpError("真实号码为空")

    params: dict[str, str] = {
        "app_id": str(cfg["app_id"]),
        "ts": str(int(time.time())),
        "number": real,
    }
    if app_call_id:
        params["app_call_id"] = str(app_call_id)

    params["sign"] = generate_sign(params, cfg["app_key"])
    url = cfg["base"] + "/bundling/alloc?" + urllib.parse.urlencode(params)

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "juzhu-tp-client/1.0", "Accept": "application/json"},
    )
    try:
        with opener.open(req, timeout=20) as resp:
            body_text = resp.read().decode("utf-8", errors="replace")
            http_status = getattr(resp, "status", 200)
    except Exception as e:
        raise TpError(f"话务请求失败: {type(e).__name__}") from e

    try:
        body = json.loads(body_text)
    except json.JSONDecodeError as e:
        raise TpError("话务响应非 JSON", http_status=http_status) from e

    errno = body.get("errno")
    if errno not in (0, "0", None):
        raise TpError(
            body.get("errmsg") or f"话务错误 errno={errno}",
            errno=errno,
            http_status=http_status,
        )

    data = body.get("data") or []
    if not data:
        raise TpError("话务未返回绑定结果", errno=errno, http_status=http_status)
    item = data[0] if isinstance(data, list) else data
    if isinstance(item, dict):
        item_errno = item.get("errno")
        if item_errno not in (0, "0", None):
            raise TpError(
                item.get("errmsg") or f"绑定失败 errno={item_errno}",
                errno=item_errno,
                http_status=http_status,
            )
        virtual = item.get("virtual_phone_number") or item.get("virtual_phone")
    else:
        virtual = None
    return format_virtual_phone(virtual or "")


def alloc_virtual_phone(number: str, *, app_call_id: str | None = None) -> dict:
    """对外别名：每次调用均实时请求话务。"""
    return call_alloc(number=number, app_call_id=app_call_id)
