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
- 模板基准：`screens/d-org-standard.html` 已经把生态拆为 **4 类机构**（🏬 B 白名单运营商 / 👥 V 人力服务商 / 🛒 M 物资 / 🎓 T 培训）+ 🏢 **国企持有方**（产权方，dashed 旁注，不在 4 类机构内），并配 P 服务认证中台关系图谱（§ 2）；其它页面以此对齐。**🛠 S 服务者（人）不属机构类**（2026-09-22 拍板：与 `d-people-standard.html` 人的标准重复），个人持证/分级/星级统一由人的标准定义，机构页只以「V 旗下持证人数 / T 培训出证」引用；新页面不要再把 S 列为机构类别

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

## 规则 8 · 居住服务工单闭环（已并轨 MySQL，`_orderbus.js` 已退役）

**"客户提交需求 → 中台派单 → 服务者接单/完成 → 客户评价 → 评价回流"这条闭环的跨页面状态，全部走 `screens/_jzapi.js`（MySQL `jz_orders`）。**（2026-09-22 拍板并轨；原 `screens/_orderbus.js` localStorage 演示总线已删除，`bzf_orders` 废弃）

- **状态机**：`pending`(待派) → `dispatched`(已派单) → `accepted`(已接单) → `serving`(服务中) → `done`(已完成待评价) → `rated`(已评价)，单一数据源 `_jzapi.js` 的 `STATUS`（`c`/`worker`/`admin` 三视角文案 + 进度条 `pct`）与 `ORDER`（状态序）。
- **接入页各司其职**：`repair.html`(C端报修提交+进度+评价) / `lvju-app-me.html`·`lvju-app-ticket.html`(旅居 App 提交+详情) / `p-service-demand.html`(中台派单) / `s-orders.html`(服务者推进) / `p-service-review.html`(评价回流)。每页保留原有"示例"静态内容，实时工单叠加并标「实时」徽标。
- **复用而非新造**：再接入任何端时引 `<script src="_jzapi.js?v=N"></script>`，报修走 `createRepair / listRepairs / repairGet / repairCancel`，派单推进评价走既有 `dispatch / advance / rate`，**不要再 new 一套 localStorage key**。

## 规则 9 · 工单 API 总线（`screens/_jzapi.js`）

**新居住 · 家政/报修工单**的跨页面状态只走 `screens/_jzapi.js`（REST `/api/juzhu/jiazheng/*`，MySQL 为唯一数据源）。

- **接入页**：`juzhu-jiazheng-*.html`、`juzhu-order-progress.html`、`lvju-app-pay.html`（`channel=jiazheng`）、`p-service-demand.html`、`p-service-review.html`、`s-orders.html`、`b-dispatch-board.html`
- **API**：`BZF_JZ.create / pay / dispatch / advance / rate / list / get / onChange`
- **鉴权**：`/api/juzhu/*` **默认拒绝**，须 `JUZHU_API_KEY`（只从 `.env` / `.env.local` 读取；**禁止**历史默认 `dev-juzhu-key`，任何环境均拒绝）；前端管理台经 `localStorage JUZHU_API_KEY` 对齐，勿在页面硬编码。白名单仅限 C 端目录/房源展示、`POST /api/juzhu/jiazheng/wechat-link`、`GET /api/juzhu/gr/orders*`、`GET .../virtual-phone`；商家开放接口走 HMAC；admin 走登录会话或 Key。**工单列表/详情/支付/评价/派单一律要 Key**（禁止 `?phone=` 匿名旁路）
- **双轨 API**：C 端工单走 `/api/juzhu/jiazheng/*`（`jz_skus` + `jz_orders`）；P/B 管理台走 `/api/juzhu/jz/*`（`jz_subcategories` / `jz_vendors` / `jz_products` / `jz_workers`）。订单表统一为 `jz_orders`，vendor 下单经 `channel_sku_id` 映射到 SKU。
- **工单出参与派单（2026-09-22）**：orders list/detail 随行下发 `type_label`——产品化下单写入的 `type` 是英文 `category_id`（cleaning…），服务端 CASE join `jz_categories` 出中文名，存量中文 type 与权益售后（type≠category_id）原样保留；页面显示类型一律用 `type_label`，**不得再各造 id→中文 映射**。`POST .../dispatch` **派单必指派**：不传 `worker` 时服务端按 `jz_workers` 信用分↓完单量↓择优自动分配（worker_json 带 `auto:true`），无 active 服务者 400——不再落 `worker_json=NULL` 幽灵单（服务者端按 worker 过滤看不见，闭环会断；存量幽灵单在 P 端显示「已派单 · 未指派」）。
- **报修单 repairs 通道（2026-09-22，原 `_orderbus` localStorage 并轨入 MySQL）**：`POST /api/juzhu/jiazheng/repairs`（C 端报修下单，挂 `ORDER_CREATE`；`sku_id=NULL`、`category_id='repair'`、`type`=中文报修类型字面量、`fee=0`、`pay_status='not_required'`、`source` 须以「旅居客 App」开头）写同一张 `jz_orders`；`GET /repairs?phone=`（**phone 必填**）与 `GET /repairs/:id?phone=`（id+phone 双因子）只出 `source LIKE '旅居客 App%'` 的行——**永远不存在匿名全表读取**（匿名在 `requireApiKey` 即 401；legacy key 经 `C_WRITE_PATH_RE` + `C_REPAIRS_READ_RE` 放行 POST/GET/DELETE）；`DELETE /repairs/:id?phone=` = 待派取消，条件硬 DELETE（`status='pending' AND worker_json IS NULL`，已派 409）——**不引入 `cancelled` 状态**（会波及 stats/各端过滤全链）。派单/推进/评价复用既有 `/orders/:id/*` 路由。C 端页面演示凭据走 localStorage `JUZHU_API_KEY`（同 `jiazheng-booking.html` 模式）或登录会话；`repair.html` 提交后把 phone 存 `localStorage bzf_repair_phone` 供「报修记录」与详情页回查。
- **生活服务专区入口恒为 12 个频道**（`index.html` 的 `renderJiazhengCats`）：入口列表以本地 `JZ_CATS` 为基准，`GET /api/juzhu/jiazheng/categories` 回来的只做**覆盖 + 追加**，**不得直接按接口结果渲染**。接口按「当前城市有无可售商品」过滤，会把当前城市没配商品的频道一并滤掉（实测 `city=贵州` 只剩 10 个，丢了保洁和维修）——但这是导航入口不是库存指示，少一个入口就少一条进频道的路。接口失败 / `_jzapi.js` 未加载时也要回落 `renderJiazhengCats(null)` 画出纯本地 12 个，不得整块空白。
- **分类配色单一数据源**：家政各分类的品牌色写在 `_jzapi.js` 的 `CAT_THEME`（`catTheme()` / `applyCatTheme(el, type)`，后者把 `--cat-brand / --cat-brand-2 / --cat-deep / --cat-soft / --cat-tint` 写到元素上）。列表页与详情页的 hero / poster / 标签 / 按钮 / **正文模块 chrome**（小节标题色条、序号圆点、商家 Logo 底、证书卡、服务者卡、选中态描边与光晕）**只消费这些 CSS 变量**，页面不得再各写一份配色表，也不得残留全局 `--brand`（青绿）——那会让蓝色/橙色频道里混进绿色。
  - `--cat-soft` = 12% 品牌色**透明**混合（叠在白卡上的浅底）；`--cat-tint` = 白底 8% 品牌色**不透明**浅底。**深色 hero 上用白色半透明，浅色容器上用 `--cat-tint`**；把 `--cat-soft` 用在深色底上会隐形。
  - `moving`（搬家）= 参考稿《搬家服务原型说明》蓝犀牛 × 贝壳 的频道蓝：品牌 `#1678ff` / `#168FFA`，详情 hero `#1376FF → #0E61FF → #408FFB` 135°，列表标签 `#EFF6FF` 底 + `#1678ff` 字。
  - `repair`（维修）**让出原来的蓝**、改用搬家腾出的橙 `#ea580c`（语义贴合「紧急响应」），避免到家服务一排两个蓝。`index.html` 各分类另有深色变体（`.jz-cat.* .bg/.orb`）与 4px 强调条（`.in::before`），改色时两处要一起改；搬家深色变体取 `#1a54b8`（**不要用 `#1d4a8c`**，与 `telecom` `#1d4e89` 的 ΔE 仅 5.3，肉眼几乎同色）。
  - 改 `_jzapi.js` 后记得把引用页的 `?v=N` 一起 +1（缓存击穿）。
- **C 端内容口径（《搬家服务原型说明》蓝犀牛 × 贝壳 2026-09-18）**——详情页各模块的字段归属：
  - **列表 hero / 频道横幅**：`jz_vendors.banner_url` 配频道级横幅（列表接口随行下发 `vendor_banner`），**仅当本频道当前商品全部来自同一商家且该商家配了横幅**时替换掉渐变 hero（否则会把 A 商的品牌物料挂在 B 商的商品列表上）。样式照原型说明视觉规范：宽 100%、高 auto 不裁切、圆角 14px；`onerror` 回落渐变 hero。素材是 OSS 那张 `lxn-banner.png`（1164×600），按仓库惯例（**无外链图**）落到 `assets/` 本地引用；缩略图由 `img_thumbs.cjs` 自动出，但 `.t*.webp` 是 gitignore 的运行时产物，页面**引原图**别引缩略图。
  - **列表卡片**（L01）：海报三段 = 商家名 / 品类 / 车型 + 卡车图标；下方 名称 + 列表描述 + **全量**标签 + 起价 + 去预约。不要加参考稿没有的「可预约」pill 或写死的「最快可约 今天18:00」。
  - **详情顶部**（D02）：**两行**标签——第一行固定「`{L2}+ 持证服务者` + `★ 评分`」，第二行**原样复用列表标签且顺序一致**。两行 chip **统一用白色半透明 `rgba(255,255,255,.16)` + 白字**：参考稿原型里 `.detail .hero-tag` 的优先级压过 `.hero-tag.blue/.green`，实际渲染就是这个样式；不统一会变成白透 + 绿 + 浅蓝三种底混排，很难看。**不要改用 `--cat-soft`**（12% 品牌色透明混合，蓝色 hero 上等于隐形）。hero 正文不要限 `max-width`（会挤成窄柱、右侧留大片空白）。
  - **服务说明**（D03）：每项 = 标题 + 正文，存 `jz_skus.includes`（`[{name,desc}]`，旧纯字符串数组渲染端仍兼容）；小面/中面 2 项、厢货 4 项。**列名禁止写 `includes_json`**：那是链家库一次热修残留，`ensureJzSkusIncludesColumn()` 启动时把它 rename 成 `includes`；接口出参也只暴露 `includes`。
  - **商家介绍**（D05）：Logo + 品牌名 + 「`{品类}服务商`」副标题 + **整段品牌简介**，简介存 `jz_vendors.intro`（`merchantIntroOf` 有值就整段用它、不再拼自动统计；**没值回落旧拼接**，避免存量商家整块空白）。不再展示评分/评价/起订价三宫格——起订价对搬家无意义且 `start_price` 未配时渲染成「¥0/起」。
  - **认证服务者**（D06）：证书按品类取，**同城/跨城 = ACP，日式 = ACA**（`/日式/` 判名）。
  - **服务流程**（D07）：全商品统一 4 步，正文存 `service_notice`（与 `service_flow` 一一对应，不是费用须知）。
- **沈阳可售商品**：列表/详情接口按「`jz_products.city_id` = 当前城市 + 商家 active 且 `city_ids` 命中」双维度过滤，**`city_id` 为 NULL 的商品在任何城市都不展示**。沈阳搬家用 `node scripts/moving-shenyang-seed.cjs seed|clean`（蓝犀牛 vendor 151，商品固定 id 段 5161-5166，幂等，clean 只删本脚本清单）。
  - 列表接口另补 `vendor_name` / `list_desc` / `vendor_banner` 三个相关子查询，与 `product_min_price` 共用 `priceAggJoin`。两条硬约束：① **tokens 绑定份数按 `priceAggJoin` 在 SQL 里的实际出现次数自动算**（`sql.split(priceAggJoin).length - 1` + cityExists 那份），**不要手工计数**——手工少 push 一份会静默查空（踩过：6 条变 0 条）；② **子查询不得引用 `v.` 别名**——`v` 只在 cityName 能解析成城市时（`cityId !== null`）才由 `priceAggJoin` 引入，传省名 / 未知城市时 `priceAggJoin` 为空串，`v.name` 会直接报 `Unknown column 'v.name' in 'field list'`（踩过）。取商家字段一律用自包子查询 `(SELECT v2.x FROM jz_vendors v2 WHERE v2.id=p.vendor_id)`，两种情况下都成立。

## 规则 10 · 话务虚拟号（TP）只走服务端

绑定虚拟号走话务 `/bundling/alloc`，`app_id` / `app_key` **涉及号池成本，禁止明文写到端上或对公网静态资源**。端只消费服务端下发的虚拟号；签名与密钥仅服务端。规范见 `docs/tp-sign-and-call.md`，联调脚本 `scripts/tp_bundling_alloc.py`。本业务约定**不传 `port`**；线上 Base 为内网 `http://i.tp.lianjia.com`，测试 `http://tp-test.lianjia.com`，外网不可直连线上。

**新居住项目电话（保租房 + 卖旧买新）**：真实号存 `projects.contact_phone`（仅 DB + 管理 API，**不进 data.json**）；C 端户型详情拨号走 `GET /api/juzhu/projects/{id}/virtual-phone`，每次实时绑号、禁止缓存。密钥放 `juzhu/.env.local`（模板 `juzhu/.env.example`），`server.py` 启动时自动加载。

## 规则 11 · 静态服务不得暴露源码与密钥

`juzhu/server.py` 与线上 Node 入口 `app.js` 用仓库根做静态根时，**必须**拦截敏感路径：`.env*`、隐藏文件、`*.py`、`*.db`/`*.sqlite`、`*.sql`、`*.ini`、`config.ini`、`api_doc.md`、`package.json`、`README.md`、根目录 `app.js`/`scf_bootstrap`/`moma_*`、`.git` 等；`/juzhu/` 仅白名单 `app.js` / `cities.json` / `data.json` / `data-*.json`。禁止目录列表。生产设置 `JUZHU_ENV=production` 且显式配置 `JUZHU_API_KEY`、`JUZHU_ADMIN_PASSWORD`，禁止依赖代码内开发默认值。文档与页面不得写真实 vendor SECRET / DB 凭证 / Bearer token。MySQL 账号只进运行时环境变量 / 本地 `.env.*`（gitignore），**禁止**写进 `app.js` 源码默认值。

## 规则 12 · 只用 Node（禁新增 Python）+ MySQL；C 端保租房走 catalog

**一切新增与改动只用 Node，不用 Python**（2026-09-04 拍板）：运行时、脚本、工具、迁移、单测一律 Node（`app.js` / `*.cjs`，Node 22+），**不得新增任何 Python 代码，也不再维护/扩展存量 Python**。`juzhu/server.py` 等 Python 文件仅作历史参考保留；此前由 Python 承担的本地联调与商家 HMAC 回归，改由 Node 侧脚本 / 直调接口完成。SCF 入口 `scf_bootstrap` → `app.js`，`/api/juzhu/*` 直连 MySQL。

- **家政种子**：`jz_seed.cjs`（`ensureSchema` 时表空才写）
- **保租房种子**：`housing_seed.cjs` 从 `juzhu/data.json` / `data-nanjing.json` / `data-guiyang.json` 灌入（`cities` 为空时）
- **商家开放接口**：`POST /api/juzhu/callback` + `/api/juzhu/jiazheng/vendor/*`（家政）+ `/api/juzhu/housing/vendor/*`（房源，2026-09）（HMAC，`vendor_api.cjs`，对齐 `api_doc.md`；文档页 `screens/property-intake-api.html` 含在线调试台，回归 `node scripts/housing_vendor_hmac_regression.cjs`）。2026-09-10 增补：`regions/list`（城市/行政区枚举，限商家开放城市）、`photos/add`（图集，上架须 ≥7 张）、`projects/rating/submit|status`（评级提审/审核状态，rating_status=passed 是上架闸；维度口径单一数据源 `rating_config.cjs`）。
- **文档中心**：`screens/open-platform.html`（开放平台门户：接口文档 + 运营手册 + FAQ 汇总，nav 在 portal 系列「开放平台」组）；FAQ 在 `screens/open-faq.html`。手册只保留中文名版（`本地生活运营服务商操作手册.html` / `平台运营方操作手册.html`），英文别名副本已删。**不要链接 `api_doc.md` 等被静态服务拦截的文件**，对外一律引 HTML 文档页。
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
- 频道内视图区分：rental 频道内以 tag「旅居」区分两个 C 端视图——lvju-app-lvju 只出带「旅居」tag（山舍等旅居托管），lvju-app-changzu 排除「旅居」tag（保租房/长租公寓）。前端过滤（lvju-catalog requiredTag / 页面内 filter），不加服务端参数。
- 演示数据：`node scripts/demo-listings.cjs seed|clean`（tag「演示」一键清理，禁止用真实商家名）；**演示项目/户型使用固定 id 段 9001-9006 / 9101-9109**，reseed 后直链不失效。
- 旅居视图补充房源：`node scripts/lvju-stay-seed.cjs seed|clean`（山舍旅居托管 vendor，rental + 「旅居」tag + `online_booking`，与 #93/#94 同口径；幂等按 slug 判重，clean 只删脚本内 slug 清单，#93/#94 不动）。
- 验收实例端口：`juzhu/.env.local` 的 `JUZHU_VERIFY_PORT`（38766），不与主服务 8766 抢端口。

## 规则 16 · 房态日历 / 多间库存 / 保险标识 / 最短连住（旅居短住口径）

**逐晚库存与入住规则的单一数据源在服务端（`stay_config.cjs` + `app.js`），页面不得各自硬编码口径。**（2026-09-05 拍板；2026-09-10 多间库存修订，设计稿 `docs/stay-multi-qty-design.md`）

- **房态**：`stay_calendar` 表只存差异行（**stored `status` 只写 `open`/`blocked` 商家闸门**；`price_night` 覆价、`qty` 放出间数覆盖、`booked_qty` 已订间数计数），**无行 = 默认可订（放出 = `units.total_qty`）**；`unit_id=0` 表示项目级（整栋/不限房型，**容量恒 1**，不收 `qty`）。**`booked` 是 `remaining<=0` 的派生态，只在接口出参出现、不落库**（`buildStayMonth` 输出 `qty/booked_qty/remaining`）。`uk_sc(project_id,unit_id,stay_date)` 唯一键不动——一行表达一个 unit-night 的计数。
  - C 端公开读：`GET /api/juzhu/projects/:id/stay-calendar?month=&unit_id=`（含夜价/三态/间数/最短连住/保险）
  - 商家读写（会话态）：`GET|POST /api/juzhu/vendor/stay-calendar`；商家读写（HMAC 开放态）：`POST /api/juzhu/housing/vendor/stay-calendar`（owner 校验）
- **多间库存（2026-09-10）**：unit = 同规格房型 × N 间（`units.total_qty` 1-999，**缺省 1 = 存量单间行为逐字节不变**，写入口 clamp 并校验「不得低于未来晚已订间数」）。口径单一数据源 `stay_config.cjs`（`totalQtyOf / effectiveQtyOf / remainingOf`）。下单带 `rooms`（缺省 1，整栋单强制 1，`booking_orders.rooms` 落库，金额 = 单间逐晚合计 × rooms）；占用 = 事务内 `INSERT IGNORE` 补缺行 + `booked_qty=booked_qty+rooms` 条件递增（**不翻 status、不碰 price_night/qty/qty_base**；`booking_id` 仅 `COALESCE` 首写，任何占用判定不得依赖它）；释放 = `releaseStayQty()` 按订单区间对称递减 + 纯占用行删除（**商家差异行 price_night/qty/blocked 原样保留**——取代旧「DELETE WHERE booking_id」连带清夜价的副作用）。商家设 `qty` 不得低于该晚 `booked_qty`；已订晚不可关房。过期单清理按 `booking_orders.payment_expires_at` 自身列判，不 join stay_calendar。
- **放出量两种口径（2026-09 方案 B，`stay_calendar.qty_base`）**：`qty_base IS NULL` = 旧「放出总量」口径，`remaining = max(0, 放出 − 已订)`（存量逐字节不变）；`qty_base` 非 NULL = **净可售口径**，商家推 `available_qty`（HMAC `stay-calendar/set` / B 端同名字段）时服务端记下**推送时点的已订数**作基线，`remaining = clamp(放出 − (已订 − 基线), 0, total_qty − 已订)`——平台之后的占用才扣、取消自动加回、**物理余量封顶防超售**。`qty` 与 `available_qty` 同传 400；写 `qty` 把基线清空；`releaseStayQty` 删纯占用行要求 `qty_base IS NULL`。**凡是读 `stay_calendar` 算 remaining 的 SQL 都必须带出 `qty_base`**（漏了会静默按旧口径算，出过这个 bug）。出参：日历 `days[].available_qty` 回显净可售（null = 旧口径），`set` 响应回 `days[]` 供推完即对账。
- **`stay-calendar/set` 双形态（2026-09-22 商家诉求）**：`status` **可选**——缺省 = 保持对应间夜现状（blocked 晚保持关房），只更新传入的 price_night/qty/available_qty，无差异行的晚按默认 open 建行；`status: open` + 全空字段 = 显式恢复默认（旧行为）；status 缺省且无任何字段 → 400。`dates` 支持**对象数组** `[{stay_date, status?, price_night?, qty?, available_qty?}]` 逐晚独立值（平铺数组 + 顶层字段形态向后兼容）。商家统一用 `available_qty` 管房态：`available_qty: 0 + status: open` = 该晚售罄（remaining 派生 0 → booked 态），不必切 blocked。
- **房间档案（`units.ext.room_profile`，单一数据源 `room_profile.cjs`）**：入驻「房源字段」表（Excel）统一塞进户型 ext，避免按业态加列——21 个字段：文本 13（`introduction/shared_spaces/child_age_policy/extra_guest_policy/beds/bath_hot_water/kitchen/climate/network/cleaning_frequency/linen_frequency/feature_image/feature_image_caption`，各带长度上限）、枚举 3（`area_type` 面积口径 / `window_type` 窗户类型 / `smoking` 吸烟属性）、数值 4（`window_count/max_guests/max_adults/max_children`）、布尔 1（`window_openable`）。**字段清单/长度/中文名只在 `room_profile.cjs`**，页面与其它模块不得再造一份。写入口：后台 `PUT /admin/units/:id`（`normalizeUnitExtInput`）与商家开放接口 `units/create|update` 的 `room_profile` 键，**合并语义**（只覆盖传入的键、未传保持原值、`null` 清除整块、未知键静默丢弃），非法取值 400 且 message 带字段中文名与可选值。出参在 `units[]` 里给**已解析的 `room_profile` 对象**（`vendor_api.unitOut()`），商家不必自己 parse `ext` 字符串；C 端详情页「房间档案」卡渲染时对文本一律 `esc()`/`textContent`（新增字段沿用这条，不要再拼 innerHTML）。
- **房源图集（2026-09 商家反馈点 4，单一数据源 `photo_config.cjs`）**：分类枚举（`bedroom/kitchen/bathroom/living/nearby/other`）与数量/大小/分辨率阈值只写这一份，页面与其它模块不得再造映射（出参用 `photoOut()` 补 `category_label`）。**全量覆盖 `photos/sync`**：按实体（`project` / `unit`）整体替换——匹配上的原地更新（匹配键 `external_id` 优先、URL 兜底，URL 带签名会变）、不在列表内的删行，事务内完成；`sort` 归一化 0..n-1，封面取 `is_cover` 中最靠前的、否则第一张，并同步 `cover_image`；超 100 张截取前 100 并回 `truncated`+`warnings`。`photos/add` 保留但改为**幂等**（同 URL / 同 `external_id` 原地更新，修掉「反复推堆重复图」）。**上架抽检**：`projects/status online` 时真拉取封面+靠前 2 张核对（`photo_config.probeImage`）——**确定性不合格**（>10MB / <800×600 / 非图）拒绝上架，**仅网络不可达**只回 warning 放行；判定逻辑是纯函数 `judgeProbe()`，网络层是薄壳。探测带 SSRF 防护（`ipIsBlocked()` 在 DNS `lookup` 回调里拦内网/环回/云元数据地址，限时、限字节、限跳转），**新增出网能力必须走这一层**。
- **默认关房（2026-09，opt-in）**：`units.ext.default_closed`（房源级 `projects.ext.default_closed` 兜底，`stay_config.defaultClosedOf`）为 true 时，**只有商家显式推送过放出量的晚才可订**（判定用「该晚有没有 `qty`」，不用 `source`——下单占用会把 source 改写成 booking 但不清 qty）；没推过的晚、只设过价的晚一律 `remaining=0`。缺省关闭 = 存量行为不变；**只作用于指定户型的预订，整栋单语义不变**。多渠道商家配合 `available_qty` 按未来 12 个月滚动推送使用。
- **最短连住（2026-09 下放户型）**：生效顺序 **`units.ext.min_stay_nights` > `projects.ext.min_stay_nights` > `STAY_MIN_NIGHTS_DEFAULT`**（rental=15 晚 / minsu=15 晚；rental 可配 1-365，minsu 可配 15-365，不得降到 15 晚以下）。房源级降级为「房源默认值」，**整栋单（不指定户型）按排序最前的户型**执行——与取消政策同一套回退（`app.js fallbackUnitRowFor()`，两条规则同源）。**三处同口径校验**：C 端日历选段、下单页、`POST /api/juzhu/booking` 服务端兜底；改口径只改服务端常量或 ext，不要在前端另设数字。户型/房态日历出参随行下发**生效值** `min_stay_nights`，前端只读它。
- **默认夜价与展示价（2026-09 价格下放户型）**：默认夜价（单间口径）= **户型 `units.ext.price_night` > `rent_monthly/30` > `price_from/30`**（minsu 最后一档为 `price_from` 原值），两频道一致；日历逐晚覆盖价仍高于本层。`stay_config.unitNightPrice()` 是唯一实现，随 unit 下发只读 `default_night_price`，**页面不得再用 `/30` 自行折算**（此前 C 端详情页/下单页各抄了一份，已收口）。整栋单价格基准 = `wholeHousePriceUnit()`：有起价按起价（存量语义），起价缺失回落排序最前户型。**`price_from` 自 2026-09 起选填**，上架闸（`vendor_api.publishEligibility` / `app.js projectPublishEligibility` 两处同口径）改为**逐户型校验能算出默认夜价 > 0**，用 `price_from` 兜底的存量房源行为不变。
- **卡片展示价（2026-09，`stay_config.priceDisplayOf` 单一数据源）**：C 端卡片只读服务端下发的 `price_from_display` / `price_unit` / `price_note`（页面不得自行折算或拼「/月起」「/晚起」）。单位口径（A″）：**minsu 与带「旅居」tag 的 rental 按晚**（取**最低可售单夜价**：从今天起按自然月向后扫 `PRICE_DISPLAY_SCAN_MONTHS`=12 个月，取第一个有可售间夜的月份内的最低价；**无差异行 = 默认可订**，只扫 `status='open'` 的差异行会把绝大多数房源误判成「暂无可订」），**其余 rental 按月**（起价语义，缺省回落户型默认夜价 × 30）。全窗口无可售 → `price_note='暂无可订'`。批量求值走 `priceDisplayScan()`（一次查库，catalog 的 `lite=1` 首屏只补最小列）。
- **逐晚计价（2026-09-10，2026-09 修订）**：订单金额 = 逐晚「日历覆盖价（`stay_calendar.price_night`，户型级 > 项目级）→ 默认夜价」合计 **× 间数（rooms）**，单一数据源 `stay_config.cjs stayNightPrices()`（单间口径），与 C 端日历/下单页展示同口径；周末/节假日分档即按日期批量覆盖实现。**0 元预订单口径已收紧（2026-09）**：`price_total` 算不出正数 → 下单直接 400「该房源未配置价格，暂不可预订」（配合 price_from 选填，避免无价房源 0 元成单）。
- **房源交易能力（2026-09-16）**：`projects.ext.online_booking`（在线预订、商家确认后线下收款）与 `online_payment`（在线支付、支付后确认）按房源独立配置，不按 rental/minsu 分流；两项可同时开但至少一项为 true。`stay_config.cjs transactionCapabilitiesOf()` 是单一读口径，`applyTransactionCapabilities()` 是写入口校验，`stayConfigOf()` 下发两项并保留 `bookable` 兼容汇总位。两项都开时 C 端客户选择，`POST /api/juzhu/booking` 用 `transaction_mode=booking|payment` 指定（缺省优先 booking）；订单是否生成 `pay_status=unpaid` 与 30 分钟支付时限只取决于 transaction_mode。
- **保险标识**：`INSURANCE_TYPES`（`switch_rental` 换租保险 / `hotel_cancel` 酒店取消险 / `property` 财产保险）是唯一枚举，存 `projects.ext.insurance`（key 数组），商家经 `PUT /api/juzhu/vendor/projects/:id` 配置；catalog/项目详情按 `insurance_types` 下发（含 label/icon），C 端直接渲染，**不要再造一份中文名映射**。
- **免费取消政策（2026-09-09，房型维度）**：`units.ext.cancel_policy = {enabled, days_before, cutoff_time}`（免费取消窗口 = 入住日往前推 `days_before`（0-30，0=入住当天）天的 `cutoff_time` 时刻，缺省 `1 天 18:00`）。**缺省从严 = 未开通即不可取消不可退**（硬截止，无扣款分档）。口径单一数据源 `stay_config.cjs`（`cancelPolicyOf / cancelDeadlineOf / freeCancelOpenOf / cancelPolicyTextOf / orderCancelInfoOf`），政策中文文案服务端算好随接口下发（`cancel_policy_text`），**前端不得自行拼口径**。客户取消闸只在 `POST /api/juzhu/booking/cancel`（窗口外 400）；商家侧取消（B 端 `PUT /vendor/orders/:id`、HMAC `bookings/cancel`）**不受此闸约束**；整栋单（`unit_id` 为空）按项目首个房型（sort_order 最小）的政策回退执行，项目无房型才从严不可取消。配置写入口：B 端房态页「取消政策」卡（vendor `PUT /units/:id` 专用键，read-modify-write 保住 `price_night`）、admin `juzhu-admin-unit.html`（`PUT /admin/units/:id` ext 合并；同卡配 `total_qty` 走列）、HMAC `units/update`。`booking/my` / `booking/lookup` 每单随下发 `can_cancel / cancel_policy_text / cancel_deadline`，C 端取消按钮以 `can_cancel` 为准。回填 `node scripts/cancel-policy-init.cjs`（给已开通项目预配默认政策）。
- **回填工具**：`node scripts/stay-calendar-init.cjs`（保险缺配置按频道默认补齐 + 存量订单重建为占用计数，幂等可重跑）；多间迁移 `node scripts/stay-qty-init.cjs`（备份 `stay_calendar_bak_20260910`，旧整行 booked → `booked_qty=1 + status='open'`）。
- **回归**：`node scripts/stay_qty_regression.cjs [base]`（订满/回补/qty 覆盖/整栋互斥/单间兼容）+ `housing_vendor_hmac_regression.cjs`（§5.7 多间段）。
- 入口页：B 端 `screens/b-stay-calendar.html`（房态月历 + 批量关房/夜价/放出间数 + 连住与保险配置 + 房型级取消政策），C 端 `lvju-app-lvju.html`（连续时间段选择）→ `lvju-app-detail.html`（房态日历，`remaining≤2` 显「仅剩 X 间」）→ `lvju-app-booking.html`（间数选择）。

## 规则 17 · 周边玩法维度（`spots` / `project_spots`）

**C 端房源详情页「周边玩法」杂志区块与笔记详情页的数据只来自 `spots`（维度字典）+ `project_spots`（项目绑定），页面不得硬编码 mock。**（2026-09-06 拍板）

- **维度**：`type ∈ scenic(景区) / biz(商圈) / food(美食) / cafe(咖啡)`（枚举与中文名收口在 `app.js` 的 `SPOT_TYPES` / `SPOT_TYPE_LABELS`，`type_label` 随接口下发，前端不得另造映射）；`city_id NULL = 全省通用`（跨市目的地如黄果树/西江，任何项目可绑）；`slug` 全局唯一（`uk_spot_slug`，小写字母/数字/连字符）；`summary` 为导语；`body` 为小红书式笔记正文（空行分段，空则前台回落 summary）；`photos` 为 JSON 图集（与封面合成轮播）；`address / duration / ticket` 为攻略信息（笔记页「去之前」卡，缺省不占行）；`cover_image` 填 `assets/` 下 jpg/png（≥60KB，缩略图管线自动出 .t240/.t640）。
- **后台配置**：`juzhu-admin.html` 独立「周边」tab（`renderSpots`，2026-09-06 从字典 tab 迁出；导航为 项目/周边/字典/设置/账号/审计）配维度（行内「笔记」按钮展开正文/图集/攻略编辑，随主行一起保存）；项目编辑器（「项目」tab）「周边玩法」卡绑定（草稿存 `state.spotBindings`，单次 `PUT /admin/projects/:id/spots` 整体替换，≤12 条）。写路由走 **`house.write`**（dict.write 未授予任何角色，勿用）；被绑定的地点不可删。
- **C 端渲染**：公开 `GET /api/juzhu/projects/:id` 随行下发 `spots`（enabled=1，SQL 已按 景区→商圈→美食→咖啡+sort 排定）；第 1 条 = 封面故事大卡，其余按维度分组编辑行；**绑定空 → 整块隐藏**，不得回落静态演示内容。深链顺序：`spot.link`（admin 覆写逃生口，缺省不填）→ **笔记详情页 `lvju-app-spot-post.html?id=`**（小红书式：图集轮播 + 编辑部行 + 正文 + #标签 + 攻略卡 + 相关笔记，数据来自公开 `GET /api/juzhu/spots/:id`，related 同类优先补齐同城市/通用）；`lvju-app-spot-detail.html` 仅保留旧 5 词条静态页。
- **样例数据**：`node scripts/spots-seed.cjs seed|clean`（贵阳 25 地点：景区/商圈/美食/咖啡，**旅居 8 项目全绑定** #93/#94/9036-9041 各一组「本地景区 + 本地商圈/美食 + 远途一日」，每地点带正文/图集/攻略；clean 只删脚本内 slug 清单与其绑定行）。

## 规则 18 · 权限点注册表单一数据源（`perm_registry.cjs`）+ 账号中心

**admin 域接口的权限与审计只走 `perm_registry.cjs`（权限点注册表），不得在路由里手写权限闸。**（2026-09-06 拍板）

- **PERMS**（权限点目录：code/中文名/domain/建议角色）与 **ROUTES**（admin 域路由 → 权限点 + 细粒度审计 action 映射）都在注册表里。内置角色的 `permissions` 由注册表折叠（`auth_center.cjs` 只留 code/name 权威清单），**改角色权限面先改注册表**，再跑 `node scripts/perm_registry_snapshot.cjs`（与基线快照逐条 diff，防漂移）+ `node scripts/perm_roles_resync.cjs`（写回库内 builtin=1 行；builtin=0 自定义角色永不触碰）。
- **新增 admin 路由必须同步在 ROUTES 登记**（method/re/perm/act/res/idGroup），正则锚定 `^...$`；漏登记的写路由会走「账号主体 + admin.write」兜底闸，漏登记的 GET 不做权限点校验。自定义角色（B5 roles CRUD）的 permissions 只能是注册表已注册点子集，`'*'` 仅限内置 platform_admin。
- **数据权限（scope）**：五档 `self < vendor < org < city < all`，存 `account_roles.scope`（JSON）。**city 档 `city_ids` 是显式授权**（账号中心「数据权限」抽屉配置），`orgs.city_ids` 只做 UI「按机构带出」初值，禁止在服务端做隐式推导（机构经营城市变动不得无审计地改变授权面）。全局读接口（org/report、admin/projects、staff）按 `scopeOf()/scopeCitySql()` 行级过滤；scope/角色变更即吊销该账号全部会话。
- **过渡开关 `settings.perm_strict`**：`0`（缺省）时持旧 `admin.write` 的账号仍可过任意权限点闸（不断崖）；`1` 严格按注册表收口（platform_op 不再有管理写权限）。**新写路由不要依赖该别名**。
- **登录防爆破**：`login_throttle` 表两级节流（ident 连错 5 次锁 30 分钟、IP 30 次/10min，env `AUTH_LOCK_*` 可调）；账号不存在也计失败并落审计（`audit_log.result` 列区分 ok/fail）。admin 登录必须显式 login_name（「只传 password 默认唯一管理员」已移除）。密码哈希 `scrypt$salt$hash`，存量 sha256 行登录时懒升级。
- **账号中心页面**：`screens/account-center.html`（P 端，功能权限+数据权限+账号+审计+IdP 六 tab）是账号/权限唯一管理入口；`juzhu-admin.html` 账号/审计 tab 只留迁移卡。`_nav.js` item 支持可选 `perms: [...]`（任一命中即显示；**未登录/演示态一律全显**，保静态演示页基线观感）；`mount()` 幂等可重入，暴露 `BZF_NAV.refresh/hydrate`。
- **回归**：`scripts/perm_gate_regression.cjs`（权限矩阵）/ `auth_security_regression.cjs`（防爆破+scrypt+TTL）/ `scope_regression.cjs`（行级过滤）/ `iam_api_regression.cjs`（账号中心 API）四条全绿才算过。
- **商家登录并入账号中心（2026-09-09）**：商家凭据 = `accounts` 行（`principal_type='user'` + `vendor_id` 绑定 + `vendor_owner` 角色，scope 自动 `{level:'vendor'}`），`POST /vendor/login` 只是别名（返回体形状不变，B 端页面零改动）：有账号走 `loginWithPassword` 统一链，无账号且 `jz_vendors` bcrypt 命中则懒建档（密码重哈希 scrypt）。`verifyPassword` 支持 bcrypt 遗留格式（`$2a$/$2b$/$2y$`，登录一次懒升级 scrypt）。批量预迁移 `node scripts/vendor_accounts_migrate.cjs [--dry]`；旧 HMAC 自证 token（`verifyVendorLoginToken`）仅宽限至自然过期、不再签发；`jz_vendors.password_hash` 冻结（仅兜底路径读一次），改密/停用商家账号在 IAM 走 `updateAccount`（自动吊销会话）。回归 `node scripts/vendor_login_migration_regression.cjs`。B 端页面（`b-listing-mgmt` / `b-go-live-check`）登录后 token 统一落 `BZF_SESSION_TOKEN`，**`JUZHU_VENDOR_TOKEN` 旧键只清不写**（2026-09-22 清理；`api-doc.html` 同步删除历史 `dev-juzhu-key` 示例，商户调试台 `BZF_HOUSING_PLAY` 记住的凭据降级为 sessionStorage 会话级）。

## 规则 19 · 内容域统筹（专题 / 路线 / 周边玩法，一个后台面）

**「住」的房源集合与「玩」的内容编排同属内容域，后台统一在 `juzhu-admin.html`「内容」tab（原「周边」tab 升级），C 端各页只读接口，不得硬编码。**（2026-09-09 拍板）

- **三层模型**：内容原子 = `spots`（地点 + 笔记，规则 17 单一数据源）→ 内容编排 = `routes`（spots 的有序串联，`stops` JSON `[{spot_id, note}]`，**不复制正文**）→ 房源集合 = `topic_*`（settings KV 筛选条件，规则 15）。`routes.city_id NULL = 全省通用`，与 spots 同口径。
- **后台**：内容 tab 二级分区（专题/路线/周边 chips 带计数，只渲染当前分区，hash 记忆）= 房源专题（KV CRUD + 在架城市切换 + 行内编辑 + 「文案」展开行简介/封面）+ 旅游路线（主从式：列表 + 全宽编辑面板，站点编辑器 ≤12 站排序加行程提示）+ 周边玩法（表格只做管理视图：快捷排序/上架开关；编辑与新建进单页面板，封面/图集实时预览 + 笔记正文；面板均带脏态守卫）。admin 接口：`GET/POST/PUT/DELETE /api/juzhu/admin/routes*`、`GET /api/juzhu/admin/topics`、`PUT|DELETE /api/juzhu/admin/topics/:slug`，全部登记 `perm_registry.ROUTES`（写 = `house.write`，读 = `admin.read`）。**`topic_bzf` 是保租房专区既有契约：可编辑/下架，禁止删除（服务端硬闸）**。专题下架（`enabled:false`）后 `catalog?topic=` 立即 404（服务端同响应不泄露存在性 + `catalogMemoInvalidateTopics()` 清缓存）。
- **公开接口（白名单 GET）**：`/api/juzhu/routes?city=`、`/api/juzhu/routes/:id`（站点水合附 spot 摘要卡）、`/api/juzhu/spots?city=&type=`（列表，此前只有 :id 详情）、`/api/juzhu/topics`（enabled 专题清单，含 label/desc/cover_image/tags/channel）。路线封面缺省回落首个有点位的封面，前端不必再兜底造图。**C 端专题入口必须读 `/api/juzhu/topics` 动态渲染，禁止硬编码专题清单**（后台建/删专题即时生效）；专题页存在性以服务端 KV 为准，本地 META 只做文案兜底。
- **C 端接库页**：`lvju-app-routes.html`（路线卡 + 时间线，站点深链 `lvju-app-spot-post.html?id=`）、`lvju-app-spots.html`（玩法列表，类型筛选 chip 用接口下发的 `type_label`，**前端不得另造类型映射**）、`lvju-app-topic.html`（专题列表 + 底部「去哪玩」挂同城 routes/scenic spots）。
- **种子**：`node scripts/find-topic-seed.cjs seed|clean`（topic KV）、`node scripts/routes-seed.cjs seed|clean`（3 条贵阳路线，站点复用 spots-seed 的 slug；幂等，clean 只删本脚本清单）。

## 规则 20 · 商家佣金费率（按业务线分档，`jz_vendors` 两列 + 下单快照）

**抽佣是平台收入条款，配置主体是平台（`vendor.fund.write`），商家只读；口径单一数据源 `vendor_rate.cjs`（app.js 与 vendor_api.cjs 共用，纯函数不连库）。（2026-09-09 拍板）**

- **两层费率模型（按业务线分档）**：`jz_vendors.commission_housing`（房源预订 booking_orders）/ `commission_jiazheng`（家政 jz_orders，本期仅配置不消费——家政服务者个人分账走 L0-L7 矩阵另一套体系）。**生效费率 = 商家差异化列 → settings KV 全局基准（`commission_housing_default` / `commission_jiazheng_default`，种子 10.00，`PUT /admin/settings` 可改）→ 内置 10 兜底**；0-100 两位小数，NULL = 按基准。
- **下单锁定快照（调价不追溯）**：`booking_orders.commission_rate` / `commission_fee` 在 `POST /api/juzhu/booking` 时按 owner 商家 housing 档生效费率写入，平台自营（无商家行）按基准；结算对账一律读快照，不要按结算时费率重算。
- **写入口与审计**：`PUT /api/juzhu/admin/vendors/:id/commission`（ROUTES 挂 `vendor.fund.write`，act `vendor.commission.update`）+ 处理器内 before/after 审计（role.update 金标准）；入驻审批 `approve` 按 `rate_base−rate_discount` 折算、按 phone **单命中** active 商家回填对应档位（多命中/未命中不阻塞）。管理台：`screens/p-vendor-rates.html`（P 端「商家费率」，nav p 系列 B 组，`_nav.js` 已登记）；全局基准走既有 `PUT /admin/settings`（`settings.write`）。
- **商家可见**：`GET /api/juzhu/vendor/me` 随发两档 `commission.{housing,jiazheng}.{rate,is_default}`；B 端 `b-listing-mgmt.html` 徽标展示房源档佣金；HMAC `bookings/list`·`bookings/detail` 与 B 端 `/vendor/booking/orders` 每单随发快照字段。**费率不经商家 HMAC 写通道**（`vendor_config.cjs` 进程缓存不受影响）。
- **商家资质复审（2026-09-22 收口，252 教训）**：`jz_vendors.review_status` 列默认 **`'pending'`**（原 `'approved'`）——**脚本直插商家不再「生而 approved」**，会进 `GET /admin/vendors` 待审视野；repo 内种子/流程建档必须**显式写 `'approved'`**（demo-listings / jz_seed / migrate-housing-channels / app.js 内置生活商家已补），否则演示房源会被 C 端过滤器（`vendor_review_status!=='approved'` 隐藏项目）静默藏掉。复审走 `PUT /admin/vendors/:id/review`（新权限点 `vendor.review`，已登记 ROUTES + 处理器 before/after 审计 `vendor.review.update`，reviewing/approved/rejected 联动 status active/suspended）。**受理台 ↔ 商家互通**：`vendor_onboarding.approved_vendor_id`——approve 按 phone 单命中时记录，受理台列表/详情回显 `approved_vendor_name`，`GET /admin/vendors` 每行随发 `onboarding_apply_no` 反查来源申请单。
- **perm 基线**：`vendor.fund.write` / `vendor.review`（domain vendor，roles platform_op/operator_admin）已入 `scripts/__fixtures__/perm_roles_baseline.json`；consult-mode 重复死规则仍为已知债，动权限面前先跑 `node scripts/perm_registry_snapshot.cjs` 对照。

## 规则 21 · 权益结算闭环单一数据源（`commerce/settlement.cjs`）

**券包/会员权益的结算、退款、冲回、对账只走 `commerce/settlement.cjs`（迁移 `004_settlement`），页面与其它模块不得另建资金表或绕过批次直接付款。**（2026-09-20 拍板）

- **逐券计算锁定在核销时刻**：`commerce_redemptions` 的 supplier/beike/channel/retained 由订单锁定的规则快照算出，账务（`commerce_ledger_entries` 借贷分组账）与结算明细（`commerce_settlement_items.rule_ref`）都引用它；改规则版本不追溯，任何"重算"都应能在验收里复算一致（不变量 I5）。
- **防重复三道闸**：① `uk_settle_once(redemption_id,line_kind)` 明细跨批次唯一；② `uk_batch_period` 同收款方同账期一批次；③ 指令 `request_no` 唯一且**重试沿用原号**（不许换号重付）。生成账单对已入账明细是幂等空操作，不是错误。
- **申请与审批分离是服务端闸**：批次复核、误核销撤销复核、差异关闭都校验提交人≠复核人；权限点 `commerce.fund.read/write/review` 只在 `perm_registry.ROUTES` 登记，前端按钮隐藏不构成校验。
- **UNKNOWN 只查原指令**：结果未知的指令禁止重试、禁止换指令；失败指令可受控重试 ≤3 次（`applyInstrument` 的 `controlled` 位只给重试链路，回执链路 paid↔failed 互斥 409）。回执按 `uk_receipt(request_no,digest)` 幂等去重。
- **沙箱机构是镜像不是资金**：`commerce_provider_requests` 即未来持牌机构适配器的契约面（`sandboxSubmit/sandboxQuery/sandboxSimulate` 三个薄壳）；对外文案必须写明"不代表真实资金"，商户页与 KPI 已内置该披露，改版不得删。
- **演示卡券不进资金域**：一切结算/退款/对账查询都带 `NOT (JSON_EXTRACT(snapshot,'$.is_demo') <=> TRUE)` 过滤；新增结算相关查询漏掉这个条件会把演示单卷进账差。
- **推广员端（juzhu-promoter.html + `_commerce-customer.js` promoter 分支）**：`/promotion` KPI 与 `promoterSettlement` 必须排除演示核销（演示核销永不进批次，漏过滤会让「待入账单核销」永久虚高）；逐券明细/归因订单/代发到账走 `GET /promotion/records`（本人 scope 只读，单查 ≤50 条）。选品目录走 `GET /promotion/products`（公开 catalog 同形状 + `commission_minor`/`commission_bps` 预估佣金，算法=核销入账同式 `channel=floor(floor(alloc×beike_bps/1e4)×channel_bps/1e4)`，演示商品恒 0 不进资金域；随行下发本人逐商品 `clicks/orders/demo_orders/redemptions/earned_minor`）。**点击埋点在公开 `GET /referral`**（分享链接落地即写 `commerce_events` `referral.click`，转化率=归因/点击的分母来源，挂了 try/catch 不阻塞落地）。分享资格闸：settings KV `promoter_gate`（缺省 `'0'`=演示期开放；`'1'`=仅 `promoter` 角色或 `*` 权限可 `POST /shares`），资格状态随 `/promotion` 下发（`promoter_gate`/`share_qualified`），页面据此渲染资格横幅。预览演示数据：`node scripts/commerce/promoter-demo-seed.cjs seed|clean|status`（依赖 `settlement-demo-seed` 的演示账号 `demo_promoter`/`Demo#2026`；只造点击事件与 is_demo 归因/核销，永不写资金域）。
- **误核销撤销保留历史**：`commerce_redemptions.coupon_id` 已从 UNIQUE 降级为普通索引（撤销后同券可再核销），防重靠核销事务内"券行锁 + 查 confirmed"——不要再把唯一索引加回去；撤销已结算明细生成 `commerce_recovery_cases`，下期生成商户账单时可 `offset_recovery` 抵扣，全部动作过账。
- **金额守恒不变量 I1–I7**（`verifyInvariants`）是验收底线：订单实付=已核销+已退款+未核销池；本地已付逐笔有机构镜像。改动结算链路后必须跑 `node scripts/commerce/settlement-test.cjs --browser`（11 场景 + 浏览器 6 检查）。

## 规则 22 · 券核销渠道（线上/线下）与酒店通兑口径

**本地生活券的核销渠道、通兑档位、名单抽样只走 `commerce/configuration.cjs` + `commerce/hotel-exchange-demo.cjs`，页面与域逻辑不得另造一份口径。**（2026-09-20 拍板）

- **所有类目的券创建时区分线上/线下**：`sku.payload.redeem_channel`（`offline` 缺省 / `online`）。线下券必须绑具体门店（商家可在商户中心「门店管理」自建，门店类型 `service_channel: store|online`）；线上券绑本商户「线上服务台」虚拟门店（承载 NOT NULL store_id，无产能），**免预约直核**。校验单一入口在 `configuration.cjs validate()` + `service.references()`（线下禁绑线上服务台、线上必须绑、枚举 `enum` 字段类型也定义在这里）。
- **酒店通兑 = 线下 + `exchange_tier`（t80…t200）**：档位枚举/中文名/展示价单一数据源 `EXCHANGE_TIERS`；同档任选名单酒店、**预约选店制**——预约必传档内 `store_id`（`kind:'hotel'` + 同档校验，跨档/锚点 422 `tier_mismatch`），`appointments.store_id`=所选酒店；核销门店与授权按实际履约门店商户（券发在运营商户名下、核销人是酒店商户员工），`redemptions.merchant_id` 归集所选酒店商户 → 结算账单按事业群自然分商户。改期/取消按 `appointment.store_id` 对称释放产能。
- **锚点虚拟门店**：每档 1 个（capacity 0，不可直接预约），承载发券时 `commerce_coupons.store_id NOT NULL`；线上服务台同理。**凡是"无固定物理门店"的券形态，优先用虚拟门店承载，不要动 commerce 表结构**（迁移 checksum 锁死，新增列须走新版本号并复制整份 DDL）。
- **isDemo 泛化约定**：`guiyang-demo.cjs isDemo()` 只看 `initialization.mode==='demo'`，批次名仅用于 seed 收据归属；新增演示批次（如 `hotel-exchange-demo-v1`）必须 payload 带 `initialization:{batch,mode:'demo'}`，否则会误入资金域。资金隔离最终只认 `snapshot.is_demo`（demo-order 打标）。
- **酒店名单**：`commerce/hotel-roster.json`（1809 家、6 档 80/100/120/160/180/200，`hotel-roster-build.cjs` 从 Excel 转换，可重跑）；演示抽样 `sampleHotels(perTier=8)` 是确定性算法（品牌分层 + hotel_code 字典序轮转），改抽样规则必须保持可复算。门店 city 挂演示城市、真实区域存 payload（名单为全国门店，通兑跨城属预期）。
- **公开名录**：`GET /api/commerce/v1/hotels`（session 前只读，与 /catalog 同形态，无需 perm 登记）只输出公开字段；C 端名录页 `juzhu-hotels.html`（generate-pages 生成，静态白名单已含）。
- **回归**：`node scripts/commerce/m1a-test.cjs --hotel-exchange`（档内任选/跨档拒绝/线上免预约/核销归集/资金零分录）；线上 `node scripts/commerce/live-hotel-check.cjs`（19 项，可重复跑：预约后即取消）。设计文档 `docs/prd/DESIGN-本地生活酒店通兑与三品类券.md`，验收 `docs/verification/hotel-exchange-closed-loop/`。

## 规则 23 · sytest 静态资源缓存约定（2026-09-22 拍板）

sytest.meizu.life 的 nginx vhost（`/etc/nginx/conf.d/sytest.meizu.life.conf`，配置在仓库外不入 git）已开 **gzip** + **css/js 强缓存**（`public, max-age=31536000, immutable`）；HTML 保持 `no-cache`，`/juzhu/app.js` 白名单块先行仍 `no-cache`。**因此：改动任何 `.js` / `.css` 后，必须同步 +1 所有引用该文件的 `?v=N`**（存量约定，见规则 9；`_nav.js` 等未带 `?v=` 的共享脚本被改后，回访用户一年内拿旧缓存——改共享脚本时顺手在主要引用页补 `?v=`）。「改了没生效」先想到缓存，再查代码。备份：`sytest.meizu.life.conf.bak.20260922-perf`。

## 规则 24 · 首页频道 tab 按城市隐藏（`cities.hidden_home_tabs`）

C 端首页（`index.html`）的频道 tab（保租房/长租/卖旧买新/生活服务/民宿/新房/二手）按城市配置显隐，单一数据源 = `cities.hidden_home_tabs`（JSON 数组，元素限 `housing_cities.cjs` 的 `HOME_TAB_IDS` 白名单 7 个 id，杜绝把后台/专题等非首页频道误写进配置）。（2026-09-23 拍板，首例：沈阳隐藏 长租/民宿/新房/二手）

- **服务端是过滤主体**：`GET /api/juzhu/catalog` 出参 `channels` 已按当前城市过滤完（改配置走 `catalogMemoInvalidateAll()` 立即生效，不走 15s TTL）；`juzhu/app.js` 的 `enabledChannels()` 只按 `cache.hidden_home_tabs` 做兜底再过滤。页面只准消费 `JUZHU.enabledChannels()`，不得各造 tab 清单。
- **写入口**：后台 `juzhu-admin.html`「字典」tab 城市行「首页隐藏 Tab」勾选 → `PUT /admin/cities/:id`（权限点 `dict.write`；服务端 `validateCityWrite` 校验白名单）。直改 DB 不走写通道时注意 catalog 有 15s 进程内 memo。
- **隐藏 ≠ 下架**：只裁首页入口，`?channel=` 直链与数据接口照常；隐藏 tab 深链（如沈阳 `?tab=resale`）由 `paintTabs()` 回落到该城市第一个可见 tab，避免空 pane。
