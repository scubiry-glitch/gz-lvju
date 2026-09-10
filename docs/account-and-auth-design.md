# 全盘账号与权限体系设计（新居住 · 保租房 / 旅居 / 家政 / 生活服务）

> 2026-09-04 · 设计稿 v1
> 覆盖角色全集：G 政府方 / F 金融方 / P 服务认证中台 / B（国企持有方 + 白名单运营商）/ T 培训 / V 人力 / M 物资 / S 服务者 / C 租客 / 商家 vendor
> 硬约束：商家账号对齐家政已有 vendor 模型；规则 4（国企≠运营方）、规则 5（试点→推广不设常量）、规则 9/10/11（密钥与鉴权红线）全程生效

---

## 0. 结论摘要

1. **建一个账号中心，不按端各建一套**：`orgs（主体）→ accounts（登录身份）→ roles（角色）→ scope（数据范围）` 四层。所有端复用同一套登录/会话/鉴权管线。
2. **商家账号完全对齐家政 vendor 模型**：`jz_vendors` 不动，作为家政/生活服务的域模型；商家的人（后台登录）挂 `accounts.vendor_id`，商家的机器（开放接口）继续走既有 `hmac_key` HMAC。白名单运营商/人力/物资/培训泛化为 `orgs`，家政 vendor 是 org 的特化（`jz_vendors.org_id` 渐进回填）。
3. **多账号是原生能力，不为主子账号做特别设计**：任何主体（商家、城市政府、供应商、运营商…）都直接挂 N 个 `accounts`，账号各自绑角色；不区分"主账号/子账号"，也没有层级继承——需要新账号就是给同一 org/vendor 再插一行 account。
4. **认证四种通道 + IdP 联邦，授权一个模型**：人=账号密码→会话 token（升级现有 HMAC 实现）；机器=per-account API Key（收敛现在的全局 key）；商家机器=vendor HMAC（保留）；C/S 端=微信/手机号轻身份；**gov/bank 走各自独立 IdP（OIDC/SAML 联邦，本地不存其密码）**。授权统一 RBAC + scope。
5. **部署已前后端分离（静态站 + Node API 分开部署），仓库暂不拆**。部署方式见 `docs/deploy.md` §4；给出三条拆仓触发线（部署节奏 / 团队边界 / 安全合规域），命中才拆——对齐规则 5 的 stage-gate 思路。
5. **B 端红线落地为权限**：国企持有方角色只有只读资管权限集；派单/上架/花名册/评级录入等运营动作只存在于运营商角色（规则 4）。

---

## 1. 角色全集盘点（overview.html 实际清单）

overview.html 的汇报分组与 `_nav.js` 系列键的对应关系，以及每类主体的账号形态：

| 汇报分组 | 系列键 | 主体 | 账号形态（目标） | 数据范围 |
|---|---|---|---|---|
| 📐 方案与标准 | `d` | 文档/发布物 | 无账号（静态页） | — |
| 🏛 政府方 | `g` + `portal` | 省住建厅及设区市 | 机构账号（人），少数监管机器对接 | region 全省只读 + 监管事项 |
| 🏦 金融方 | `f` | 江苏银行 | 机构账号（人）+ 资金对账机器 | 监管账户/资金流（限本行） |
| 🏢 B·国企持有方 | `b`（资管二级） | 安居集团等产权方 | 机构账号（人）**只读** | org 本级 + city（资管/报表/合规/绩效） |
| 🏬 B·白名单运营商 | `b`（运营二级） | 贝壳/自如/龙湖/华润… | 机构账号（人），多岗位角色 | org 本级 + city（日常运营动作） |
| 🧭 P 认证中台 | `p` | 平台自运营 | 平台账号（人）+ 系统任务 | all |
| 🎓 T 培训 | `t` | 家协培训等 | 机构账号（人） | org 本级（课程/学员/考试） |
| 👥 V 人力 | `v` | 人力服务商 | 机构账号（人） | org 本级（派单/花名册） |
| 🛒 M 物资 | `m` | 北新建材等供应商 | 机构账号（人）+ 订单机器 | org 本级（商品/订单） |
| 🛠 S 服务者 | `s` | 管家/维修工/阿姨 | 个人轻身份（手机号/微信） | self（本人工单/收入/认证） |
| 👤 C 租客 | `c` | 租客/业主 | 匿名浏览 + 微信/手机号登录 | self（本人订单/预约） |
| 🏪 商家 vendor | —（API 层） | 家政/生活服务商家 | **人：后台账号挂 vendor_id；机器：vendor HMAC**（现状保留） | vendor 本商家 |

> 注：`d-org-standard.html` 的 5 类机构（S/B/V/M/T）+ 国企持有方（产权方，不在 5 类内）即本表主体口径；账号体系必须保持"国企持有方"作为**独立 org_type**，不得并入运营商。

---

## 2. 现状盘点：已有 4 套鉴权与缺口

| # | 机制 | 现状 | 问题 |
|---|---|---|---|
| 1 | 全局 `JUZHU_API_KEY` | admin 台 + P/B 管理页共用一把 key，timingSafeEqual 比对 | **一把钥匙全通**：无法区分人/端/机构，无法吊销单人 |
| 2 | admin 登录会话 | `HMAC(adminPassword, exp)` 签名当 token | 无账号表、无过期吊销、单租户 |
| 3 | vendor HMAC | `hmac_auth.cjs` per-vendor `hmac_key` 对 body 签名；`vendor_no`/`whitelist_id`/`url_link`/`order_detail_url`/`platform_certs` | **模型最完整**，但只有机器通道，商家运营人员没有后台账号 |
| 4 | C 端轻身份 | 匿名白名单（catalog/gr-orders/wechat-link）+ phone 参数 | 无登录态；`jz_orders.phone`/`gr_orders.user_id` 各自为政 |

**结论**：不推翻任何一套——把 #3 vendor 模型升格为"商家账号标准"，把 #1/#2 收敛进统一账号中心，#4 增加登录态但保留匿名白名单（规则 9 不扩大匿名面）。

---

## 3. 身份与权限模型

### 3.1 四层模型

```
orgs（主体机构）          ← 谁的
 └─ accounts（登录身份）   ← 谁来登录（人 / 机器两种 principal）
     └─ account_roles     ← 以什么角色
         └─ roles + scope ← 能做什么（permission）× 能碰哪些数据（scope）
```

**DDL（MySQL 5.7 兼容，进 `mysql_schema.sql` 追加）：**

```sql
-- 主体机构：所有机构的统一父表
CREATE TABLE IF NOT EXISTS orgs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_no   VARCHAR(32)  NOT NULL UNIQUE,           -- 对齐 vendor_no 编号风格
  org_type VARCHAR(16)  NOT NULL,                  -- holding|operator|vendor|labor|material|training|bank|gov|platform
  name     VARCHAR(128) NOT NULL,
  city_ids TEXT,                                    -- 经营城市（JSON 数组），对齐 jz_vendors.city_ids
  status   VARCHAR(16)  NOT NULL DEFAULT 'active',  -- active|suspended|terminated
  whitelist_id INT NULL,                            -- 关联白名单表；运营商/商家可见
  idp_issuer VARCHAR(255) NULL,                     -- gov/bank 独立 IdP 的 issuer / SAML entityID（平台侧配置，密钥不入此表）
  created_at VARCHAR(32), updated_at VARCHAR(32),
  KEY idx_type (org_type)
);

-- 登录身份：人与机器共用一张表，principal_type 区分；任意主体可挂 N 个账号（原生多账号，无主/子层级）
CREATE TABLE IF NOT EXISTS accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  org_id INT NULL,                 -- 机构身份（gov/bank/org 人员可为 NULL=平台直属）
  vendor_id INT NULL,              -- 商家直连（对齐 jz_vendors.id；与 org_id 二选一或并存）
  principal_type VARCHAR(8) NOT NULL DEFAULT 'user',  -- user|machine
  login_name VARCHAR(64) NULL UNIQUE,                 -- 机器 principal 时可空
  phone VARCHAR(32) NULL,
  password_hash VARCHAR(128) NULL,                    -- sha256(salt+pwd)，禁明文；IdP 联邦账号恒为 NULL
  api_key_hash VARCHAR(128) NULL,                     -- 机器 key 只存哈希
  idp_type VARCHAR(16) NULL,                          -- local|oidc|saml|wechat|sms（NULL=local）
  idp_subject VARCHAR(128) NULL,                      -- IdP 侧唯一标识（sub / NameID / openid / phone）
  display_name VARCHAR(64),
  status VARCHAR(16) NOT NULL DEFAULT 'active',       -- active|locked|disabled
  last_login_at VARCHAR(32),
  created_at VARCHAR(32), updated_at VARCHAR(32),
  UNIQUE KEY uk_idp (idp_type, idp_subject),
  KEY idx_vendor (vendor_id), KEY idx_org (org_id), KEY idx_phone (phone)
);

CREATE TABLE IF NOT EXISTS roles (
  role_code VARCHAR(32) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  permissions TEXT NOT NULL,        -- JSON 数组：["project.read","order.dispatch",...]
  builtin TINYINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS account_roles (
  account_id INT NOT NULL,
  role_code VARCHAR(32) NOT NULL,
  scope JSON-equivalent TEXT NOT NULL DEFAULT '{}',  -- {"level":"vendor","city_ids":[..],"vendor_ids":[..]}
  PRIMARY KEY (account_id, role_code)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token_hash VARCHAR(128) NOT NULL UNIQUE,           -- 存 sha256(token)，原文只在签发时返回一次
  account_id INT NOT NULL,
  expires_at BIGINT NOT NULL, revoked_at BIGINT NULL,
  ua VARCHAR(255), ip VARCHAR(64), created_at VARCHAR(32),
  KEY idx_account (account_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id INT, role_code VARCHAR(32),
  action VARCHAR(64) NOT NULL, resource VARCHAR(128), resource_id VARCHAR(64),
  scope_level VARCHAR(16),
  before_json LONGTEXT, after_json LONGTEXT,
  ip VARCHAR(64), created_at VARCHAR(32),
  KEY idx_account_time (account_id, id)
);
```

### 3.2 scope：数据范围（ABAC-lite，五级就够）

| level | 语义 | 典型角色 |
|---|---|---|
| `self` | 仅本人数据 | worker、user |
| `vendor` | 本商家（vendor_id 圈定） | vendor_operator |
| `org` | 本机构 | operator_admin、training_admin、material_admin |
| `city` | 指定城市（city_ids） | holding_viewer、gov_viewer |
| `all` | 全平台 | platform_admin |

**鉴权判定**：`permission ∈ role.permissions` 且 `resource.scope ⊆ account.scope`。范围取交集，角色不叠加放权。

### 3.3 内置角色清单（首版 12 个，宁少勿多）

| role_code | 给谁 | 关键权限 | 规则 4/5 约束 |
|---|---|---|---|
| `platform_admin` | P 中台运维 | all | 唯一能改 `settings`/渠道/角色 |
| `platform_op` | P 中台运营 | 认证评级、服务商准入、争议处理 | — |
| `holding_viewer` | **国企持有方** | 报表/资管/合规/运营商绩效 **只读** | **无任何运营动作权限**（规则 4） |
| `operator_admin` | 白名单运营商管理员 | 房源上下架、派单、花名册、绩效、工单 | 限 org scope |
| `operator_dispatcher` | 运营商调度员 | 派单/改派/工单推进 | 限 org scope |
| `operator_housekeeper` | 管家 | 本人名下工单/房源带看 | 限 self+org |
| `gov_viewer` | 住建厅 | 全省监管看板/投诉/合规 **只读** | 出规则不出运营（规则 4） |
| `bank_viewer` | 江苏银行 | 监管账户/资金流 **只读** | 限本行数据 |
| `vendor_owner` | 商家管理员（对齐 vendor） | 商家全部：商品/SKU/服务者/订单/对账 | 限 vendor scope |
| `vendor_operator` | 商家客服/运营 | 订单接单/改派/售后 | 限 vendor scope |
| `worker` | S 端服务者 | 接单/完工/收入查看 | 限 self |
| `user` | C 端租客 | 下单/支付/评价/预约 | 限 self |

> 培训（T）、人力（V）、物资（M）首版复用机构型角色：`training_admin` / `labor_admin` / `material_admin`（权限面各自收敛在课程学员、派单花名册、商品订单三域），不再细分岗位——等试点期真实使用反馈再拆。

### 3.4 权限矩阵（核心资源 × 角色）

| 资源 | holding_viewer | operator_* | gov_viewer | vendor_* | worker | user | platform_admin |
|---|---|---|---|---|---|---|---|
| 房源 projects/units | R（本市报表口径） | **RWD**（本机构） | R（脱敏） | — | R（带看） | R | RWD |
| 家政 SKU/商品 | — | — | — | **RWD**（本商家） | R | R | RWD |
| 工单 jz_orders | R（SLA 聚合） | **RD + 改派** | R（投诉视角） | **RU**（本商家接单） | **RU**（本人） | **RU**（本人） | RWD |
| 派单 dispatch | — | **W** | — | W（vendor 内部） | — | — | W |
| 评价 rating | R | R | R | R | R（收评） | **W** | RWD（争议） |
| 好房子/旅居评级录入 | — | W（运营商录入） | 审定 R | — | — | — | 审定 WD |
| 培训课程/考试 | — | — | R | — | **RU**（本人） | — | RWD |
| 物资订单 | — | W（申领） | — | **RWD**（本商家） | — | W（申领） | RWD |
| 资金/对账 | R（资管口径） | R（本机构流水） | R | R（本商家对账） | R（本人收入） | R（本人支付） | RWD |
| 系统设置/角色/渠道 | — | — | — | — | — | — | **RWD** |

R=读 W=建 U=改 D=删；一切写操作进 `audit_log`。

---

## 4. 认证设计（四通道）

### 4.1 机构端/平台端（人）：账号密码 → 会话 token

- `POST /api/auth/login`（login_name/phone + password）→ `{access_token, expires_in, account, roles}`
- token 格式**沿用现有实现思路并升级**：`base64(payload).HMAC(secret_per_account, exp)`，payload 带 `aid/roles/exp/jti`；服务端以 `sessions.token_hash` 校验并可吊销（改密/锁定即 revoke）。
- 密码策略：sha256(salt+pwd) 落库；连错 5 次锁 30 分钟；不设"万能查看密码"。
- admin 现有 `JUZHU_ADMIN_PASSWORD` 迁移为首个 `platform_admin` 账号，登录后原密码作废。

### 4.2 机器对机器：API Key 收敛

- 现全局 key → **per-account machine key**（`principal_type='machine'`，存 `api_key_hash`）。传递沿用 `X-API-Key`。
- **过渡兼容**：全局 key 保留但权限降为 `admin` 域只读 + 一个版本周期；新签发的机器 key 按账号 scope 生效。
- 禁止历史默认 `dev-juzhu-key`（规则 9 不变），key 只从 `.env*` / DB 读，页面只从 localStorage 对齐、不硬编码。

### 4.3 商家（vendor）：人与机器分离，域模型不动 ← **对齐家政 vendor 模型**

```
jz_vendors（域模型：商家资质/评级/佣金/城市，保留）
   │
   ├─ 人：accounts(vendor_id=jz_vendors.id, roles=[vendor_owner|vendor_operator])
   │      → 商家后台登录（/vendor-admin），走 4.1 会话
   └─ 机器：开放接口 POST /api/juzhu/callback、/api/juzhu/jiazheng/vendor/*
          → 继续用 jz_vendors.hmac_key 做 HMAC（hmac_auth.cjs 不改）
```

- **多账号原生支持，无主/子账号设计**：一个商家直接挂 N 个 `accounts`（各自绑 `vendor_owner`/`vendor_operator`），账号间无层级、无继承；账号的开/停/改由 `platform_admin`（及后续放开的 `account.manage` 权限点）操作。同一规则适用于所有 org_type——城市政府、供应商、运营商多账号同此，不做任何主体特殊化。
- `hmac_key`/`url_link`/`order_detail_url` 永不出库（沿用 `VENDOR_SECRET_FIELDS` 剥离）；商家后台里只见尾号。
- 白名单准入：`jz_vendors.whitelist_id` / `orgs.whitelist_id` 为准入门槛建档字段，**运营商白名单与商家白名单分开两张档**（规则 4：国企持有方只读白名单，不审批）。
- M 物资/V 人力若未来要做开放接口，**复用同一套 HMAC 通道**（per-org secret），不新造签名协议。

### 4.4 C 端租客：轻身份

- 匿名白名单保持现状（目录/房源/我的订单查询），**不扩大**（规则 9）。
- 涉写操作（下单/支付/评价）要求登录：微信 `code2session`（主）或手机号验证码（辅），签发同 4.1 会话，role=`user`，scope=self。
- `jz_orders.phone` 与账号 phone 归一：登录后写操作强制校验 `order.phone == account.phone`，堵 `?phone=` 匿名旁路（规则 9 红线）。

### 4.5 S 端服务者：worker 身份

- 手机号+验证码（服务者无企业微信，验证码最省）；登录后绑定 `jz_workers.id`（+ `vendor_id` 归属）。
- 一个 worker 只绑一个账号；换手机号走 vendor_owner 或 platform_op 后台改绑 + 审计。

### 4.6 gov/bank：对接各自独立 IdP（已拍板）

政府端与银行端**不在本系统建密码**，走各自机构的独立 IdP 联邦登录：

```
gov/bank 用户 → 机构 IdP（政务外网统一认证 / 银行内网 SSO）
            → OIDC authorization code（首选）/ SAML 2.0 断言
            → 本系统回调 /api/auth/idp/callback?org=<org_no>
            → 校验 issuer（= orgs.idp_issuer）+ 签名 + audience
            → 按 (idp_type, idp_subject) 匹配或首次 JIT 建档 accounts（role=gov_viewer/bank_viewer，scope 按 org 预配）
            → 签发本系统会话 token（4.1 同款）
```

- **本地 `password_hash` 恒为 NULL**，登出/锁定只影响本系统会话，不影响 IdP 会话；账号生命周期以 IdP 为准（`status=disabled` 仅作本地兜底闸）。
- 首版只做 **IdP 发起 + 本系统 SP**（Service Provider）角色，不做本系统向 IdP 的单点回跳；每类主体（gov/bank）各配一个 issuer，互不复用。
- 实施安排在**阶段 3**（政企接入期），阶段 1/2 用 `idp_type='local'` 账号先行；但 `idp_type/idp_subject/orgs.idp_issuer` 字段在阶段 1 建表时就带上，避免二次迁移。
- 密钥（OIDC client_secret / SAML 证书）只存平台运行时配置（env / 平台私有配置表），不进 `orgs` 明文列、不进任何静态资源。

### 4.7 密钥红线（不变项）

- TP 虚拟号 `app_id/app_key` 只在服务端（规则 10）；DB 凭证只在运行时 env（规则 11）；任何端页面不落真实密钥；C 端拨号虚拟号每次实时绑号、禁缓存。

---

## 5. API 边界与中间件管线

```
请求 → identify（解析凭据：session token / api key / vendor hmac / 匿名）
     → authenticate（验签/查 sessions）
     → authorize（permission + scope 交集）
     → handler
     → audit（写操作必记）
```

路径分区（`/api/juzhu/` 下）：

| 前缀 | 鉴权 | 现状映射 |
|---|---|---|
| `/api/juzhu/public/*`（含现 C 端白名单） | 匿名 | `isCEndPublicApi` 白名单平移 |
| `/api/juzhu/c/*` | user 会话 | 下单/支付/评价 |
| `/api/juzhu/s/*` | worker 会话 | 接单/完工（对齐 `screens/s-orders.html` 的 `_jzapi` 调用） |
| `/api/juzhu/org/*` | 机构会话（operator/holding 分权） | B 端运营台 + 国企只读台 |
| `/api/juzhu/vendor/*` | vendor HMAC（机器）+ `/vendor-admin` 会话（人） | 现商家开放接口不动 |
| `/api/juzhu/admin/*` | platform_admin | 现 admin 收敛 |

`app.js` 落地顺序：先在 `handleApiDirect` 入口把 `assertAdminAuthorized/assertApiAuthorized` 替换为统一 `authorize(req, needPermission)`，旧的 `requireApiKey` 变成机器通道的其中一种凭据解析器。

---

## 6. 仓与部署：**部署已前后端分离，仓库暂不拆，给出拆仓触发线**

**部署面（已分离，见 `docs/deploy.md` §4）**：静态前端（nginx 直接服务静态目录，无需 Node）与后端 API（`node app.js` + MySQL，独立进程/独立端口，nginx 反代 `/api/`）分开部署、可分机放置、独立发布与回滚。本仓库 + `juzhu-admin` 等页面即前端产物；`app.js` 一进程即后端。

**仓库面（暂不拆）**：一仓（原型 + Node 后端 + 移动壳）对试点期效率最优。拆仓触发线（命中任一再拆）：

| 触发线 | 信号 | 拆法 |
|---|---|---|
| 部署节奏分化 | 后端需要独立于原型的发布/回滚频率 | `sy-api`（Node 后端）独立仓，原型仓经 API 联调 |
| 团队/权限边界 | 商家端/服务者端交给独立小组或外包 | `sy-console-vendor` / `sy-app-s` 独立仓，账号体系 API 化对接 |
| 安全合规域 | F 端银行要求独立合规审查域、政务外联专区 | `sy-finance-gateway` 独立仓（只放对账/资金接口），密钥域隔离 |

**必须保持的约定（拆仓也不变）**：`screens/_nav.js` 单一导航源与规则 1 的同步义务；`_region.js`/`_orderbus.js`/`_jzapi.js` 三个单一数据源随所属端走；后端 API 契约（含 HMAC 协议）以 `api_doc.md` 为准，跨仓只走版本化 API，不共享 DB 表读写。

---

## 7. 迁移路径（三阶段，stage-gate 不自动滚动 · 规则 5）

### 阶段 1 · 账号中心试点（平台内，2–3 周量级）
- 建 `orgs/accounts/roles/account_roles/sessions/audit_log`；`jz_vendors` 回填 `org_id`
- admin 收敛为 `platform_admin` 账号；全局 API Key 降级计划启动；商家后台（`vendor_owner/operator`）上线
- **出口标准**：①全部管理写接口带审计；②商家能用子账号分岗登录；③旧全局 key 只剩只读。未达标 → 缩范围重做，不进阶段 2

### 阶段 2 · 多角色接入（试点验证后启动）
- S 端 worker 登录、C 端登录态（下单/评价强制）、B 端双视角分权（holding_viewer 只读上线）、P/T/V/M 机构账号按试点城市接入
- **出口标准**：①试点城市真实运营商/商家/服务者三方都用账号体系完成一轮真实闭环；②`?phone=` 旁路全量关闭；③权限矩阵通过安全评审。未达标 → 只扩不广、重试

### 阶段 3 · 政企推广（**上限假设，非承诺**）
- gov_viewer / bank_viewer 接入（**走各自独立 IdP 联邦登录，见 §4.6**；字段已在阶段 1 建好，本阶段只做对接与 JIT 建档联调）、多城市复制、白名单批量准入
- **前置限定**：依赖政策传导与各方自愿接入，指标（接入项目数/账号数/MAU）全部按"政策推动+自愿复制后的上限假设"表述，不作承诺；"政策传导 → 实际接入"列入风险表（高概率/极高影响）

---

## 8. 与既有约定对齐清单

| 约定 | 本设计的落点 |
|---|---|
| 规则 4 国企≠运营方 | `holding_viewer` 只读角色 + org_type=holding 独立建模；运营动作权限仅 operator_* |
| 规则 5 试点→推广 | §7 三阶段全部带出口标准；推广指标=上限假设 |
| 规则 9 鉴权 | 全局 key 收敛、`?phone=` 旁路关闭、vendor secret 不出库、页面 key 只进 localStorage |
| 规则 10 TP | 虚拟号密钥不下端，通道不变 |
| 规则 11 静态/密钥 | 账号体系新增的 `.env`、schema 变更照旧不进静态白名单；`audit_log` 不经静态服务暴露 |
| 规则 12/14 只用 Node | 全部 DDL 进 `mysql_schema.sql` + `ensureSchema`；实现、脚本、回归测试一律 Node + mysql2，不新增/不运行 Python |
| 规则 13 频道名 | `channel_name` 等设置项权限收归 `platform_admin` |

---

## 附：已拍板决策（2026-09-04）

| # | 决策 | 落点 |
|---|---|---|
| 1 | **不为主/子账号做特别设计**：商家、城市政府、供应商等一切主体原生多账号（同一 org/vendor 挂 N 个 account，各绑角色，无层级继承） | §3.1 DDL 注释、§4.3 |
| 2 | **前后端已分离部署**：静态前端与 Node API 分开部署，deploy 文档给出分别部署方式 | §6、`docs/deploy.md` §4 |
| 3 | **gov/bank 对接各自独立 IdP**：本系统不建其密码，OIDC/SAML 联邦 + JIT 建档，阶段 3 实施、字段阶段 1 就位 | §4.6、§7 阶段 3 |

## 附：待拍板问题（不阻塞阶段 1）

1. **C 端登录形态**（微信为主还是手机号为主）——跟微信预约 `wechat-link` 链路一起定。
2. **审计留存期**——建议 ≥180 天，等政府合规要求确认。
3. **`account.manage` 权限下放节奏**（机构自助开号 vs 平台代开）——试点期由 `platform_admin` 代开，跑通后再评估下放给 `vendor_owner`/`operator_admin`。

---

## 附：落地状态（2026-09-06 · 阶段 1 完成盘点）

> 本节为实施后增量记录；上文为设计稿原文（保留作对照）。

**阶段 1 出口标准逐条核对：**
- ①全部管理写接口带审计 → ✅ `perm_registry.ROUTES` 26 条写路由逐条落细粒度 `audit_log.action`（`project.update`/`account.create`/`role.update`…，替代粗粒度 `admin.write`）
- ②商家能用子账号分岗登录 → ✅ `vendor_owner`/`vendor_operator` 原生多账号（§4.3 未做主/子设计，按本表执行）；商家登录口接入登录节流
- ③旧全局 key 只剩只读 → ✅ 更进一步：admin 域 GET 亦按 `admin.read` 收口，旧 key 全域 403

**本轮（B0-B7）额外落地（超出阶段 1 原范围）：**
- 权限点注册表 `perm_registry.cjs` 单一数据源（PERMS 权限点目录 + ROUTES 路由映射 + `roleDefaults` 折叠 + 基线快照闸）
- 防爆破：`login_throttle` 两级节流（§4.1「连错 5 次锁 30 分钟」落地，IP 维度防喷洒）+ `audit_log.result` 列 + 账号不存在也留痕
- 密码 scrypt 懒升级；会话分级 TTL（管理面 12h / C·S 30d / IdP 12h）
- scope 落地：city 档 `city_ids` 显式授权（§3.2）；org/report、admin/projects、staff 行级过滤；`stats` 对匿名降级
- 账号中心 `screens/account-center.html`：roles CRUD（自定义角色，`'*'` 红线）、权限矩阵、数据权限抽屉、会话管理（解锁/强制下线）、审计增强、IdP 配置 UI
- 菜单按权限裁剪（`_nav.js` item.perms；未登录全显）
- `settings.perm_strict` 过渡开关已置 `1`（platform_op 写权限收归 platform_admin）

**待拍板项进展：**
- #3 `account.manage` 下放 → 权限点已注册、未接路由（试点期平台代开维持）
- #1 C 端登录形态 → 未动（仍随微信 `wechat-link` 链路一起定）
- #2 审计留存期 → 默认 180 天维持（`AUDIT_RETENTION_DAYS`）

**回归基线**：`scripts/perm_gate_regression.cjs`、`auth_security_regression.cjs`、`scope_regression.cjs`、`iam_api_regression.cjs` 四条 + `node test_static_guard.js`，全绿为过。
