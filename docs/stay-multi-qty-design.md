# 旅居短住 · 多间库存设计（unit 总间数 + 每晚放出间数）

> 2026-09-10 · 设计稿 v1
> 需求：① 一个 unit（户型）下支持多个库存数量（同规格房型 × N 间）；② 每日房态日历在逐晚库存之上支持设置「当天放出几个可用」。
> 硬约束：规则 15（差异属性不加列/不建分表的边界在此打破——qty 是库存核心字段，须进 SQL 聚合，故加列）；规则 16（逐晚库存与入住规则单一数据源在服务端）；0 元预订单口径不变；存量单间 unit 行为完全不变。

---

## 0. 结论摘要

1. **房型计数模型**：unit 加 `total_qty`（总间数，缺省 1 = 现状全兼容）；下单按「间数 × 逐晚价」成交，同一 unit 的 N 间房不区分具体房间号。
2. **每晚可用数 = 三元函数**：`remaining = blocked ? 0 : max(0, COALESCE(行.qty, total_qty) − 行.booked_qty)`。`qty` 是商家按晚覆盖的「放出间数」，`booked_qty` 是该晚已订间数——都是 `stay_calendar` 新列。
3. **stored `status` 收敛为 `open`/`blocked`（商家闸门）**；`booked` 降级为 `remaining<=0` 的**派生态**，只在接口出参里出现，不再落库。`uk_sc` 唯一键**不动**——计数模型恰好一行表达一个 unit-night，这是本次改造最小的结构代价。
4. **下单占用 = 补缺行 + 条件递增**（`booked_qty = booked_qty + rooms`，受 `remaining >= rooms` 闸），释放 = 对称递减 + 纯占用行清理。顺带修掉规则 16 记录的旧副作用：**取消不再连带清掉商家 `price_night` 覆盖**。
5. **口径全部收口 `stay_config.cjs`**（两侧共用的单一数据源）：可用数公式、日历组装、逐晚计价、释放 helper；`app.js` 与 `vendor_api.cjs` 不再各写一份房态写 SQL 的语义（SQL 文本仍两侧各一份，但判定逻辑走共享函数）。
6. C 端下发 `remaining`，日历/下单页展示「仅剩 X 间」（≤2 触发稀缺文案）与「已订满」；B 端房态页批量卡新增「放出间数」，admin unit 编辑器新增「总间数」。

---

## 1. 现状与为什么必须动结构

现状（规则 16）：`stay_calendar` 每行 = 一个 unit-night 的**布尔占用**（`status: open/blocked/booked` + `booking_id`），隐含库存恒为 1 间。三个结构性事实使「多间」无法在现模型上打补丁：

| # | 事实 | 位置 |
|---|---|---|
| 1 | `status='booked'` 是整行状态，一行只能表达「全占/没占」，无法表达「3 间订了 1 间」 | `app.js:1384-1396` |
| 2 | 下单冲突校验是「存在任一 blocked/booked 行即拒」，不是数量比较 | `app.js:4901-4910` |
| 3 | 释放 = `DELETE FROM stay_calendar WHERE booking_id=? AND source='booking'`（5 处同句式），一行只能挂一个 booking_id | `app.js:770,5058,5156`、`vendor_api.cjs:964,992` |

**关键取舍：不动 `uk_sc(project_id, unit_id, stay_date)`。** 备选的「每间房一行」或「每 booking-night 一行」都要改唯一键、动 6 处 `ON DUPLICATE KEY UPDATE` 语义，收益只是能追踪房间号——原型阶段不需要。计数模型下唯一键继续充当「一个 unit-night 一行」的物理保证。

> 仓库内先例：`jz_sku_slots.capacity/booked`（`app.js:1540-1541`，占用 `UPDATE ... WHERE booked<capacity` 判 `affectedRows`）——家政档期已验证过「容量+已占」计数模型，本设计与之同构。

## 2. 已拍板的决策（2026-09-10）

| 决策点 | 结论 |
|---|---|
| 库存语义 | 房型计数模型（unit × N 间，无房间号） |
| 每日可用数 | 支持按晚覆盖（`stay_calendar.qty`），无覆盖行 = 用 `units.total_qty` |
| C 端展示 | 展示「仅剩 X 间」（剩余 ≤2）与「已订满」 |
| 存量兼容 | 缺省 1 间全兼容：`total_qty` 缺省 1、旧行迁移后行为与改造前逐字节一致 |

## 3. 数据模型

### 3.1 加列（`app.js` ensureSchema `extraCols` + DDL 两处）

```js
['units', 'total_qty INT NOT NULL DEFAULT 1'],            // 总间数（写入口 clamp 1-999）
['stay_calendar', 'qty INT NULL'],                        // 该晚放出间数覆盖；NULL = total_qty
['stay_calendar', 'booked_qty INT NOT NULL DEFAULT 0'],   // 该晚已订间数
['booking_orders', 'rooms INT NOT NULL DEFAULT 1'],       // 订购间数（整栋单恒为 1）
```

- `units` DDL 同步 `app.js:1323-1342` 与 `juzhu/mysql_schema.sql`；`stay_calendar` DDL 同步 `app.js:1384-1396`（不在 mysql_schema.sql）。
- **`projects.unit_count` 不复用**（现语义 = 户型种类数，`syncProjectUnitCount()` 在写）；`managed_unit_count` 也不复用（营销口径在管套数）。新列独立命名 `total_qty`，避免撞名。
- `stay_calendar.booking_id` 语义降级为「首个占用订单 id」（`COALESCE(booking_id, ?)` 保首写），仅作展示/排查线索，**任何占用/释放判定不得再依赖它**。

### 3.2 stored `status` 收敛

- 落库只写 `'open' | 'blocked'`；`STAY_STATUS.BOOKED` 保留为**出参派生态**。
- 迁移：`status='booked'` 旧行 → `booked_qty=1, status='open'`（`scripts/stay-qty-init.cjs`，备份表 `stay_calendar_bak_20260910`）。
- `buildStayMonth` 对未迁移库做防御：见到 legacy `status='booked'` 行按「满房」处理（不依赖迁移已跑）。

### 3.3 可用数公式（单一数据源 `stay_config.cjs` 新导出）

```js
// effectiveQtyOf(row, unit): 行.qty ?? (row.unit_id===0 ? 1 : unit.total_qty||1)
//   项目级行（unit_id=0，整栋）容量恒 1——整栋只有一份
// remainingOf(row, unit):    row.status==='blocked' ? 0
//                          : row.status==='booked' ? 0            // legacy 防御
//                          : max(0, effectiveQtyOf - row.booked_qty)
// dayStatusOf(row, unit):    remaining<=0 ? 'booked' : row.status  // 出参派生
```

## 4. 下单链路（`POST /api/juzhu/booking`）

1. 入参加 `rooms`（缺省 1，clamp 1-99；**整栋单强制 1**）；`unitRow` SELECT 补 `total_qty`。
2. 过期单清理（`app.js:4895-4898`）**去 stay_calendar join**：旧行靠 `s.booking_id=b.id AND s.status='booked'` 反查，多间后 booking_id 只是首写标记会漏单。改为按订单自身列判过期（project 内 `pending + unpaid + payment_expires_at<=now`），与后台 `cleanupExpiredBookingOrders()` 同口径。
3. **冲突校验改为逐晚可用数比较**（事务内 `FOR UPDATE` 锁候选行）：
   ```sql
   SELECT sc.unit_id, sc.stay_date, sc.status, sc.qty, sc.booked_qty, u.total_qty
   FROM stay_calendar sc LEFT JOIN units u ON u.id=sc.unit_id
   WHERE sc.project_id=? AND sc.stay_date>=? AND sc.stay_date<?
     AND (sc.unit_id=? OR sc.unit_id=0)      -- 整栋单不拼 unit 条件 = 全项目行
   FOR UPDATE
   ```
   整栋单：区间内任一行 `remaining>0`（含 blocked→0 的反面即 blocked/booked）即拒——沿用「整栋包圆」语义；指定 unit：项目级行 `blocked` 或 `booked_qty>0`（整栋被订）→ 拒；unit 级行 `remaining < rooms` → 拒（错误信息带 `conflict_date` + 剩余间数）。项目行锁（`app.js:4879`）保留，串行化语义不变。
4. **占用两步**（替换 `app.js:4949-4963` 的翻状态写法）：
   ```sql
   -- ① 补缺行（无行 = 默认可订 的落库形态；INSERT IGNORE 依赖 uk_sc 幂等）
   INSERT IGNORE INTO stay_calendar(project_id,unit_id,stay_date,status,source,updated_at)
     VALUES (?, unitId, d, 'open', 'booking', now) ...
   -- ② 条件递增（防超卖硬闸；booking_id 只在首占用时写）
   UPDATE stay_calendar SET booked_qty=booked_qty+?, source='booking',
     booking_id=COALESCE(booking_id,?), updated_at=?
   WHERE project_id=? AND unit_id=? AND stay_date IN (...) 
   ```
   `affectedRows !== nights` → rollback 返 400（并发兜底，正常路径已被 3 的 FOR UPDATE 挡住）。**UPDATE 子句不再触碰 `price_night`/`qty`/`status`**——商家覆盖天然保留，旧规则「勿写全列 no-op」随之作废。
5. 价格：`stayNightPrices()` 单间逐晚口径**不变**，`price_total = nightCalc.total × rooms`；佣金快照在放大后的 `price_total` 上计算（规则 20 机制零改动）。0 元预订单口径不变。
6. `booking_orders` INSERT/响应/webhook payload 带 `rooms`；`booking/my`、`booking/lookup`、商家侧订单列表随行下发。

## 5. 释放链路（5 处 DELETE 收口为 1 个 helper）

`stay_config.cjs` 新导出 `releaseStayQty(execute, {project_id, unit_id, rooms, checkin, checkout, now})`：

```sql
-- ① 对称递减（按订单自身 checkin/checkout/unit 重算区间，不依赖 booking_id）
UPDATE stay_calendar SET booked_qty=GREATEST(booked_qty-?,0), updated_at=?
WHERE project_id=? AND unit_id=? AND stay_date>=? AND stay_date<?     -- unit_id 取 order.unit_id||0
-- ② 纯占用行清理（商家差异行——price_night/qty/blocked——原地保留）
DELETE FROM stay_calendar WHERE ...同区间... AND booked_qty=0 AND price_night IS NULL
  AND qty IS NULL AND status='open' AND source='booking'
```

替换点：客户取消 `app.js:5058`、`expireBooking` `app.js:770`、商家会话态拒单 `app.js:5156`、HMAC confirm 过期单 `vendor_api.cjs:964`、HMAC cancel `vendor_api.cjs:992`。递减用 `GREATEST(...,0)` 兜底幂等。**这同时修掉旧副作用**（取消删行连带清 `price_night`，CLAUDE.md 规则 16 原文记载的行为）。

## 6. 商家房态写入（会话态 `app.js:5669-5747` 与 HMAC `vendor_api.cjs:850-903` 镜像同步）

入参：`{project_id, unit_id?, dates[], status: 'open'|'blocked', price_night?, qty?}`

| 分支 | 规则 |
|---|---|
| `blocked`（关房） | 目标晚中凡 `booked_qty>0` 者拒（400，须先取消订单）——沿用「已订晚不可关房」；upsert `status='blocked'`，不动 price/qty |
| `open` + price 和/或 qty | upsert 对应字段；**`qty` 须 ≥ 该晚 `booked_qty`**（不能放出少于已订的量），逐晚校验后写 |
| `open` 两者皆空（恢复默认） | `booked_qty=0` 的行照旧 DELETE；**有占用的行保留**，仅清 `price_night`/`qty` 回默认值（旧行为是整行删，会丢占用计数，必须改） |

`qty` 校验：正整数 1-999；`unit_id=0`（项目级）不收 `qty`（整栋容量恒 1）。已订晚保护查询由 `status='booked'` 改 `booked_qty>0`。

### units 侧 `total_qty` 写入口

| 通道 | 处理 |
|---|---|
| HMAC `units/create` / `units/update`（vendor_api.cjs） | 收 `total_qty`（1-999）；update 时若未来晚 `booked_qty > 新值` → 400 |
| 会话态商家 unit PUT（app.js） | 同上口径 |
| admin `PUT /admin/units/:id`（juzhu-admin-unit.html） | 收 `total_qty` 列写入 |
| B 端房态页房型下拉 | 文案带 `(N 间)`，只读展示 |

## 7. 读接口与页面

- **公开日历** `GET /projects/:id/stay-calendar`、商家 GET（会话态/HMAC `stay-calendar/query`）：`days[]` 每项新增 `qty`（放出间数）、`booked_qty`、`remaining`；`status` 即派生态。批量形状同。前端旧字段全部保留，纯增量。
- `b-stay-calendar.html`：批量卡加「放出间数」输入（与夜价并列，blocked 时也可设）；格子徽标 `剩 N` / `已订 X/N`；图例改「总数/已订/剩余」；点击翻转改小面板（关房/开房/设 qty）。
- `lvju-app-detail.html`：`noslot` 判定改 `remaining<=0`；新 `.cd.low` 低库存样式；格子文案 `仅剩X间`（≤2）；选段守卫按「区间最小剩余 ≥ 间数」。
- `lvju-app-booking.html`：unit 下拉旁加「间数」选择器（上限 = 选段内最小剩余）；合计 `× rooms`（**只乘合计，不改 `stayNightPrices` 单晚口径**）；payload 加 `rooms`；满房报错文案带剩余数。
- `juzhu-admin-unit.html`：「取消政策」卡同层加「总间数」input，走 `PUT /units/:id` 的 `total_qty` 列（不走 ext，原因见 §3.1）。

## 8. 迁移与回归

- **`scripts/stay-qty-init.cjs`**（幂等可重跑，模板 `stay-bookable-init.cjs`）：备份 `stay_calendar_bak_20260910` → 旧 booked 行 `booked_qty=1, status='open'` → `units.total_qty` 空值归一 → 分布报告。
- **既有脚本同步**：`stay-calendar-init.cjs` / `stay-bookable-init.cjs` 的「DELETE source='booking' 后重建」路径改写新模型行（`status='open'` + `booked_qty`），否则重跑会把新列冲掉。
- **新回归 `scripts/stay_qty_regression.cjs`**（PORT=38766 验证实例）断言：total_qty=3 时订 1 剩 2 → 订满剩 0 显示 booked → 第 4 间 400 → 取消回补 3 且商家夜价仍在 → qty 覆盖 1 生效 → 整栋单与 unit 单互斥 → **缺省单间 unit 全程行为与改造前一致**。
- **`housing_vendor_hmac_regression.cjs`**：`d.status==='booked'` 计数断言（L278-294）改 `remaining` 口径；units/create 带 `total_qty`、set 带 `qty` 用例。
- 真浏览器（/tmp/e2e playwright-core，MCP browser 缺 Chromium 不可用）：「仅剩 X 间」渲染 + B 端设置 qty。

## 9. 文档同步

- `screens/property-intake-api.html`：§3.2 加 `total_qty`；§3.3 加 `qty/booked_qty/remaining` 与 status 派生说明；§4.7/4.8/4.10 示例块；§5.1 set 入参与已订晚规则改写；§8 在线调试台模板（`stay-calendar/set` 加 `qty`、`units/update` 加 `total_qty`；标量字段自动进 HMAC 签名，无需改签名代码）。
- `api_doc.md` 对应段同步。
- `CLAUDE.md` 规则 16 增补：多间库存三元组、stored status 收敛、占用/释放不变式、迁移命令。

## 10. 明确不做（本期边界）

- 不同间不同价 / 房间号级库存追踪（计数模型的前提）。
- 订单逐晚明细落库（`booking_orders` 仍只有 `price_total` 快照，多间 = 同价放大）。
- 项目级（`unit_id=0`）`qty` 覆盖——整栋容量恒 1。
- 释放的跨订单精确对账（`GREATEST` 兜底 + 订单区间重算已够原型置信）。
- `projects.unit_count` / `managed_unit_count` 语义迁移（保持原义，避免统计口径漂移）。
