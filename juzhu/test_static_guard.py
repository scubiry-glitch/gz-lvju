#!/usr/bin/env python3
"""静态敏感路径拦截单测（与 app.js isPublicStatic 对齐）。"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402


def assert_block(path):
    assert not server.is_public_static(path), f"should block {path}"


def assert_allow(path):
    assert server.is_public_static(path), f"should allow {path}"


def main():
    for p in (
        "/.env",
        "/.env.prod",
        "/.env.local",
        "/package.json",
        "/.gitignore",
        "/README.md",
        "/CLAUDE.md",
        "/api_doc.md",
        "/docs/api-document.html",
        "/docs/tp-sign-and-call.md",
        "/docs/xjz-api.html",
        "/juzhu/server.py",
        "/juzhu/.env",
        "/app.js",
        "/scf_bootstrap",
        "/moma_deploy.js",
        "/scripts/tp_bundling_alloc.py",
        "/node_modules/mysql2/package.json",
    ):
        assert_block(p)

    for p in (
        "/",
        "/index.html",
        "/juzhu/app.js",
        "/juzhu/cities.json",
        "/juzhu/data.json",
        "/juzhu/data-guiyang.json",
        "/screens/p-jz-product.html",
    ):
        assert_allow(p)

    # 生产禁用整棵 /docs/
    old = os.environ.get("JUZHU_ENV")
    os.environ["JUZHU_ENV"] = "production"
    try:
        assert_block("/docs/region-abstraction-plan.md")
        assert_block("/docs/anything.html")
    finally:
        if old is None:
            os.environ.pop("JUZHU_ENV", None)
        else:
            os.environ["JUZHU_ENV"] = old

    # 历史默认 API Key 一律无效
    old_key = os.environ.get("JUZHU_API_KEY")
    os.environ["JUZHU_API_KEY"] = "dev-juzhu-key"
    try:
        h = server.Handler
        # 用实例方法绑定需 RequestHandler；直接测模块级逻辑经 Handler 原型
        class _H(server.Handler):  # type: ignore
            def __init__(self):  # noqa: D107
                pass

        assert _H()._expected_api_key() == ""
    finally:
        if old_key is None:
            os.environ.pop("JUZHU_API_KEY", None)
        else:
            os.environ["JUZHU_API_KEY"] = old_key

    os.environ["JUZHU_API_KEY"] = "unit-test-only-key"
    try:
        class _H2(server.Handler):  # type: ignore
            def __init__(self):
                pass

        assert _H2()._expected_api_key() == "unit-test-only-key"
    finally:
        if old_key is None:
            os.environ.pop("JUZHU_API_KEY", None)
        else:
            os.environ["JUZHU_API_KEY"] = old_key

    print("ok: static guard + api key policy")


if __name__ == "__main__":
    main()
