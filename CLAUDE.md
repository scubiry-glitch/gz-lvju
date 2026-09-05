# Claude 工作约定 · 江苏保租房专用频道

## 规则 1 · 页面变动时必须同步导航

**只要任何 `screens/*.html` 文件被新增、改名、删除、或职责变更（如 G 端页变为 P 端页），同一次提交必须同步更新：**

1. **`screens/_nav.js`** — 共享导航模块的数据源
   - 6 个系列各自的页面清单（G / B / F / P / S / C）
   - 改动包括：增减项、改 label、改路径、改徽标计数、改归属系列
   - 这是单一数据源，所有页面通过 `<div id="side-nav" data-series="..." data-active="...">` mount

2. **`overview.html`** — 全站导航总览页面（仓库根目录）
   - 列出全部页面，按系列分组
   - 用作开发预览、需求评审、政府方演示的总入口
   - 不存在则新建；存在则补全/更新

**实施细则：**
- 不要只改单页面就提交。修页面 + 改 `_nav.js` + 改 `overview.html` 应该在同一 commit。
- 若改动很多页面，按系列分批提交，但每个 commit 内三者必须同步。
- 新建系列（如未来加 V 端供应商）时，先在 `_nav.js` 增加系列定义，再建页面。

## 规则 2 · 共享导航的使用

每个桌面页面应包含：
```html
<div id="side-nav" data-series="g" data-active="whitelist-operator"></div>
<script src="_nav.js"></script>
```

每个移动页面应包含：
```html
<div id="tab-bar" data-series="s" data-active="orders"></div>
<script src="_nav.js"></script>
```

`data-series` 取值：`g` `b` `f` `p` `s` `c`
`data-active` 取值：`_nav.js` 中该系列的 page id

不要在页面内再硬编码 sidebar/tabbar 的 HTML。如需扩展，去改 `_nav.js`。

## 规则 3 · 设计 token 一致性

每个系列有固定品牌色，写在 `_nav.js` 的系列定义里。页面内 CSS variable 应当与之对齐：

| 系列 | 品牌色 | 用途 |
|---|---|---|
| G 住建厅 | `#1e40af` 政务深蓝 | 监管 |
| B 运营机构（国企持有方+白名单运营商） | `#0f766e` 青绿 | 运营 |
| F 江苏银行 | `#0f1a4d` + `#b45309` 深蓝金 | 金融 |
| P 服务认证中台 | `#0f172a` 黑底 | 平台 |
| S 服务者 App | `#0f766e` 青绿（与 B 对齐） | 移动 |
| C 租客 | `#2563eb` 蓝 | 用户 |

## 规则 4 · 角色定位红线（持有方 vs 运营方）

**"国企"是房屋持有方/资管方，不是日常运营方；主要日常运营方是贝壳和其他白名单内的机构（自如/龙湖/华润/招商/贝壳省心租等）。**

- 国企看 **资管/报表/合规/运营商绩效**，不直接做派单/上架/管家/工单等日常动作
- 派单、房源上下架、员工花名册、绩效续约、好房子评级录入 等动作页 **属于白名单运营商**，国企方"只读"
- 写文案时不要用"国企运营平台 / 国企运营方"这种把国企=运营方的表述，使用 **国企持有方 + 白名单运营商** 二分
- B 端导航/页面如果让国企看到"5 张工单超时未处理"这类一线运维事件 = 视角错位，需要降级为"运营商 SLA 异常"维度
- 模板基准：`screens/d-org-standard.html` 已经把生态拆为 **5 类机构**（🛠 S 服务者 / 🏬 B 白名单运营商 / 👥 V 人力服务商 / 🛒 M 物资 / 🎓 T 培训）+ 🏢 **国企持有方**（产权方，dashed 旁注，不在 5 类机构内），并配 P 服务认证中台关系图谱（§ 2）；其它页面以此对齐

## 规则 5 · 试点-推广节奏（不把政策当常量）

**政府政策支持 → 实际房源接入** 是一条不确定链路。先试点再推进，不要把推广性指标当作承诺。**这条规则约束所有面向决策者的文案与目标。**

- 涉及"46 项目 / 全省 500 / 30 万 MAU / 全省一张网 / 11 月发布会官宣"这类推广性指标，必须带 **"试点验证后启动"** 或 **"政策推动+自愿复制后的上限假设"** 的前置限定语
- 北极星指标要区分 **承诺指标**（试点期内可控的漏斗/合规命中率）与 **上限假设**（依赖政策传导的项目数/MAU）
- 三阶段的"出口标准"是下一阶段启动的 **stage-gate 门槛**，未达标则延期、缩范围、重做试点，不自动滚动
- 风险表必须包含"政策传导 → 实际接入"一行（高概率/极高影响），不要被"国企 IT 能力弱"等技术风险掩盖
- 写新文档/页面时遇到这类指标自问：**这是承诺还是上限？前置条件写清楚了吗？**

## 规则 6 · 沉淀新的约定到这里

如果你发现项目里有新约定（取舍判断、命名模式、数据格式），把它写在这个文件里，避免下次重复决策。

## 规则 7 · 地域/部门/业务词 配置单一数据源（`screens/_region.js`）

**所有"主体名词"只能写在 `screens/_region.js` 的预设里，页面与导航不得再硬编码。** 主体名词包括：省（全称/简称/设区市/省会）、主管厅（住建厅/商务厅…）、业务词（保租房/旅居住宿…）、金融机构（江苏银行…）、国企持有方（安居集团…）、生态机构示例名单（自如/龙湖/优家装饰/北新建材/家协培训…）、运营方品牌（贝壳）。

- **预设切换**：`?region=js|gx|gz_wl`（或 localStorage `bzf_region`），默认 `js`（江苏·住建厅，= 现有字面量基准，切到它时 relabel 为空操作）。`overview.html` 顶部有可视化切换下拉。
- **两条落地路径**：
  1. **导航/chrome**（`_nav.js` / `_navmobile.js` / `index.html` 新居住首页 / `index2.html` 故事板城市切换器）→ 直接读 `window.BZF_REGION` 拼装，不走 relabel。改这类文案时改配置字段，别写死。
  2. **页面正文**（`screens/*.html` 全量）→ 由 `_region.js` 的 `relabel()` 在 DOMContentLoaded 时按"江苏基准串→激活预设值"词典替换。所以正文里**仍以江苏字面量书写**（保持基准可读），新增页面只需引入 `<script src="_region.js"></script>`（在 nav 脚本之前；根目录页面用 `screens/_region.js`）。
- **新增省份/厅**：只在 `_region.js` 的 `PRESETS` 加一个 key，不改任何页面。
- **relabel 词典规则**：源串始终是 `PRESETS.js`（江苏基准），按"长串优先"排序避免子串误伤；运营方品牌 `贝壳` 是跨域常量（仅极少数演示场景换）。
- **已知边界**：① relabel 只处理静态文本节点 + `<title>`，页面**加载后由 JS 动态生成**的含品牌串内容不会被替换——这类内容应改读 `BZF_REGION`；② 需保持江苏原值的样例节点加 `data-noregion` 跳过；③ **改名 ≠ 改业务语义**：把保租房换成旅居住宿后，F 系列公积金/监管账户、好房子评级口径等是业务重做，不在本层职责内。
- 详见 `docs/region-abstraction-plan.md`。

## 规则 8 · 居住服务工单闭环单一数据源（`screens/_orderbus.js`）

**"客户提交需求 → 中台派单 → 服务者接单/完成 → 客户评价 → 评价回流"这条闭环的跨页面状态，只走 `screens/_orderbus.js`（localStorage `bzf_orders`），页面不得各自硬编码 mock。** 这是让纯静态原型"可点击贯通可演示"的总线。

- **状态机**：`pending`(待派) → `dispatched`(已派单) → `accepted`(已接单) → `serving`(服务中) → `done`(已完成待评价) → `rated`(已评价)。每态在 `STATUS` 里同时给出 `c`/`worker`/`admin` 三视角文案 + 进度条 `pct`。
- **四个接入页各司其职**：`repair.html`(C端提交+进度+评价) / `p-service-demand.html`(中台派单) / `s-orders.html`(服务者推进) / `p-service-review.html`(评价回流)。每页保留原有"示例"静态内容，**实时工单叠加在顶部并标「实时」徽标**，演示不污染基线观感。
- **API**：`BZF_ORDERS.create / dispatch / advance / rate / byStatus / get / reset / onChange`。`advance` 封顶到 `done`（评价只能由客户 `rate` 触发）；`onChange` 监听跨页 storage 变更自动重渲染。
- **复用而非新造**：再接入任何端（如 B 端运营商工单视图、G 端投诉关联）时，引 `<script src="_orderbus.js"></script>`（在 region 脚本之后、nav 脚本前后均可，只要在使用 `BZF_ORDERS` 的内联脚本之前），从 `byStatus()` 取数据渲染，**不要再 new 一套 localStorage key**。
- **与 region 解耦**：本总线只产数据，服务者姓名/房源等为样例字面量，不参与 relabel；如某态文案需随省份变，改读 `BZF_REGION`，勿写死。

## 规则 9 · 家政工单 API 总线（`screens/_jzapi.js`）

**新居住 · 家政频道**的跨页面状态只走 `screens/_jzapi.js`（REST `/api/juzhu/jiazheng/*`，MySQL 为唯一数据源），与 `_orderbus.js`（localStorage 报修演示）并行、不混用。

- **接入页**：`juzhu-jiazheng-*.html`、`juzhu-order-progress.html`、`lvju-app-pay.html`（`channel=jiazheng`）、`p-service-demand.html`、`p-service-review.html`、`s-orders.html`、`b-dispatch-board.html`
- **API**：`BZF_JZ.create / pay / dispatch / advance / rate / list / get / onChange`
- **鉴权**：`/api/juzhu/*` **默认拒绝**，须 `JUZHU_API_KEY`（只从 `.env` / `.env.local` 读取；**禁止**历史默认 `dev-juzhu-key`，任何环境均拒绝）；前端管理台经 `localStorage JUZHU_API_KEY` 对齐，勿在页面硬编码。白名单仅限 C 端目录/房源展示、`POST /api/juzhu/jiazheng/wechat-link`、`GET /api/juzhu/gr/orders*`、`GET .../virtual-phone`；商家开放接口走 HMAC；admin 走登录会话或 Key。**工单列表/详情/支付/评价/派单一律要 Key**（禁止 `?phone=` 匿名旁路）
- **双轨 API**：C 端工单走 `/api/juzhu/jiazheng/*`（`jz_skus` + `jz_orders`）；P/B 管理台走 `/api/juzhu/jz/*`（`jz_subcategories` / `jz_vendors` / `jz_products` / `jz_workers`）。订单表统一为 `jz_orders`，vendor 下单经 `channel_sku_id` 映射到 SKU。

## 规则 10 · 话务虚拟号（TP）只走服务端

绑定虚拟号走话务 `/bundling/alloc`，`app_id` / `app_key` **涉及号池成本，禁止明文写到端上或对公网静态资源**。端只消费服务端下发的虚拟号；签名与密钥仅服务端。规范见 `docs/tp-sign-and-call.md`，联调脚本 `scripts/tp_bundling_alloc.py`。本业务约定**不传 `port`**；线上 Base 为内网 `http://i.tp.lianjia.com`，测试 `http://tp-test.lianjia.com`，外网不可直连线上。

**新居住项目电话（保租房 + 卖旧买新）**：真实号存 `projects.contact_phone`（仅 DB + 管理 API，**不进 data.json**）；C 端户型详情拨号走 `GET /api/juzhu/projects/{id}/virtual-phone`，每次实时绑号、禁止缓存。密钥放 `juzhu/.env.local`（模板 `juzhu/.env.example`），`server.py` 启动时自动加载。

## 规则 11 · 静态服务不得暴露源码与密钥

`juzhu/server.py` 与线上 Node 入口 `app.js` 用仓库根做静态根时，**必须**拦截敏感路径：`.env*`、隐藏文件、`*.py`、`*.db`/`*.sqlite`、`*.sql`、`*.ini`、`config.ini`、`api_doc.md`、`package.json`、`README.md`、根目录 `app.js`/`scf_bootstrap`/`moma_*`、`.git` 等；`/juzhu/` 仅白名单 `app.js` / `cities.json` / `data.json` / `data-*.json`。禁止目录列表。生产设置 `JUZHU_ENV=production` 且显式配置 `JUZHU_API_KEY`、`JUZHU_ADMIN_PASSWORD`，禁止依赖代码内开发默认值。文档与页面不得写真实 vendor SECRET / DB 凭证 / Bearer token。MySQL 账号只进运行时环境变量 / 本地 `.env.*`（gitignore），**禁止**写进 `app.js` 源码默认值。

## 规则 12 · 只用 Node（禁新增 Python）+ MySQL；C 端保租房走 catalog

**一切新增与改动只用 Node，不用 Python**（2026-09-04 拍板）：运行时、脚本、工具、迁移、单测一律 Node（`app.js` / `*.cjs`，Node 22+），**不得新增任何 Python 代码，也不再维护/扩展存量 Python**。`juzhu/server.py` 等 Python 文件仅作历史参考保留；此前由 Python 承担的本地联调与商家 HMAC 回归，改由 Node 侧脚本 / 直调接口完成。SCF 入口 `scf_bootstrap` → `app.js`，`/api/juzhu/*` 直连 MySQL。

- **家政种子**：`jz_seed.cjs`（`ensureSchema` 时表空才写）
- **保租房种子**：`housing_seed.cjs` 从 `juzhu/data.json` / `data-nanjing.json` / `data-guiyang.json` 灌入（`cities` 为空时）
- **商家开放接口**：`POST /api/juzhu/callback` + `/api/juzhu/jiazheng/vendor/*`（HMAC，`vendor_api.cjs`，对齐 `api_doc.md`）
- **C 端展示**：`juzhu/app.js` 优先 `GET /api/juzhu/catalog?city=`，失败才回落静态 JSON
- **我的订单 / 微信预约**：`GET /api/juzhu/gr/orders*`、`POST /api/juzhu/jiazheng/wechat-link`（vendor 密钥与 `url_link` 读 `jz_vendors` 表 `hmac_key`/`url_link`/`order_detail_url` 三列，禁止对外 HTTP）
- **SQLite 存量一次性导入**：`node migrate_to_mysql.cjs [sqlite.db]`（见 `docs/deploy.md`）
- **Python 存量**（`juzhu/server.py` 等）：仅作历史参考保留，不再运行 / 维护 / 扩展（见下方规则 14）

## 规则 13 · 频道名称单一数据源（`settings.channel_name`）

C 端「新居住频道 / 新居住专区 / 新居住」等品牌文案只读全局设置 `channel_name`（默认 `新居住频道`），后台 `juzhu-admin.html`「设置」页可改。词干 = 去掉末尾「频道/专区」。页面不得再写死这组字眼。

## 规则 14 · 脚本一律用 Node（mysql2），不用 Python

一切数据库操作（DDL/DML/迁移/备份）、一次性脚本、数据验证脚本、联调与回归测试用 **Node + `mysql2`**（仓库已装依赖；`node -e` 或 `scripts/*.cjs`），**禁止**为跑 SQL 引入或编写 Python（pymysql 等）。与规则 12 同一口径：**只用 Node，Python 存量（`juzhu/server.py`、`juzhu/test_vendor_api.py` 等）仅作历史参考，不运行、不维护、不扩展**。连接配置只从环境变量读（`MYSQL_*` / `JUZHU_DB_*`），禁止把凭证写进脚本或仓库文件。

## 规则 15 · 房源频道模型（channel / topic / 评级口径）

**频道是业务类型，专题是筛选条件，两者不许混。**（2026-09-04 拍板）

- `projects.channel ∈ rental(租赁住宿=长租+旅居，监管同口径) / minsu(惠居民宿) / newhouse(新房) / resale(二手) / trade(卖旧买新)`。
  **`bzf`（保租房）不再是 channel** —— 它是一个专题（topic），定义存 `settings` KV（key `topic_bzf`，JSON 条件 `{channel:'rental', tags:['保租房']}`），查询走 `GET /api/juzhu/catalog?topic=bzf`。**禁止**在任何表/新代码里把 bzf 当 channel 写死。
- 频道差异属性放 `projects.ext` / `units.ext`（JSON text），**不为单个频道加专用列、不建分表**。
- **商家维度必挂**：`projects.owner_vendor_id`（NOT NULL，153=平台自营），商家接口 `/api/juzhu/vendor/*` 一律按它隔离。
- **评级口径按频道**（服务端 `RATING_DIMS` 是单一数据源，前后端一致）：`rental`=好房子4维（comfort/green/tech/safety）、`minsu`=旅居彩贝5维（scenery/facilities/service/location/culture）、newhouse/resale 暂无。评级编号前缀：rental=`SY-RENT-`、minsu=`MZ-`（旧 `SY-BZF-` 兼容查询）。
- 上下架 = `projects.status`（online/offline/draft）；C 端 catalog 只出 `online`。
- 演示数据：`node scripts/demo-listings.cjs seed|clean`（tag「演示」一键清理，禁止用真实商家名）；**演示项目/户型使用固定 id 段 9001-9006 / 9101-9109**，reseed 后直链不失效。
- 验收实例端口：`juzhu/.env.local` 的 `JUZHU_VERIFY_PORT`（38766），不与主服务 8766 抢端口。

## 规则 16 · 房态日历 / 保险标识 / 最短连住（旅居短住口径）

**逐晚库存与入住规则的单一数据源在服务端（`app.js`），页面不得各自硬编码口径。**（2026-09-05 拍板）

- **房态**：`stay_calendar` 表只存差异行（`status: open/blocked/booked`、`price_night` 覆盖、`booking_id`），**无行 = 默认可订**；`unit_id=0` 表示项目级（整栋/不限房型）。`booked` 只由下单写入、取消自动释放，商家接口不可改已订晚。
  - C 端公开读：`GET /api/juzhu/projects/:id/stay-calendar?month=&unit_id=`（含夜价/三态/最短连住/保险）
  - 商家读写：`GET|POST /api/juzhu/vendor/stay-calendar`（关房/开房/设夜价，owner 校验）
- **最短连住**：`STAY_MIN_NIGHTS_DEFAULT`（rental=15 晚 / minsu=1）+ `projects.ext.min_stay_nights`（1-365，商家可覆盖）。**三处同口径校验**：C 端日历选段、下单页、`POST /api/juzhu/booking` 服务端兜底；改口径只改服务端常量或 ext，不要在前端另设数字。
- **保险标识**：`INSURANCE_TYPES`（`switch_rental` 换租保险 / `hotel_cancel` 酒店取消险 / `property` 财产保险）是唯一枚举，存 `projects.ext.insurance`（key 数组），商家经 `PUT /api/juzhu/vendor/projects/:id` 配置；catalog/项目详情按 `insurance_types` 下发（含 label/icon），C 端直接渲染，**不要再造一份中文名映射**。
- **回填工具**：`node scripts/stay-calendar-init.cjs`（保险缺配置按频道默认补齐 + 存量订单重建为 booked 行，幂等可重跑）。
- 入口页：B 端 `screens/b-stay-calendar.html`（房态月历 + 批量关房/夜价 + 连住与保险配置），C 端 `lvju-app-lvju.html`（连续时间段选择）→ `lvju-app-detail.html`（房态日历）→ `lvju-app-booking.html`。
