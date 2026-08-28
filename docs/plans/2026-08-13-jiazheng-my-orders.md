# 生活服务专区「我的订单」实施计划

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** 在生活服务专区新增「我的订单」快捷入口 + 订单列表页 + 订单详情页，数据源 gr_orders，打通 user_id 下单链路。

**Architecture:** gr_orders 表新增 user_id 列；index.html 通过 _jzapi.js 全局存取模拟 user_id，详情页下单时透传后端落库；新增匿名聚合接口 `GET /api/juzhu/gr/orders?user_id=x`（过滤 pending，返回 counts+list）与单条接口；前端新增入口区块、列表页、详情页三个静态页。

**Tech Stack:** Python（dbconn/MySQL 兼容层 + urllib 冒烟脚本）、原生 HTML/JS/CSS（复用 lvju-app.css 卡片体系）。

**设计文档:** `docs/plans/2026-08-13-jiazheng-my-orders-design.md`

**规范提醒:**
- 前端渲染禁用硬编码 fallback：接口失败→区块隐藏/失败提示；空数据→空态文案，不造 mock。
- server.py 路由：精确匹配声明在正则捕获之前。
- Git 提交：中文 + 作用域前缀（feat(juzhu)/test(juzhu)），每任务独立提交。
- 测试脚本 `juzhu/test_gr_my_orders.py` 从 T1 起渐进构建（urllib 直连 http://127.0.0.1:8765）。

---

## Task 1: gr_orders 表新增 user_id 列（数据层迁移）

**Files:**
- Modify: `juzhu/mysql_schema.sql`
- Modify: `juzhu/schema.sql`
- Modify: `juzhu/db.py`

**Step 1: 写失败测试** — 新建 `juzhu/test_gr_my_orders.py` 骨架：

```python
#!/usr/bin/env python3
"""我的订单链路冒烟：user_id 迁移 → 下单落库 → 聚合接口过滤 pending → 单条详情。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db as jdb  # noqa: E402

TEST_USER = "test_gr_orders_user"


def check_user_id_column():
    conn = jdb.connect()
    rows = conn.execute("PRAGMA table_info(gr_orders)").fetchall()
    cols = [dict(r)["name"] for r in rows]
    assert "user_id" in cols, f"gr_orders 缺少 user_id 列，现有列: {cols}"
    print("[PASS] check_user_id_column: user_id 列存在")


def main():
    check_user_id_column()
    print("ALL PASS")


if __name__ == "__main__":
    main()
```

**Step 2: 运行 — 确认失败**
Command: `cd juzhu && python3 test_gr_my_orders.py`
Expected: FAIL — `AssertionError: gr_orders 缺少 user_id 列`

**Step 3: 实现**

`juzhu/mysql_schema.sql` — gr_orders 建表加列（`vendor_oid` 之后）：

```sql
  vendor_oid      VARCHAR(64),
  user_id         VARCHAR(64),                -- 下单用户 id（C 端模拟，后期接真实登录）
```

`juzhu/schema.sql` — 同位置：

```sql
  vendor_oid      TEXT,                       -- 商家订单号
  user_id         TEXT,                       -- 下单用户 id（C 端模拟，后期接真实登录）
```

schema.sql 底部（vendor_id 迁移注释块之后）追加：

```sql
-- 迁移：老库 gr_orders 增加 user_id 列（我的订单用户维度）
-- 注意：新库建表已含该列，此语句会报 duplicate column 错误，由 _connect_db() 捕获忽略
ALTER TABLE gr_orders ADD COLUMN user_id TEXT;
```

`juzhu/db.py` — `ensure_schema` 内 gr_order_cols 迁移块（vendor_id 检查之后）追加：

```python
    if gr_order_cols and "user_id" not in gr_order_cols:
        conn.execute("ALTER TABLE gr_orders ADD COLUMN user_id TEXT")
```

**Step 4: 运行 — 确认通过**
Command: `cd juzhu && python3 test_gr_my_orders.py`
Expected: PASS（db.connect() 会触发 ensure_schema 完成列迁移）

**Step 5: Commit**
`git add juzhu/mysql_schema.sql juzhu/schema.sql juzhu/db.py juzhu/test_gr_my_orders.py && git commit -m "feat(juzhu): gr_orders 表新增 user_id 列"`

---

## Task 2: 下单链路写入 user_id

**Files:**
- Modify: `juzhu/gr_orders.py`
- Modify: `juzhu/jiazheng_api.py`

**Step 1: 写失败测试** — `test_gr_my_orders.py` 追加：

```python
def check_create_order_with_user():
    from gr_orders import create_order, get_order_by_ref

    conn = jdb.connect()
    ref = "GRTEST" + str(int(__import__("time").time() * 1000))
    create_order(conn, ref, "99", city="沈阳", vendor_id=None, user_id=TEST_USER)
    conn.commit()
    row = get_order_by_ref(conn, ref)
    assert row and row.get("user_id") == TEST_USER, f"user_id 未落库: {row}"
    conn.execute("DELETE FROM gr_orders WHERE order_ref = ?", (ref,))
    conn.commit()
    print("[PASS] check_create_order_with_user")
```

并在 `main()` 中 `check_user_id_column()` 之后调用 `check_create_order_with_user()`。

**Step 2: 运行 — 确认失败**
Command: `cd juzhu && python3 test_gr_my_orders.py`
Expected: FAIL — `TypeError: create_order() got an unexpected keyword argument 'user_id'`

**Step 3: 实现**

`juzhu/gr_orders.py` — `create_order` 修改：

```python
def create_order(conn, order_ref, sku, city="沈阳", vendor_id=None, user_id=None):
    """创建一条 gr_orders 记录。
    vendor_oid / fee / worker_name / worker_phone / eta / cancel_reason 留空。
    返回 order_ref。
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        """INSERT INTO gr_orders
           (order_ref, vendor_id, user_id, sku, city, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)""",
        (order_ref, vendor_id, user_id, sku, city, now),
    )
```

`juzhu/jiazheng_api.py` — `handle_wechat_link` 中读取并透传（`create_order` 调用处）：

```python
        user_id = (body.get("user_id") or "").strip() or None

        create_order(
            conn,
            order_ref,
            str(product_id),
            vendor_id=product.get("vendor_id"),
            user_id=user_id,
        )
```

**Step 4: 运行 — 确认通过**
Command: `cd juzhu && python3 test_gr_my_orders.py`
Expected: PASS（两项检查均过）

**Step 5: Commit**
`git add juzhu/gr_orders.py juzhu/jiazheng_api.py juzhu/test_gr_my_orders.py && git commit -m "feat(juzhu): 下单链路写入 user_id"`

---

## Task 3: gr_orders 查询函数（列表聚合 + 单条）

**Files:**
- Modify: `juzhu/gr_orders.py`

**Step 1: 写失败测试** — `test_gr_my_orders.py` 追加：

```python
def check_list_user_orders_filters_pending():
    import time
    from gr_orders import list_user_orders

    conn = jdb.connect()
    stamp = str(int(time.time() * 1000))
    refs = []
    for i, status in enumerate(["pending", "paid", "assigned", "serving", "completed"]):
        ref = f"GRTESTL{stamp}{i}"
        conn.execute(
            "INSERT INTO gr_orders (order_ref, user_id, sku, city, status, created_at)"
            " VALUES (?, ?, '99', '沈阳', ?, datetime('now','localtime'))",
            (ref, TEST_USER, status),
        )
        refs.append(ref)
    conn.commit()
    try:
        data = list_user_orders(conn, TEST_USER)
        got = {r["order_ref"] for r in data["list"]}
        assert all(r not in got for r in refs[:1]), "pending 订单被泄露"
        assert len(got) == 4, f"应返回 4 条，实际 {len(got)}"
        assert data["counts"] == {"paid": 1, "assigned": 1, "serving": 1, "completed": 1}, data["counts"]
        print("[PASS] check_list_user_orders_filters_pending")
    finally:
        conn.execute("DELETE FROM gr_orders WHERE user_id = ? AND order_ref LIKE 'GRTESTL%'", (TEST_USER,))
        conn.commit()
```

在 `main()` 中追加调用。

**Step 2: 运行 — 确认失败**
Command: `cd juzhu && python3 test_gr_my_orders.py`
Expected: FAIL — `ImportError: cannot import name 'list_user_orders'`

**Step 3: 实现** — `juzhu/gr_orders.py` 文件头部（imports 之后）追加：

```python
# 我的订单（C 端）可见状态：pending 属未支付阶段，不对用户展示
USER_VISIBLE_STATUSES = ("paid", "assigned", "serving", "completed", "cancelled")
```

文件末尾追加两个函数：

```python
def list_user_orders(conn, user_id, limit=50):
    """按用户列出订单（过滤 pending），附带 4 状态计数与服务名/类目（join 产品与 SPU）。"""
    rows = conn.execute(
        """SELECT o.*, p.name AS product_name, s.category_id AS category_id
           FROM gr_orders o
           LEFT JOIN jz_products p ON CAST(p.id AS CHAR) = o.sku
           LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
           WHERE o.user_id = ? AND o.status != 'pending'
           ORDER BY o.created_at DESC, o.id DESC
           LIMIT ?""",
        (user_id, limit),
    ).fetchall()
    items = [dict(r) for r in rows]
    counts = {"paid": 0, "assigned": 0, "serving": 0, "completed": 0}
    for it in items:
        if it.get("status") in counts:
            counts[it["status"]] += 1
    return {"counts": counts, "list": items}


def get_user_order(conn, order_ref, user_id):
    """按 order_ref + user_id 查单（防串单），join 产品名/类目。"""
    row = conn.execute(
        """SELECT o.*, p.name AS product_name, s.category_id AS category_id
           FROM gr_orders o
           LEFT JOIN jz_products p ON CAST(p.id AS CHAR) = o.sku
           LEFT JOIN jz_skus s ON s.id = p.channel_sku_id
           WHERE o.order_ref = ? AND o.user_id = ?""",
        (order_ref, user_id),
    ).fetchone()
    return dict(row) if row else None
```

**Step 4: 运行 — 确认通过**
Command: `cd juzhu && python3 test_gr_my_orders.py`
Expected: PASS（三项检查均过）

**Step 5: Commit**
`git add juzhu/gr_orders.py juzhu/test_gr_my_orders.py && git commit -m "feat(juzhu): 新增我的订单查询函数（过滤 pending + counts）"`

---

## Task 4: 匿名接口 GET /api/juzhu/gr/orders（+ 单条）

**Files:**
- Modify: `juzhu/jiazheng_api.py`
- Modify: `juzhu/server.py`

**Step 1: 写失败测试** — `test_gr_my_orders.py` 追加（顶部加 urllib imports）：

```python
import json
import urllib.error
import urllib.request

HOST = "http://127.0.0.1:8765"


def http_get(path):
    req = urllib.request.Request(HOST + path)
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"__status": e.code, "body": e.read().decode()}


def check_gr_orders_api():
    import time
    from gr_orders import list_user_orders

    conn = jdb.connect()
    stamp = str(int(time.time() * 1000))
    for i, status in enumerate(["pending", "paid", "completed"]):
        conn.execute(
            "INSERT INTO gr_orders (order_ref, user_id, sku, city, status, created_at)"
            " VALUES (?, ?, '99', '沈阳', ?, datetime('now','localtime'))",
            (f"GRTESTA{stamp}{i}", TEST_USER, status),
        )
    conn.commit()
    try:
        # 缺 user_id → 400
        r = http_get("/api/juzhu/gr/orders")
        assert r.get("__status") == 400, f"缺 user_id 应 400，实际 {r}"
        # 正常聚合：无 pending、counts 正确
        r = http_get("/api/juzhu/gr/orders?user_id=" + TEST_USER)
        assert r.get("ok"), r
        assert len(r["list"]) == 2, f"list 应 2 条（无 pending），实际 {r['list']}"
        assert r["counts"]["paid"] == 1 and r["counts"]["completed"] == 1, r["counts"]
        # 单条详情（防串单：其他 user 查不到 → 404）
        ref = list_user_orders(conn, TEST_USER)["list"][0]["order_ref"]
        d = http_get(f"/api/juzhu/gr/orders/{ref}?user_id={TEST_USER}")
        assert d.get("ok") and d.get("order", {}).get("order_ref") == ref, d
        d2 = http_get(f"/api/juzhu/gr/orders/{ref}?user_id=other_user")
        assert d2.get("__status") == 404, f"跨用户应 404，实际 {d2}"
        print("[PASS] check_gr_orders_api")
    finally:
        conn.execute("DELETE FROM gr_orders WHERE user_id = ? AND order_ref LIKE 'GRTESTA%'", (TEST_USER,))
        conn.commit()
```

在 `main()` 中追加调用。**需 server 运行**（见 Step 2 前置）。

**Step 2: 启动 server + 运行 — 确认失败**
Command: `cd juzhu && python3 server.py`（另开终端后台运行）
Command: `cd juzhu && python3 test_gr_my_orders.py`
Expected: FAIL — `assert r.get("__status") == 400` 失败（当前 404 unknown route）

**Step 3: 实现**

`juzhu/jiazheng_api.py` — 文件末尾追加两个 handler（`_respond_json` 已存在）：

```python
# ═══════════════════════════════════════════════════════════════
#  我的订单（GR 侧，C 端匿名可读；user_id 必填）
# ═══════════════════════════════════════════════════════════════

def handle_gr_orders(handler, qs):
    """GET /api/juzhu/gr/orders?user_id=xxx —— 聚合返回 counts + list（过滤 pending）。"""
    user_id = (qs.get("user_id") or [""])[0].strip()
    if not user_id:
        _respond_json(handler, {"ok": False, "error": "缺少 user_id 参数"}, 400)
        return True
    try:
        limit = int((qs.get("limit") or ["50"])[0])
    except ValueError:
        limit = 50
    conn = _connect_db()
    try:
        from gr_orders import list_user_orders

        data = list_user_orders(conn, user_id, limit)
        _respond_json(handler, {"ok": True, **data})
    finally:
        conn.close()
    return True


def handle_gr_order_detail(handler, order_ref, qs):
    """GET /api/juzhu/gr/orders/{order_ref}?user_id=xxx —— 单条详情（防串单）。"""
    user_id = (qs.get("user_id") or [""])[0].strip()
    if not user_id:
        _respond_json(handler, {"ok": False, "error": "缺少 user_id 参数"}, 400)
        return True
    conn = _connect_db()
    try:
        from gr_orders import get_user_order

        order = get_user_order(conn, order_ref, user_id)
        if not order:
            _respond_json(handler, {"ok": False, "error": "订单不存在"}, 404)
        else:
            _respond_json(handler, {"ok": True, "order": order})
    finally:
        conn.close()
    return True
```

`juzhu/server.py` — 在 `# === 生成微信小程序 URL Link` 注释行（约 L864）之前插入（精确在前、正则在后）：

```python
        # === 我的订单（GR 侧，匿名可读；user_id 必填） ===
        if path == "/api/juzhu/gr/orders" and method == "GET":
            return jiazheng_api.handle_gr_orders(self, qs)

        m = re.match(r"^/api/juzhu/gr/orders/([^/]+)$", path)
        if m and method == "GET":
            return jiazheng_api.handle_gr_order_detail(self, m.group(1), qs)
```

**Step 4: 重启 server + 运行 — 确认通过**
Command: 重启 `python3 server.py`；`cd juzhu && python3 test_gr_my_orders.py`
Expected: PASS（四项检查均过）

**Step 5: Commit**
`git add juzhu/jiazheng_api.py juzhu/server.py juzhu/test_gr_my_orders.py && git commit -m "feat(juzhu): 新增我的订单匿名查询接口"`

---

## Task 5: _jzapi.js 增加 userId/setUserId

**Files:**
- Modify: `screens/_jzapi.js`

**Step 1: 失败测试（浏览器手工）**
浏览器打开 `index.html`，DevTools console 执行 `BZF_JZ.userId()`。
Expected: FAIL — `TypeError: BZF_JZ.userId is not a function`

**Step 2: 实现** — 在 `regionCity` 函数附近（`window.BZF_JZ = {...}` 导出之前）追加：

```js
  // 模拟用户 id（后期替换为真实获取用户 id 的代码）
  var USER_KEY = 'jz_demo_user_id';
  var DEMO_USER_ID = 'demo_user_001';

  function userId() {
    try { return localStorage.getItem(USER_KEY) || DEMO_USER_ID; } catch (e) { return DEMO_USER_ID; }
  }

  function setUserId(id) {
    try { if (id) localStorage.setItem(USER_KEY, id); } catch (e) {}
    return userId();
  }
```

并在 `window.BZF_JZ = {...}` 导出对象中追加两行（`regionCity: regionCity` 附近）：

```js
    userId: userId,
    setUserId: setUserId,
```

**Step 3: 验证通过（浏览器手工）**
- `BZF_JZ.userId()` → `"demo_user_001"`
- `BZF_JZ.setUserId('demo_user_001'); BZF_JZ.userId()` → `"demo_user_001"`
- localStorage 中 `jz_demo_user_id` 存在

**Step 4: Commit**
`git add screens/_jzapi.js && git commit -m "feat(juzhu): 生活服务链路全局 user_id 存取"`

---

## Task 6: index.html 模拟 user_id + 「我的订单」快捷入口区块

**Files:**
- Modify: `index.html`

**Step 1: 失败检查（浏览器手工）**
打开 `index.html`，切到「生活服务专区」tab，滚动到热门子类之下。
Expected: FAIL — 不存在「我的订单」区块。

**Step 2: 实现**

(1) `<style>` 内 `.jz-promo` 样式之后追加：

```css
    /* 我的订单快捷入口 */
    .jz-ordbar{display:flex;background:#fff;border:1px solid var(--border);border-radius:14px;
      margin:0 16px 12px;padding:14px 0;box-shadow:0 5px 14px rgba(15,42,38,.05);}
    .jz-ordbar a{flex:1;text-align:center;font-size:12px;color:var(--ink);position:relative;}
    .jz-ordbar a .ic{font-size:22px;display:block;margin-bottom:4px;}
    .jz-ordbar a .bdg{position:absolute;top:-6px;right:24%;background:#dc2626;color:#fff;font-size:9px;
      min-width:15px;height:15px;border-radius:999px;display:grid;place-items:center;padding:0 3px;font-weight:700;}
```

(2) `pane-jiazheng` 内「热门子类」区块（`<div class="jz-sub-list" id="jzSubs"></div>`）之后插入：

```html
      <!-- 我的订单（GR 侧） -->
      <div class="sec-h" id="jzSecOrders"><span class="bar"></span><h2>我的订单</h2><span class="more"><a href="juzhu-jiazheng-orders.html">全部订单 ›</a></span></div>
      <div class="jz-ordbar" id="jzOrderBar"></div>
```

(3) JS 区（`paintJzLinks()` 定义附近）追加：

```js
  // —— 我的订单快捷入口：user_id 为模拟值；接口失败时整块隐藏（禁用硬编码兜底）——
  (function(){
    if (!window.BZF_JZ) return;
    // 模拟用户 id（后期替换为真实获取用户 id 的代码）
    BZF_JZ.setUserId('demo_user_001');
    var STATUS_UI = [
      { id: 'paid',      ic: '💳',   label: '已支付' },
      { id: 'assigned',  ic: '🧑‍🔧', label: '已派单' },
      { id: 'serving',   ic: '🛠️',   label: '服务中' },
      { id: 'completed', ic: '✅',   label: '已完成' }
    ];
    fetch('/api/juzhu/gr/orders?user_id=' + encodeURIComponent(BZF_JZ.userId()))
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (!res.ok) return;
        var counts = res.counts || {};
        document.getElementById('jzOrderBar').innerHTML = STATUS_UI.map(function(s){
          var n = counts[s.id] || 0;
          return '<a href="juzhu-jiazheng-orders.html?status=' + s.id + '">' +
            (n > 0 ? '<span class="bdg">' + n + '</span>' : '') +
            '<span class="ic">' + s.ic + '</span>' + s.label + '</a>';
        }).join('');
      })
      .catch(function(){
        var bar = document.getElementById('jzOrderBar');
        var sec = document.getElementById('jzSecOrders');
        if (bar) bar.style.display = 'none';
        if (sec) sec.style.display = 'none';
      });
  })();
```

**Step 3: 验证通过（浏览器手工）**
- 生活服务 tab 下可见「我的订单」区块，4 格显示已支付/已派单/服务中/已完成
- 有测试数据时对应格显示红色角标；无数据时 4 格 0 角标但区块仍显示
- 断网/停 server 刷新：区块整体隐藏，页面其余正常

**Step 4: Commit**
`git add index.html && git commit -m "feat(juzhu): 生活服务专区新增我的订单快捷入口"`

---

## Task 7: 订单列表页 juzhu-jiazheng-orders.html

**Files:**
- Create: `juzhu-jiazheng-orders.html`

**Step 1: 失败检查（浏览器手工）**
访问 `juzhu-jiazheng-orders.html`。
Expected: FAIL — 404 / 文件不存在。

**Step 2: 实现** — 新建文件：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>我的订单 · 生活服务</title>
<link rel="stylesheet" href="lvju-app.css?v=6">
<style>
  .scr{padding-bottom:24px;}
  .appbar{position:sticky;}
  .stt.paid{color:var(--gold-deep);}
  .stt.assigned{color:var(--brand);}
  .stt.serving{color:#ea580c;}
  .stt.cancelled{color:#94a3b8;}
  .empty{padding:56px 24px;text-align:center;color:var(--muted);font-size:13px;}
  .empty .ic{font-size:40px;display:block;margin-bottom:10px;}
</style>
</head>
<body>
<div class="app">
  <div class="scr">
    <div class="appbar">
      <a class="bk" href="index.html">‹</a>
      <div class="ttl">我的订单</div>
      <div class="act"><span style="visibility:hidden">⚙</span></div>
    </div>

    <div class="otabs" id="tabs">
      <a class="on" data-s="">全部</a>
      <a data-s="paid">已支付</a>
      <a data-s="assigned">已派单</a>
      <a data-s="serving">服务中</a>
      <a data-s="completed">已完成</a>
    </div>

    <div class="wrap" id="list" style="padding-top:14px;"></div>
  </div>
</div>
<script src="screens/_jzapi.js"></script>
<script>
(function(){
  var JZ = window.BZF_JZ;
  var q = new URLSearchParams(location.search);
  var curStatus = q.get('status') || '';
  var CAT_ICON = { cleaning: '🧹', repair: '🔧', moving: '📦', nanny: '👶' };
  var STATUS_UI = {
    paid:      { label: '已支付', cls: 'paid' },
    assigned:  { label: '已派单', cls: 'assigned' },
    serving:   { label: '服务中', cls: 'serving' },
    completed: { label: '已完成', cls: 'done' },
    cancelled: { label: '已取消', cls: 'cancelled' }
  };

  function fmtYuan(fee){
    if (fee == null) return '—';
    return '¥' + Number(fee / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function render(list){
    if (!list || !list.length) {
      document.getElementById('list').innerHTML =
        '<div class="empty"><span class="ic">🧾</span>暂无订单</div>';
      return;
    }
    document.getElementById('list').innerHTML = list.map(function(o){
      var st = STATUS_UI[o.status] || { label: o.status, cls: 'done' };
      var name = o.product_name || '服务（已下架）';
      var icon = CAT_ICON[o.category_id] || '🧰';
      return '<div class="ordcard">' +
        '<div class="oh"><span class="shop">🐚 新居住 · 生活服务</span>' +
        '<span class="stt ' + st.cls + '">' + st.label + '</span></div>' +
        '<div class="ob">' +
          '<div class="th" style="display:grid;place-items:center;font-size:30px;' +
            'background:linear-gradient(135deg,#0f766e,#14b8a6);">' + icon + '</div>' +
          '<div class="oi">' +
            '<div class="nm">' + esc(name) + '</div>' +
            '<div class="meta">' + esc(o.city || '') + ' · 下单 ' + esc((o.created_at || '').slice(0, 16)) + '</div>' +
            '<div class="amt">实付 <b>' + fmtYuan(o.fee) + '</b> · 订单号 ' + esc((o.order_ref || '').slice(-6)) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="of"><a class="primary" href="juzhu-jiazheng-order-detail.html?order_ref=' +
          encodeURIComponent(o.order_ref) + '">查看详情</a></div>' +
      '</div>';
    }).join('');
  }

  function load(){
    fetch('/api/juzhu/gr/orders?user_id=' + encodeURIComponent(JZ.userId()))
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (!res.ok) return render(null);
        var list = res.list || [];
        if (curStatus) list = list.filter(function(o){ return o.status === curStatus; });
        render(list);
      })
      .catch(function(){ render(null); });
  }

  document.getElementById('tabs').addEventListener('click', function(e){
    var t = e.target.closest('a'); if (!t) return;
    curStatus = t.getAttribute('data-s');
    document.querySelectorAll('#tabs a').forEach(function(a){ a.classList.toggle('on', a === t); });
    load();
  });

  // 初始 tab 高亮：URL status 参数对齐
  if (curStatus) {
    document.querySelectorAll('#tabs a').forEach(function(a){
      a.classList.toggle('on', a.getAttribute('data-s') === curStatus);
    });
  }
  load();
})();
</script>
</body>
</html>
```

**Step 3: 验证通过（浏览器手工）**
- 打开页面：显示订单卡片（仅「查看详情」一个按钮），tab 可切换筛选
- 无订单 → 显示"暂无订单"空态；停 server → 同样空态（无 mock 渲染）
- 卡片点击「查看详情」→ 跳详情页（带 order_ref）

**Step 4: Commit**
`git add juzhu-jiazheng-orders.html && git commit -m "feat(juzhu): 新增我的订单列表页"`

---

## Task 8: 订单详情页 juzhu-jiazheng-order-detail.html

**Files:**
- Create: `juzhu-jiazheng-order-detail.html`

**Step 1: 失败检查（浏览器手工）**
从列表页点「查看详情」。
Expected: FAIL — 404 / 文件不存在。

**Step 2: 实现** — 新建文件：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>订单详情 · 生活服务</title>
<link rel="stylesheet" href="lvju-app.css?v=6">
<style>
  .scr{padding-bottom:24px;}
  .appbar{position:sticky;}
  .steps{background:#fff;margin:13px 16px 0;border:1px solid var(--border);border-radius:14px;padding:18px 14px 14px;}
  .steps h3{font-size:14px;color:var(--ink);margin-bottom:14px;}
  .step{display:flex;gap:11px;position:relative;padding-bottom:18px;}
  .step:last-child{padding-bottom:4px;}
  .step .dot{width:22px;height:22px;border-radius:50%;background:#eef2f1;color:#96a39f;
    display:grid;place-items:center;font-size:11px;flex-shrink:0;}
  .step .line{position:absolute;left:10.5px;top:24px;bottom:2px;width:2px;background:#eef2f1;}
  .step:last-child .line{display:none;}
  .step.done .dot{background:var(--brand-soft);color:var(--brand);}
  .step.done .line{background:var(--brand-soft);}
  .step.cur .dot{background:linear-gradient(90deg,var(--brand),var(--brand-2));color:#fff;}
  .step b{font-size:13px;color:var(--ink);display:block;}
  .step.done b{color:var(--brand-deep);}
  .step span{font-size:11px;color:var(--muted);margin-top:2px;display:block;}
  .cancelled-tip{margin:13px 16px 0;background:#fff7f5;border:1px solid #fecaca;border-radius:14px;
    padding:12px 14px;font-size:12px;color:#dc2626;}
  .info{background:#fff;margin:13px 16px 0;border:1px solid var(--border);border-radius:14px;overflow:hidden;}
  .info .row{display:flex;justify-content:space-between;gap:14px;padding:12px 14px;
    border-bottom:1px solid var(--border);font-size:13px;}
  .info .row:last-child{border-bottom:0;}
  .info .row .k{color:var(--muted);flex-shrink:0;}
  .info .row .v{text-align:right;color:var(--ink);}
  .err{padding:56px 24px;text-align:center;color:var(--muted);font-size:13px;}
</style>
</head>
<body>
<div class="app">
  <div class="scr">
    <div class="appbar">
      <a class="bk" href="juzhu-jiazheng-orders.html">‹</a>
      <div class="ttl">订单详情</div>
      <div class="act"><span style="visibility:hidden">⚙</span></div>
    </div>
    <div id="body"></div>
  </div>
</div>
<script src="screens/_jzapi.js"></script>
<script>
(function(){
  var JZ = window.BZF_JZ;
  var q = new URLSearchParams(location.search);
  var orderRef = q.get('order_ref') || '';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function fmtYuan(fee){
    if (fee == null) return '—';
    return '¥' + Number(fee / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }

  function fmtTime(t){ return t ? String(t).replace('T', ' ').slice(0, 16) : '—'; }

  function render(o){
    var STEPS = [
      { id: 'created',  label: '下单',   time: o.created_at },
      { id: 'paid',     label: '已支付', time: o.paid_at },
      { id: 'assigned', label: '已派单', time: o.eta },       // 预计上门时间
      { id: 'serving',  label: '服务中', time: o.updated_at },
      { id: 'completed',label: '已完成', time: o.completed_at }
    ];
    var order = ['paid', 'assigned', 'serving', 'completed'];
    var curIdx = order.indexOf(o.status);
    var html = '';
    if (o.status === 'cancelled') {
      html += '<div class="cancelled-tip">该订单已取消' +
        (o.cancel_reason ? '：' + esc(o.cancel_reason) : '') + '</div>';
    }
    html += '<div class="steps"><h3>服务流程</h3>' + STEPS.map(function(s, i){
      var cls = '';
      if (curIdx >= 0) {
        if (i > 0 && i <= curIdx + 1) cls = 'done';
        if (i === curIdx + 1) cls = 'cur';
      }
      return '<div class="step ' + cls + '"><div class="line"></div>' +
        '<div class="dot">' + (cls === 'done' ? '✓' : (i + 1)) + '</div>' +
        '<div><b>' + s.label + '</b><span>' + fmtTime(s.time) + '</span></div></div>';
    }).join('') + '</div>';

    var rows = [
      ['服务名称', o.product_name || '服务（已下架）'],
      ['订单金额', fmtYuan(o.fee)],
      ['所在城市', o.city || '—'],
      ['服务者', o.worker_name ? (o.worker_name + (o.worker_phone ? ' · ' + o.worker_phone : '')) : '待派单'],
      ['预计上门', fmtTime(o.eta)],
      ['订单号', o.order_ref],
      ['下单时间', fmtTime(o.created_at)],
      ['支付时间', fmtTime(o.paid_at)],
      ['完成时间', fmtTime(o.completed_at)]
    ];
    html += '<div class="info">' + rows.map(function(r){
      return '<div class="row"><span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span></div>';
    }).join('') + '</div>';
    document.getElementById('body').innerHTML = html;
  }

  function load(){
    fetch('/api/juzhu/gr/orders/' + encodeURIComponent(orderRef) + '?user_id=' + encodeURIComponent(JZ.userId()))
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (!res.ok || !res.order) {
          document.getElementById('body').innerHTML =
            '<div class="err">订单不存在或无权查看</div>';
          return;
        }
        render(res.order);
      })
      .catch(function(){
        document.getElementById('body').innerHTML =
          '<div class="err">加载失败，请稍后重试</div>';
      });
  }

  if (!orderRef) {
    document.getElementById('body').innerHTML = '<div class="err">缺少订单参数</div>';
  } else {
    load();
  }
})();
</script>
</body>
</html>
```

**Step 3: 验证通过（浏览器手工）**
- 正常订单：上半部 5 步状态条（已完成步骤绿色✓、当前步骤高亮、之后灰显，时间正确）
- cancelled 订单：顶部红色取消提示 + 步骤条全灰
- 信息卡 9 行字段齐全；无操作按钮

**Step 4: Commit**
`git add juzhu-jiazheng-order-detail.html && git commit -m "feat(juzhu): 新增订单详情页（5 步流程 + 订单信息）"`

---

## Task 9: 端到端冒烟 + 执行记录

**Files:**
- Modify: `docs/plans/2026-08-13-jiazheng-my-orders.md`（本文件末尾追加执行记录）
- Test: `juzhu/test_gr_my_orders.py`

**Step 1: 全量测试**
Command: `cd juzhu && python3 test_gr_my_orders.py`
Expected: ALL PASS（4 项：列迁移 / 下单落库 / 过滤 pending + counts / 接口行为含 400 与跨用户 404）

**Step 2: 手工链路验证清单**（浏览器）
1. 打开 `index.html` → 生活服务专区 → 「我的订单」区块可见
2. 详情页下单（带 user_id，见 Network 请求体）→ gr_orders 新增 pending 单（不出现在我的订单）
3. 用 `test_vendor_api.py` 的 HmacAuth 方式回调 paid/assigned/serving/completed（或 DB 直接改状态）→ 入口角标与列表实时更新
4. 列表页 tab 筛选正确；详情页步骤条与信息卡正确

**Step 3: 本计划文件末尾追加执行记录**
```markdown
## 执行记录

- 2026-08-13 T1-T9 完成，test_gr_my_orders.py 全绿（4 项检查）。
```

**Step 4: Commit**
`git add juzhu/test_gr_my_orders.py docs/plans/2026-08-13-jiazheng-my-orders.md && git commit -m "test(juzhu): 我的订单链路冒烟脚本与执行记录"`

## 执行记录

- 2026-08-13 T1-T9 完成，test_gr_my_orders.py 全绿（4 项检查：列迁移 / 下单落库 / 过滤 pending + counts / 接口行为含 400 与跨用户 404）。
- 提交：9a0aafa（user_id 列迁移）→ 6f25a35（下单链路）→ 01c7083（查询函数）→ a293695（匿名接口）→ 1d15c54（前端 user_id 存取）→ 80de76d（入口区块）→ 3ba9f96（列表页）→ ee12642（详情页）→ 本记录。
- 实施偏差记录：server.py 的 GET 路由需注册在 `_public_get`（`_route` 中段为死代码，所有非 admin GET 会先转入 `_public_get`）；详情页步骤条"下单"（i=0）步骤始终标记 done（对齐设计文档"当前状态之前的步骤标已完成样式"）。
- 浏览器验证：index.html 角标正确（paid/assigned/serving/completed 各计数）；新增 paid 单后刷新角标 1→2；file:// 断网模拟下「我的订单」区块整体隐藏；列表页 4 卡仅「查看详情」按钮、tab 筛选正确；详情页 completed 4 步 ✓ + 末步高亮、cancelled 红色提示 + 全灰、缺参数错误态正确。
