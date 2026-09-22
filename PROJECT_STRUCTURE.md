# 居住服务平台 · 项目结构与访问指南

> 本文档基于根目录 [`README.md`](README.md) 与仓库实测整理，作为「每个文件夹/文件是什么、怎么访问、接口在哪里」的总索引。
> 项目定位：**保租房 / 新居住 / 旅居 / 家政** 四业务线可点击静态原型（~200 页）+ 可运行 Node/MySQL 数据层。

---

## 1. 一句话架构

```
浏览器/APP(WebView)  ──HTTP──▶  app.js (Node 22+ 单入口)
                                ├─ 静态文件服务（拦截 .env*/ *.sql/ *.py 等敏感路径）
                                ├─ /api/juzhu/*  REST 路由（C 端 / admin / vendor 三轨）
                                └─ ensureSchema 自动补表/补列
                                          │
                                          ▼
                                       MySQL（MYSQL_* / JUZHU_DB_* 由运行时环境变量注入）
```

- **前端**：纯静态 HTML + 共享 JS 总线（`screens/_*.js`），无构建步骤，可直接 `http.server` 预览。
- **后端**：单一 `app.js` 进程（SCF 入口 `scf_bootstrap`），端口运行时 `PORT`（默认 9000；本地调试常配 8766）。
- **鉴权**：后台 `JUZHU_API_KEY` + 账号中心会话；商家开放接口走 HMAC-SHA256；密钥**只**来自 `.env*` / `runtime.env` 等运行时环境变量。

---

## 2. 根目录文件导航

### 2.1 总入口 HTML（直接双击或挂静态服务器访问）

| 文件 | 作用 | 是否走后端 |
|---|---|---|
| `overview.html` | **全站总入口**：全部页面按系列/汇报视角分组 + 搜索 + 地域切换 | 否（导航数据源 `screens/_nav.js`） |
| `index.html` | 新居住首页（`index` 方案 C），含家政 Tab | 是 |
| `index2.html` | 原型故事板 | 否 |
| `lvju-app-home.html` | 旅居 C 端 App 首页（36 页群入口） | 是 |
| `beike-app-home.html` | 贝壳租房 App 首页型入口 | 否 |
| `baozufang-channel-overview.html` | 保租房 V1/V2/V3 三档总入口 | 否 |
| `baozufang-overview-v1-basic.html` | 保租房 V1 仅展示 | 否 |
| `baozufang-overview-v2-standard.html` | 保租房 V2 + 标准体系 | 否 |
| `baozufang-overview-v3-full.html` | 保租房 V3 + 交易闭环 | 部分 |
| `lvju-overview.html` | 旅居总览 | 否 |
| `lvju-gov-dashboard.html` / `lvju-gov-dashboard-map.html` | 旅居政务大屏 | 否 |
| `lvju-rating-standard.html` / `lvju-journey.html` / `lvju-roadmap.html` | 评级标准 / 旅程图 / 路线图 | 否 |
| `prd.html` | PRD 渲染页 | 否 |

### 2.2 新居住 juzhu 业务页（根目录 `juzhu-*.html`）

频道首页、卖旧买新（`juzhu-channel-*`）、好房子评级（`juzhu-admin-unit.html` / `juzhu-unit-detail.html` / `juzhu-bzf-*`）、家政闭环（`juzhu-jiazheng-*`、`juzhu-order-progress.html`）、生活/专题（`juzhu-life-layouts.html` / `juzhu-topic.html`）等共约 17 页。**大多需后端**。

### 2.3 家政业务页（根目录 `jiazheng-*.html` + `jiazheng-*.css/.js`）

| 文件 | 作用 |
|---|---|
| `jiazheng-landing-cleaning/moving/nanny/repair.html` | 保洁 / 搬家 / 保姆 / 维修 4 品类落地页 |
| `jiazheng-list.html` `jiazheng-booking.html` `jiazheng-order.html` `jiazheng-payment.html` `jiazheng-vendor.html` | 列表→下单→订单→支付→商家页 |
| `jiazheng-data.js` | 家政「目录/SKU」前端适配 + 离线 mock/兜底（**非权威源**） |
| `jiazheng-app.css` | 家政样式 |
| `jz-datepick.js` | 日期选择组件 |
| `moving-vendor-guide.html` | 搬家商家接入指引页 |

### 2.4 旅居 App 页群（根目录 `lvju-app-*.html`，约 36 页）

列表/详情/日历/下单/支付/订单/路线/玩法/专题/笔记/钱包/优惠券/客服等，统一通过 `lvju-catalog.js` 拉取 C 端数据。

### 2.5 Node 后端模块（根目录 `*.cjs` / `app.js`）

| 模块 | 职责 |
|---|---|
| `app.js` | 路由总入口：C 端 catalog/详情/日历/预订/取消 + admin 域 + vendor 会话域 + 静态服务 + `ensureSchema` |
| `stay_config.cjs` | 房态/按晚预订/保险/最短连住/**房型级免费取消政策**口径（纯函数，app.js 与 vendor_api 共用） |
| `vendor_rate.cjs` | 商家佣金费率单一数据源（商家差异化列 → settings KV → 内置 10 兜底） |
| `vendor_api.cjs` + `hmac_auth.cjs` + `vendor_config.cjs` | 商家 HMAC 开放接口（房源建稿/上下架/房态/订单，owner 校验） |
| `auth_center.cjs` + `perm_registry.cjs` | 账号中心：会话/密码（scrypt，bcrypt 遗留懒升级）/节流 + 权限点注册表与审计 |
| `idp_oidc.cjs` | IdP / OIDC 对接（联邦登录阶段 3） |
| `jz_seed.cjs` / `staff_seed.cjs` / `housing_seed.cjs` | 家政 / 员工 / 保租房种子（表空才写） |
| `gr_orders.cjs` | 我的订单（gr_orders）查询 |
| `img_thumbs.cjs` | 图片缩略图自维护管线（列表/卡片提速） |
| `channel_brand.cjs` | 频道品牌文案 |
| `housing_cities.cjs` | 城市/地域配置适配 |
| `juzhu_import.cjs` | 从 MySQL 快照灌入商家/SKU/订单 |
| `migrate_to_mysql.cjs` | SQLite 存量一次性导入 MySQL |
| `prelaunch_cleanup.cjs` | **一次性**上线前数据清理（仅首次上线用，生产禁重复执行，默认 dry-run） |

### 2.6 根目录其它脚本 / 配置 / 测试

| 文件 | 作用 |
|---|---|
| `scf_bootstrap` | SCF 启动入口：source `.env`/`runtime.env` → 校验生产门禁 → `node app.js` |
| `runtime.env` | **非隐藏**运行时环境变量副本（SCF 常丢隐藏文件）；含 MySQL 凭证 / API Key / 话务密钥。**禁止经 HTTP 暴露，禁止写入文档/仓库**。 |
| `capacitor.config.ts` | Capacitor 壳配置（APP `com.beike.lvju`；`server.url` 默认加载线上旅居首页，本地调试用 `CAP_SERVER_URL`） |
| `moma_*.sh` / `moma_deploy.js` | Moma 平台部署脚本（解析参数 → 调部署 API） |
| `package_backend.sh` | 后端打包 |
| `scripts/build-apk.sh`（见 scripts/） | APK 构建 |
| `package.json` / `package-lock.json` | 依赖与 npm 脚本（`build:android` / `cap:sync` / `cap:open` / `cap:run` / `build:apk`） |
| `jsbridgesdk.js` | 链家 JSBridge SDK（WebView 调原生） |
| `test_*.js` / `test_*.cjs` | 单测：首页性能、房源 catalog、启动、静态守卫、HMAC 等（见 §6） |
| `CLAUDE.md` | 20 条工作约定（导航同步/角色红线/单一数据源/频道模型/权限注册表/佣金口径…） |
| `VERIFICATION.md` / `C端联调测试手册.md` / `联调手册.md` | 验证与联调说明 |
| `api_doc.md` / `api-doc.html` / `api-doc.md` | **内部**接口文档（被静态守卫拦截，对外不得直接链接） |
| `PRD-保租房专用频道-V1.0.md` / `prd.md` / `prd.html` | PRD 文档 |
| `*.png` / `mq0n1457-*.doc` / `mq0pq2pl-*好房子*.xlsx` / `江苏租赁行业标准_V25.docx` | 图谱截图 / 标准依据文件 |
| `guizhou-map.json` / `shenyang-map.json` | 地域地图配置（贵州/沈阳预设） |

---

## 3. 子目录详解

### `screens/` —— 保租房四端 + P 中台 + 开放平台（122 个 HTML）
导航/移动端/地域/订单/家政总线的**单一数据源 JS** 也在这里：

| 文件 | 职责 |
|---|---|
| `_nav.js` | 桌面 sidebar + 6 系列（G/B/F/P/S/C）页面清单单一数据源；`item` 支持 `perms` |
| `_navmobile.js` | 移动端 chrome（status-bar / 渐变 header / 底部 tabbar） |
| `_region.js` | 地域/部门/业务词/机构主体名词单一数据源；`?region=` 切预设 + `relabelStr()` 改名 |
| `_orderbus.js` | 报修工单演示总线（走 `localStorage bzf_orders`） |
| `_jzapi.js` | 家政工单 REST 总线（C 端下单 + P/B 管理台双轨，MySQL 权威） |
| `_qr.js` | 二维码生成（第三方 MIT 库） |
| `_console-login.js` | 中台登录态桥接 |

页面按前缀分端：`g-` 住建厅、`b-` 国企持有方/运营、`f-` 江苏银行、`p-` 服务认证中台、`s-` 服务者、`c-` 租客、`v-` 物资、`t-` 培训、`m-` 供应商、`d-` 蓝图标准、`account-center.html` 账号中心、`open-platform.html` 开放平台、`portal-*` 门户。
`shots/` 为该目录截图资源。

### `docs/` —— 设计与 PRD 文档（30 个 .md）
| 子目录/文件 | 内容 |
|---|---|
| `deploy.md` | 部署 / MySQL 迁移 |
| `account-and-auth-design.md` | 账号中心与权限设计 |
| `tp-sign-and-call.md` | 话务虚拟号签名与调用（密钥仅服务端） |
| `juzhu-info-architecture.md` | 新居住信息架构 |
| `region-abstraction-plan.md` | 地域抽象落地方案 |
| `release-packaging.md` `detail-page-optimization-plan.md` | 发布打包 / 详情页优化方案 |
| `plans/` | 11 篇设计+决策记录（家政我的订单、MySQL 迁移、商家城市、商家接入、配置入表…） |
| `prd/` | 家政频道 PRD（全流程 + 4 品类）+ SPU/SKU 分层设计 |
| `security/` | 2 篇安全修复记录（后台越权修复、敏感信息泄露修复） |
| `superpowers/` | 能力/规范参考 |

### `scripts/` —— 全部 Node 回归/种子/迁移脚本（29 文件）
| 类别 | 脚本 |
|---|---|
| 回归（绿了才算过） | `auth_security` / `perm_gate` / `scope` / `iam_api`（IAM 四条）· `housing_vendor_hmac` / `vendor_hmac`（HMAC）· `booking_cancel_policy` · `vendor_commission` · `vendor_go_live` · `vendor_login_migration`；另有 `test_api_auth_gate.js` / `test_juzhu_admin_auth.js` / `test_juzhu_contact_phone.js` |
| 演示/种子 | `demo-listings`（固定 id 9001-9109）· `lvju-stay-seed` · `spots-seed` / `routes-seed` / `find-topic-seed` |
| 迁移/回填 | `cancel-policy-init` · `stay-bookable-init` · `stay-calendar-init` · `vendor_accounts_migrate` · `migrate-housing-channels` · `perm_registry_snapshot` / `perm_roles_resync`（权限基线防漂移） |
| 其它 | `mock_oidp.cjs`（OIDC mock）· `tp_bundling_alloc.py`（话务分配）· `build-apk.sh` · `__fixtures__/perm_roles_baseline.json`（权限基线快照） |

### `juzhu/` —— Python 历史存量（不运行/不维护/不扩展）
23 个 `.py` + `mysql_schema.sql` + 数据 JSON（`data*.json` / `cities.json`）。`server.py` 等仅作参考；**一切新增用 Node + mysql2**。关键参考：`mysql_schema.sql`（schema 权威定义）、`data-nanjing/shenyang/guizhou.json`（城市种子数据）。

### `assets/` —— 静态资源（849 文件）
- `assets/juzhu/`：新居住图片（webp/jpg/png/jpeg）
- `assets/lvju/`：旅居图片（15 jpg）
- `assets/_scratch/`：临时草稿（png/cjs/json，开发用）

### `android/` —— Capacitor Android 壳（54 文件）
标准 Gradle 工程：`android/app/`（主模块、Java 源码、res 资源、manifest）+ `gradle/`、`resources/`、`build.gradle` 等。`namespace=com.beike.lvju`。通过 `npm run cap:sync` 与 `www/` 同步。

### `www/` —— Capacitor 本地静态资源壳
仅 `index.html`（加载提示页）；离线壳模式由 `capacitor.config.ts` 切换，默认走远程 `server.url`。

### `vendor/` —— 本地依赖
`lianjia-jsbridge3-1.1.6.tgz`（链家 JSBridge npm 包，被 `package.json` 以 `file:` 引用）。

### `e2e/` —— 端到端冒烟
`smoke.mjs`（冒烟测试入口）。

### `exports/` —— 交付物 PDF
`gen-pdfs.mjs` + 9 个 PDF（总图谱/人的标准/房的标准/机构的标准/三档对比/三阶段）。

### `lvju-download/` `zhijian-download/` —— APK 分发页
各含 `index.html` + `.apk`（旅居 / 家政 Android 安装包落地页）。

---

## 4. 如何访问

### 4.1 静态预览（无需后端，多数原型页够用）
```bash
python3 -m http.server 8000
# http://localhost:8000/overview.html       全站导航
# http://localhost:8000/index.html          新居住首页
# http://localhost:8000/lvju-app-home.html  旅居 App
```

### 4.2 带后端（新居住数据 / 家政下单 / 预订 / 后台）
```bash
cp juzhu/.env.example juzhu/.env.local   # 配 MySQL 凭证 + JUZHU_API_KEY + JUZHU_ADMIN_PASSWORD
node app.js                              # 代码默认端口 PORT||9000；本地/验证守护常用 8766（验证实例见 JUZHU_VERIFY_PORT，如 38766）
# 前台：http://localhost:8766/index.html   （或 9000，取决于 PORT）
# 后台：http://localhost:8766/juzhu-admin.html（登录走账号中心）
```
> 端口说明：`app.js` 源码默认 `PORT || 9000`；`README.md` 所述本地/验证环境 **8766**（验证实例 `JUZHU_VERIFY_PORT=38766`）为守护拉起时实际注入的 `PORT`。两者不冲突，以运行时 `PORT` 为准。

生产必须经 `scf_bootstrap` 启动且 `JUZHU_ENV=production`、显式配置密钥；静态服务会拦截 `.env*` / `*.sql` / `*.py` 等敏感路径。

### 4.3 移动端 / APK
- `npm run cap:sync && npm run cap:open`（Android Studio）
- 已构建包见 `lvju-download/index.html`、`zhijian-download/index.html`
- 远程壳：`capacitor.config.ts` 默认加载 `https://xjz.ke.com/lvju-app-home-demo.html`

### 4.4 地域切换
`overview.html` 顶部下拉，或 URL 加 `?region=` / `localStorage bzf_region`：
`js`(江苏·住建厅·保租房，默认) · `gx`(广西) · `sy_zj`(沈阳·旅居) · `gz_zj`(贵州·旅居)。

---

## 5. 接口（API）在哪里

**全部集中在根目录 `app.js` 单进程内**（无独立 controller 目录），路径统一前缀 `/api/juzhu`。
鉴权三轨：
- **C 端公开/受限公开**：部分 GET 无需 Key；写操作（预订/登录/入驻申请）按白名单放行（见 `isCEndPublicApi`）。
- **admin 域**：全方法强制 `JUZHU_API_KEY`（除 `auth/login|check`），并由 `perm_registry.cjs` 做细粒度权限闸与审计。
- **vendor 开放接口**：`POST /api/juzhu/callback` 及 `/api/juzhu/jiazheng/vendor/*`、`/api/juzhu/housing/vendor/*` 走 HMAC-SHA256（平台→商家）。商家自身登录后拿 token 调 `/api/juzhu/vendor/*`。

### 5.1 C 端（目录 / 内容 / 预订 / 家政）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/juzhu/catalog` | 房源目录 |
| GET | `/api/juzhu/cities` `/api/juzhu/districts` | 城市 / 区县 |
| GET | `/api/juzhu/settings` `/api/juzhu/stats` `/api/juzhu/ratings` `/api/juzhu/trade` | 设置 / 统计 / 评级 / 交易 |
| GET | `/api/juzhu/projects/:id` `/projects/:slug` `/projects/:slug/units` `/projects/:id/stay-calendar` | 项目详情 / 户型 / 房态日历（公开，无 PII） |
| GET | `/api/juzhu/projects/:id/virtual-phone` | 虚拟号（话务，密钥仅服务端） |
| GET | `/api/juzhu/units/:id` `/units/:id/photos` | 户型详情 / 户型图片 |
| GET | `/api/juzhu/org/report` | 资管大盘聚合（按账号 scope 过滤城市） |
| GET | `/api/juzhu/routes` `/spots` `/topics` | 内容域：路线 / 地点笔记 / 专题 |
| GET | `/api/juzhu/jiazheng/categories` `/skus` `/workers` | 家政类目 / SKU / 服务者 |
| GET | `/api/juzhu/jiazheng/skus/:id`(含 `/slots` `/detail` `/vendors`) | 家政 SKU 详情 |
| GET | `/api/juzhu/gr/orders` `/gr/orders/:ref` `/:ref/vendor-detail` | 我的订单（gr_orders） |
| POST | `/api/juzhu/booking` `/booking/lookup` `/booking/cancel` `/booking/pay` | 按晚预订 / 查单 / 取消 / 支付（受限公开） |
| GET | `/api/juzhu/booking/my` `/booking/contacts` | 我的预订 / 联系人 |
| POST | `/api/juzhu/booking/contacts` | 保存联系人 |
| POST | `/api/juzhu/auth/tenant` `/auth/beike` | C 端登录（tenant / 贝壳） |
| POST | `/api/juzhu/jiazheng/wechat-link` | 家政微信链路 |
| POST | `/api/juzhu/onboarding/apply` | 公开入驻申请 |
| GET | `/api/juzhu/onboarding/status` | 入驻进度（单号+手机号双匹配） |
| POST | `/api/juzhu/callback` | 商家回调（HMAC） |

**家政订单全链路**（C 端写 + 中台派单，双轨）：
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/juzhu/jiazheng/orders` | 订单列表（需 API Key；phone 仅作过滤） |
| GET | `/api/juzhu/jiazheng/orders/stats` | 订单统计（须在 `:id` 之前） |
| GET | `/api/juzhu/jiazheng/orders/:id` | 订单详情 |
| POST | `/api/juzhu/jiazheng/orders` | 下单（C 端受限公开） |
| POST | `/api/juzhu/jiazheng/orders/:id/pay` | 支付 |
| POST | `/api/juzhu/jiazheng/orders/:id/dispatch` | 中台派单 |
| POST | `/api/juzhu/jiazheng/orders/:id/advance` | 服务者推进状态 |
| POST | `/api/juzhu/jiazheng/orders/:id/rate` | 评价（需 API Key） |

### 5.2 admin 域（编辑后台 / 中台 / 账号中心 / IAM）
前缀 `/api/juzhu/admin`，**全方法需 `JUZHU_API_KEY` + 权限闸**：
| 方法 | 路径 | 说明 |
|---|---|---|
| POST/GET | `/admin/auth/login` `/auth/check` | 后台登录 / 会话校验（免 Key） |
| GET/POST | `/admin/projects` `/admin/projects/:id` | 项目管理（GET 列表/详情；POST 新建） |
| POST | `/admin/projects/:id/units` `/:id/rating/submit` | 户型建稿 / 评级提交 |
| GET/PUT/DELETE | `/admin/units/:id` `/:id/photos` | 户型增改删 / 图片 |
| GET/POST | `/admin/spots` `/admin/routes` `/admin/topics` | 内容域管理 |
| GET/POST | `/admin/vendor-onboarding` `/:id/review` | 商家入驻受理 / 复核状态机 |
| GET | `/admin/vendors` `/vendors/consult` `/vendors/rates` `/vendors/commission-history` | 商家列表 / 咨询 / 费率 / 佣金历史 |
| PUT | `/admin/vendors/commission-defaults` | 默认佣金率 |
| GET/POST | `/admin/cities` `/admin/districts` | 城市 / 区县管理 |
| PUT | `/admin/city` | 更新城市 |
| GET/PUT | `/admin/settings` | 设置 KV（含 `perm_strict` / `login_throttle`） |
| GET | `/admin/dictionary` | 字典 |
| POST | `/admin/export` `/admin/upload` | 导出 / 上传 |
| POST | `/admin/accounts` `/admin/roles` | 账号 / 角色管理 |
| GET | `/admin/permissions` `/admin/iam/overview` `/admin/orgs` `/admin/audit` `/admin/idp-configs` | 权限点 / IAM 总览 / 组织 / 审计 / IdP 配置 |
| PUT | `/admin/idp-configs` | 更新 IdP 配置 |
| POST | `/admin/ratings/:code/review` | 好房子评级复核（rating 复核状态机） |

### 5.3 vendor 域（商家开放接口，HMAC 或登录 token）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/juzhu/vendor/login` | 商家登录（并入账号中心，返回体兼容） |
| GET | `/api/juzhu/vendor/stay-calendar` | 商家房态日历（owner 校验） |
| POST | `/api/juzhu/vendor/stay-calendar` | 批量房态/夜价 |
| PUT | `/api/juzhu/vendor/units/:id` | 商家调价/改户型（限自己项目，仅价格字段） |
| POST(prefix) | `/api/juzhu/jiazheng/vendor/*` `/housing/vendor/*` | 家政/房源 HMAC 开放接口（建稿/上下架/房态/订单） |

> 接口权威细节见内部 `api_doc.md`（**被静态守卫拦截，仅限内网/本地查阅，勿对外链接**）。

---

## 6. 测试与质量门

- **单测**（根目录 `test_*.js` / `test_*.cjs`）：首页性能、房源 catalog、启动、静态守卫、HMAC。
- **回归**（见 §3 `scripts/`）：IAM 四条、HMAC 两条、取消政策、佣金、上线自查、商家登录迁移——**绿了才算过**。
- **e2e**：`e2e/smoke.mjs` 冒烟。

---

## 7. 数据层与三层数据边界（互不重叠）

- **MySQL** 为唯一权威源；schema 权威在 `juzhu/mysql_schema.sql`，`app.js` `ensureSchema` 运行时自动补表/补列。
- **三层边界**（详见 `CLAUDE.md` 规则 8/9/15/18/19）：
  1. `jiazheng-data.js`（根）= 家政目录/SKU 前端适配 + 离线 mock（**非权威**）；
  2. `screens/_jzapi.js` = 家政订单总线，走 REST，**MySQL 权威**；
  3. `screens/_orderbus.js` = 报修演示总线，走 `localStorage`。
- **频道模型**：`projects.channel ∈ rental/minsu/newhouse/resale/trade`；`bzf` 是专题（settings KV）非 channel；差异属性走 `ext` JSON；商家维度必挂 `owner_vendor_id`。
- **预订链路**：房态日历 → 最短连住 → **房型级免费取消**（缺省从严不可取消）→ 下单锁定**佣金快照**（调价不追溯）。
- **权限**：五档数据权限 `self < vendor < org < city < all`；过渡开关 `settings.perm_strict`；登录防爆破 `login_throttle`。

---

## 8. 一图速查：从哪里进、看什么

| 你想… | 去这里 |
|---|---|
| 看全部页面/导航 | `overview.html`（或 `index2.html` 故事板） |
| 看新居住 | `index.html`（需后端） |
| 看旅居 App | `lvju-app-home.html` |
| 看保租房四端 | `baozufang-channel-overview.html` → 选 V1/V2/V3 → `screens/gov-admin.html` 等 |
| 看中台/账号中心 | `screens/p-console.html` / `screens/account-center.html` |
| 看家政闭环 | `jiazheng-landing-cleaning.html` → list → order → `juzhu-order-progress.html` |
| 找接口定义 | `app.js`（§5 清单）/ 内部 `api_doc.md` |
| 找种子/迁移/回归 | `scripts/` + 根 `*.cjs` |
| 找设计/PRD | `docs/`（`plans/` `prd/` `security/`） |
| 找部署 | `docs/deploy.md` + `scf_bootstrap` + `moma_deploy.js` |
| 拿 Android 包 | `lvju-download/` `zhijian-download/` |

---

*保租房四方共建原型 · 已扩展为四业务线居住服务平台（静态原型 + Node/MySQL 服务）。本索引依据根 `README.md` 与仓库实测整理。*
