# DESIGN · 新居住家政服务频道

> 版本：v1.0  
> 日期：2026-07-09  
> 站点：https://sy.meizu.life  
> 入口页：`index.html`  
> 城市预设：沈阳（可切换贵州/江苏等区域）

---

## 1. 文档目的

本文档基于 `gz-lvju` 仓库现有 HTML 原型，梳理**新居住频道 · 家政服务**的设计方案，作为后续原型迭代与开发的统一依据。

约束原则（来自产品确认）：

1. **风格**：延续 `lvju-app.css` 青绿 + 金色品牌体系，与贝壳 App 旅居频道一致
2. **字段**：以中台已有数据模型为主（`_orderbus.js`、服务认证中台 P 端、`juzhu/schema.sql`）
3. **部署**：本地优先，`python3 juzhu/server.py` + 静态页；API 鉴权使用 **API Key**
4. **参考图**：用户后续提供参考图，视觉布局可对齐参考，但组件/色板/字段不得偏离本设计

---

## 2. 频道定位与信息架构

### 2.1 频道入口

| 层级 | 页面 | 说明 |
|------|------|------|
| L0 | `beike-app-home.html` | 贝壳 App 首页 |
| L1 | `index.html` | 新居住频道（方案 C · 网格） |
| L2 | 保租房 / 卖旧买新 / **家政** | Tab 切换（`channels` 表控制启用） |
| L3 | `juzhu-jiazheng-list.html?type=` | 品类列表 + 子类 SKU |
| L4 | `juzhu-jiazheng-detail.html` | 服务详情 + 下单 |
| L5 | 下单 → 支付 → 进度 → 评价 | 全流程 C 端 |

### 2.2 家政四大品类（原型内置）

来源：`index.html` → `JZ_CATS`

| ID | 品类 | 图标 | 子类（示例） |
|----|------|------|-------------|
| `cleaning` | 保洁 | 🧹 | 日常保洁、深度清洁、搬家保洁、开荒保洁、擦玻璃、油烟机清洗 |
| `repair` | 维修 | 🔧 | 家电维修、管道疏通、灯具安装、门窗维修、防水补漏、空调清洗 |
| `moving` | 搬家 | 📦 | 居民搬家、长途搬家、钢琴搬运、企业搬迁、日式搬家、搬货上下楼 |
| `nanny` | 保姆 | 👶 | 住家保姆、育儿嫂、月嫂、钟点工、养老护理、医院陪护 |

各品类 PRD 见同目录：

- `PRD-家政-01-保洁品类.md`
- `PRD-家政-02-维修品类.md`
- `PRD-家政-03-搬家品类.md`
- `PRD-家政-04-保姆品类.md`
- `PRD-家政-00-全流程与中台认证.md`

---

## 3. 视觉与交互规范

### 3.1 设计 Token（沿用现有）

```css
/* lvju-app.css */
--brand: #0f766e;      /* 主色 · 青绿 */
--brand-deep: #0b5d56;
--gold: #b48a3f;       /* 强调 · 价格/星级 */
--ink: #10171c;
--serif: 'Noto Serif SC', ...;  /* 标题 */
```

**C 端（App 壳）**

- 最大宽度 430px，`.app` 手机列布局
- 顶栏 `.appbar`：返回 + 标题 + 操作
- 底部 `.cta` 固定主按钮
- 步骤条 `.steps`：下单三阶段（预定 → 支付 → 完成）

**P 端（服务认证中台）**

- 侧栏 240px + 主内容区
- 主色 `--accent: #6366f1`（靛蓝）
- 卡片 `.card` + KPI `.kpi` + 表格

**B 端（运营商）**

- 主色 `--accent: #0f766e`（与 C 端品牌一致）
- 看板 Kanban 五列：待派 → 匹配 → 已派 → 服务中 → 已完成

### 3.2 家政 Tab 专属组件（v3-grid 已定义）

| 组件 | 类名 | 用途 |
|------|------|------|
| 品类大卡 | `.jz-cat` | 2×2 网格，四色渐变（cleaning/repair/moving/nanny） |
| 热门子类行 | `.jz-sub-list .row` | 服务名 + 规格 + 起价 |
| 营销位 | `.jz-promo-card` | HOT / GRAD / PRO 三档运营卡片 |
| 分区头图 | `.split-hd` | 城市 Hero + Tab 切换 |

### 3.3 参考图接入原则

用户提供的参考图用于：

- 信息密度与卡片比例
- 摄影/插画风格方向

**不得改变：**

- 品牌色与字体体系
- 工单字段名与中台状态机
- 服务者 L0–L7 等级展示规则
- 支付存管文案（贝壳支付 / 资金冻结）

---

## 4. 数据模型设计

### 4.1 现有字段（直接复用）

**房源侧** — `juzhu/schema.sql`

- `cities` / `districts` / `projects` / `units` / `photos`
- `units.keeper` JSON：`{name, avatar, phone}` — 管家联系人
- `units.amenities` / `tags` / `rent_detail`

**工单侧** — `screens/_orderbus.js`（localStorage 原型总线，后续落库）

```javascript
{
  id: "WO-2026-80001",       // 工单号
  type: "保洁",                 // 需求类型
  category: "cleaning",       // 品类 ID
  desc: "厨房油污严重",        // 问题描述
  house: "梧桐公馆 3-1202",   // 房源/位置
  phone: "138****1234",
  expectTime: "2026-07-10 14:00",
  source: "旅居客 App",
  fee: 248,                   // 服务费基准
  status: "pending",          // 状态机
  worker: { name, level, tags },
  rating: { stars, tags, text },
  createdAt, createdLabel,
  log: [{ s, at }]
}
```

**状态机**（全端统一）

```
pending → dispatched → accepted → serving → done → rated
待派单    已派单       已接单     服务中     已完成   已评价
```

### 4.2 建议新增表（家政 SKU）

```sql
-- 家政品类
CREATE TABLE jz_categories (
  id TEXT PRIMARY KEY,          -- cleaning|repair|moving|nanny
  name TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1
);

-- 子类 SKU
CREATE TABLE jz_skus (
  id INTEGER PRIMARY KEY,
  category_id TEXT REFERENCES jz_categories(id),
  name TEXT NOT NULL,           -- 深度清洁 · 4小时
  slug TEXT NOT NULL,
  spec TEXT,                    -- 3人团队 · 含厨卫去污
  price_from INTEGER,           -- 分或元（演示为元）
  price_unit TEXT,              -- 起|/台|/月|/次
  duration_min INTEGER,         -- 预估时长（分钟）
  tags TEXT,                    -- JSON
  cover_image TEXT,
  sort_order INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1
);

-- 服务订单（落库版，字段对齐 _orderbus.js）
CREATE TABLE jz_orders (
  id TEXT PRIMARY KEY,
  sku_id INTEGER REFERENCES jz_skus(id),
  category_id TEXT,
  user_id TEXT,
  house TEXT,
  phone TEXT,
  expect_time TEXT,
  desc TEXT,
  fee INTEGER,
  pay_status TEXT DEFAULT 'unpaid',  -- unpaid|paid|refunded
  pay_method TEXT,
  pay_at TEXT,
  status TEXT DEFAULT 'pending',
  worker_id TEXT,
  worker_json TEXT,             -- JSON
  rating_json TEXT,
  source TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### 4.3 中台认证关联字段

| 中台页面 | 关联工单字段 | 说明 |
|----------|-------------|------|
| `p-onboarding-review.html` | `worker_id` 入驻状态 | 未建档不可接单 |
| `g-whitelist-service.html` | `worker.level` | 住建白名单审定 |
| `p-standards.html` | `worker.level` L0–L7 | 等级标准 |
| `p-traffic-policy.html` | 派单权重 | 等级+信用+距离 |
| `p-transaction.html` | `fee` 分账 | T+7 结算 |
| `p-service-review.html` | `rating` | 评价回流信用引擎 |
| `p-cert-issue.html` | 证书编号 | 持证上岗校验 |

**接单前置条件**（原型已体现）：

- 实名 + 资质通过（`p-onboarding-review`）
- 住建白名单在册（`g-whitelist-service`）
- 对应工种证书有效（`s-cert.html`）
- 已投保（`p-insurance.html`）
- 无合规预警（如 `R-107` 社保断缴不可派单）

---

## 5. 端到端流程设计

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  C 端下单    │ →  │  在线支付    │ →  │  中台派单    │ →  │  S 端接单    │ →  │  C 端评价    │
│  详情页      │    │  收银台      │    │  工单池      │    │  我的工单    │    │  评价页      │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
      │                  │                  │                  │                  │
 juzhu-jiazheng-    lvju-app-pay.html   p-service-         s-orders.html    lvju-app-review
 detail.html                            demand.html                           .html
      │                  │                  │                  │                  │
      └──────────────────┴──────────────────┴──────────────────┴──────────────────┘
                              _orderbus.js / API 统一状态
```

| 阶段 | C 端页面 | P/B 端页面 | 关键动作 |
|------|----------|-----------|----------|
| 浏览 | `index.html` | — | 选品类 / 子类 |
| 下单 | `juzhu-jiazheng-detail.html`（待建） | — | 填地址/时间/备注 → `BZF_ORDERS.create()` |
| 支付 | `lvju-app-pay.html` | `p-transaction.html` | 选支付方式 → 资金存管冻结 |
| 派单 | `repair.html` 进度 Tab | `p-service-demand.html` / `b-dispatch-board.html` | 规则派单 / 手动派单 |
| 接单 | — | `s-orders.html` | 服务者接单 → `advance()` |
| 服务 | — | `s-orders.html` | 出发 → 服务中 → 完工 |
| 评价 | `lvju-app-review.html` | `p-service-review.html` | `rate()` → 信用引擎计分 |

---

## 6. API 设计（本地 + API Key）

### 6.1 部署方式

```bash
cd /root/.openclaw/workspacedev/bzf/sy
python3 juzhu/server.py
# 前台 http://localhost:8765/index.html
# 中台 screens http://localhost:8765/screens/p-console.html
```

生产静态站：`https://sy.meizu.life`（nginx 托管）；带 API 能力需反代到 `8765` 或独立服务。

### 6.2 鉴权

沿用 `property-intake-api.html` 模式：

```
Header: Authorization: Bearer <API_KEY>
或:     X-API-Key: <API_KEY>
```

| 环境 | Key 存放 | 说明 |
|------|----------|------|
| 本地开发 | `juzhu/.env.local`（gitignore） | `JZ_API_KEY=dev_xxx` |
| 测试 | 服务器环境变量 | 不入库 |
| 生产 | 密钥管理服务 | 轮换周期 90 天 |

### 6.3 家政 API 端点（建议）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/juzhu/jiazheng/categories` | 四大品类 |
| GET | `/api/juzhu/jiazheng/skus?category=cleaning` | 子类 SKU 列表 |
| GET | `/api/juzhu/jiazheng/skus/{slug}` | SKU 详情 |
| POST | `/api/juzhu/jiazheng/orders` | 创建订单（需登录或 Key） |
| GET | `/api/juzhu/jiazheng/orders/{id}` | 订单详情 + 状态 |
| POST | `/api/juzhu/jiazheng/orders/{id}/pay` | 发起支付 |
| POST | `/api/juzhu/jiazheng/orders/{id}/rate` | 提交评价 |
| GET | `/api/juzhu/admin/orders?status=pending` | 中台工单池（需 Key） |
| POST | `/api/juzhu/admin/orders/{id}/dispatch` | 派单 |
| POST | `/api/juzhu/admin/orders/{id}/advance` | 推进状态 |

公开读接口（品类/SKU）可匿名；写接口与 admin 接口必须带 API Key。

---

## 7. 页面清单与开发优先级

### P0 — 闭环可演示

| 页面 | 状态 | 说明 |
|------|------|------|
| `index.html` | ✅ 已有 | 家政 Tab + 四大类入口 |
| `juzhu-jiazheng-list.html` | ⬜ 待建 | 子类列表 + 筛选 |
| `juzhu-jiazheng-detail.html` | ⬜ 待建 | SKU 详情 + 下单表单 |
| `lvju-app-pay.html` | ✅ 已有 | 复用收银台，改订单上下文 |
| `repair.html` | ✅ 已有 | 复用报修页作进度查询 |
| `s-orders.html` | ✅ 已有 | 服务者接单 |
| `p-service-demand.html` | ✅ 已有 | 中台派单 |
| `lvju-app-review.html` | ✅ 已有 | 复用评价页 |

### P1 — 中台深化

| 页面 | 说明 |
|------|------|
| `b-dispatch-board.html` | B 端运营商看板 |
| `p-transaction.html` | 分账结算 |
| `p-service-review.html` | 评价回流 |
| `p-onboarding-review.html` | 入驻受理 |
| `g-whitelist-service.html` | 住建白名单 |

### P2 — 数据落库

- `jz_*` 表 + `server.py` 端点
- `_orderbus.js` 迁移为 API 读写（保留 localStorage 降级）

---

## 8. 与中台认证体系关系图

```
                    ┌──────────────────────────────────────┐
                    │     服务认证中台 (P) p-console.html   │
                    │  标准 · 规则 · 数据 · 证书 · 信用引擎   │
                    └───────────────┬──────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
  g-whitelist-service        p-onboarding-review          p-cert-issue
  住建白名单审定              入驻申请受理                  统一颁证
         │                          │                          │
         └──────────────────────────┼──────────────────────────┘
                                    ▼
                           s-cert.html · 服务者持证
                                    │
                                    ▼
              p-service-demand → s-orders → p-service-review
                    派单            接单          评价回流
```

---

## 9. 验收标准

1. 四大品类均可从频道首页进入，完成下单→支付→派单→接单→评价全链路点击演示
2. 工单状态在 C/P/S 三端同步（`_orderbus.js` 或 API）
3. 未持证服务者不可被派单（中台规则拦截提示）
4. 视觉与 `lvju-app.css` 一致，无独立配色方案
5. 本地 `server.py` 启动后 API Key 鉴权生效
6. 参考图融入后不影响字段与中台跳转链路

---

## 10. 附录：原型索引

| 角色 | 关键页面 |
|------|----------|
| C 端 | `index.html`, `lvju-app-pay.html`, `lvju-app-review.html`, `repair.html` |
| S 端 | `s-orders.html`, `s-cert.html`, `screens/home.html` |
| P 端 | `p-console.html`, `p-service-demand.html`, `p-service-review.html`, `p-transaction.html` |
| B 端 | `b-dispatch-board.html`, `b-operator-console.html` |
| G 端 | `g-whitelist-service.html`, `gov-admin.html` |
