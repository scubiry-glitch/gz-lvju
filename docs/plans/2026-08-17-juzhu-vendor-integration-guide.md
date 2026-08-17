# 家政商家联调手册 Implementation Plan

> 设计文档：`docs/plans/2026-08-17-juzhu-vendor-integration-guide-design.md`（已批准）
> 本文档任务无 TDD 代码，采用"先写章节 → 实测验证章节内容 → 提交"的验证驱动流程；每任务内的地址/命令/SQL 必须实测通过后才可提交。

**Goal:** 在仓库根编写 `联调手册.md`，让接手联调的人无需口头交接即可完成新商家入驻联调（含测试库地址、数据配置、测试服务器、日志查看、联调步骤），不含任何密码。

**Architecture:** 手册 8 章；与 `api_doc.md`（商家视角协议）分工：本手册为 GR 内部联调人员操作视角；所有凭证只写获取途径不写值。

**Tech Stack:** Markdown；验证依赖测试库 MySQL（62.234.26.57:3306/juzhu，juzhu/.env 提供凭证）、测试服务器 49.232.103.71:8765、本地 python3 server.py。

**文件：**
- Create: `联调手册.md`（仓库根）
- Test: 无新增代码测试；每任务用 Bash 实测验证（SQL 执行、脚本运行、地址可达）

---

### Task 1: 手册骨架 + 第 1-2 章（目的 / 环境信息）

**Step 1: 写内容**
创建 `联调手册.md`，包含：
- 标题 + 一句话定位（内部联调人员使用；商家协议见 api_doc.md）
- 第 1 章 手册目的与适用对象（3-5 行 + 文档分工表）
- 第 2 章 环境信息一览（表格）：
  - 测试服务器 `http://49.232.103.71:8765`（部署目录 `/projects/beike`，端口 8765）
  - 测试库 `62.234.26.57:3306` 库名 `juzhu`（本地与测试共用同一实例；账号密码见 `juzhu/.env` 的 `JUZHU_DB_*`，本手册不收录）
  - 本地启动 `cd juzhu && python3 server.py`（默认 8765 端口，本地日志 `/tmp/juzhu_server.log`）
  - 发布脚本 `bash publish_test.sh`（rsync 同步代码 + 重启测试服务器；脚本内含服务器凭证，本手册不收录）
  - 出站 IP 白名单说明（GR 调商家接口的实际出站 IP 从日志"IP无权访问-x.x.x.x"获取，告知商家加白名单）

**Step 2: 实测验证**
Command: `curl -s -m 8 -o /dev/null -w "%{http_code}" http://49.232.103.71:8765/api/juzhu/jiazheng/vendor/cities/list -X POST -H "Content-Type: application/json" -d '{"vendor_id":41}'`
Expected: `401`（服务器可达；未签名请求被拒）

**Step 3: 提交**
`git add 联调手册.md && git commit -m "docs(juzhu): 联调手册骨架与环境信息章节"`

---

### Task 2: 第 3 章 数据配置（关键表 + 新商家 INSERT SQL 模板）

**Step 1: 写内容**
在 `联调手册.md` 追加第 3 章：
- 关键表说明（表结构要点）：
  - `jz_vendors`（商家主数据）：id/type/name/logo/address/district_id/city_ids/phone/vendor_no/hmac_key/url_link/order_detail_url/status/sort_order 等；type 为 cleaning/repair/moving/nanny 四选一（单值驱动 B 端产品列表）；city_ids 逗号分隔城市 id
  - `cities`：1 沈阳 / 2 贵阳 / 3 北京 / 4 上海
  - `jz_skus`：24 个平台标准品 SPU（id/category_id/name/slug）
  - `jz_products`：商家产品（vendor_id/city_id/channel_sku_id/path/query），由商家通过 vendor 接口或 P 端维护，无需手工 SQL
  - `gr_orders`：订单（vendor_id/order_ref/vendor_oid/status/user_id…）
- 新商家 INSERT SQL 模板（逐字段注释）：

```sql
-- 新商家入驻：jz_vendors 插入一行（id 自增可不写或指定；建议与 sort_order 同值，参考 41/42）
INSERT INTO jz_vendors (
  type, name, logo, address, district_id, city_ids, phone,
  rating, review_count, rank_type, rank_label, badges, live,
  start_price, unit, fulfillment, hours, vendor_no, whitelist_id,
  hmac_key, url_link, order_detail_url, status, sort_order, created_at, updated_at
) VALUES (
  'cleaning',                    -- type：cleaning/repair/moving/nanny 四选一
  '新商家名称',                    -- name：C 端展示名
  NULL, NULL, NULL,              -- logo / address / district_id
  '1,2',                         -- city_ids：逗号分隔（cities 表：1 沈阳 2 贵阳 3 北京 4 上海）
  NULL,                          -- phone
  0, 0, NULL, NULL, NULL, 0,     -- rating/review_count/rank_type/rank_label/badges/live
  NULL, NULL, 'to_home', NULL,   -- start_price/unit/fulfillment/hours
  'V0043',                       -- vendor_no：商家编码（可选）
  NULL,                          -- whitelist_id：白名单关联（可选）
  '<64位hex密钥>',                -- hmac_key：与商家约定的 HMAC-SHA256 密钥（openssl rand -hex 32 生成）
  'https://<商家域名>/.../generate/urllink',  -- url_link：商家 URL Link 生成接口完整地址
  'https://<商家域名>/.../order/detail',      -- order_detail_url：商家订单详情查询接口（可选，不配则详情页不覆盖）
  'active', 43,                  -- status / sort_order（建议与 id 一致）
  NOW(), NOW()
);
```

- hmac_key 生成命令：`openssl rand -hex 32`（64 位 hex；也可由商家提供，双方一致即可）
- 重要提醒：**改 jz_vendors 表后需重启 server 生效**（密钥配置为进程内懒加载缓存）
- 平台标准品对照：提示用 `SELECT id, name, slug FROM jz_skus WHERE category_id='<type>';` 查可选 SPU

**Step 2: 实测验证**
在测试库执行 SQL 模板（插入测试商家 43 → 查询确认 → 删除回滚）：
Command:
```bash
cd juzhu && python3 -c "
from tp_client import load_dotenv
load_dotenv()
import db
conn = db.connect()
conn.execute(\"INSERT INTO jz_vendors (type,name,city_ids,hmac_key,url_link,order_detail_url,status,sort_order,created_at,updated_at) VALUES ('cleaning','手册模板测试','1,2','x'*64,'https://test.example.com/link','https://test.example.com/detail','active',43,NOW(),NOW())\")
row = conn.execute('SELECT id,type,name,city_ids,status FROM jz_vendors WHERE id=43').fetchone()
print('插入验证:', dict(row))
conn.execute('DELETE FROM jz_vendors WHERE id=43')
conn.commit(); conn.close()
print('已回滚删除')
"
```
Expected: `插入验证: {'id': 43, ...}` + `已回滚删除`

**Step 3: 提交**
`git add 联调手册.md && git commit -m "docs(juzhu): 联调手册数据配置章节与新商家 SQL 模板"`

---

### Task 3: 第 4 章 商家侧清单 + 第 5 章 联调步骤与方法

**Step 1: 写内容**
在 `联调手册.md` 追加：
- 第 4 章 商家侧工作清单（转达商家，附 api_doc.md 章节引用）：
  1. 提供 HMAC 密钥（64 位 hex，与 GR 侧约定一致）
  2. 实现 api_doc.md 第 2-4 章：HMAC-SHA256 签名、订单状态回调（POST /api/juzhu/callback）、商家产品管理接口
  3. 提供 api_doc.md 第 5 章两个接口：小程序 URL Link 生成接口、订单详情查询接口
  4. 将 GR 侧出站 IP 加入商家接口白名单（实际 IP 见第 2 章获取方式）
  5. 响应时效：订单详情查询建议 5 秒内返回
- 第 5 章 联调步骤与方法（顺序操作，每步含命令/工具）：
  1. 商家信息收集（清单：名称/type/城市/密钥/两个接口地址/测试小程序）
  2. GR 侧数据配置（按第 3 章 SQL 模板执行；重启 server）
  3. 签名自测：`cd juzhu && python3 sign_test.py`（本地验签工具，密钥读 jz_vendors 表）
  4. 全接口联调：`cd juzhu && python3 test_vendor_api.py`（打测试服务器 22 请求 9 断言；可用 `JUZHU_TEST_BASE` 指定目标；会创建/软删测试产品）
  5. 下单全链路：C 端下单 `POST /api/juzhu/jiazheng/wechat-link`（body: product_id + user_id）→ 平台调商家 url_link 接口 → 返回小程序链接 → 生成 gr_orders 订单（order_ref）
  6. 回调联调：商家按 api_doc.md 第 3 章推送状态；状态机 pending→paid→assigned→serving→completed；cancelled 终态；paid 回调后本地写入 vendor_oid，后续回调必须 order_ref+vendor_oid 匹配
  7. 订单详情同步：进入订单详情页平台静默调商家 order_detail_url 并同步本地（vendor_oid/status/fee/worker/cancel_reason 向前覆盖）
  8. C 端回归：`cd juzhu && python3 test_gr_my_orders.py`（列表/详情/vendor-detail 同步）
  9. 造单示例：create_order 造单 Python 片段（vendor_id 指向新商家、user_id 指定）

**Step 2: 实测验证**
Command: `cd juzhu && python3 sign_test.py 2>&1 | tail -2`
Expected: `【服务端】正常请求校验结果: True` / 篡改校验 `False`

**Step 3: 提交**
`git add 联调手册.md && git commit -m "docs(juzhu): 联调手册商家清单与联调步骤章节"`

---

### Task 4: 第 6-8 章（日志排查 / 验收清单 / 安全约定）

**Step 1: 写内容**
在 `联调手册.md` 追加：
- 第 6 章 日志查看与问题排查：
  - 本地日志：`tail -f /tmp/juzhu_server.log`；测试服务器日志：ssh 登录 49.232.103.71 后 `tail -f /tmp/beike_server.log`
  - 出站请求日志格式 `[平台→商家] <时间> POST/GET <url>`（含参数与返回；JUZHU_LOG_DETAIL=false 时只打印 URL 一行）
  - 排查表：401 签名失败（密钥不一致/时间戳/参数过滤，见 api_doc.md 第 2 章）；`IP无权访问-x.x.x.x`（把 x.x.x.x 告知商家加白名单）；SSL 证书链不全（平台已放宽校验，白名单兜底）；回调 404 订单不存在（order_ref 或 vendor_oid 不匹配）；状态未推进（状态机顺序）；详情页未覆盖（商家未配 order_detail_url 或接口静默失败，看服务器日志）；配置不生效（改表后未重启 server）
- 第 7 章 联调完成验收清单（Checkbox）：
  - [ ] 商家接口地址/密钥已配置 jz_vendors 且重启生效
  - [ ] sign_test.py 签名验签通过
  - [ ] test_vendor_api.py 22 请求断言全部通过
  - [ ] 5 种回调状态正确落库（paid 金额/assigned 服务者/eta 北京时间无时区/cancelled 原因）
  - [ ] 下单成功生成 url_link 并创建订单
  - [ ] C 端"我的订单"可见且状态正确
  - [ ] 订单详情同步生效（下次查询即最新数据）
  - [ ] 日志无异常（无 SSL/超时/签名错误堆积）
- 第 8 章 安全约定：
  - 本手册不含任何密码/密钥；数据库凭证在 `juzhu/.env`（gitignore 屏蔽）、服务器凭证在 `publish_test.sh`
  - 密钥不进 git（`.key`/`.env*` 已被 .gitignore 屏蔽）
  - vendor 对外接口不返回 hmac_key/url_link/order_detail_url（平台已剥离）
  - 收到真实密钥只在 jz_vendors 表配置，禁止写文档/代码

**Step 2: 实测验证**
Command: `ls -la /tmp/juzhu_server.log 2>/dev/null && tail -2 /tmp/juzhu_server.log && grep -c "平台→商家" /tmp/juzhu_server.log`
Expected: 日志文件存在、可见出站日志行

**Step 3: 提交**
`git add 联调手册.md && git commit -m "docs(juzhu): 联调手册日志排查验收清单与安全约定章节"`

---

### Task 5: 全文敏感信息扫描 + 收尾

**Step 1: 敏感信息扫描**
Command:
```bash
grep -nEi "password|passwd|secret|密钥[:：][[:space:]]*[0-9a-f]{32}|sshpass|REMOTE_PASS|JUZHU_DB_PASSWORD=" 联调手册.md
```
Expected: 仅命中"安全约定"章节的字段名/获取途径描述（如 `JUZHU_DB_PASSWORD` 作为字段名出现可接受），不得出现任何实际密码值/密钥值。

再确认：`git status --short` 无意外文件。

**Step 2: 提交执行记录**
`docs/plans/2026-08-17-juzhu-vendor-integration-guide-design.md` 末尾追加"执行记录"节（各任务验证结果），提交：
`git add docs/plans/2026-08-17-juzhu-vendor-integration-guide-design.md && git commit -m "docs(plans): 联调手册设计与验证记录"`

---

## 注意

- 全程不修改任何代码与数据库 schema（SQL 模板验证插入后必须回滚删除）
- 手册不出现任何真实密码/密钥值；引用凭证时只写获取途径
- 每任务提交后 `git status --short` 确认工作区干净
