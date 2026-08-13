# DESIGN · 家政频道 SPU/SKU 分层流程

> 版本：v1.0
> 日期：2026-07-12
> 站点：https://sytest.meizu.life （预览）
> 关联：`DESIGN-新居住家政服务频道.md`、`PRD-家政-00-全流程与中台认证.md`
> 数据源：`juzhu/juzhu.db`（jz_* 表）、`juzhu/server.py`（`/api/juzhu/jz/*`）

---

## 1. 文档目的

明确家政频道「**谁设计什么、谁上什么货**」的职责分层，把现有 jz_* 数据表与页面对齐到统一的商品域模型，作为后续 P 端 SPU 管理台、商家 SKU 台开发的依据。**本文档只做设计，不改现有页面。**

核心命题（来自产品确认）：

1. **平台 P** 负责设计 **类目 + SPU**（标准品，全平台统一，商家不可改标准）
2. **商家后台 B** 负责上 **SKU = SPU + 服务者 + 时间**（各商家自行实例化、定价、排班）
3. 认证在两层分别体现：平台管**商家白名单/资质**与**服务者持证/等级**；商家在自己 SKU 上绑定已认证的服务者

---

## 2. 整体流程（两层职责 + 下单）

```
① 平台 P · 服务认证中台                ② 商家后台 B · 运营商工作台              ③ C 端 · 贝壳 App
   ┌─────────────────────┐            ┌──────────────────────────┐          ┌────────────────┐
   │ 类目（4大类/24子类）  │            │ 选一个 SPU                 │          │ 频道 → 品类列表 │
   │ SPU（标准服务品）     │  ──引用──▶ │  + 绑本店服务者(已认证)     │  ──上架──▶│ → 服务详情      │
   │  · 标准工序/时长/参考价│            │  + 排可约时段              │          │ → 选时间下单    │
   │  · 归属子类目          │            │  + 定价/优惠               │          │ → 支付 → 工单池 │
   └─────────────────────┘            │  = 可售 SKU                │          └────────────────┘
        平台标准，锁定                   └──────────────────────────┘               实例化后可售
```

- **SPU（Standard Product Unit）**：平台定义的"标准服务"，如「深度清洁 · 4 小时」。规定标准工序、参考时长、参考价、归属子类目。**跨商家统一**，保证同名服务口径一致、可比价。
- **SKU（Stock Keeping Unit）**：商家把某个 SPU 实例化——绑定**自家已认证服务者** + 设定**可约时段** + 定**实际售价**，形成 C 端真正可下单的最小单元。
- **下单侧**：C 端详情页（`juzhu-jiazheng-detail.html`）展示 商家(vendor) + SPU(服务说明) + 认证服务者 + 评价，用户选时段下单进工单池（`jz_orders`）。

---

## 3. 数据模型映射

现有表已基本齐备，且 **`jz_products.channel_sku_id → jz_skus.id` 关联已存在**，即"商家 SKU 引用平台 SPU"的结构关系天然成立，无需新建关联主线。

| 域概念 | 归属层 | 现有表 | 现状 | 语义定位 |
|---|---|---|---|---|
| 类目（大类） | 平台 P | `jz_categories`(4) | ✅ 已 seed | 保洁/维修/搬家/保姆 |
| 子类目 | 平台 P | `jz_subcategories`(24) | ✅ 已 seed | 日常保洁/管道疏通… |
| **SPU** | 平台 P | `jz_skus`(9) | ⚠️ 现为 C 端目录，**语义升格为 SPU** | 深度清洁·4小时 等标准品 |
| **SKU** | 商家 B | `jz_products`(21) | ⚠️ 有商家+价格+最早时间，**缺服务者绑定与时段** | 商家实例化售卖单元 |
| 商家 | 商家 B | `jz_vendors`(8) | ✅ 已 seed | 春晖家政/蚂蚁搬家… |
| 服务者 | 商家 B | `jz_workers`(10) | ✅ 已 seed | 含 level/certs/白名单 |
| 工单 | C/中台 | `jz_orders` | ✅ | 下单后统一流转 |
| SPU↔SKU 关联 | — | `jz_products.channel_sku_id` | ✅ 字段已在 | SKU 引用 SPU |

> 命名澄清：为避免"jz_skus 叫 sku 却是平台标准品"的混淆，本设计约定 **jz_skus = SPU 语义**、**jz_products = 商家 SKU 语义**。表名保持不变（避免破坏现有 C 端与 API），仅在文档与 UI 文案上以 SPU/SKU 表述。

---

## 4. 页面职责矩阵

| 端 | 页面 | 现状 | 目标职责 |
|---|---|---|---|
| **P 平台** | `screens/p-jz-category.html` | ✅ 已接 API | 类目/子类目管理 |
| **P 平台** | `screens/p-jz-spu.html` **（新建）** | ❌ 不存在 | **SPU 管理台**：标准服务品增删改（名称/子类目/标准工序/时长/参考价/图集），全平台统一 |
| **B 商家** | `screens/p-jz-product.html` → 升级 | ⚠️ 仅商家+价格+最早时间 | **商家 SKU 台**：选 SPU + 勾选本店服务者 + 排可约时段 + 定价，生成可售 SKU |
| **B 商家** | `screens/p-jz-worker.html` | ✅ 已接 API | 服务者花名册（等级/持证/白名单） |
| **C 端** | `juzhu-jiazheng-detail.html` | ✅ 已做 | 展示 vendor+SPU+服务者+评价 → 下单 |

> ⚠️ 规则 1 约束：新建 `p-jz-spu.html`、或把 `p-jz-product` 改名/改职责，**同一 commit 必须同步 `screens/_nav.js` + `overview.html`**。SPU 台归 **P 服务认证中台系列**，SKU 台归 **B 运营商工作台系列**。

---

## 5. 差距 & 改造清单

### 5.1 缺口一：平台缺 SPU 管理台
- 现象：`jz_skus`(9) 有数据、C 端能读，但 P 端无页面管理，且未点明"标准品"定位。
- 改造：新建 `p-jz-spu.html`，读写 `/api/juzhu/jiazheng/skus`（读接口已有；需补 P 端写接口 `POST/PUT/DELETE`）。字段：名称、slug、归属子类目、spec、标准工序 service_flow、参考时长 duration_min、参考价 price_from、图集。

### 5.2 缺口二：商家 SKU 未做到 =服务者+时间
- 现象：`jz_products` 有 `vendor_id/price/earliest_time`，但**无服务者绑定**、**无排班时段**。
- 改造（**加法式**，不破坏现有字段）：
  - **服务者绑定**：新增关联 `jz_sku_workers(product_id, worker_id)`（多对多），或 `jz_products.worker_ids`(JSON)。推荐关联表，便于 C 端"该 SKU 可选阿姨"列表与排班。
  - **时段排班**：新增 `jz_sku_slots(product_id, date, start, end, worker_id, capacity, booked)`，或先用 `jz_products.slot_rule`(JSON) 描述可约规则（如"每天 08:00–20:00，每 2h 一档"）。原型阶段可先 JSON 规则，后续再落表。
  - C 端详情页选时段时，从该 SKU 的 slots/规则取可约档，落单写入 `jz_orders`（含 worker_id）。

### 5.3 后端接口补充（对应改造）
| 接口 | 现状 | 需求 |
|---|---|---|
| `/api/juzhu/jiazheng/skus` 写 | 仅读 | P 端 SPU 台需 `POST/PUT/DELETE` |
| `/api/juzhu/jz/products` 写 | 有 `POST/PUT` | 扩展 body：`worker_ids` / `slot_rule` |
| `/api/juzhu/jz/products/{id}/workers` | 无 | 绑定/解绑服务者 |
| `/api/juzhu/jz/products/{id}/slots` | 无 | 排班读写 |

---

## 6. 认证在各层的体现（呼应规则 4 红线）

| 层 | 认证对象 | 字段 | 展示位 |
|---|---|---|---|
| 平台 P | 商家资质 | `jz_vendors.badges`(whitelist/backcheck/top10)、`whitelist_id`、`rank_label` | 商家认证台、C 端商家介绍 |
| 平台 P | 服务者持证 | `jz_workers.level`、`certs`、`is_whitelisted`、`credit_score` | 服务者管理台、C 端认证服务者 |
| 商家 B | 只能绑**已认证**的自家服务者到 SKU | 关联 `jz_sku_workers` | 商家 SKU 台 |

> 红线：商家（白名单运营商）在自己 SKU 上组货、排班、绑人；平台（认证中台）只发认证与标准，不替商家排班。国企持有方在此链路中不出现（家政为运营商-服务者生态）。

---

## 7. 落地节奏（分阶段，避免一次性大改）

- **P0 · 文档对齐（本文档）**：确立 SPU/SKU 语义与页面职责。✅ 已完成
- **P1 · 平台 SPU 台**：`p-jz-spu.html` + SPU CRUD（`/api/juzhu/jz/spu`，删除防护）+ 同步 `_nav.js`/`overview.html`。✅ 已完成
- **P2 · 商家 SKU 台**：`jz_sku_workers` 关联表；`p-jz-product` 升级为「选 SPU + 勾服务者 + 定价」；product CRUD 接 `channel_sku_id`/`worker_ids`；seed 35 条绑定。✅ 已完成
- **P3 · C 端下单绑定**：`get_detail_context` 改取 SKU 绑定的服务者；详情页服务者卡可「指定 TA」；下单带 `worker_id`，工单 `worker_json` 记录首选服务者。✅ 已完成
- **P4 · 排班闭环（P/B/C 前端贯通）**：`jz_sku_slots` 排班表 + CRUD/generate/book_slot；B 端 `p-jz-schedule.html` 排班台（选 SKU→给服务者排日期×时段×容量）；C 端详情页时段改读真实可约档（按日期分组，显示服务者+剩余），选档=定服务者+时间；下单传 `slot_id` **占用容量**（约满 409）；工单 `worker_json` 记录服务者+档期。seed 315 档期。✅ 已完成
- **出口标准**：每阶段 C 端详情页 → 下单 → 工单池链路可点击贯通、无回归。四阶段均已在 sytest 上 Playwright 渲染 + 端到端下单验证通过。

## 11. 拿不到排期表时的降级兼容（试点友好）

**排期表（`jz_sku_slots`）是可选增强，不是必需依赖。** 商家未维护档期时，全链路自动降级，从产品详情到评价无一步阻断。

| 环节 | 有排期表（增强态） | 无排期表（降级态） |
|---|---|---|
| 产品详情·时间 | 「选择上门档期」：真实档位（日期×时段×服务者×剩余），选定锁名额 | 「选择意向时段」：静态意向时段 + ⚠️「实际时间派单后电话确认」提示 |
| 产品详情·服务者 | 档位自带服务者，选档即定人 | 服务者卡「指定 TA」作为**意向偏好**（可选，不绑档） |
| 下单 | 带 `slot_id`，占用容量（约满 409） | 只带 `expect_time`(+可选 `worker_id`)，不占容量 |
| 派单 | 尊重档位服务者 | 有意向服务者则尊重，否则中台/商家轮派定人 |
| 服务→完成→评价 | 状态机 pending→…→rated，与排期**无关**，两态完全一致 |

- **判定**：详情页 `GET /skus/{slug}/slots` 返回空 → 前端 `markMode('intent')` 切换文案与静态时段；有档 → `markMode('real')` 渲染真实档位。
- **后端零耦合**：`_create_jz_order` 中 `slot_id` 缺省即走"仅时间/偏好"分支；派单 `_dispatch` 有首选则用、无则轮派。
- **跨页一致提示**（三页文案统一）：
  - 详情页：「选择意向时段」+⚠️ / 「选择上门档期」
  - 下单确认页：意向态显示「⚠️ 意向时段，派单后电话确认」且保留"调整上门时间"；档期态显示「✓ 已锁定该档期，名额已保留」且隐藏调整入口
  - 进度页：订单信息「上门时间」行带 **意向·待确认** / **已约档期** 徽标
- **验证**：已删除某 SKU 全部档期，端到端跑通 下单(意向)→支付→派单(轮派)→接单→服务→完成→评价(rated)，无一步失败；四态（下单/进度 × 意向/档期）文案渲染正确。

## 10. 运营一致性完善（P4+）

- **派单尊重客户选择**：客户在档位选定服务者后，中台/商家派单（`/dispatch`）若不显式指定，**默认指派该服务者**（`worker.from_customer=true`），并保留预约档期，不再随机轮派。
- **进度页展示**：`juzhu-order-progress.html` 兼容"下单未派单"(`{preferred, slot}`)与"已派单"两种 worker 形态；待派单时标题显示「首选服务者」+「您指定」徽标 + 预约档期。
- **档期开/关**：`p-jz-schedule` 每档可「关闭/开启」（`PUT /jz/slots/{id}` status=open/closed），关闭的档期不再对 C 端开放，已有预约的档期禁止删除（只能关闭）。

## 9. 三端闭环成果（P4 完成态）

```
P 平台          B 商家                       C 客户
─────           ──────                       ──────
类目 p-jz-category
SPU  p-jz-spu ──▶ SKU  p-jz-product（选SPU+勾服务者）
                  排班 p-jz-schedule（服务者×日期×时段×容量）──▶ 详情页按档下单（选服务者+时间）
                                                              └─ 占用容量 → 工单(worker+slot) → 工单池
```

---

## 8. 遵循的项目约定

- **规则 1**：新建/改职责页面与 `_nav.js`、`overview.html` 同 commit 同步。
- **规则 4**：商家=运营方组货排班，平台=发认证标准，二者不混。
- **规则 9**：C 端走 `/api/juzhu/jiazheng/*`（jz_skus=SPU + jz_orders）；P/B 管理台走 `/api/juzhu/jz/*`（vendors/products/workers/subcategories）。SPU 台建议复用 `jiazheng/skus` 读接口 + 新增 P 端写接口，保持双轨清晰。
