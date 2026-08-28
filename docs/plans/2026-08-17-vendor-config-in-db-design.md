# 设计：商家密钥配置从 hmac_secret.key 迁移至 jz_vendors 表

日期：2026-08-17

## 1. 背景与目标

现状：商家 HMAC 密钥与接口地址存在文件 `juzhu/hmac_secret.key`（格式 `vendor_id|hmac_key|url_link|order_detail_url`，后两列可选），`jiazheng_api.py` 的 `_load_vendor_config()` 每次调用读取该文件，用于三处：

1. HMAC 签名鉴权（`_verify_vendor_auth` → `HmacAuth.verify_signature`）
2. 商家 URL Link 生成接口地址（`_call_gen_url_link`）
3. 商家订单详情查询接口地址（`handle_gr_vendor_detail`）

目标：删除文件，配置迁入 `jz_vendors` 表（新增三列），文件与表数据一一对应（41=来来、42=蓝犀牛）。

## 2. 已确认决策

- **迁移方式**：db.py 启动自动迁移（缺列 ALTER；文件存在且表内值为空时自动导入，打日志提示）
- **读取方式**：进程内懒加载缓存（改表后需重启 server 生效）
- **字段命名**：`hmac_key`、`url_link`、`order_detail_url`
- **删文件时机**：由用户手动删除（代码保留文件导入逻辑，旧部署环境可自动迁移；确保无引用后才删）
- **旧测试脚本**：`test_vendor_api.py`、`sign_test.py` 改为从表取密钥

## 3. 数据模型

`jz_vendors` 新增三列（`mysql_schema.sql` 与 `jiazheng_schema.sql` 同步）：

| 列 | 类型 | 说明 |
|------|------|------|
| `hmac_key` | TEXT | HMAC-SHA256 密钥（可空；空 = 该商家未接入） |
| `url_link` | TEXT | 商家 URL Link 生成接口完整地址（可空） |
| `order_detail_url` | TEXT | 商家订单详情查询接口完整地址（可空） |

现有数据迁移：41（来来）三列全填；42（蓝犀牛）填 hmac_key + url_link。

## 4. 迁移逻辑（db.py）

`ensure_jz_vendor_schema` 内增加：

1. `PRAGMA table_info(jz_vendors)` 检测，缺列逐个 `ALTER TABLE` 添加
2. 加列后检查 `hmac_secret.key` 是否存在：
   - 存在 → 解析各行的 `vendor_id|hmac_key|url_link|order_detail_url`
   - 仅当该 vendor 行的 `hmac_key` 为空时才 UPDATE（不覆盖表内已有值）
   - 打日志：迁移了几家、提示"配置已迁入 jz_vendors，可删除 hmac_secret.key"
3. 迁移异常捕获记日志，不影响启动

## 5. 读取与缓存（jiazheng_api.py）

`_load_vendor_config()` 改造为进程内懒加载：

- 模块级缓存 `_VENDOR_CONFIG_CACHE = None` + 线程锁
- 首次调用：`SELECT id, hmac_key, url_link, order_detail_url FROM jz_vendors WHERE hmac_key IS NOT NULL AND TRIM(hmac_key) <> ''`
- 返回结构不变：`{vid: {"key", "url_link", "order_detail_url"}}`，三个消费方零改动
- 错误提示文案：`请检查 hmac_secret.key` → `请检查 jz_vendors 表配置`

## 6. 安全：防密钥泄露（新增关键点）

`hmac_key` 入表后，任何 `SELECT * FROM jz_vendors` 的出口都可能把密钥带进对外响应：

- `jiazheng_db.py` 的 `list_vendors`（L46-61）、`get_vendor`（L64-73）为 `SELECT *` → 出口统一剥离 `hmac_key`/`url_link`/`order_detail_url`
- 排查其余 vendor JOIN 出口（server.py 相关查询、jiazheng_api.py L317 均为列别名查询，确认不含敏感列）
- 新增 `_strip_vendor_secrets()` 统一处理，测试覆盖

## 7. 文件与文档

- `juzhu/hmac_secret.key`：用户手动删除（代码侧保留导入逻辑）
- `server.py`：静态路径拦截列表移除 `hmac_secret.key` 条目
- `README.md`、`CLAUDE.md`：相关描述同步更新
- `.gitignore` 的 `*.key` 规则保留（无害）

## 8. 测试策略

- 迁移验证：删除文件后重启 server，HMAC 鉴权仍通过（用表内密钥签名真实请求）
- 防泄露验证：vendor 相关接口响应不含 hmac_key/url_link/order_detail_url
- 出站验证：wechat-link 与 vendor-detail 从表配置取地址正常
- 旧测试脚本改造后跑通

## 9. 风险与回滚

- 风险：改表后未重启 server，缓存旧数据/空数据 → 运维注意重启
- 回滚：恢复 hmac_secret.key 文件即可（导入逻辑只在表内值为空时生效，文件优先兼容）
