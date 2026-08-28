#!/usr/bin/env python3
"""链家 TP 绑定号码 /bundling/alloc 服务端联调客户端。

规范见 docs/tp-sign-and-call.md。密钥仅环境变量，禁止写进前端或提交仓库。

签名规则（与官方 PHP 示例对齐）：
  1. 去掉 sign；跳过空值
  2. key 正向排序，拼 key=value&...
  3. 末尾追加 &app_key=XXX
  4. md5

本业务约定：不传 port。

用法：
  # 推荐：juzhu/.env.local 写好 TP_* 后
  python3 scripts/tp_bundling_alloc.py --number 13800138000

  # 或 export
  export TP_APP_ID=...
  export TP_APP_KEY=...
  export TP_BASE=http://tp-test.lianjia.com   # 线上为内网 i.tp
  python3 scripts/tp_bundling_alloc.py --number 13800138000
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# 与 juzhu/server.py 共用 .env.local 加载
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "juzhu"))
try:
    from tp_client import load_dotenv  # noqa: E402
except ImportError:
    load_dotenv = None


def generate_sign(params: dict, app_key: str) -> tuple[str, str]:
    data = {
        k: v
        for k, v in params.items()
        if k != "sign" and v is not None and str(v).strip() != ""
    }
    items = sorted((str(k).strip(), str(v).strip()) for k, v in data.items())
    raw = "&".join(f"{k}={v}" for k, v in items) + f"&app_key={app_key}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest(), raw


def call_alloc(
    *,
    base: str,
    app_id: str,
    app_key: str,
    number: str | None = None,
    uc_id: str | None = None,
    port: str | None = None,
    city_id: str | None = None,
    app_call_id: str | None = None,
    app_data: str | None = None,
    expire_time: str | None = None,
    dry_run: bool = False,
) -> dict:
    params: dict[str, str] = {
        "app_id": str(app_id),
        "ts": str(int(time.time())),
    }
    if number:
        params["number"] = number
    if uc_id:
        params["uc_id"] = uc_id
    if port:
        params["port"] = port
    if city_id:
        params["city_id"] = city_id
    if app_call_id:
        params["app_call_id"] = app_call_id
    if app_data:
        params["app_data"] = app_data
    if expire_time:
        params["expire_time"] = expire_time

    sign, raw = generate_sign(params, app_key)
    params["sign"] = sign
    url = base.rstrip("/") + "/bundling/alloc?" + urllib.parse.urlencode(params)

    result = {"sign_raw": raw, "sign": sign, "url": url}
    if dry_run:
        return result

    # 本机若开了系统 HTTP 代理，直连内网域名可能超时；强制无代理
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "tp-bundling-alloc/1.0", "Accept": "application/json"},
    )
    with opener.open(req, timeout=20) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        result["http_status"] = resp.status
        try:
            result["body"] = json.loads(body)
        except json.JSONDecodeError:
            result["body"] = body
    return result


def main() -> int:
    if load_dotenv:
        load_dotenv()
    p = argparse.ArgumentParser(description="TP 绑定号码 /bundling/alloc")
    p.add_argument("--number", help="被叫号码，多个用逗号分隔")
    p.add_argument("--uc-id", help="用户 ID；有则 number 失效")
    p.add_argument("--port", help="绑定渠道")
    p.add_argument("--city-id", help="城市编码，如 110000")
    p.add_argument("--app-call-id", help="业务绑定关系唯一 ID")
    p.add_argument("--app-data", help="随路数据")
    p.add_argument("--expire-time", help="过期时间 Y-m-d H:i:s")
    p.add_argument("--dry-run", action="store_true", help="只打印签名与 URL，不发请求")
    args = p.parse_args()

    app_id = os.environ.get("TP_APP_ID", "").strip()
    app_key = os.environ.get("TP_APP_KEY", "").strip()
    base = os.environ.get("TP_BASE", "http://tp-test.lianjia.com").strip()

    if not app_id or not app_key:
        print("请先设置环境变量 TP_APP_ID / TP_APP_KEY", file=sys.stderr)
        return 2
    if not args.number and not args.uc_id:
        print("需要 --number 或 --uc-id", file=sys.stderr)
        return 2

    try:
        out = call_alloc(
            base=base,
            app_id=app_id,
            app_key=app_key,
            number=args.number,
            uc_id=args.uc_id,
            port=args.port,
            city_id=args.city_id,
            app_call_id=args.app_call_id,
            app_data=args.app_data,
            expire_time=args.expire_time,
            dry_run=args.dry_run,
        )
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False, indent=2))
        return 1

    # 不回显 app_key
    print(json.dumps(out, ensure_ascii=False, indent=2))
    body = out.get("body")
    if isinstance(body, dict) and body.get("errno") not in (0, "0", None):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
