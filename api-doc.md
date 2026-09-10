# juzhu 本地生活服务平台 · API 接口文档

> 版本：v1.0 ｜ 更新日期：2026-08-13 ｜ 适用平台：juzhu 本地生活服务（新居住频道 + 家政服务）
> 本文档接口全部来自生产代码（server.py / jiazheng_api.py / gr_orders.py / db.py），可直接对接联调。

---

## 1. 概述

### 1.1 Base URL

| 环境 | 地址 |
|------|------|
| 生产环境 | `https://shenyang.meizu.life/api/juzhu` |
| 本地/内网 | `http://127.0.0.1:8765/api/juzhu`（server.py 监听端口） |

### 1.2 内容类型

- 请求/响应均为 `application/json; charset=utf-8`
- 支持 CORS（`Access-Control-Allow-Origin: *`），允许 `GET / POST / PUT / DELETE / OPTIONS`

### 1.3 鉴权体系（两套并行）

| 调用方 | 鉴权方式 | 适用范围 |
|--------|----------|----------|
| 管理台（P/B 端页面） | **API Key**（`Authorization: Bearer <key>` 或 `X-API-Key: <key>`） | 管理端写接口 + 订单流接口 |
| 第三方商家（B 端系统对接） | **HMAC-SHA256 签名**（vendor_id + sign） | 商家产品管理 + 订单状态回调 |
| 公开只读 | 无 | C 端展示、类目/SPU/产品/服务者查询 |

> 管理台默认密钥：`dev-juzhu-key`（正式环境使用分配的生产密钥，通过环境变量 `API_KEY` 配置）。

---

## 2. 接口总览

### 2.1 公开只读接口（GET，无需鉴权）

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 1 | GET | `/api/juzhu/cities` | 城市列表 |
| 2 | GET | `/api/juzhu/stats` | 平台统计（区县/保租房/二手房/管理房源数） |
| 3 | GET | `/api/juzhu/settings` | 平台开关与预订电话 |
| 4 | GET | `/api/juzhu/districts` | 区县列表 |
| 5 | GET | `/api/juzhu/ratings` | 评级公示列表（按状态筛选） |
| 6 | GET | `/api/juzhu/ratings/{code}` | 评级公示详情 |
| 7 | GET | `/api/juzhu/districts/{slug}/projects` | 区县下保租房项目 |
| 8 | GET | `/api/juzhu/projects/{slug}` | 项目详情 |
| 9 | GET | `/api/juzhu/projects/{slug}/units` | 项目房源（含照片） |
| 10 | GET | `/api/juzhu/trade` | 二手房/交易列表 |
| 11 | GET | `/api/juzhu/jz/categories` | 家政服务子类目（P/B 视角） |
| 12 | GET | `/api/juzhu/jz/spu` | 平台标准品 SPU 全量（P 端 SPU 管理台） |
| 13 | GET | `/api/juzhu/jz/slots` | 排班档期列表（按 product_id） |
| 14 | GET | `/api/juzhu/jz/vendors` | 商家列表（人力服务商） |
| 15 | GET | `/api/juzhu/jz/vendors/{id}` | 商家详情 |
| 16 | GET | `/api/juzhu/jz/products` | 商家产品列表（按 vendor/type/status 筛选） |
| 17 | GET | `/api/juzhu/jz/products/{id}` | 产品详情 |
| 18 | GET | `/api/juzhu/jz/workers` | 服务者列表（在线/按商家/全部） |
| 19 | GET | `/api/juzhu/jz/workers/{id}` | 服务者详情 |
| 20 | GET | `/api/juzhu/jz/orders` | 订单列表（status/limit 筛选） |
| 21 | GET | `/api/juzhu/jz/orders/overview` | 订单概览漏斗 |
| 22 | GET | `/api/juzhu/jz/orders/{id}` | 订单详情 |
| 23 | GET | `/api/juzhu/jz/activities` | 活动列表（按 tag_id） |
| 24 | GET | `/api/juzhu/jiazheng/categories` | 家政类目（C 端启用项） |
| 25 | GET | `/api/juzhu/jiazheng/workers` | 服务者（C 端展示） |
| 26 | GET | `/api/juzhu/jiazheng/orders` | 订单列表（`?phone=` 或 API Key） |
| 27 | GET | `/api/juzhu/jiazheng/orders/{id}` | 订单详情（C 端视图） |
| 28 | GET | `/api/juzhu/jiazheng/skus` | C 端 SKU 列表（可售产品聚合） |
| 29 | GET | `/api/juzhu/jiazheng/skus/{slug}` | SKU 详情（含比价商家/服务者/评价） |
| 30 | GET | `/api/juzhu/jiazheng/skus/{slug}/slots` | SKU 可约档期（滚动 5 天） |
| 31 | GET | `/api/juzhu/life/*` | 生活服务 API 桥接（第三方） |

### 2.2 管理端写接口（API Key，前缀 `/api/juzhu/admin`）

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 32 | GET/POST | `/api/juzhu/admin/districts` | 区县列表/新增 |
| 33 | PUT/DELETE | `/api/juzhu/admin/districts/{id}` | 区县编辑/删除 |
| 34 | GET/POST | `/api/juzhu/admin/projects` | 项目列表（channel/district/city/q 筛选）/新增 |
| 35 | GET/PUT/DELETE | `/api/juzhu/admin/projects/{id}` | 项目详情/编辑/删除 |
| 36 | POST | `/api/juzhu/admin/projects/{id}/units` | 项目下新增房源 |
| 37 | POST | `/api/juzhu/admin/projects/{id}/rating/submit` | 提交项目评级 |
| 38 | POST | `/api/juzhu/admin/ratings/{code}/review` | 评级复核 |
| 39 | GET/PUT/DELETE | `/api/juzhu/admin/units/{id}` | 房源详情/编辑/删除 |
| 40 | GET/POST | `/api/juzhu/admin/units/{id}/photos` | 房源照片列表/上传 |
| 41 | PUT/DELETE | `/api/juzhu/admin/photos/{id}` | 照片编辑/删除 |
| 42 | POST | `/api/juzhu/admin/export` | 全量数据导出（刷新统计） |
| 43 | GET/PUT | `/api/juzhu/admin/settings` | 平台设置读取/更新 |
| 44 | GET | `/api/juzhu/admin/dictionary` | 字典数据（类目/标签等） |
| 45 | PUT | `/api/juzhu/admin/city` | 城市信息更新 |
| 46 | PUT | `/api/juzhu/admin/channels/{slug}` | 频道开关更新 |
| 47 | POST | `/api/juzhu/admin/upload` | 文件上传（multipart） |

### 2.3 家政订单流接口（API Key）

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 48 | POST | `/api/juzhu/jiazheng/orders` | 创建订单（C 端下单） |
| 49 | POST | `/api/juzhu/jiazheng/orders/{id}/pay` | 支付（幂等；占用档期名额） |
| 50 | POST | `/api/juzhu/jiazheng/orders/{id}/quote` | 维修单报价 |
| 51 | POST | `/api/juzhu/jiazheng/orders/{id}/dispatch` | 派单（自动/指定） |
| 52 | POST | `/api/juzhu/jiazheng/orders/{id}/advance` | 状态推进（服务者侧） |
| 53 | POST | `/api/juzhu/jiazheng/orders/{id}/rate` | 客户评价（1-5 星） |
| 54 | POST | `/api/juzhu/jiazheng/orders/stats` | 订单统计（GET，需 Key） |
| 55 | POST | `/api/juzhu/jiazheng/wechat-link` | 生成微信小程序 URL Link + 创建 GR 订单 |

### 2.4 家政管理台写接口（API Key，前缀 `/api/juzhu/jz`）

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 56 | POST | `/api/juzhu/jz/orders` | 创建订单（兼容旧字段名） |
| 57 | POST | `/api/juzhu/jz/orders/{id}/dispatch` | 派单（手动 worker_id 或自动选第一名在线） |
| 58 | POST | `/api/juzhu/jz/orders/{id}/status` | 订单状态推进（管理台） |
| 59 | POST | `/api/juzhu/jz/orders/{id}/rate` | 评价（含信用分变动） |
| 60 | POST | `/api/juzhu/jz/categories` | 新增类目 |
| 61 | PUT/DELETE | `/api/juzhu/jz/categories/{id}` | 类目编辑/删除 |
| 62 | POST | `/api/juzhu/jz/spu` | 新增 SPU（平台标准品） |
| 63 | PUT/DELETE | `/api/juzhu/jz/spu/{id}` | SPU 编辑/删除 |
| 64 | POST | `/api/juzhu/jz/slots/generate` | 批量生成档期 |
| 65 | POST | `/api/juzhu/jz/slots` | 新增档期 |
| 66 | PUT/DELETE | `/api/juzhu/jz/slots/{id}` | 档期状态/删除 |
| 67 | POST | `/api/juzhu/jz/products` | 新增产品（商家 SKU） |
| 68 | PUT/DELETE | `/api/juzhu/jz/products/{id}` | 产品编辑/删除 |
| 69 | POST | `/api/juzhu/jz/workers` | 新增服务者 |
| 70 | PUT/DELETE | `/api/juzhu/jz/workers/{id}` | 服务者编辑/删除 |

### 2.5 第三方商家接口（HMAC-SHA256 签名）

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 71 | POST | `/api/juzhu/callback` | 订单状态回调（支付/派单/服务/完成/取消） |
| 72 | POST | `/api/juzhu/jiazheng/vendor/categories/list` | 类目列表 |
| 73 | POST | `/api/juzhu/jiazheng/vendor/skus/list` | SPU（平台标准品）列表 |
| 74 | POST | `/api/juzhu/jiazheng/vendor/products/list` | 产品列表（筛选） |
| 75 | POST | `/api/juzhu/jiazheng/vendor/products/detail` | 产品详情 |
| 76 | POST | `/api/juzhu/jiazheng/vendor/products/create` | 创建产品 |
| 77 | POST | `/api/juzhu/jiazheng/vendor/products/update` | 编辑产品 |
| 78 | POST | `/api/juzhu/jiazheng/vendor/products/status` | 状态变更（上架/下架/售罄） |
| 79 | POST | `/api/juzhu/jiazheng/vendor/products/delete` | 删除产品（软删） |

---

## 3. 认证方式

### 3.1 API Key（管理台 / 订单流）

请求头二选一：

```
Authorization: Bearer dev-juzhu-key
X-API-Key: dev-juzhu-key
```

未通过校验返回：

```json
{ "error": "unauthorized", "message": "请通过 Authorization: Bearer <API_KEY> 或 X-API-Key 传入有效 API Key" }
```

### 3.2 HMAC-SHA256 签名（第三方商家）

GR 侧为每个商家分配唯一 `vendor_id` 和密钥，商家在每个请求体中附带签名。

**签名步骤：**

1. 构造业务请求体，确保包含 `vendor_id`
2. 移除 `sign` 字段（如存在）
3. 生成当前时间戳（毫秒），以 `timestamp` 为键加入
4. 嵌套对象递归展平：`{"worker":{"name":"李"}}` → `worker.name=李`
5. 过滤值为 `null` 或 `""` 的字段
6. 按 Key 字典序排序
7. 拼接 `key1=value1&key2=value2&...`
8. 以商家密钥为 key 计算 HMAC-SHA256，取 hex 小写即 `sign`
9. 将 `timestamp` 与 `sign` 一并放入请求 JSON

服务端校验：时间戳误差窗口 5 分钟（防重放），签名不匹配返回 401。

**测试密钥：**

```
VENDOR_ID = 41
SECRET    = 7d993c779bcaecf3180239984fe679a8f963a501a5b160e2dc434bce9a20666d
```

**签名示例（产品列表）：**

原始参数：

```json
{ "vendor_id": 41, "status": "on" }
```

加入 timestamp → 排序 → 拼接：

```
status=on&timestamp=1785998316159&vendor_id=41
```

`HMAC-SHA256(secret, 上述字符串)` 的 hex 摘要即 `sign`，最终请求体：

```json
{
  "vendor_id": 41,
  "status": "on",
  "timestamp": 1785998316159,
  "sign": "a1b2c3d4..."
}
```

---

## 4. 核心数据模型

### 4.1 SKU = SPU + 服务者 + 价格（平台规则）

```
类目 jz_categories（平台标准类目）
  └── SPU jz_skus（平台标准品：标准工序/参考价/最低等级，商家不可改）
        └── 商家产品 jz_products（channel_sku_id 指向 SPU + vendor_id 商家 + 自定义价格）
              └── 排班档期 jz_sku_slots（product_id + 服务者 + 时段 + 容量）
```

- **SPU 由平台定义**：标准工序、参考价、所需最低服务等级；商家只能在其上创建自己的产品（SKU），不能修改 SPU 本身
- **产品（商家 SKU）= SPU + 服务者 + 价格**：同一 SPU 下不同商家可挂不同价格，C 端比价
- 产品状态：`on`（上架）/ `off`（下架）/ `soldout`（售罄）

### 4.2 订单状态机

```
pending(待派单) → dispatched(已派单) → accepted(已接单) → serving(服务中) → done(待评价) → rated(已评价)
     │                │
     └── cancelled(已取消)
```

支付状态：`unpaid` → `paid`（`pay_status` 独立于业务状态）。

### 4.3 档期占用规则

- 下单时**只记录档期意向**，不做名额占用（软校验）
- **支付时才占用名额**（`book_slot`）：档期已满/已关则支付失败（409），订单保持 unpaid，用户改期
- 滚动排期：SKU 档期查询时自动补足未来 5 天（`ensure_rolling_slots`）

---

## 5. 公开只读接口详解

### 5.1 GET /api/juzhu/cities

城市列表。可选参数：`?city=`（城市名或 slug）。

**响应：**

```json
[
  { "id": 1, "name": "沈阳", "slug": "shenyang", "booking_phone": "024-12345678" }
]
```

### 5.2 GET /api/juzhu/stats

平台统计。可选 `?city=`。

**响应：**

```json
{
  "districts": 11,
  "projects_bzf": 23,
  "projects_trade": 156,
  "units": 4280
}
```

### 5.3 GET /api/juzhu/settings

**响应：**

```json
{
  "booking_phone": "024-12345678",
  "show_city_switcher": true,
  "show_life_service": true
}
```

### 5.4 GET /api/juzhu/districts

区县列表。可选 `?city=`。

### 5.5 GET /api/juzhu/ratings

评级公示列表。可选参数：`?status=pending|approved|rejected`。

### 5.6 GET /api/juzhu/ratings/{code}

评级公示详情（code 形如 `SY-BZF-{id}`）。

### 5.7 GET /api/juzhu/districts/{slug}/projects

**响应：**

```json
{
  "district": { "id": 1, "name": "和平区", "slug": "heping" },
  "projects": [ { "id": 1, "name": "...", "channel": "bzf" } ]
}
```

### 5.8 GET /api/juzhu/projects/{slug}

项目详情。

### 5.9 GET /api/juzhu/projects/{slug}/units

**响应：**

```json
{
  "project": { "id": 1, "name": "..." },
  "units": [ { "id": 1, "name": "A栋1单元", "sort_order": 0 } ],
  "photos": [ { "id": 1, "entity_type": "unit", "entity_id": 1, "url": "..." } ]
}
```

### 5.10 GET /api/juzhu/trade

二手房/交易列表。可选 `?city=`。**响应：** `{ "listings": [...] }`

### 5.11 GET /api/juzhu/jz/categories

家政服务子类目（P/B 视角）。参数：`?type=`、`?all=1`（含禁用）。

### 5.12 GET /api/juzhu/jz/spu

平台标准品 SPU 全量（P 端 SPU 管理台数据源）。

### 5.13 GET /api/juzhu/jz/slots

排班档期列表。**必填：** `?product_id=123`。

### 5.14 GET /api/juzhu/jz/vendors

商家列表。参数：`?type=`（如 `renli` 人力服务商）。

### 5.15 GET /api/juzhu/jz/products

产品列表。参数：`?vendor_id=`、`?type=`、`?status=`。

**响应：** `{ "list": [...] }`

### 5.16 GET /api/juzhu/jz/workers

服务者列表。参数：`?vendor_id=`、`?all=1`（全部，否则返回在线）。

### 5.17 GET /api/juzhu/jz/orders

订单列表。参数：`?status=`、`?limit=`（默认 50）。

### 5.18 GET /api/juzhu/jz/orders/overview

订单概览漏斗（今日各状态计数）。

### 5.19 GET /api/juzhu/jz/orders/{id}

订单详情。

### 5.20 GET /api/juzhu/jz/activities

活动列表。参数：`?tag_id=`。

### 5.21 GET /api/juzhu/jiazheng/categories

C 端启用的家政类目（`enabled=1`）。

**响应：**

```json
{ "items": [ { "id": 1, "name": "保洁", "icon": "🧹", "sort_order": 0 } ] }
```

### 5.22 GET /api/juzhu/jiazheng/skus

C 端可售 SKU 列表（仅含已有上架产品的 SPU）。参数：`?category=`、`?q=`（名称/规格模糊）。

**响应：**

```json
{
  "items": [
    {
      "id": 1, "slug": "baojie-3h", "name": "日常保洁 3 小时", "spec": "3h/次",
      "category_id": 1, "category_name": "保洁", "category_icon": "🧹",
      "product_min_price": 12900, "unit": "次"
    }
  ]
}
```

> 价格为分（如 12900 = ¥129）。

### 5.23 GET /api/juzhu/jiazheng/skus/{slug}

SKU 详情。参数：`?vendor=`（指定商家）。

**响应：**

```json
{
  "item": { "id": 1, "slug": "baojie-3h", "name": "...", "product_min_price": 12900 },
  "related": [ "...同品类其他 SKU（最多 4 个）..." ],
  "product": { "商家默认产品详情" },
  "vendor": { "商家详情" },
  "vendors": [ "同款多商家（比价/切换）" ],
  "workers": [ "可提供服务者" ],
  "reviews": [ "评价" ],
  "merchant_intro": "商家介绍"
}
```

### 5.24 GET /api/juzhu/jiazheng/skus/{slug}/slots

SKU 可约档期（自动滚动补足 5 天）。参数：`?vendor=`。

**响应：** `{ "slots": [ { "id": 1, "slot_date": "2026-08-14", "start_time": "09:00", "end_time": "12:00", "status": "open", "capacity": 1, "booked": 0, "worker": { "id": 1, "name": "李师傅", "level": "L3" } } ] }`

### 5.25 GET /api/juzhu/life/*

生活服务桥接接口，转发至第三方（见 §8 回调与桥接）。

---

## 6. 管理端接口详解（API Key）

> 除特别说明外，均需 `Authorization: Bearer <key>`。

### 6.1 区县管理

- `GET /api/juzhu/admin/districts` → 区县数组
- `POST /api/juzhu/admin/districts` → 新增，body：`{ "name", "slug", "city_id", "sort_order" }` → `{ "ok": true, "id": n }`
- `PUT /api/juzhu/admin/districts/{id}` → 编辑
- `DELETE /api/juzhu/admin/districts/{id}` → 删除（有项目时禁止）

### 6.2 项目管理

- `GET /api/juzhu/admin/projects`：筛选 `?channel=bzf|trade`、`?district_id=`、`?city_id=`、`?q=`（名称模糊）
- `POST /api/juzhu/admin/projects`：新增项目
- `GET /api/juzhu/admin/projects/{id}`：项目 + 房源 + 照片
- `PUT /api/juzhu/admin/projects/{id}`：编辑
- `DELETE /api/juzhu/admin/projects/{id}`：删除
- `POST /api/juzhu/admin/projects/{id}/units`：新增房源
- `POST /api/juzhu/admin/projects/{id}/rating/submit`：提交评级 → `{ "ok": true, "code": "SY-BZF-{id}" }`

### 6.3 房源与照片

- `GET/PUT/DELETE /api/juzhu/admin/units/{id}`
- `GET /api/juzhu/admin/units/{id}/photos`：照片列表
- `POST /api/juzhu/admin/units/{id}/photos`：上传照片
- `PUT/DELETE /api/juzhu/admin/photos/{id}`

### 6.4 平台设置

- `GET /api/juzhu/admin/settings` → `{ "key": "value" }`（settings 表全量）
- `PUT /api/juzhu/admin/settings` → 更新（body 为键值对，含 `show_city_switcher` / `show_life_service` 等布尔开关）
- `GET /api/juzhu/admin/dictionary`：字典（评级指标、标签、服务类目等）
- `PUT /api/juzhu/admin/city`：更新城市信息（预订电话等）
- `PUT /api/juzhu/admin/channels/{slug}`：频道开关（bzf / trade / life）

### 6.5 数据导出与上传

- `POST /api/juzhu/admin/export`：刷新区县统计并导出全量 → `{ "ok": true, "stats": {...} }`
- `POST /api/juzhu/admin/upload`：multipart 文件上传 → `{ "ok": true, "url": "..." }`

---

## 7. 家政订单流接口详解（API Key）

### 7.1 POST /api/juzhu/jiazheng/orders —— 创建订单

**请求：**

```json
{
  "product_id": 123,
  "expectTime": "2026-08-15T09:00:00",
  "house": "沈阳市和平区XX路1号",
  "phone": "13800000000",
  "desc": "全屋深度保洁",
  "slot_id": 45,
  "worker_id": 8,
  "source": "新居住频道"
}
```

- `product_id` / `sku_id`（兼容旧字段名）必填，且产品须 `status='on'` 且 SPU/类目启用
- `house` / `phone` / `expectTime`（或 `expect_time` / `scheduled_at`）必填
- `slot_id` 可选：记录档期意向（软校验，已满返回 409）
- `worker_id` / `preferred_worker_id` 可选：客户指定服务者
- `fee` 可选，默认取产品价格

**响应（201）：**

```json
{
  "ok": true,
  "order": {
    "id": "JZ202608131200001234",
    "sku_id": 123, "category_id": "clean", "category": "日常保洁",
    "type": "保洁", "icon": "🧹",
    "house": "沈阳市和平区XX路1号", "phone": "13800000000",
    "expect_time": "2026-08-15T09:00:00", "desc": "全屋深度保洁",
    "fee": 12900, "pay_status": "unpaid", "status": "pending",
    "worker": { "preferred": {...}, "slot": {...} },
    "source": "新居住频道", "created_at": "2026-08-13T12:00:00Z",
    "log": [ { "s": "pending", "at": "2026-08-13T12:00:00Z", "by": "user" } ]
  },
  "sku": { "id": 123, "price_from": 12900, "category_id": "clean", "category_name": "保洁" }
}
```

### 7.2 POST /api/juzhu/jiazheng/orders/{id}/pay —— 支付

**请求：** `{ "pay_method": "贝壳支付" }`

- 幂等：已支付订单重复调用返回当前订单视图
- 占用档期名额（若下单时选了档期）；档期已满/已关返回 **409**

**响应：** `{ "ok": true, "order": {...} }`（`pay_status: "paid"`, `pay_at` 已写入）

### 7.3 POST /api/juzhu/jiazheng/orders/{id}/quote —— 维修报价

**请求：**

```json
{
  "quote_items": [ { "name": "更换水龙头", "price": 15000 } ],
  "quote_note": "包含上门费与辅材"
}
```

- 仅 `category_id='repair'`（维修单）支持报价，其他类目返回 400
- 报价金额累加进订单 `fee`，报价说明追加到 `desc`

**响应：**

```json
{ "ok": true, "order": {...}, "quote_items": [ { "name": "更换水龙头", "price": 15000 } ] }
```

### 7.4 POST /api/juzhu/jiazheng/orders/{id}/dispatch —— 派单

**请求：** `{ "worker": { "id": 8, "name": "李师傅", "level": "L3" } }`

**派单逻辑（真实实现）：**

1. 订单须已支付（`pay_status='paid'`），否则 400「订单未支付，不可派单」
2. 仅 `pending`（待派单）状态可派单
3. 未传 `worker` 时：优先**尊重客户选择**（下单时选定的服务者，标记 `from_customer: true`）；无首选则按轮询分配内置服务者池
4. 保留客户预约档期（写入 worker.slot）
5. 状态 → `dispatched`，日志追加派单记录

**响应：** `{ "ok": true, "order": {...} }`（含 `worker` 与 `log`）

### 7.5 POST /api/juzhu/jiazheng/orders/{id}/advance —— 状态推进

**请求：** `{}`（服务者侧操作）

- 按状态机自动推进 `dispatched → accepted → serving → done`
- `pending` 状态不可推进（需先派单）；`rated` 只能由客户评价产生

**响应：** `{ "ok": true, "order": {...} }`

### 7.6 POST /api/juzhu/jiazheng/orders/{id}/rate —— 客户评价

**请求：**

```json
{
  "score": 5,
  "tags": ["准时", "干净"],
  "text": "非常专业"
}
```

- `score` 须为 1-5 整数，否则 400
- 仅 `done`（待评价）状态可评价，评价后状态 → `rated`

**响应：** `{ "ok": true, "order": {...} }`（含 `rating`）

### 7.7 POST /api/juzhu/jiazheng/wechat-link —— 生成微信 URL Link

**请求：** `{ "product_id": 123 }`

**流程（真实实现）：**

1. 校验产品存在且 `status='on'`
2. 生成 GR 订单号：`GR + YYYYMMDDHHmmss + 4位随机数`（查重防碰撞，最多重试 10 次）
3. 调用第三方小程序链接生成接口（config.ini `[wechat] url_link_api`，携带 `Token`）
4. 创建 gr_orders 记录（status=`pending`，写入 `order_ref`）
5. 返回 url_link

**响应：**

```json
{
  "ok": true,
  "url_link": "weixin://dl/business/?t=xxxx",
  "order_ref": "GR202608131200001234"
}
```

---

## 8. 第三方商家接口详解（HMAC-SHA256）

> 所有请求体必须含 `vendor_id` + `timestamp` + `sign`（见 §3.2 签名算法）。

### 8.1 POST /api/juzhu/callback —— 订单状态回调

第三方小程序在用户下单/订单状态变更后回传 GR 侧。

**请求参数：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `vendor_id` | integer | ✅ | 商家 ID，由 GR 侧分配 |
| `order_ref` | string | ✅ | GR 侧订单参考号（如 `GR202608071429360148`） |
| `lailai_oid` | string | ✅ | 来来订单号 |
| `status` | string | ✅ | 订单状态（见状态表） |
| `fee` | integer | 条件 | `paid` 时必填，金额（分） |
| `worker` | object | 条件 | `assigned` 时必填 |
| `worker.name` | string | 条件 | 服务者姓名 |
| `worker.phone` | string | 条件 | 服务者电话 |
| `worker.eta` | string | 条件 | 预计到达时间（ISO 8601） |
| `cancel_reason` | string | 条件 | `cancelled` 时必填 |
| `timestamp` | integer | ✅ | 毫秒时间戳（防重放，5 分钟窗口） |
| `sign` | string | ✅ | HMAC-SHA256 签名 |

**状态枚举：**

| status | 说明 | 必填额外字段 |
|--------|------|-------------|
| `paid` | 已支付 | `fee` |
| `assigned` | 已派单 | `worker`（name/phone/eta） |
| `serving` | 服务中 | — |
| `completed` | 已完成 | — |
| `cancelled` | 已取消 | `cancel_reason` |

> 首次回调 `paid` 时仅按 `order_ref` 查找并写入 `lailai_oid`；后续状态变更需 `order_ref` + `lailai_oid` 联合匹配。

**响应：** `{ "code": 0, "message": "success" }`

**错误码：**

| code | HTTP | 说明 |
|------|------|------|
| 0 | 200 | 成功 |
| 400 | 400 | 缺少必填参数或条件必填不满足 |
| 401 | 401 | 签名校验失败（密钥未配置/签名缺失/时间戳过期/不匹配） |
| 404 | 404 | 订单不存在 |
| 500 | 500 | 服务端内部错误 |

### 8.2 商家产品管理接口

统一前缀 `/api/juzhu/jiazheng/vendor/`，全部 POST + HMAC 签名。

**8.2.1 POST .../categories/list —— 类目列表**

**响应：** `{ "code": 0, "message": "success", "data": [ { "id", "name", "icon" } ] }`

**8.2.2 POST .../skus/list —— SPU 列表**

平台标准品（不可修改，商家基于其创建产品）。

**8.2.3 POST .../products/list —— 产品列表**

请求体：`{ "vendor_id": 41, "status": "on", "page": 1, "page_size": 20 }`

**8.2.4 POST .../products/detail —— 产品详情**

请求体：`{ "vendor_id": 41, "product_id": 123 }`

**8.2.5 POST .../products/create —— 创建产品**

请求体：

```json
{
  "vendor_id": 41,
  "sku_id": 1,
  "name": "日常保洁 3 小时（和平店）",
  "price": 12900,
  "stock": 100,
  "spec": "3h/次"
}
```

**8.2.6 POST .../products/update —— 编辑产品**

**8.2.7 POST .../products/status —— 状态变更**

请求体：`{ "vendor_id": 41, "product_id": 123, "status": "on|off|soldout" }`

**8.2.8 POST .../products/delete —— 删除（软删）**

请求体：`{ "vendor_id": 41, "product_id": 123 }`

---

## 9. 管理台写接口详解（/api/juzhu/jz/*，API Key）

> 这些接口是 P 端管理台（类目/SPU/档期/产品/服务者）与订单状态推进的数据源，全部需要 API Key（此前曾存在可匿名调用的安全隐患，已修复，见 CLAUDE.md 规则 9）。

### 9.1 类目管理

- `POST /api/juzhu/jz/categories` → 新增 → `{ "ok": true, "id": n }`
- `PUT /api/juzhu/jz/categories/{id}` → 编辑 → `{ "ok": true }`
- `DELETE /api/juzhu/jz/categories/{id}` → 删除 → `{ "ok": true }`（有关联数据返回 400）

### 9.2 SPU 管理（平台标准品）

- `POST /api/juzhu/jz/spu` → 新增 → `{ "ok": true, "id": n }`
- `PUT /api/juzhu/jz/spu/{id}` → 编辑
- `DELETE /api/juzhu/jz/spu/{id}` → 删除

### 9.3 档期管理

- `POST /api/juzhu/jz/slots/generate` → 批量生成

```json
{
  "product_id": 123,
  "worker_ids": [8, 9],
  "dates": ["2026-08-15"],
  "times": ["09:00-12:00"],
  "capacity": 1
}
```

→ `{ "ok": true, "created": n }`

- `POST /api/juzhu/jz/slots` → 新增单档期
- `PUT /api/juzhu/jz/slots/{id}` → `{ "status": "open|closed" }` → `{ "ok": true }`
- `DELETE /api/juzhu/jz/slots/{id}` → 删除

### 9.4 产品管理

- `POST /api/juzhu/jz/products` → 新增 → `{ "ok": true, "id": n }`
- `PUT /api/juzhu/jz/products/{id}` → 编辑
- `DELETE /api/juzhu/jz/products/{id}` → 删除

### 9.5 服务者管理

- `POST /api/juzhu/jz/workers` → 新增 → `{ "ok": true, "id": n }`
- `PUT /api/juzhu/jz/workers/{id}` → 编辑
- `DELETE /api/juzhu/jz/workers/{id}` → 删除

### 9.6 订单状态推进（管理台）

- `POST /api/juzhu/jz/orders` → 创建订单（字段与 §7.1 一致，兼容 `product_id`/`sku_id`、`address`/`house`、`scheduled_at`/`expectTime`）
- `POST /api/juzhu/jz/orders/{id}/dispatch` → 派单。请求：`{ "worker_id": 8 }`；不传则自动选第一名在线服务者
- `POST /api/juzhu/jz/orders/{id}/status` → 状态推进。请求：`{ "status": "accepted" }`（合法值：pending/dispatched/accepted/serving/done/rated/cancelled）
- `POST /api/juzhu/jz/orders/{id}/rate` → 评价（信用分联动）。请求：`{ "score": 5, "tags": [], "text": "" }`

**信用分变动规则（真实实现）：**

| 评分 | 信用分变动 |
|------|-----------|
| 5 星 | +2.4 |
| 4 星 | +1.2 |
| 2-3 星 | −1.5 |
| 1 星 | −3.0 |

---

## 10. GR 订单模块（gr_orders.py）

GR 侧预约订单（来来回调）独立于家政订单表，专用于小程序跳转-回传闭环。

### 10.1 表结构

| 字段 | 说明 |
|------|------|
| `order_ref` | GR + YYYYMMDDHHmmss + 4 位随机数（唯一，查重防碰撞） |
| `sku` | 关联产品 ID |
| `city` | 城市（默认"沈阳"） |
| `status` | pending → paid → assigned → serving → completed / cancelled |
| `lailai_oid` | 来来订单号（paid 回调写入） |
| `fee` | 金额（分，paid 回调写入） |
| `worker_name` / `worker_phone` / `eta` | 派单信息（assigned 回调写入） |
| `cancel_reason` | 取消原因 |
| `created_at` | 创建时间 |

### 10.2 闭环流程

```
① 商家小程序 → POST /api/juzhu/jiazheng/wechat-link（product_id）
② 平台生成 order_ref + 调第三方 URL Link API → 返回 weixin:// 链接
③ 用户在小程序内下单支付 → 小程序回调 POST /api/juzhu/callback（status=paid, fee）
④ 派单 → 回调 status=assigned（worker 信息）
⑤ 服务中/完成/取消 → 回调对应状态
```

---

## 11. 错误码约定

### 11.1 平台接口（/api/juzhu/*）

| HTTP | 说明 |
|------|------|
| 200 | 成功 |
| 201 | 创建成功（订单） |
| 400 | 参数错误 / 状态非法 / 仅维修单可报价 / 未支付不可派单 |
| 401 | API Key 无效 / HMAC 签名校验失败 |
| 404 | 资源不存在 / 未知路由 |
| 409 | 档期已约满（支付占用冲突） |
| 500 | 服务端内部错误 |

错误响应统一格式：`{ "error": "错误描述" }`（管理端）或 `{ "code": 401, "message": "..." }`（商家端）。

### 11.2 通用字段约定

- 金额一律为**分**（整数），如 12900 = ¥129
- 时间戳：创建/更新时间 ISO 8601（如 `2026-08-13T12:00:00Z`）；签名时间戳为毫秒整数
- 订单 ID：`JZ` 前缀；GR 订单号：`GR` 前缀 + 时间戳 + 4 位随机数

---

## 12. 参考实现（Python 签名）

```python
import hashlib, hmac, time

def sign_request(body: dict, secret: str) -> dict:
    payload = body.copy()
    payload.pop("sign", None)
    timestamp = int(time.time() * 1000)
    flat = {}
    def flatten(d, prefix=""):
        for k, v in d.items():
            if v is None or v == "":
                continue
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                flatten(v, key)
            else:
                flat[key] = str(v)
    flatten(payload)
    flat["timestamp"] = str(timestamp)
    s = "&".join(f"{k}={flat[k]}" for k in sorted(flat))
    sign = hmac.new(secret.encode(), s.encode(), hashlib.sha256).hexdigest()
    payload["timestamp"] = timestamp
    payload["sign"] = sign
    return payload
```

---

## 附录 A：接口数量统计

| 分类 | 数量 |
|------|------|
| 公开只读（GET） | 31 |
| 管理端（admin，API Key） | 16 |
| 家政订单流（jiazheng，API Key） | 8 |
| 家政管理台（jz，API Key） | 15 |
| 第三方商家（HMAC） | 9 |
| **合计** | **79** |

> 注：另有 API 网关规划接口（/v3/*，如信用分、智能派单、证书签发/吊销等，见《平台运营方操作手册》6.2 节），属二期能力开放范畴，不在本文档范围内。
