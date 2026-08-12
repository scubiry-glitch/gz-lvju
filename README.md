# 居住服务平台原型 · 静态 HTML + SQLite 数据层

> 起于「保租房四方共建」，已生长为覆盖 **保租房 / 新居住 / 旅居 / 家政** 四条业务线的可点击静态原型，
> 叠加 **共享导航总线 + 工单总线 + 地域配置 + 家政 REST/SQLite 数据层**，用于需求评审、政府方演示与研发对齐。

**保租房四方共建框架（仍然成立）**：住建厅 × 江苏银行 × 国企持有方（+ 白名单运营商：自如/龙湖/华润/招商/贝壳省心租 等同业）× 贝壳租房
**主体名词单一数据源**：所有省/厅/业务词/机构名走 `screens/_region.js`，页面正文以「江苏基准字面量」书写，运行时按预设 relabel（详见「地域切换」）。

> 推广性指标（46 项目 / 全省 / 30 万 MAU 等）一律为「试点验证后启动」的上限假设，非时间承诺（见 `CLAUDE.md` 规则 5）。

---

## 📊 规模总览（对仓库实测）

| 维度 | 数量 | 说明 |
|---|---:|---|
| HTML 页面总计 | **~176** | 根目录 67 + `screens/` 109 |
| 保租房四端 + P 中台（`screens/*.html`） | 109 | 按首字母前缀分系列，见下表 |
| 新居住 juzhu（`juzhu-*.html`） | 12 | 保租房目录 + 卖旧买新 + 家政 Tab + 编辑后台 |
| 旅居 App（`lvju-app-*.html`） | 33 | C 端旅居小程序型页面群 |
| 旅居其它（`lvju-*.html`，政务/总览/评级） | 6 | 政府大屏 / 总览 / 评级标准 |
| 家政落地页（`jiazheng-*.html`） | 9 | 4 品类落地 + 列表 / 详情 / 下单 / 支付 / 商家 |
| 保租房三档入口（`baozufang-*.html`） | 4 | 三档总入口 + V1/V2/V3 总览 |
| 其它根入口 | 4 | `index.html`（新居住首页）`index2.html`（原型故事板）`overview.html` `beike-app-home.html` |

`screens/` 按前缀分系列（实测）：**P 中台 34 · G 住建厅 14 · S 服务者 9 · B 运营 7 · F 金融 6 · D 蓝图/标准 6 · C 租客 5 · V 人力 3 · T 培训 3 · M 物资 3**，另有若干无前缀 C 端页（`home/detail/policy/profile/apply/...`）。

---

## 🧭 四条业务线 · 入口点

| 业务线 | 主入口 | 说明 | 后端依赖 |
|---|---|---|:-:|
| **保租房 四方共建** | [`baozufang-channel-overview.html`](baozufang-channel-overview.html) | V1/V2/V3 三档版本选择器 + 能力对照 | 否 |
| ├ C 端体验 | [`index2.html`](index2.html) · [`screens/home.html`](screens/home.html) | 租客原型故事板 / 频道页 | 否 |
| ├ G 住建厅监管 | [`screens/gov-admin.html`](screens/gov-admin.html) | 监管总览（白名单/合规/大屏入口） | 否 |
| ├ B 运营机构 | [`screens/b-operator-console.html`](screens/b-operator-console.html) | 国企持有方资管视角 + 运营商工作台 | 否 |
| ├ F 江苏银行 | [`screens/f-escrow.html`](screens/f-escrow.html) | 监管账户对账 / 结算 / 公积金 | 否 |
| └ P 服务认证中台 | [`screens/p-console.html`](screens/p-console.html) | 5 类机构（S/B/V/M/T）认证底座 | 部分* |
| **新居住 juzhu** | [`index.html`](index.html) | 频道首页（方案 C），含家政 Tab | 是（数据/家政） |
| ├ 内容编辑后台 | [`juzhu-admin.html`](juzhu-admin.html) | 项目/房源/好房子评级录入 | 是 |
| **旅居 App** | [`lvju-app-home.html`](lvju-app-home.html) | 旅居 C 端小程序型首页（33 页群） | 否 |
| ├ 旅居总览/政务 | [`lvju-overview.html`](lvju-overview.html) · [`lvju-gov-dashboard.html`](lvju-gov-dashboard.html) | 演示总览 + 政府大屏 | 否 |
| **家政** | [`jiazheng-landing-cleaning.html`](jiazheng-landing-cleaning.html) | 保洁/维修/搬家/保姆 4 品类落地页 | 是（API） |
| ├ 下单闭环 | [`juzhu-jiazheng-list.html`](juzhu-jiazheng-list.html) → detail → [`juzhu-order-progress.html`](juzhu-order-progress.html) | C 端下单 → 中台派单 → 服务者推进 → 评价 | 是（`_jzapi.js`） |
| **全站总入口** | [`overview.html`](overview.html) | 全部约 176 页按系列/汇报视角分组 + 搜索 + 地域切换 | 否 |

> *P 中台大部分页面为静态原型；`p-service-demand / p-service-review / p-rating-review / p-rating-detail` 等在有后端时读 SQLite。

**如何到达其余页面**：不逐一枚举约 176 页。开发预览走 [`overview.html`](overview.html)（按系列分组 + 关键词搜索）；导航单一数据源为 [`screens/_nav.js`](screens/_nav.js)，桌面页 `<div id="side-nav" data-series="..." data-active="...">`、移动页 `<div id="m-tabbar" ...>` 自动挂载。

---

## 🏗 三档版本（保租房，仍有效）

| 版本 | 定位 | 入口 |
|---|---|---|
| **V1 · 仅展示** | 信息门户型 · 0 资金风险 | [`baozufang-overview-v1-basic.html`](baozufang-overview-v1-basic.html) |
| **V2 · + 标准体系** | 展示 + 好房子标准公示 | [`baozufang-overview-v2-standard.html`](baozufang-overview-v2-standard.html) |
| **V3 · + 交易闭环** | 端到端一站式办理 · 全四端 | [`baozufang-overview-v3-full.html`](baozufang-overview-v3-full.html) |

三档总入口 → [`baozufang-channel-overview.html`](baozufang-channel-overview.html)。

---

## 🔌 共享 JS 总线（`screens/_*.js` 单一数据源）

| 文件 | 职责 | 数据源 |
|---|---|---|
| [`_nav.js`](screens/_nav.js) | 桌面 sidebar + 6 系列页面清单（G/B/F/P/S/C）单一数据源；页面不硬编码导航 | 内置 SERIES 定义 |
| [`_navmobile.js`](screens/_navmobile.js) | 移动端 chrome（status-bar / 渐变 header / 底部 tabbar）集中配置 | 内置 |
| [`_region.js`](screens/_region.js) | 地域/部门/业务词/机构主体名词单一数据源；运行时 relabel + `relabelStr()` 属性改名 | `PRESETS` + `?region=` |
| [`_orderbus.js`](screens/_orderbus.js) | 居住服务「报修」工单闭环总线（可点击贯通演示） | `localStorage bzf_orders` |
| [`_jzapi.js`](screens/_jzapi.js) | 家政工单 REST 总线（C 端下单 + P/B 管理台双轨 API） | **SQLite**（`juzhu/server.py`） |
| [`_qr.js`](screens/_qr.js) | 二维码生成（第三方 MIT 库） | — |

**三层数据边界（互不重叠，见 `CLAUDE.md` 规则 8/9）**：
1. `jiazheng-data.js`（根目录）= 家政「目录/SKU」前端适配 + 离线 mock/兜底；
2. `screens/_jzapi.js` = 家政订单总线，走 REST `/api/juzhu/jiazheng/*` 与 `/api/juzhu/jz/*`，**SQLite 为唯一权威源**；
3. `screens/_orderbus.js` = 报修演示总线，走 `localStorage bzf_orders`。
三者不共享 key、不合并。

---

## 🗄 数据层（新居住 · 家政 · SQLite + REST）

目录 `juzhu/`：

| 文件 | 说明 |
|---|---|
| `server.py` | API + 静态文件 + 编辑后台服务（`HTTPServer`，端口 **8765**） |
| `db.py` / `jiazheng_db.py` | SQLite schema / 序列化辅助 |
| `schema.sql` / `jiazheng_schema.sql` | 建表 SQL |
| `juzhu.db` | **权威 SQLite 库**（本地，`.gitignore`） |
| `data.json` | 前端静态数据源（可提交，`server.py` 保存时重导） |
| `seed_from_folder.py` / `seed_jiazheng.py` | 入库 / 播种脚本 |

REST 双轨：C 端工单 `/api/juzhu/jiazheng/*`（`jz_skus` + `jz_orders`）；P/B 管理台 `/api/juzhu/jz/*`（`jz_subcategories` / `jz_vendors` / `jz_products` / `jz_workers`）。鉴权用 `localStorage JUZHU_API_KEY`（默认 `dev-juzhu-key`）。

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

**静态预览（大多数页面够用）**：
```bash
cd /proweb/run/sy
python3 -m http.server 8000
# 入口：http://localhost:8000/overview.html                    全站导航
#      http://localhost:8000/baozufang-channel-overview.html   保租房三档
#      http://localhost:8000/lvju-app-home.html                旅居 App
```

**带后端（新居住数据 / 家政下单闭环 / 编辑后台需要）**：
```bash
cd /proweb/run/sy
python3 juzhu/server.py
# 服务：http://localhost:8765/
# 前台：http://localhost:8765/index.html
# 后台：http://localhost:8765/juzhu-admin.html
```
（`server.py` 同时托管静态文件，因此单跑它即可同时访问静态页与 API。）

---

## 📚 文档与参考

| 文档 | 用途 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | 工作约定（导航同步 / 角色红线 / 地域与总线单一数据源，9 条规则） |
| [`docs/juzhu-info-architecture.md`](docs/juzhu-info-architecture.md) | 新居住信息架构 |
| [`docs/region-abstraction-plan.md`](docs/region-abstraction-plan.md) | 地域抽象落地方案 |
| [`docs/prd/`](docs/prd/) | 家政频道 PRD（全流程 + 4 品类）+ 设计稿 |
| [`juzhu/README.md`](juzhu/README.md) | 数据层快速开始 / 编辑后台 / 好房子评级复核 |
| [`PRD-保租房专用频道-V1.0.md`](PRD-保租房专用频道-V1.0.md) | 保租房 PRD V1.0 |
| `江苏租赁行业标准_V25.docx` / `mq0pq2pl-_好房子_标准提案-.xlsx` | 标准依据 / 好房子评星细则 |
| [`20260605_192600.png`](20260605_192600.png) · [`20260605_223100.png`](20260605_223100.png) | 四方共建 × 能力 × 阶段总体图谱 |

---

*保租房四方共建原型 · 已扩展为四业务线居住服务平台原型*
