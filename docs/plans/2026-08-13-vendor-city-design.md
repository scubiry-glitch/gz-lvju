# 商家商品城市体系设计（2026-08-13）

## 背景

商家（jz_vendors）已有 `city_ids` 关联城市（TEXT 逗号分隔，如 `'1'`、`'1,2'`），
但商家产品（jz_products）没有城市字段，商家 API 也没有城市查询能力。
本次将城市维度补全到商家商品链路：商家 API 城市查询、产品 city_id、
B 端管理台城市筛选、C 端页面按传入城市过滤。

## 现状盘点

| 能力 | 现状 |
|---|---|
| 商家 API 城市查询 | 无（vendor API 只有 categories/skus/products） |
| jz_products 城市字段 | 无 `city_id` 列 |
| B 端 p-jz-product.html | 筛选只有 类目/状态/商家/搜索，无城市；表单无城市 |
| C 端城市过滤 | list/detail 数据请求已带 city（`_jzapi.js` + `server.py` 按 `vendor.city_ids` 过滤）；**index.html 4 个生活服务入口链接是静态的，不带 city 参数** |
| 城市数据源 | `GET /api/juzhu/cities` 已存在，返回 cities 全表 |

## 关键决策（已与用户确认）

1. **city_id 必填**：不论商家关联单城还是多城，创建商品时 city_id 都必须传，且必须属于该商家的 `city_ids`，否则 400。
2. **B 端管理台表单也加城市字段**，与商家 API 对齐；列表顺带显示城市名称。
3. **C 端过滤维持商家维度**（按 `vendor.city_ids`，不改后端过滤逻辑，老数据兼容）；只修页面传参缺口。

## 数据模型

`jz_products` 新增列：

```sql
ALTER TABLE jz_products
  ADD COLUMN city_id INT NULL AFTER vendor_id,
  ADD KEY idx_jz_products_city (city_id);
```

- 语义：产品所属城市；必须 ∈ 所属商家的 `city_ids`。
- 约束靠应用层校验（商家 API 与 B 端写接口统一），不建外键（与 city_ids 的 TEXT 形态无法建 FK）。
- **老数据回填**（上线时一次性执行，取商家 city_ids 的第一个城市）：
  ```sql
  UPDATE jz_products p JOIN jz_vendors v ON v.id = p.vendor_id
     SET p.city_id = CAST(SUBSTRING_INDEX(v.city_ids, ',', 1) AS UNSIGNED)
   WHERE p.city_id IS NULL;
  ```

同步更新 `juzhu/mysql_schema.sql`（CREATE TABLE 段），供全新部署使用。
本地与测试机共用同一 MySQL 库（62.234.26.57），ALTER 只需执行一次；
`dbconn` 的 schema 自愈只建表不加列，ALTER 由人工/脚本执行。

## 后端设计

### 1. 商家 API（jiazheng_api.py，HMAC 签名，vendor_id 由鉴权提供）

新增路由 `POST /api/juzhu/jiazheng/vendor/cities/list`：

- 实现 `_vendor_cities_list(handler, body, vendor_id)`：
  1. `SELECT city_ids FROM jz_vendors WHERE id=?`
  2. 拆分逗号 → 查 `SELECT id, name, slug FROM cities WHERE id IN (...)`（保持 city_ids 顺序）
  3. 响应 `{code:0, message:"success", list:[{id, name, slug}]}`；无关联城市返回空列表
- 商家永远只能看到本商家 `city_ids` 关联的城市。

产品接口改造：

| 接口 | 改动 |
|---|---|
| `products/create` | `city_id` 必填（缺 → 400「缺少 city_id」）；必须 ∈ `vendor.city_ids`（否则 400「city_id 不属于该商家」） |
| `products/update` | 传 `city_id` 时校验 ∈ `vendor.city_ids`，不传不改 |
| `products/list` | 每项返回 `city_id` + `city_name`（LEFT JOIN cities）；支持 `city_id` 筛选参数 |
| `products/detail` | 返回 `city_id` + `city_name` |

校验辅助：`_vendor_city_ids(conn, vendor_id) -> [int]`（解析 `city_ids` 文本）。

### 2. B 端管理台（server.py + jiazheng_db.py）

- `list_products`（jiazheng_db.py）：
  - SELECT 加 `c.name AS city_name`（`LEFT JOIN cities c ON c.id = p.city_id`）
  - 新增 `city_id` 过滤参数
- `GET /api/juzhu/jz/products`：接受 `city_id` 查询参数，透传给 `list_products`。
- `create_product` / `update_product`（jiazheng_db.py）：字段列表加入 `city_id`（INSERT 列 + UPDATE 白名单）。
- B 端写接口（server.py `/api/juzhu/jz/products` POST/PUT）：与商家 API 同规则校验
  `city_id` 必填且 ∈ `vendor.city_ids`（复用同一校验函数，避免双轨逻辑）。

### 3. 文档

`api_doc.md`：新增 `vendor/cities/list` 章节；`products/create|update|list|detail` 补充 `city_id`/`city_name` 字段说明与校验规则。

## 前端设计

### 1. p-jz-product.html（B 端管理台）

- 筛选区新增 `f_city` 下拉：「全部城市」+ cities 数据（`load()` 时 `GET /api/juzhu/cities`）；`applyFilter()` 按 `p.city_id` 过滤。
- 列表表格新增「城市」列，显示 `p.city_name`。
- 表单新增 `m_city` 下拉：
  - 选商家后联动：只显示该商家 `city_ids` 中的城市（`allVendors` 已含 `city_ids` 字段，cities 数据已加载）；未选商家时显示全部城市。
  - 保存 body 增加 `city_id`；必填校验（未选 → toast「请选择城市」）。

### 2. index.html（生活服务专区入口）

4 个入口链接（保洁/维修/搬家/保姆）目前是静态 `href="juzhu-jiazheng-list.html?type=xxx"`。
初始化时用 JS 把当前城市拼进链接（复用 `BZF_JZ.chainCity()`；静态 href 保留作无 JS 兜底）：

```js
document.querySelectorAll('.jz-cat-grid a[href*="juzhu-jiazheng-list.html"]').forEach(a => {
  a.href = BZF_JZ.chainCity(a.getAttribute('href'));
});
```

### 3. juzhu-jiazheng-list.html / juzhu-jiazheng-detail.html

数据请求已带 city（`_jzapi.js` 自动），页内跳转已用 `chainCity`，无需改动；
入口带 city 后即实现「只过滤传入城市的数据」。验证即可。

## 风险与兼容

- **老数据**：回填 SQL 必须先行执行，否则 B 端筛选「全部城市」时老产品城市为空。
- **远程 3306 安全组**：上次迁移的遗留阻塞（测试机 → MySQL 未放行）。本次验证若仍需直连测试，需先确认已放行。
- **兼容层**：`city_id` 为 INT NULL，旧调用不传时商家 API 会 400（按新规则，符合预期）；B 端 GET 不传则不过滤（老行为）。

## 验证清单

1. `python3 juzhu/test_vendor_api.py`（扩展用例后全绿）：
   - `vendor/cities/list` 只返回本商家关联城市
   - `products/create` 缺 city_id → 400；city_id 不属于商家 → 400；合法 → 200
   - `products/list` / `products/detail` 返回 city_name
2. 离线 db 层自测：`list_products` 的 city_id 过滤 + city_name。
3. B 端 curl：`GET /api/juzhu/jz/products?city_id=1` 只返回沈阳产品。
4. 页面人工验证：index 选贵阳 → 入口链接带 `city=贵阳` → list 页只显示贵阳商家数据；
   B 端 p-jz-product.html 筛选城市、表单联动、列表城市列。
5. 线上 DDL + 回填执行完成，`SELECT city_id, COUNT(*) FROM jz_products GROUP BY city_id` 无 NULL。
