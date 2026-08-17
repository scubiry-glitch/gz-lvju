# 商家密钥配置迁入 jz_vendors 表 Implementation Plan

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.
> 设计文档：`docs/plans/2026-08-17-vendor-config-in-db-design.md`（已批准）

**Goal:** 删除 hmac_secret.key 文件依赖，商家 HMAC 密钥与接口地址迁入 jz_vendors 表三列（hmac_key/url_link/order_detail_url），读取改为进程内懒加载缓存，并防止密钥经 vendor 接口泄露。

**Architecture:** db.py 启动自愈（缺列 ALTER + 文件存在且表值为空时自动导入）；jiazheng_api.py `_load_vendor_config()` 改为懒加载缓存（返回结构不变，三个消费方零改动）；jiazheng_db.py vendor 出口统一剥离敏感列。文件由用户手动删除。

**Tech Stack:** Python3（urllib/threading）、MySQL（dbconn 兼容层，PRAGMA table_info 检测列）、项目测试风格为脚本断言（print PASS），非 pytest。

**测试脚本：** 新建 `juzhu/test_vendor_config_db.py`（T1–T4 共用，main() 顺序执行）。运行前提：`python3 test_vendor_config_db.py` 直连测试库（62.234.26.57），头部 `from tp_client import load_dotenv; load_dotenv()`。

---

### Task 1: schema 文件加三列

**Files:**
- Modify: `juzhu/mysql_schema.sql`（jz_vendors CREATE TABLE 加列）
- Modify: `juzhu/jiazheng_schema.sql`（同步）
- Test: `juzhu/test_vendor_config_db.py`（新建，含 check_schema_files）

**Step 1: 写失败测试**（新建 test_vendor_config_db.py 骨架 + 第一个检查）：

```python
#!/usr/bin/env python3
"""商家密钥配置迁库验证：schema 列 → db.py 迁移 → 缓存读取 → 防泄露。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tp_client import load_dotenv  # noqa: E402

load_dotenv()

HERE = os.path.dirname(os.path.abspath(__file__))


def check_schema_files():
    for name in ("mysql_schema.sql", "jiazheng_schema.sql"):
        text = open(os.path.join(HERE, name), encoding="utf-8").read()
        # 仅校验 jz_vendors 建表段含三列（文本级检查，避免误命中其它表）
        start = text.find("CREATE TABLE")
        seg = text[text.find("jz_vendors"):text.find("jz_vendors") + 1200]
        assert "hmac_key" in seg, f"{name} jz_vendors 缺 hmac_key 列"
        assert "url_link" in seg, f"{name} jz_vendors 缺 url_link 列"
        assert "order_detail_url" in seg, f"{name} jz_vendors 缺 order_detail_url 列"
    print("[PASS] check_schema_files")


def main():
    check_schema_files()


if __name__ == "__main__":
    main()
```

**Step 2: 运行确认失败**

Command: `cd juzhu && python3 test_vendor_config_db.py`
Expected: FAIL — `AssertionError: mysql_schema.sql jz_vendors 缺 hmac_key 列`

**Step 3: 实现**——mysql_schema.sql 的 jz_vendors 建表段 `whitelist_id INT,` 之后加：

```sql
  whitelist_id INT,
  hmac_key TEXT,                          -- HMAC-SHA256 密钥（空 = 未接入）
  url_link TEXT,                          -- 商家 URL Link 生成接口完整地址
  order_detail_url TEXT,                  -- 商家订单详情查询接口完整地址
  status VARCHAR(16) DEFAULT 'active',
```

jiazheng_schema.sql 同步在 `whitelist_id INTEGER,` 行后加三行 TEXT 列。

**Step 4: 运行确认通过**

Command: `python3 test_vendor_config_db.py`
Expected: PASS

**Step 5: 提交**
`git add juzhu/mysql_schema.sql juzhu/jiazheng_schema.sql juzhu/test_vendor_config_db.py && git commit -m "feat(juzhu): jz_vendors schema 增加 hmac_key/url_link/order_detail_url 三列"`

---

### Task 2: db.py 运行时迁移 + 文件导入

**Files:**
- Modify: `juzhu/db.py`（ensure_jz_vendor_schema 加列迁移 + 文件导入）
- Test: `juzhu/test_vendor_config_db.py`（加 check_db_migration）

**Step 1: 写失败测试**（main() 加 `check_db_migration()`）：

```python
def check_db_migration():
    import db as jdb
    conn = jdb.connect()
    cols = {dict(r)["name"] for r in conn.execute("PRAGMA table_info(jz_vendors)").fetchall()}
    assert {"hmac_key", "url_link", "order_detail_url"} <= cols, f"缺列: {cols}"
    row41 = conn.execute("SELECT hmac_key, url_link, order_detail_url FROM jz_vendors WHERE id=41").fetchone()
    row42 = conn.execute("SELECT hmac_key, url_link, order_detail_url FROM jz_vendors WHERE id=42").fetchone()
    assert row41 and row41[0] and row41[1] and row41[2], f"41 未从文件导入: {row41}"
    assert row42 and row42[0] and row42[1] and row42[2] is None, f"42 未从文件导入: {row42}"
    conn.close()
    print("[PASS] check_db_migration")
```

> 注：该测试进程独立（_SCHEMA_READY 未置位），connect() 会触发 ensure_schema 执行加列+导入。测试前需确保表内 41/42 行三列值为 NULL（新 ALTER 的列天然为 NULL；若为已迁入状态，测试应改为"文件与表值一致"断言——实现时若遇到已迁入数据按实际调整断言，禁止盲目 DELETE）。

**Step 2: 运行确认失败**

Command: `python3 test_vendor_config_db.py`
Expected: FAIL — `AssertionError: 缺列: {...}`（列未 ALTER 出来）

**Step 3: 实现**——db.py `ensure_jz_vendor_schema` 的 vendor_cols 段追加：

```python
        for col, dtype in (("hmac_key", "TEXT"), ("url_link", "TEXT"), ("order_detail_url", "TEXT")):
            if col not in vendor_cols:
                conn.execute(f"ALTER TABLE jz_vendors ADD COLUMN {col} {dtype}")
        # 密钥配置迁移：hmac_secret.key 仍存在时导入（仅当该行 hmac_key 为空，不覆盖表内已有值）
        key_path = Path(__file__).resolve().parent / "hmac_secret.key"
        if key_path.exists():
            imported = 0
            try:
                for line in key_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split("|")
                    if len(parts) < 2:
                        continue
                    vid = parts[0].strip()
                    hmac_key = parts[1].strip()
                    url_link = parts[2].strip() if len(parts) >= 3 else None
                    order_detail_url = parts[3].strip() if len(parts) >= 4 else None
                    row = conn.execute(
                        "SELECT hmac_key FROM jz_vendors WHERE id=?", (int(vid),)
                    ).fetchone()
                    if row and not (row[0] or "").strip():
                        conn.execute(
                            "UPDATE jz_vendors SET hmac_key=?, url_link=?, order_detail_url=? WHERE id=?",
                            (hmac_key, url_link, order_detail_url, int(vid)),
                        )
                        imported += 1
                if imported:
                    print(f"[migrate] 商家密钥配置已迁入 jz_vendors（{imported} 家），可删除 hmac_secret.key", flush=True)
            except Exception as e:
                print(f"[migrate] hmac_secret.key 导入失败（不影响启动）: {e}", flush=True)
```

注意：vendor_cols 集合在加列后需刷新（参考同函数 L355 的做法）。

**Step 4: 运行确认通过**

Command: `python3 test_vendor_config_db.py`
Expected: PASS（含 [PASS] check_db_migration）

**Step 5: 提交**
`git add juzhu/db.py juzhu/test_vendor_config_db.py && git commit -m "feat(juzhu): db.py 启动迁移 jz_vendors 密钥三列并导入 hmac_secret.key 数据"`

---

### Task 3: jiazheng_api.py 进程内懒加载缓存

**Files:**
- Modify: `juzhu/jiazheng_api.py`（_load_vendor_config 改造）
- Test: `juzhu/test_vendor_config_db.py`（加 check_vendor_config_cache）

**Step 1: 写失败测试**：

```python
def check_vendor_config_cache():
    from jiazheng_api import _load_vendor_config
    vendors = _load_vendor_config()
    assert "41" in vendors and "42" in vendors, f"缓存缺 vendor: {list(vendors)}"
    v41 = vendors["41"]
    assert v41["key"] and v41["url_link"] and v41["order_detail_url"], v41
    v42 = vendors["42"]
    assert v42["key"] and v42["url_link"] and not v42.get("order_detail_url"), v42
    # 缓存命中：第二次调用返回同一对象
    assert _load_vendor_config() is vendors, "缓存未生效"
    print("[PASS] check_vendor_config_cache")
```

**Step 2: 运行确认失败**

Command: `python3 test_vendor_config_db.py`
Expected: FAIL — 当前 `_load_vendor_config` 读文件：无 order_detail_url 则 `v42["order_detail_url"]` 存在但为空串（可能 KeyError 或值不同）——注意测试断言 `"41" in vendors`（当前实现返回文件解析，41 有 4 列会通过部分断言；若意外通过需确认缓存断言 `is` 失败即可）。Expected 至少最后一条断言 FAIL（每次调用都新建 dict）。

**Step 3: 实现**——jiazheng_api.py 替换 `_load_vendor_config`：

```python
_VENDOR_CONFIG_CACHE = None
_VENDOR_CONFIG_LOCK = threading.Lock()


def _load_vendor_config():
    """从 jz_vendors 表加载商家密钥配置（进程内懒加载缓存）。

    返回: {"41": {"key": "...", "url_link": "...", "order_detail_url": "..."}, ...}
    仅返回 hmac_key 非空的商家；改表后需重启 server 生效。
    """
    global _VENDOR_CONFIG_CACHE
    if _VENDOR_CONFIG_CACHE is not None:
        return _VENDOR_CONFIG_CACHE
    with _VENDOR_CONFIG_LOCK:
        if _VENDOR_CONFIG_CACHE is not None:
            return _VENDOR_CONFIG_CACHE
        vendors = {}
        conn = _connect_db()
        try:
            rows = conn.execute(
                "SELECT id, hmac_key, url_link, order_detail_url FROM jz_vendors "
                "WHERE hmac_key IS NOT NULL AND TRIM(hmac_key) <> ''"
            ).fetchall()
            for r in rows:
                vid = str(r["id"])
                vendors[vid] = {
                    "key": (r["hmac_key"] or "").strip(),
                    "url_link": (r["url_link"] or "").strip(),
                    "order_detail_url": (r["order_detail_url"] or "").strip(),
                }
        finally:
            conn.close()
        _VENDOR_CONFIG_CACHE = vendors
        return vendors
```

- 顶部 imports 加 `import threading`
- `_KEY_PATH` 常量删除
- 错误文案：L561 `请检查 hmac_secret.key` → `请检查 jz_vendors 表配置`；L718 注释同步

**Step 4: 运行确认通过**

Command: `python3 test_vendor_config_db.py`
Expected: PASS

**Step 5: 提交**
`git add juzhu/jiazheng_api.py juzhu/test_vendor_config_db.py && git commit -m "feat(juzhu): 商家密钥配置改为从 jz_vendors 表懒加载缓存"`

---

### Task 4: vendor 出口防密钥泄露

**Files:**
- Modify: `juzhu/jiazheng_db.py`（_strip_vendor_secrets + list_vendors/get_vendor 出口剥离）
- Test: `juzhu/test_vendor_config_db.py`（加 check_vendor_secrets_stripped）

**Step 1: 写失败测试**：

```python
def check_vendor_secrets_stripped():
    import db as jdb
    from jiazheng_db import list_vendors, get_vendor
    conn = jdb.connect()
    try:
        for v in list_vendors(conn):
            for secret in ("hmac_key", "url_link", "order_detail_url"):
                assert secret not in v, f"list_vendors 泄露 {secret}: vendor {v.get('id')}"
        v41 = get_vendor(conn, 41)
        for secret in ("hmac_key", "url_link", "order_detail_url"):
            assert secret not in v41, f"get_vendor 泄露 {secret}"
    finally:
        conn.close()
    print("[PASS] check_vendor_secrets_stripped")
```

**Step 2: 运行确认失败**

Command: `python3 test_vendor_config_db.py`
Expected: FAIL — `AssertionError: list_vendors 泄露 hmac_key`（T2 迁移后表中已有值，SELECT * 直接带出）

**Step 3: 实现**——jiazheng_db.py：

```python
VENDOR_SECRET_FIELDS = ("hmac_key", "url_link", "order_detail_url")


def _strip_vendor_secrets(vendor):
    """对外响应剥离商家密钥与接口地址（内部出站调用另从 jiazheng_api 缓存取）。"""
    if not vendor:
        return vendor
    for f in VENDOR_SECRET_FIELDS:
        vendor.pop(f, None)
    return vendor
```

`list_vendors`：`_rows_to_list(rows)` 后对每个 v 调 `_strip_vendor_secrets(v)`（在附加 products 之前）。
`get_vendor`：`v = _row_to_dict(row)` 后调 `_strip_vendor_secrets(v)`。

**Step 4: 运行确认通过**

Command: `python3 test_vendor_config_db.py`
Expected: PASS

**Step 5: 提交**
`git add juzhu/jiazheng_db.py juzhu/test_vendor_config_db.py && git commit -m "fix(juzhu): vendor 对外接口剥离 hmac_key 等敏感字段防泄露"`

---

### Task 5: 旧测试脚本改读表

**Files:**
- Modify: `juzhu/test_vendor_api.py`（get_secret 改查 jz_vendors）
- Modify: `juzhu/sign_test.py`（key 读取改查 jz_vendors）

**Step 1: 改造**（无新增测试，改造后运行原脚本验证）：
- test_vendor_api.py L29-45：`get_secret(vendor_id)` 改为 `db.connect()` 后 `SELECT hmac_key FROM jz_vendors WHERE id=?`
- sign_test.py L5：同样改查表
- 运行 `python3 sign_test.py` 验证签名逻辑仍可用（本地离线可跑）
- test_vendor_api.py 打测试服务器，若网络可达则跑通；不可达则记录原因

**Step 2: 提交**
`git add juzhu/test_vendor_api.py juzhu/sign_test.py && git commit -m "test(juzhu): 测试脚本密钥改从 jz_vendors 表读取"`

---

### Task 6: 拦截与文档清理

**Files:**
- Modify: `juzhu/server.py`（静态拦截列表移除 "hmac_secret.key"）
- Modify: `juzhu/README.md`（拦截列表描述）
- Modify: `CLAUDE.md`（url_link 读取来源描述）

**Step 1:** server.py L81 删除 `"hmac_secret.key",` 行（文件将不存在，条目无意义；保留也无害但按设计清理）。
**Step 2:** README.md 拦截路径列表、CLAUDE.md L127 描述更新为"vendor url_link 读 jz_vendors 表"。
**Step 3: 提交**
`git add juzhu/server.py juzhu/README.md CLAUDE.md && git commit -m "docs(juzhu): 移除 hmac_secret.key 静态拦截与文档引用"`

---

### Task 7: 全量验证与收尾

**验证清单（不提交代码，仅确认）：**
1. `python3 test_vendor_config_db.py` 四项 ALL PASS
2. `python3 test_gr_my_orders.py` 回归 ALL PASS（HMAC 回调鉴权改用表内密钥后仍通过——sign_test 或 HMAC 端到端回调）
3. 重启 server 后 curl 验证：
   - `curl http://127.0.0.1:8765/...` vendor 产品列表接口响应无 hmac_key 字段
   - HMAC 签名请求 `/api/juzhu/callback`（用表内 41 密钥签名）返回 code 0/404 而非 401（鉴权通过）
   - `wechat-link` 出站调用取到 url_link（商家白名单限制时报"IP无权访问"亦证明地址取到）
4. 用户手动删除 `juzhu/hmac_secret.key` 后再重启 server，复跑第 2 条 HMAC 鉴权验证（证明无文件依赖）
5. 提交执行记录：`docs/plans/2026-08-17-vendor-config-in-db.md` 末尾追加验证结果

**提交：**
`git add docs/plans/2026-08-17-vendor-config-in-db.md && git commit -m "docs(plans): 密钥迁库实施计划与验证记录"`

---

## 注意

- 全程不提交 `juzhu/hmac_secret.key`（juzhu/.gitignore `*.key` 已屏蔽，提交前 git status 确认）
- 每任务提交后 `git status --short` 确认工作区干净
- server 后台进程需在 T3 后重启（加载新缓存逻辑），T7 时正式重启验证

---

## 执行记录（2026-08-17）

T1-T6 全部完成并提交，验证结果：

1. `python3 test_vendor_config_db.py` 四项 ALL PASS（schema 列 / db.py 迁移导入 / 懒加载缓存 / 防泄露剥离）
2. `python3 test_gr_my_orders.py` 回归 ALL PASS（7 项，含 HMAC 回调鉴权）
3. 重启 server 后验证：
   - `GET /api/juzhu/jz/vendors`（2 家）与 `/api/juzhu/jz/vendors/41` 响应均无 hmac_key/url_link/order_detail_url 字段
   - 表内 41 密钥签名 POST `/api/juzhu/callback` → `404 订单不存在`（鉴权通过，非 401）
   - `wechat-link` 出站调用日志 `POST https://uat.doorslink.net/.../generate/urllink`（url_link 取自查表；商家拒本机 IP 属预期，测试环境无此问题）
4. **无文件依赖验证**：临时移走 hmac_secret.key 后重启 server，复跑 HMAC 签名回调仍鉴权通过；验证后文件已恢复
5. `python3 sign_test.py` 签名/验签/篡改校验全通过；`python3 test_vendor_api.py` 打测试环境 22 请求 9/9 断言通过（密钥均从表读取）

`juzhu/hmac_secret.key` 保留待用户自行删除（db.py 的文件导入兼容逻辑在旧部署环境仍可自动迁移）。
