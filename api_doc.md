# 商家服务系统 API 文档

## 1. 概述

第三方商家通过本接口管理产品（SKU）和接收订单状态回调。

- **测试环境**：`http://49.232.103.71:8765`
- **生产环境**：-
- **Content-Type**：`application/json`
- **认证方式**：HMAC-SHA256 签名（见第 2 章）
- **测试密钥**：密钥线下同步

### 接口一览

| 分类 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 回调 | `POST` | `/api/juzhu/callback` | 订单状态变更通知 |
| 类目 | `POST` | `/api/juzhu/jiazheng/vendor/categories/list` | 查询可用类目 |
| SPU | `POST` | `/api/juzhu/jiazheng/vendor/skus/list` | 查询平台标准品 |
| 产品 | `POST` | `/api/juzhu/jiazheng/vendor/products/list` | 产品列表（支持筛选）|
| 产品 | `POST` | `/api/juzhu/jiazheng/vendor/products/detail` | 产品详情 |
| 产品 | `POST` | `/api/juzhu/jiazheng/vendor/products/create` | 创建产品 |
| 产品 | `POST` | `/api/juzhu/jiazheng/vendor/products/update` | 编辑产品 |
| 产品 | `POST` | `/api/juzhu/jiazheng/vendor/products/status` | 状态变更（上架/下架/售罄）|
| 产品 | `POST` | `/api/juzhu/jiazheng/vendor/products/delete` | 删除产品（软删） |

---

## 2. 认证方式（HMAC-SHA256 签名）

所有接口均需 HMAC-SHA256 签名。GR 侧为每个商家分配唯一的 `vendor_id` 和对应密钥，商家在**每个请求体**中附带签名。

### 签名步骤

1. **准备请求参数**：构造业务请求体，确保包含 `vendor_id`。

2. **移除 sign**：将请求体中的 `sign` 字段移除（如存在）。

3. **添加时间戳**：生成当前时间戳（毫秒），以 `timestamp` 为键名加入参数集合。

4. **递归展平**：将嵌套对象展开为扁平键值对，使用 `.` 分隔层级。
   - 例：`{"worker": {"name": "李师傅", "phone": "139****5678"}}` →
     `worker.name=李师傅`, `worker.phone=139****5678`

5. **过滤空值**：移除值为 `null` 或空字符串 `""` 的字段。

6. **按 Key 字典序排序**：将所有展平后的键按字母升序排列。

7. **拼接待签名字符串**：以 `&` 连接，格式为 `key1=value1&key2=value2&...`

8. **计算 HMAC-SHA256**：以商家密钥为 key，对待签名字符串做 HMAC-SHA256 运算，取 hex 小写摘要。

9. **写入请求体**：将 `timestamp` 和 `sign` 放入请求 JSON 中一并发送。

### 签名示例（产品列表）

请求参数：

```json
{
  "vendor_id": 41,
  "status": "on"
}
```

**步骤分解**：

1. 加入 `timestamp`（如 `1785998316159`）：

   ```
   vendor_id → 41
   status → on
   timestamp → 1785998316159
   ```

2. 无嵌套，无需展平，无空值。

3. 按 Key 排序：

   ```
   status=on
   timestamp=1785998316159
   vendor_id=41
   ```

4. 拼接待签名字符串：

   ```
   status=on&timestamp=1785998316159&vendor_id=41
   ```

5. 计算 `HMAC-SHA256(secret_key, above_string)` → hex 摘要即 `sign`。

6. 最终请求体：

   ```json
   {
     "vendor_id": 41,
     "status": "on",
     "timestamp": 1785998316159,
     "sign": "a1b2c3d4..."
   }
   ```

### 签名示例（回调 assigned）

请求参数：

```json
{
  "vendor_id": 41,
  "order_ref": "GR202608071429360148",
  "lailai_oid": "LL_88888",
  "status": "assigned",
  "worker": {
    "name": "李师傅",
    "phone": "139****5678",
    "eta": "2026-08-07T14:00:00+08:00"
  }
}
```

展平后排序：

```
lailai_oid=LL_88888
order_ref=GR202608071429360148
status=assigned
timestamp=1785998316159
vendor_id=41
worker.eta=2026-08-07T14:00:00+08:00
worker.name=李师傅
worker.phone=139****5678
```

拼接待签名字符串：

```
lailai_oid=LL_88888&order_ref=GR202608071429360148&status=assigned&timestamp=1785998316159&vendor_id=41&worker.eta=2026-08-07T14:00:00+08:00&worker.name=李师傅&worker.phone=139****5678
```

---

## 3. 订单状态回调接口

### POST /api/juzhu/callback

第三方小程序在用户完成下单或订单状态变更后，通过本接口将订单信息回传给 GR 侧。

### 请求参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `vendor_id` | integer | ✅ | 商家 ID，由 GR 侧分配 |
| `order_ref` | string | ✅ | GR 侧订单参考号（如 `GR202608071429360148`） |
| `lailai_oid` | string | ✅ | 来来订单号 |
| `status` | string | ✅ | 订单状态，可选值见下方状态表 |
| `fee` | integer | 条件 | `paid` 时必填，金额（分） |
| `worker` | object | 条件 | `assigned` 时必填，服务者信息 |
| `worker.name` | string | 条件 | 服务者姓名 |
| `worker.phone` | string | 条件 | 服务者电话 |
| `worker.eta` | string | 条件 | 预计到达时间（ISO 8601） |
| `cancel_reason` | string | 条件 | `cancelled` 时必填，取消原因 |
| `timestamp` | integer | ✅ | 当前时间戳（毫秒），用于防重放 |
| `sign` | string | ✅ | HMAC-SHA256 签名 |

> **`vendor_id` 来源**：URL Link 生成时，GR 侧将 `vendor_id` 写入 query string（`...&vendor_id=41`），小程序从 URL 参数中提取后回传。

### 状态枚举

| status | 说明 | 必填额外字段 |
|--------|------|-------------|
| `paid` | 已支付 | `fee` |
| `assigned` | 已派单 | `worker` (name, phone, eta) |
| `serving` | 服务中 | — |
| `completed` | 已完成 | — |
| `cancelled` | 已取消 | `cancel_reason` |

> **注意**：首次回调 `paid` 时，GR 侧仅用 `order_ref` 查找订单并写入 `lailai_oid`；后续状态变更需同时提供 `order_ref` + `lailai_oid` 联合匹配。

### 响应参数

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | integer | 0 = 成功，其他 = 错误 |
| `message` | string | 提示信息 |

### 错误码

| code | HTTP 状态码 | 说明 |
|------|-----------|------|
| 0 | 200 | 成功 |
| 400 | 400 | 缺少必填参数或条件必填字段不满足 |
| 401 | 401 | 签名校验失败（vendor_id 未配置 / sign 缺失 / 过期 / 不匹配） |
| 404 | 404 | 订单不存在 |
| 500 | 500 | 服务端内部错误 |

### 调用示例

#### 支付回调（paid）

```bash
curl -X POST https://your-domain/api/juzhu/callback \
  -H "Content-Type: application/json" \
  -d '{
    "vendor_id": 41,
    "order_ref": "GR202608071429360148",
    "lailai_oid": "LL_88888",
    "status": "paid",
    "fee": 12800,
    "timestamp": 1785998316159,
    "sign": "..."
  }'
```

响应：

```json
{"code": 0, "message": "success"}
```

#### 派单回调（assigned）

```bash
curl -X POST https://your-domain/api/juzhu/callback \
  -H "Content-Type: application/json" \
  -d '{
    "vendor_id": 41,
    "order_ref": "GR202608071429360148",
    "lailai_oid": "LL_88888",
    "status": "assigned",
    "worker": {
      "name": "李师傅",
      "phone": "139****5678",
      "eta": "2026-08-07T14:00:00+08:00"
    },
    "timestamp": 1785998316159,
    "sign": "..."
  }'
```

#### 完成回调（completed）

```bash
curl -X POST https://your-domain/api/juzhu/callback \
  -H "Content-Type: application/json" \
  -d '{
    "vendor_id": 41,
    "order_ref": "GR202608071429360148",
    "lailai_oid": "LL_88888",
    "status": "completed",
    "timestamp": 1785998316159,
    "sign": "..."
  }'
```

#### 取消回调（cancelled）

```bash
curl -X POST https://your-domain/api/juzhu/callback \
  -H "Content-Type: application/json" \
  -d '{
    "vendor_id": 41,
    "order_ref": "GR202608071429360148",
    "lailai_oid": "LL_88888",
    "status": "cancelled",
    "cancel_reason": "用户主动取消",
    "timestamp": 1785998316159,
    "sign": "..."
  }'
```

---

## 4. 商家产品管理接口

所有产品接口按 `vendor_id` 隔离数据，跨商家访问返回 404。`vendor_id` 由鉴权提供，创建/编辑时**不可**在 body 中覆写。

### 通用响应格式

```json
{"code": 0, "message": "success"}
```

| code | HTTP 状态码 | 说明 |
|------|-----------|------|
| 0 | 200 | 成功 |
| 400 | 400 | 缺少必填参数 / 参数值非法 |
| 401 | 401 | 签名校验失败 |
| 404 | 404 | 资源不存在或不属于该商家 |
| 500 | 500 | 服务端内部错误 |

---

### 4.1 类目列表

```http
POST /api/juzhu/jiazheng/vendor/categories/list
```

返回所有状态为 `on` 的子类目（不分页），用于产品创建/筛选时的类目下拉。

**请求参数**（除 `vendor_id` + 签名外无业务参数）：

```json
{"vendor_id": 41}
```

**响应**：

```json
{
  "code": 0,
  "message": "success",
  "list": [
    {"id": 1, "parent_type": "cleaning", "name": "日常保洁", "icon": "🧹", "sort_order": 1},
    {"id": 2, "parent_type": "cleaning", "name": "深度清洁", "icon": "🧼", "sort_order": 2}
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | integer | 类目 ID |
| `parent_type` | string | 父类型（cleaning / repair / moving / nanny） |
| `name` | string | 类目名称 |
| `icon` | string | 图标 emoji |
| `sort_order` | integer | 排序 |

---

### 4.2 SPU 列表

```http
POST /api/juzhu/jiazheng/vendor/skus/list
```

返回所有 `enabled=1` 的平台标准品 SPU（不分页），用于创建产品时选择引用的 SPU。

**请求参数**（除 `vendor_id` + 签名外无业务参数）：

```json
{"vendor_id": 41}
```

**响应**：

```json
{
  "code": 0,
  "message": "success",
  "list": [
    {
      "id": 1,
      "category_id": "cleaning-daily",
      "name": "日常保洁2小时",
      "slug": "cleaning-daily-2h",
      "spec": "2小时",
      "price_from": 99,
      "price_unit": "次",
      "duration_min": 120,
      "tags": "日常保洁,基础清洁",
      "badges": "热门",
      "worker_min_level": "L2"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | integer | SPU ID（创建产品时填入 `channel_sku_id`） |
| `category_id` | string | 所属类目 ID |
| `name` | string | SPU 名称 |
| `slug` | string | URL 友好标识 |
| `spec` | string | 规格描述 |
| `price_from` | integer | 参考起价（分） |
| `price_unit` | string | 计价单位 |
| `duration_min` | integer | 标准时长（分钟） |
| `tags` | string | 标签（逗号分隔） |
| `badges` | string | 徽章 |
| `worker_min_level` | string | 要求服务者最低等级 |

---

### 4.3 产品列表

```http
POST /api/juzhu/jiazheng/vendor/products/list
```

返回当前商家的产品列表，支持筛选。

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `vendor_id` | integer | ✅ | 商家 ID |
| `category` | string | 否 | 按类目名称筛选（精确匹配） |
| `status` | string | 否 | 按状态筛选：`on` / `off` / `sold_out` |
| `name` | string | 否 | 按产品标题模糊搜索 |

**请求示例**：

```json
{"vendor_id": 41, "category": "深度清洁", "status": "on"}
```

**响应**：

```json
{
  "code": 0,
  "message": "success",
  "list": [
    {
      "id": 3,
      "vendor_id": 41,
      "title": "深度清洁4小时",
      "subtitle": "适合大面积深度保洁",
      "category": "深度清洁",
      "duration_hours": 4.0,
      "area_range": "100-150㎡",
      "unit": "次",
      "price": 29900,
      "original_price": 39900,
      "discount_label": "7.5折",
      "earliest_time": "次日08:00",
      "advance_booking_hours": 12,
      "sales_count": 128,
      "rating": 4.8,
      "service_tags": "[\"深度清洁\",\"全屋保洁\",\"高温消毒\"]",
      "channel_sku_id": 2,
      "path": "pages/index",
      "query": "id=123123",
      "status": "on",
      "sort_order": 1,
      "vendor_name": "来来",
      "vendor_type": "cleaning",
      "spu_name": "深度清洁4小时",
      "worker_ids": [101, 102]
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | integer | 产品 ID |
| `vendor_id` | integer | 所属商家 ID |
| `title` | string | 产品标题 |
| `subtitle` | string | 副标题 |
| `category` | string | 类目名称 |
| `duration_hours` | float | 服务时长（小时） |
| `area_range` | string | 适用面积范围 |
| `unit` | string | 计价单位 |
| `price` | integer | 售价（分） |
| `original_price` | integer | 原价（分） |
| `discount_label` | string | 折扣标签 |
| `earliest_time` | string | 最早可约时间 |
| `advance_booking_hours` | integer | 需提前预约小时数 |
| `sales_count` | integer | 销量 |
| `rating` | float | 评分 |
| `service_tags` | string | 服务标签（JSON 数组） |
| `channel_sku_id` | integer | 引用的 SPU ID |
| `path` | string | 小程序页面路径 |
| `query` | string | 小程序页面参数 |
| `status` | string | 状态：`on` / `off` / `sold_out` |
| `spu_name` | string | 引用的 SPU 名称（只读） |
| `worker_ids` | []integer | 绑定的服务者 ID 列表（只读） |

---

### 4.4 产品详情

```http
POST /api/juzhu/jiazheng/vendor/products/detail
```

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `vendor_id` | integer | ✅ | 商家 ID |
| `id` | integer | ✅ | 产品 ID |

**请求示例**：

```json
{"vendor_id": 41, "id": 3}
```

**响应**：

```json
{
  "code": 0,
  "message": "success",
  "product": {
    "id": 3,
    "title": "深度清洁4小时",
    "...": "...（字段同产品列表）"
  }
}
```

---

### 4.5 创建产品

```http
POST /api/juzhu/jiazheng/vendor/products/create
```

> `vendor_id` 由签名鉴权自动确定，**不可**在请求体中覆写。即使传入也会被忽略。

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `vendor_id` | integer | ✅ | 商家 ID（签名用，不会作为入库值被覆写） |
| `title` | string | ✅ | 产品标题 |
| `subtitle` | string | 否 | 副标题 |
| `category` | string | 否 | 类目名称 |
| `duration_hours` | float | 否 | 服务时长（小时） |
| `area_range` | string | 否 | 适用面积范围 |
| `unit` | string | 否 | 计价单位（默认"次"） |
| `price` | float | 否 | 售价（元），默认 0 |
| `original_price` | float | 否 | 原价（元） |
| `discount_label` | string | 否 | 折扣标签 |
| `earliest_time` | string | 否 | 最早可约时间 |
| `advance_booking_hours` | integer | 否 | 需提前预约小时数 |
| `service_tags` | []string | 否 | 服务标签列表 |
| `channel_sku_id` | integer | 否 | 引用的 SPU ID（从 SPU 列表接口获取） |
| `path` | string | 否 | 小程序页面路径 |
| `query` | string | 否 | 小程序页面参数 |
| `status` | string | 否 | 状态（默认 `on`） |
| `sort_order` | integer | 否 | 排序（默认 99） |
| `worker_ids` | []integer | 否 | 绑定的服务者 ID 列表 |

**请求示例**：

```json
{
  "vendor_id": 41,
  "title": "日常保洁2小时",
  "subtitle": "基础日常清洁",
  "category": "日常保洁",
  "price": 99,
  "unit": "次",
  "channel_sku_id": 1,
  "worker_ids": [101]
}
```

**响应**：

```json
{"code": 0, "message": "success", "id": 10}
```

---

### 4.6 编辑产品

```http
POST /api/juzhu/jiazheng/vendor/products/update
```

> `vendor_id` 不可修改；`id` 用于定位产品，不可作为更新字段。仅更新 body 中传入的字段，未传字段保持不变。

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `vendor_id` | integer | ✅ | 商家 ID |
| `id` | integer | ✅ | 产品 ID |
| （其他） | — | 否 | 同创建接口，按需传入 |

**请求示例**：

```json
{
  "vendor_id": 41,
  "id": 10,
  "title": "日常保洁2小时（特惠）",
  "price": 79,
  "status": "on"
}
```

**响应**：

```json
{"code": 0, "message": "success"}
```

---

### 4.7 状态变更

```http
POST /api/juzhu/jiazheng/vendor/products/status
```

> 独立于编辑接口，仅修改状态字段。

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `vendor_id` | integer | ✅ | 商家 ID |
| `id` | integer | ✅ | 产品 ID |
| `status` | string | ✅ | `on`（上架）/ `off`（下架）/ `sold_out`（售罄） |

**请求示例**：

```json
{"vendor_id": 41, "id": 10, "status": "sold_out"}
```

**响应**：

```json
{"code": 0, "message": "success"}
```

---

### 4.8 删除产品（软删）

```http
POST /api/juzhu/jiazheng/vendor/products/delete
```

> 将产品状态置为 `off`（下架），不物理删除。已下架产品再次调用返回 404。

**请求参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `vendor_id` | integer | ✅ | 商家 ID |
| `id` | integer | ✅ | 产品 ID |

**请求示例**：

```json
{"vendor_id": 41, "id": 10}
```

**响应**：

```json
{"code": 0, "message": "success"}
```

---

## 5. 小程序 URL Link 接口协议

商家需提供一个 URL Link 生成接口，GR 侧在用户下单时会调用该接口获取小程序链接。

### 请求（GR → 商家）

GR 侧以 `POST` 方式调用，`Content-Type: application/json`：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 否 | 小程序页面路径 |
| `query` | string | 否 | 小程序页面原始查询参数（如 `activityId=xxx`） |
| `order_ref` | string | ✅ | GR 侧订单参考号（如 `GR202608121430120001`） |

### 响应（商家 → GR）

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | integer | `200` 表示成功，`-1` 表示失败 |
| `msg` | string/null | 提示信息 |
| `data` | string/null | 成功时为小程序 URL Link，失败时为 `null` |

> **重要**：GR 侧仅当 `code = 200` 时视为成功。

### 成功响应示例

```json
{
  "code": 200,
  "msg": null,
  "data": "weixin://dl/business/?t=E8iVw9ME0Yc&cq=code%3DF2C202608070001"
}
```

### 来来接口参考

| 项目 | 说明 |
|------|------|
| 测试环境地址 | `https://uat.doorslink.net/mall/beike/juzhu/generate/urllink` |
| 请求方式 | `POST` |
| Content-Type | `application/json` |
| 认证方式 | 调用方出口公网 IP 白名单 |

#### 调用示例

```bash
curl -X POST https://uat.doorslink.net/mall/beike/juzhu/generate/urllink \
  -H "Content-Type: application/json" \
  -d '{
    "path": "pages-sub/goods/goods",
    "query": "activityId=2031123456789012345",
    "order_ref": "GR202608071429360148"
  }'
```

#### 常见错误

| 场景 | code | msg 示例 |
|------|------|----------|
| IP 不在白名单 | `-1` | `IP无权访问-203.0.113.10` |
| `query` 为空 | `-1` | `参数不能为空` |
| `order_ref` 为空 | `-1` | `GR侧订单参考号不能为空` |
| `activityId` 缺失或非法 | `-1` | `数字格式错误` |
| 链接生成失败 | `-1` | `生成小程序链接失败` |

---

## 6. 参考实现（Python）

```python
import hashlib
import hmac
import time
import json
import urllib.request

class HmacAuth:
    def __init__(self, secret_key: str):
        self.secret_key = secret_key.encode('utf-8')

    def _flatten_and_filter(self, data: dict, prefix: str = '') -> dict:
        """递归展平嵌套字典，过滤 None 和空字符串"""
        flat_dict = {}
        for k, v in data.items():
            if v is None or v == "":
                continue
            key_name = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                flat_dict.update(self._flatten_and_filter(v, key_name))
            else:
                flat_dict[key_name] = str(v)
        return flat_dict

    def _build_string_to_sign(self, flat_params: dict) -> str:
        """按 Key 字典序排序，拼接为 a=1&b=2"""
        sorted_keys = sorted(flat_params.keys())
        return "&".join([f"{k}={flat_params[k]}" for k in sorted_keys])

    def generate_signature(self, request_body: dict) -> dict:
        """生成带签名的请求体"""
        payload = request_body.copy()
        payload.pop("sign", None)
        timestamp = int(time.time() * 1000)
        flat_params = self._flatten_and_filter(payload)
        flat_params["timestamp"] = str(timestamp)
        string_to_sign = self._build_string_to_sign(flat_params)
        sign = hmac.new(
            self.secret_key,
            string_to_sign.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        payload["timestamp"] = timestamp
        payload["sign"] = sign
        return payload

    def post(self, url: str, body: dict) -> dict:
        """发送签名请求并返回响应"""
        payload = self.generate_signature(body)
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers={
            'Content-Type': 'application/json'
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))


# ── 使用示例（测试环境） ──

VENDOR_ID = 41
SECRET = "<向管理员索取>"
BASE = "<测试环境 Base URL>"
auth = HmacAuth(SECRET)

# 查询产品列表
resp = auth.post(f"{BASE}/api/juzhu/jiazheng/vendor/products/list", {
    "vendor_id": VENDOR_ID,
    "status": "on",
})
print(resp)

# 创建产品
resp = auth.post(f"{BASE}/api/juzhu/jiazheng/vendor/products/create", {
    "vendor_id": VENDOR_ID,
    "title": "新服务产品",
    "category": "日常保洁",
    "price": 99,
    "unit": "次",
    "channel_sku_id": 1,
})
print(resp)

# 订单回调
resp = auth.post(f"{BASE}/api/juzhu/callback", {
    "vendor_id": VENDOR_ID,
    "order_ref": "GR202608071429360148",
    "lailai_oid": "LL_88888",
    "status": "paid",
    "fee": 12800,
})
print(resp)
```
