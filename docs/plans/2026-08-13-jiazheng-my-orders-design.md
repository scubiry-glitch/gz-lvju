# 生活服务专区「我的订单」设计

日期：2026-08-13
状态：已批准（固定 5 步状态条 / localStorage 全局存取 user_id / 单聚合接口）

## 背景与目标

生活服务专区（index.html `pane-jiazheng`）目前只有"选服务 → 详情页 → 跳转第三方小程序下单"链路，
用户下单后无法在频道内查看自己的订单。本设计在专区内新增「我的订单」入口，提供订单列表页与订单
详情页，数据源为 `gr_orders` 表（GR 侧预约订单），并打通 user_id 从入口到下单单据的链路。

## 决策记录

1. 快捷入口只展示 4 状态：已支付(paid)、已派单(assigned)、服务中(serving)、已完成(completed)。
2. 所有面向用户的订单查询一律过滤 `pending` 状态（下单未支付不出现在"我的订单"）。
3. `gr_orders` 增加 `user_id TEXT` 列；user_id 由 index.html 模拟（`demo_user_001`），
   通过 `_jzapi.js` 的 localStorage 全局存取，下单时写入订单。
4. 订单详情页上方为固定 5 步状态条（下单→已支付→已派单→服务中→已完成），按订单状态高亮，
   时间取订单时间戳；下方为订单信息卡。
5. 订单列表页视觉对齐 lvju-app-orders.html 的 ordcard 卡片体系，卡片仅保留「查看详情」一个操作。
6. 接口方案：单聚合接口 `GET /api/juzhu/gr/orders`，一次返回 counts + list。

## 数据层

- `juzhu/schema.sql`：`gr_orders` 建表语句增加 `user_id TEXT`（放在 `vendor_oid` 之后）。
- `juzhu/db.py`：仿 vendor_id 的运行时迁移模式，`PRAGMA table_info(gr_orders)` 检查后
  `ALTER TABLE gr_orders ADD COLUMN user_id TEXT`。
- `juzhu/mysql_schema.sql`：`gr_orders` 表定义同步增加 `user_id VARCHAR(64)`。
- `juzhu/gr_orders.py`：`create_order(conn, order_ref, sku, city, vendor_id, user_id=None)`，
  INSERT 时写入 user_id。

## user_id 链路

- `screens/_jzapi.js`：新增 `BZF_JZ.userId()` / `BZF_JZ.setUserId(id)`，key 为
  `jz_demo_user_id`，未设置时返回默认 `demo_user_001`（模拟期常量，注释标注后期替换为真实获取逻辑）。
- `index.html`：加载时调用 `BZF_JZ.setUserId('demo_user_001')`（模拟用户 id，后期替换）。
- `juzhu-jiazheng-detail.html`：下单 `POST /api/juzhu/jiazheng/wechat-link` 的 body 增加
  `user_id: JZ.userId()`。
- `juzhu/jiazheng_api.py` `handle_wechat_link`：读取 `body.get("user_id")`，透传 `create_order`。
- 回调 `update_order_callback` 不改动 user_id（创建时写入，回调只推进状态）。

## 后端接口

新增 `GET /api/juzhu/gr/orders?user_id=xxx&limit=50`（匿名可调，对齐 wechat-link 的
"勿依赖 API Key"约定；插入 server.py 公开 GET 区，精确路由声明在正则捕获路由之前）：

- `user_id` 必填，缺失返回 400。
- 过滤 `status != 'pending'`；按 `created_at DESC` 排序。
- `counts` 仅统计 4 状态：`{paid, assigned, serving, completed}`。
- 每条订单 LEFT JOIN `jz_products`（`gr_orders.sku` 存的是 product_id）取 `product_name`；
  查不到产品时 `product_name` 为 NULL（前端显示"服务（已下架）"，不造 mock 名称）。
- 返回结构：`{"ok": true, "counts": {...}, "list": [{order_ref, vendor_oid, sku, city, status,
  fee, worker_name, worker_phone, eta, cancel_reason, paid_at, completed_at, created_at,
  updated_at, product_name, user_id}, ...]}`

详情复用列表接口数据即可：列表页点击详情时经 URL 参数 `order_ref` 传参，详情页从
`/api/juzhu/gr/orders?user_id=...` 结果中匹配，或直接新增单条查询 `GET /api/juzhu/gr/orders/{order_ref}`
（若实现简单则采用后者；两种均可，计划阶段以单条查询接口落地）。

## 前端页面

### 1. 快捷入口（index.html pane-jiazheng）

「热门子类」区块之后新增：

```
── 我的订单                   全部订单 ›
[已支付] [已派单] [服务中] [已完成]   （角标数字）
```

- CSS 仿 lvju-app-me.html 的 ordbar（bdg 角标 + ic + 标签），样式写入 index.html 现有 `<style>`。
- 数据：`GET /api/juzhu/gr/orders?user_id=BZF_JZ.userId()` 的 counts。
- 行为约定：接口成功且 counts 全 0 → 区块仍显示（4 格 0 角标，保证可进入"全部订单"空态页）；
  接口失败 → 整块隐藏（禁用硬编码 fallback）。
- 4 格分别链接 `juzhu-jiazheng-orders.html?status=paid|assigned|serving|completed`；
  「全部订单」链接不带 status。

### 2. 订单列表页：新建 `juzhu-jiazheng-orders.html`

- 引入 `lvju-app.css`，复用 `.otabs` 状态 tab（全部/已支付/已派单/服务中/已完成）
  与 `.ordcard`（`.oh` 状态头 / `.ob` 缩略图+信息 / `.of` 操作区）卡片体系。
- 状态标签色：在页面 `<style>` 内补充 `.stt` 变体（paid/assigned/serving/done/cancelled）。
- 卡片信息：product_name、city、fee（分转元）、order_ref、created_at；缩略图用类目 emoji
  （sku 是 product_id，不强制取图）。
- 操作区仅一个按钮：「查看详情」→ `juzhu-jiazheng-order-detail.html?order_ref=...`。
- 全部 tab 下 cancelled 订单正常展示（"已取消"标签）；pending 已被接口过滤，永不出现。
- 空态：接口成功且 list 为空 → 显示"暂无订单"空态文案；接口失败 → 显示加载失败提示，
  不渲染任何 mock 订单。

### 3. 订单详情页：新建 `juzhu-jiazheng-order-detail.html`

- 上半部：固定 5 步状态条（下单→已支付→已派单→服务中→已完成），当前状态之前的步骤标
  已完成样式，当前步骤高亮，之后步骤灰显。步骤时间映射：
  - 下单 = created_at；已支付 = paid_at；已派单 = eta（预计上门）；服务中 = updated_at；
    已完成 = completed_at。缺失时间显示"—"。
- 下半部：订单信息卡：服务名称（product_name，NULL 时"服务（已下架）"）、金额 fee、
  城市、服务者（worker_name / worker_phone，有才显示）、预计上门 eta、订单号 order_ref、
  下单/支付/完成时间。无任何操作按钮。

## 测试策略

项目无 pytest，沿用 `juzhu/test_jiazheng_flow.py` 的 urllib 直连冒烟脚本模式，新增
`juzhu/test_gr_my_orders.py`：

1. user_id 列迁移存在性（`PRAGMA table_info(gr_orders)`）。
2. `POST /api/juzhu/jiazheng/wechat-link` 带 user_id → gr_orders 落库含 user_id。
3. `GET /api/juzhu/gr/orders` 过滤 pending：创建 pending 订单后接口不返回该单，
   counts 为 0；回调推进 paid/assigned/serving/completed 后对应 counts 正确。
4. 缺少 user_id 参数返回 400。

前端为静态页 + 手工链路验证：index 设 user_id → 详情页下单 → 回调推进状态 →
入口角标/列表/详情一致。

## 规范遵守

- 前端渲染禁用硬编码 fallback（无数据隐藏 / 空态文案，不造 mock）。
- server.py 路由顺序：精确匹配 `/api/juzhu/gr/orders` 声明在 `^/api/juzhu/gr/orders/([^/]+)$` 之前。
- Git 提交：中文 + 作用域前缀（`feat(juzhu): ...`），语义相关改动分独立提交。
