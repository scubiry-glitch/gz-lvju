# 居住服务平台 · 静态原型 + Node/MySQL 数据层

> 起于「保租房四方共建」，已生长为覆盖 **保租房 / 新居住 / 旅居 / 家政** 的可点击原型 + 可运行服务：
> 静态页面群（~200 页）叠加 **共享导航总线 / 工单总线 / 地域配置**，后端为 **Node 22+ 单入口 `app.js`（`/api/juzhu/*` 直连 MySQL）**，
> 含房源频道与按晚预订、房型级免费取消、商家 HMAC 开放接口、商家佣金费率、账号中心 IAM、内容域（专题/路线/周边玩法）。
> 用于需求评审、政府方演示与研发对齐。

**保租房四方共建框架（仍然成立）**：住建厅 × 江苏银行 × 国企持有方（+ 白名单运营商：自如/龙湖/华润/招商/贝壳省心租 等同业）× 贝壳租房
**主体名词单一数据源**：所有省/厅/业务词/机构名走 `screens/_region.js`，页面正文以「江苏基准字面量」书写，运行时按预设 relabel（详见「地域切换」）。

> 推广性指标（46 项目 / 全省 / 30 万 MAU 等）一律为「试点验证后启动」的上限假设，非时间承诺（见 `CLAUDE.md` 规则 5）。
> 工作约定（导航同步 / 角色红线 / 单一数据源 / 权限注册表 / 频道模型等 20 条规则）见 [`CLAUDE.md`](CLAUDE.md)。

---

## 📊 规模总览（对仓库实测）

| 维度 | 数量 | 说明 |
|---|---:|---|
| HTML 页面总计 | **~203** | 根目录 81 + `screens/` 122 |
| 保租房四端 + P 中台（`screens/*.html`） | 122 | P 中台 38 · G 住建厅 14 · S 服务者 9 · B 运营 9 · F 金融 6 · D 蓝图/标准 6 · C 租客 5 · V 人力 3 · T 培训 3 · M 物资 3 · 开放平台/门户 4 · 运营手册 2 等 |
| 新居住 juzhu（`juzhu-*.html`） | 17 | 目录 + 卖旧买新 + 家政 Tab + 编辑后台 + 订单进度 |
| 旅居 App（`lvju-app-*.html`） | 36 | C 端旅居小程序型页面群（列表/详情/日历/下单/支付/订单/路线/玩法/专题/笔记） |
| 旅居其它（`lvju-*.html`） | 8 | 总览 / 政务大屏 / 评级标准 / 旅程图 |
| 家政落地页（`jiazheng-*.html`） | 9 | 4 品类落地 + 列表 / 详情 / 下单 / 支付 / 商家 |
| 保租房三档入口（`baozufang-*.html`） | 4 | 三档总入口 + V1/V2/V3 总览 |
| 其它根入口 | — | `index.html`（新居住首页）· `index2.html`（原型故事板）· `overview.html`（全站总入口）· `beike-app-home.html` |

---

## 🧭 业务线 · 入口点

| 业务线 | 主入口 | 说明 | 后端 |
|---|---|---|:-:|
| **全站总入口** | [`overview.html`](overview.html) | 全部页面按系列/汇报视角分组 + 搜索 + 地域切换（数据源 `screens/_nav.js`） | 否 |
| **保租房 四方共建** | [`baozufang-channel-overview.html`](baozufang-channel-overview.html) | V1/V2/V3 三档版本选择器 + 能力对照 | 否 |
| ├ G 住建厅监管 | [`screens/gov-admin.html`](screens/gov-admin.html) | 监管总览（白名单/合规/大屏入口） | 否 |
| ├ B 运营机构 | [`screens/b-operator-console.html`](screens/b-operator-console.html) | 国企持有方资管视角 + 白名单运营商工作台 | 否 |
| ├ F 江苏银行 | [`screens/f-escrow.html`](screens/f-escrow.html) | 监管账户对账 / 结算 / 公积金 | 否 |
| └ P 服务认证中台 | [`screens/p-console.html`](screens/p-console.html) | 5 类机构（S/B/V/M/T）认证底座 + 入驻受理/费率/评级复核 | 部分 |
| **新居住 juzhu** | [`index.html`](index.html) | 频道首页（方案 C），含家政 Tab | 是 |
| ├ 编辑后台 | [`juzhu-admin.html`](juzhu-admin.html) | 项目/房源/户型/好房子评级/周边/内容/设置（登录走账号中心） | 是 |
| ├ 账号中心 | [`screens/account-center.html`](screens/account-center.html) | 功能权限 + 数据权限 + 账号 + 审计 + IdP（商家登录已并入） | 是 |
| ├ 开放平台 | [`screens/open-platform.html`](screens/open-platform.html) | 商家入驻申请 + 接口文档 + 在线调试台 + FAQ | 是 |
| **旅居 App** | [`lvju-app-home.html`](lvju-app-home.html) | 旅居 C 端首页（36 页群）→ 列表/详情/房态日历/下单/支付 | 是 |
| **家政** | [`jiazheng-landing-cleaning.html`](jiazheng-landing-cleaning.html) | 保洁/维修/搬家/保姆 4 品类落地页 | 是 |
| ├ 下单闭环 | [`juzhu-jiazheng-list.html`](juzhu-jiazheng-list.html) → detail → [`juzhu-order-progress.html`](juzhu-order-progress.html) | 下单 → 中台派单 → 服务者推进 → 评价回流 | 是（`_jzapi.js`） |

**如何到达其余页面**：走 [`overview.html`](overview.html)（按系列分组 + 关键词搜索）；导航单一数据源为 [`screens/_nav.js`](screens/_nav.js)，桌面页 `<div id="side-nav" data-series="..." data-active="...">`、移动页 `<div id="tab-bar" ...>` 自动挂载。

---

## 🏗 三档版本（保租房，仍有效）

| 版本 | 定位 | 入口 |
|---|---|---|
| **V1 · 仅展示** | 信息门户型 · 0 资金风险 | [`baozufang-overview-v1-basic.html`](baozufang-overview-v1-basic.html) |
| **V2 · + 标准体系** | 展示 + 好房子标准公示 | [`baozufang-overview-v2-standard.html`](baozufang-overview-v2-standard.html) |
| **V3 · + 交易闭环** | 端到端一站式办理 · 全四端 | [`baozufang-overview-v3-full.html`](baozufang-overview-v3-full.html) |

三档总入口 → [`baozufang-channel-overview.html`](baozufang-channel-overview.html)。

---

## ⚙️ 运行时（Node 22+ · MySQL）

**SCF 入口 `scf_bootstrap` → `app.js`**：API（`/api/juzhu/*`）+ 静态文件 + schema 演进（`ensureSchema`）单进程。本地/验证环境端口 8766（验证实例 `JUZHU_VERIFY_PORT=38766`，见 `juzhu/.env.example` → 拷为 `juzhu/.env.local`，启动自动加载；8766 有守护自动拉起，kill 即换新代码）。

### 根目录 Node 模块地图

| 模块 | 职责 |
|---|---|
| `app.js` | 路由总入口：C 端 catalog/详情/日历/预订/取消、admin 域、vendor 会话域、静态服务（拦截 `.env*`/`*.sql` 等敏感路径） |
| `stay_config.cjs` | 房态/按晚预订/保险/最短连住/**房型级免费取消政策**口径单一数据源（纯函数，app.js 与 vendor_api 共用） |
| `vendor_rate.cjs` | 商家佣金费率（按业务线分档）单一数据源；生效费率 = 商家差异化列 → settings KV 基准 → 内置 10 兜底 |
| `vendor_api.cjs` + `hmac_auth.cjs` + `vendor_config.cjs` | 商家 HMAC 开放接口（房源建稿/上下架/房态/订单，owner 校验） |
| `auth_center.cjs` + `perm_registry.cjs` | 账号中心：会话/密码（scrypt，bcrypt 遗留懒升级）/节流 + 权限点注册表（PERMS/ROUTES）与审计 |
| `idp_oidc.cjs` / `mock_oidp.cjs`(scripts) | IdP / OIDC 对接 |
| `jz_seed.cjs` / `housing_seed.cjs` | 家政 / 保租房种子（表空才写） |
| `gr_orders.cjs` / `img_thumbs.cjs` / `channel_brand.cjs` | 我的订单 / 图片缩略图管线 / 频道品牌文案 |

REST 双轨：C 端工单 `/api/juzhu/jiazheng/*`（`jz_skus` + `jz_orders`）；P/B 管理台 `/api/juzhu/jz/*`（`jz_subcategories` / `jz_vendors` / `jz_products` / `jz_workers`）。商家开放接口 `POST /api/juzhu/callback` + `/api/juzhu/housing/vendor/*`（HMAC）。鉴权密钥只从 `.env*` 读取（**禁止**任何默认 key / `?phone=` 匿名旁路）；MySQL 凭证只进运行时环境变量 / 本地 `.env.*`（gitignore）。schema 权威定义见 [`juzhu/mysql_schema.sql`](juzhu/mysql_schema.sql)。

> `juzhu/server.py` 等 Python 存量仅作历史参考保留：**不运行、不维护、不扩展**（2026-09 拍板，一切新增用 Node + mysql2）。

---

## 🔌 共享 JS 总线（`screens/_*.js` 单一数据源）

| 文件 | 职责 | 数据源 |
|---|---|---|
| [`_nav.js`](screens/_nav.js) | 桌面 sidebar + 6 系列页面清单（G/B/F/P/S/C）单一数据源；item 支持可选 `perms`；页面不硬编码导航 | 内置 SERIES 定义 |
| [`_navmobile.js`](screens/_navmobile.js) | 移动端 chrome（status-bar / 渐变 header / 底部 tabbar）集中配置 | 内置 |
| [`_region.js`](screens/_region.js) | 地域/部门/业务词/机构主体名词单一数据源；运行时 relabel + `relabelStr()` 属性改名 | `PRESETS` + `?region=` |
| [`_orderbus.js`](screens/_orderbus.js) | 居住服务「报修」工单闭环总线（可点击贯通演示） | `localStorage bzf_orders` |
| [`_jzapi.js`](screens/_jzapi.js) | 家政工单 REST 总线（C 端下单 + P/B 管理台双轨 API） | **MySQL**（`/api/juzhu/*`） |
| [`_qr.js`](screens/_qr.js) | 二维码生成（第三方 MIT 库） | — |

**三层数据边界（互不重叠，见 `CLAUDE.md` 规则 8/9）**：
1. `jiazheng-data.js`（根目录）= 家政「目录/SKU」前端适配 + 离线 mock/兜底；
2. `screens/_jzapi.js` = 家政订单总线，走 REST，**MySQL 为唯一权威源**；
3. `screens/_orderbus.js` = 报修演示总线，走 `localStorage`。
三者不共享 key、不合并。

---

## 🗄 数据层（MySQL）

- schema：[`juzhu/mysql_schema.sql`](juzhu/mysql_schema.sql)（运行时 `app.js` `ensureSchema` 自动补列/补表）；SQLite 存量一次性导入 `node migrate_to_mysql.cjs [sqlite.db]`
- 频道模型（规则 15）：`projects.channel ∈ rental/minsu/newhouse/resale/trade`；`bzf` 是专题（settings KV）不是 channel；频道差异属性放 `ext` JSON，不加列不分表；商家维度必挂 `owner_vendor_id`
- 预订链路：房态日历（`stay_calendar` 无行=默认可订，开通 `stay_bookable` 才生效）→ 最短连住 → **房型级免费取消政策**（`units.ext.cancel_policy`，缺省从严不可取消）→ 下单锁定**佣金快照**（调价不追溯）
- 内容域（规则 19）：`spots`（地点+笔记）→ `routes`（站点串联）→ `topic_*`（房源集合 KV），后台统一在 `juzhu-admin.html`「内容」tab
- 权限（规则 18）：五档数据权限 `self < vendor < org < city < all`；过渡开关 `settings.perm_strict`；登录防爆破 `login_throttle`

## 🧪 脚本（全部 Node，`scripts/*.cjs`）

| 类别 | 脚本 |
|---|---|
| 回归（绿了才算过） | `perm_gate` / `auth_security` / `scope` / `iam_api`（IAM 四条）· `housing_vendor_hmac` / `vendor_hmac`（HMAC）· `booking_cancel_policy`（取消政策）· `vendor_commission`（佣金）· `vendor_go_live`（上线自查）· `vendor_login_migration`（商家登录迁移） |
| 演示/种子 | `demo-listings`（房源演示数据，固定 id 9001-9109）· `lvju-stay-seed`（旅居补充房源）· `spots-seed` / `routes-seed` / `find-topic-seed`（内容域） |
| 迁移/回填 | `cancel-policy-init` · `stay-bookable-init` · `stay-calendar-init` · `vendor_accounts_migrate` · `migrate_to_mysql` · `perm_registry_snapshot` / `perm_roles_resync`（权限基线防漂移） |

凭证只从环境变量（`MYSQL_*` / `JUZHU_DB_*` / `juzhu/.env.local`）读取，禁止写入仓库。

---

## 🌐 地域切换（`screens/_region.js`）

同一套页面可切省份 / 主管厅 / 业务词，通过 `?region=` 或 `localStorage bzf_region` 选择预设：

| 预设 key | 域 | 说明 |
|---|---|---|
| `js`（默认） | 江苏 · 住建厅 · 保租房 | 现有页面字面量基准，relabel 为空操作 |
| `gx` | 广西 · 住建厅 · 保租房 | 仅换省/市/银行/国企 |
| `sy_zj` | 沈阳 · 住建局 · 旅居住宿 | 辽宁旅居模式 |
| `gz_zj` | 贵州 · 住建厅 · 旅居住宿 | 换厅 + 换业务词 + 换运营机构域 |

`overview.html` 顶部有可视化切换下拉。新增省份只在 `_region.js` 的 `PRESETS` 加一个 key，不改任何页面。`relabelStr()` 支持属性字面量改名，修复了「JS 动态生成内容不随省份切换」的边界。

---

## 🚀 本地预览

**静态预览（大多数原型页够用）**：
```bash
cd /proweb/run/sy
python3 -m http.server 8000
# 入口：http://localhost:8000/overview.html                    全站导航
#      http://localhost:8000/index.html                        新居住首页
#      http://localhost:8000/lvju-app-home.html                旅居 App
```

**带后端（新居住数据 / 家政下单 / 预订链路 / 后台需要）**：
```bash
cd /proweb/run/sy
cp juzhu/.env.example juzhu/.env.local    # 配 MySQL 凭证与 JUZHU_API_KEY / JUZHU_ADMIN_PASSWORD
node app.js                               # 8766（守护自动拉起；验证实例端口见 JUZHU_VERIFY_PORT）
# 前台：http://localhost:8766/index.html
# 后台：http://localhost:8766/juzhu-admin.html（登录走账号中心）
```
部署详见 [`docs/deploy.md`](docs/deploy.md)。生产必须 `JUZHU_ENV=production` 且显式配置密钥，静态服务会拦截 `.env*` / `*.sql` / `*.py` 等敏感路径——**对外文档一律引 HTML 文档页，不要链 `api_doc.md` 等被拦截文件**。

---

## 📚 文档与参考

| 文档 | 用途 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | 工作约定（20 条规则：导航同步 / 角色红线 / 单一数据源 / 频道模型 / 权限注册表 / 佣金口径…） |
| [`docs/deploy.md`](docs/deploy.md) | 部署 / MySQL 迁移 |
| [`docs/account-and-auth-design.md`](docs/account-and-auth-design.md) | 账号中心与权限设计 |
| [`docs/tp-sign-and-call.md`](docs/tp-sign-and-call.md) | 话务虚拟号签名与调用（密钥仅服务端） |
| [`docs/juzhu-info-architecture.md`](docs/juzhu-info-architecture.md) | 新居住信息架构 |
| [`docs/region-abstraction-plan.md`](docs/region-abstraction-plan.md) | 地域抽象落地方案 |
| [`docs/prd/`](docs/prd/) | 家政频道 PRD（全流程 + 4 品类）+ 设计稿 |
| [`juzhu/README.md`](juzhu/README.md) | 数据层快速开始 / 编辑后台 / 好房子评级复核 |
| [`PRD-保租房专用频道-V1.0.md`](PRD-保租房专用频道-V1.0.md) | 保租房 PRD V1.0 |
| `江苏租赁行业标准_V25.docx` / `mq0pq2pl-_好房子_标准提案-.xlsx` | 标准依据 / 好房子评星细则 |
| [`20260605_192600.png`](20260605_192600.png) · [`20260605_223100.png`](20260605_223100.png) | 四方共建 × 能力 × 阶段总体图谱 |

---

*保租房四方共建原型 · 已扩展为四业务线居住服务平台（静态原型 + Node/MySQL 服务）*
