# 商家商品城市体系 — 实施计划（2026-08-13）

> 设计文档：[2026-08-13-vendor-city-design.md](2026-08-13-vendor-city-design.md)
> 约定：每个任务先写失败测试/验证命令 → 实现 → 验证通过 → 提交。
> 测试环境：本地 `server.py`（连线上 MySQL 62.234.26.57）+ `JUZHU_TEST_BASE=http://127.0.0.1:8765`。
> 远程测试机（49.232.103.71）：3306 安全组已放行，全链路远程验证通过。

## T1. DDL：schema 文件 + 线上库加列 + 老数据回填

**文件**：`juzhu/mysql_schema.sql`

1. `jz_products` CREATE TABLE 段：`vendor_id INT NOT NULL` 后加
   `city_id INT NULL,`；索引段加 `KEY idx_jz_products_city (city_id),`。
2. 对线上 MySQL（62.234.26.57/juzhu，dba 已授权）执行：
   ```sql
   ALTER TABLE jz_products ADD COLUMN city_id INT NULL AFTER vendor_id,
     ADD KEY idx_jz_products_city (city_id);
   UPDATE jz_products p JOIN jz_vendors v ON v.id = p.vendor_id
      SET p.city_id = CAST(SUBSTRING_INDEX(v.city_ids, ',', 1) AS UNSIGNED)
    WHERE p.city_id IS NULL;
   ```
3. 本地测试副本同步：`/tmp/test_juzhu.db`（SQLite）执行同款 ALTER（db 层离线自测用）。

**验证**：
```bash
python3 - <<'EOF'  # 连线上库
from juzhu.dbconn import connect
c = connect()
print([dict(r) for r in c.execute("DESC jz_products") if r[0]=='city_id'])
print(c.execute("SELECT city_id, COUNT(*) FROM jz_products GROUP BY city_id").fetchall())
EOF
```
- DESC 有 `city_id INT YES`；分组统计无 NULL 行。

**提交**：`schema:jz_products 增加 city_id 列（城市维度）`

## T2. db 层：list/create/update 支持 city_id

**文件**：`juzhu/jiazheng_db.py`

1. `list_products(conn, vendor_id=None, type_=None, status=None, city_id=None, limit=200)`：
   - SELECT 加 `c.name AS city_name`，`LEFT JOIN cities c ON c.id=p.city_id`
   - 过滤：`city_id is not None` → `AND p.city_id=?`
2. `create_product`：INSERT 列清单与 VALUES 加 `city_id`（`int(data["city_id"]) if data.get("city_id") else None`，vendor_id 之后）。
3. `update_product`：字段白名单加 `"city_id"`。
4. 新增校验辅助 `vendor_city_ids(conn, vendor_id) -> [int]`（解析 `jz_vendors.city_ids` 文本，空/无 → `[]`）；`validate_product_city(conn, vendor_id, city_id) -> (ok, err_msg)`：city_id 为空 → False「缺少 city_id」；不在商家城市列表 → False「city_id 不属于该商家」。

**验证**（本地连线上库，冒烟脚本）：
- `list_products(conn, city_id=1)` 只返回沈阳产品且每项含 `city_name`；
- `create_product` 传 city_id 落库可读回；`update_product` 改 city_id 生效；
- `validate_product_city(41, 2)` → False（商家 41 只关联沈阳），`(41, 1)` → True。

**提交**：`db:商品列表/创建/更新支持 city_id 与城市校验`

## T3. 商家 API：cities/list + create/update 校验 + list/detail 城市名

**文件**：`juzhu/jiazheng_api.py`、`juzhu/test_vendor_api.py`

**先写测试**（`test_vendor_api.py` 新增用例，商家 41「来来」city_ids='1'，商家 42「蓝犀牛」city_ids='1,2'）：
- `vendor/cities/list`：41 → 只含沈阳（id=1）；42 → 含沈阳+贵阳且顺序与 city_ids 一致
- `products/create` 缺 city_id → `code=400`；city_id=2（不属于 41）→ `code=400`；city_id=1 → `code=0`，返回 id
- `products/detail` 新建 id → 含 `city_name='沈阳'`
- `products/list` → 每项含 `city_name`
- `products/update` city_id=2（不属于 41）→ `code=400`；city_id=1 → `code=0`

**实现**：
1. 路由表加 `"/api/juzhu/jiazheng/vendor/cities/list": _vendor_cities_list`。
2. `_vendor_cities_list`：`vendor_city_ids()` → `SELECT id, name, slug FROM cities WHERE id IN (...)`，按 city_ids 顺序返回 `{code:0, list:[{id,name,slug}]}`。
3. `_vendor_products_create`：`validate_product_city` 不通过 → `_respond_json(... , 400)`；通过后 `create_product`。
4. `_vendor_products_update`：body 有 `city_id` 时校验；`_vendor_products_list`/`_vendor_products_detail` 附加 `city_name`（逐项 `LEFT JOIN cities` 或复用 `list_products` 结果）。

**验证**：`JUZHU_TEST_BASE=http://127.0.0.1:8765 python3 juzhu/test_vendor_api.py` 全绿（含旧用例）。

**提交**：`api:商家城市查询接口+商品 city_id 校验与城市名返回`

## T4. B 端接口：GET 城市筛选 + 写接口校验

**文件**：`juzhu/server.py`

1. `GET /api/juzhu/jz/products`：解析 `city_id` 参数 → `list_products(..., city_id=...)`。
2. `POST /api/juzhu/jz/products`（1825 行附近）：`validate_product_city(conn, body["vendor_id"], body.get("city_id"))` 不通过 → `{"error": msg}` 400；通过后 `create_product`。
3. `PUT /api/juzhu/jz/products/{id}`：body 有 `city_id` 时先取产品 vendor_id 校验。

**验证**（本地 curl + X-API-Key）：
- `GET /api/juzhu/jz/products?city_id=1` 全为沈阳产品；
- `POST` 缺 city_id → 400；非法城市 → 400；合法 → ok。

**提交**：`server:B 端商品接口支持城市筛选与校验`

## T5. p-jz-product.html：城市筛选 + 表单城市字段 + 列表城市列

**文件**：`screens/p-jz-product.html`

1. `load()` 追加 `fetch('/api/juzhu/cities')` → `allCities`；`f_city` 填充「全部城市」+ 城市名。
2. `applyFilter()`：`f_city` 有值 → `p.city_id == 值` 过滤。
3. `render()` 表格表头与行加「城市」列（`p.city_name || '—'`）。
4. 表单加 `m_city` 下拉（grid 内第一行）：选商家（`m_vendor.onchange`）联动为该商家 `city_ids` 城市（`allVendors` 含 `city_ids`，`allCities` 映射）；未选商家显示全部城市。`openModal` 回显 `p.city_id`。
5. `mSave` body 加 `city_id: parseInt($('m_city').value)`；必填校验「请选择城市」。
6. `applyFilter` 绑定 `f_city.onchange`。

**验证**：本地起服务，浏览器打开 `screens/p-jz-product.html`：筛选下拉有沈阳/贵阳；筛选沈阳列表只剩沈阳产品且显示城市名；新增表单选商家后城市下拉联动；保存缺城市被拦截。

**提交**：`ui:B 端商品管理台城市筛选/表单/列表`

## T6. index.html：生活服务入口链接携带城市

**文件**：`index.html`

1. 页尾 JS（初始化处）遍历 `.jz-cat-grid a[href*="juzhu-jiazheng-list.html"]`，`a.href = BZF_JZ.chainCity(a.getAttribute('href'))`（静态 href 兜底）。

**验证**：index 页切换城市为贵阳后，4 个入口链接 href 含 `city=贵阳`；点击进入 list 页城市定位为贵阳，列表只显示贵阳商家服务。

**提交**：`ui:首页家政入口链接携带城市参数`

## T7. 文档 + 回归 + 发布

**文件**：`api_doc.md`、`publish_test.sh`（如需要）

1. `api_doc.md`：
   - 总表加 `POST /api/juzhu/jiazheng/vendor/cities/list`；
   - 新增 cities/list 章节（请求/响应/错误码）；
   - `products/create|update` 加 `city_id` 字段与 400 规则；`products/list|detail` 响应加 `city_id`/`city_name`。
2. 全量回归：`JUZHU_TEST_BASE=http://127.0.0.1:8765 python3 juzhu/test_vendor_api.py` + B 端 curl 冒烟 + 页面人工清单。
3. 发布测试机：`./publish_test.sh`（代码同步 + 重启）；远程验证受 3306 安全组阻塞，记录待办。

**提交**：`docs:商家 API 文档补充城市接口与 city_id 字段`

## 边界说明

- C 端 list/detail 页数据请求已带 city、跳转已用 chainCity，不改动；T6 修入口后闭环。
- 商家 API 老客户端不传 city_id 会 400（按新规则预期行为，文档注明）。
- 测试数据清理：测试新建的产品删除（软删 status=off 或硬删）。

## 执行记录（2026-08-13 全部完成）

| 任务 | 提交 | 验证 |
|------|------|------|
| T1 DDL | d694889 | 线上 DESC 有 city_id、16 行回填无 NULL |
| T2 db 层 | 5e24fdb | test_db_city 16/16 |
| T3 商家 API | 43c8ae4 | test_vendor_api 22 步 9/9 断言 |
| T4 B 端接口 | 7abacb2 | B 端冒烟 POST/PUT 正负例 + GET 筛选 |
| T5 产品管理页 | 67e31a6 | 浏览器验证 a-f 全通过 |
| T6 首页入口 | 95f9127 | 浏览器验证：#jzSubs 与大分类链接随城市切换同步更新 |
| T7 文档+回归+发布 | e13af3d | 全量回归通过；publish_test.sh 发布后远程验证 cities/筛选正常 |

注：
- 线上商家 41 的 city_ids 在执行期间由用户调整为 `1,2,3`（原 `1`），T3/T7 回归断言已同步。
- 历史冒烟残留（「接口测试」系列 11 条 status=off）已物理清理。
- 线上当前无贵阳（city_id=2）产品，测试机 `city_id=2` 筛选返回空列表属预期；B 端可随时按新流程在贵阳建品。
