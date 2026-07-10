# PRD-家政-00 · 全流程与中台认证

> 版本：v1.0 | 日期：2026-07-09 | 优先级：P0

---

## 1. 需求背景

新居住频道（`juzhu-channel-v3-grid.html`）在保租房、卖旧买新之外，新增**家政服务** Tab，覆盖保洁、维修、搬家、保姆四大品类。产品要求原型支持完整交易闭环，并与现有**服务认证中台**打通。

本 PRD 描述跨品类通用流程与中台认证约束；各品类差异见 01–04 分册。

---

## 2. 用户角色

| 角色 | 端 | 代表页面 |
|------|-----|----------|
| 租客 / 旅居客 | C | `juzhu-channel-v3-grid.html` |
| 服务者 | S | `s-orders.html`, `s-cert.html` |
| 平台运营 | P | `p-service-demand.html`, `p-console.html` |
| 房源运营商 | B | `b-dispatch-board.html` |
| 住建监管 | G | `g-whitelist-service.html` |

---

## 3. 全流程状态机

### 3.1 订单状态（对齐 `_orderbus.js`）

| 状态 | 编码 | C 端文案 | S 端文案 | P 端文案 | 触发方 |
|------|------|----------|----------|----------|--------|
| 待派单 | `pending` | 待派单 | 待接单 | 待派 | C 下单且支付成功 |
| 已派单 | `dispatched` | 已派单 | 待接单 | 已派单 | P/B 派单绑定服务者 |
| 已接单 | `accepted` | 处理中 | 待出发 | 已接单 | S 确认接单 |
| 服务中 | `serving` | 服务中 | 服务中 | 服务中 | S 标记出发/到场 |
| 已完成 | `done` | 待评价 | 已完成 | 已完结 | S 完工确认 |
| 已评价 | `rated` | 已评价 | 已评价 | 已评价 | C 提交评价 |

### 3.2 支付状态（独立维度）

| 状态 | 说明 |
|------|------|
| `unpaid` | 已下单未支付（15 分钟超时关单） |
| `paid` | 已支付，资金存管冻结 |
| `settled` | 服务完成 + 无争议，T+7 结算给服务者 |
| `refunded` | 退款完成 |

### 3.3 流程时序

```
C端                    支付网关              P中台                S端
 │                       │                    │                    │
 │──选SKU/填单───────────│                    │                    │
 │──创建订单─────────────│                    │                    │
 │──跳转收银台───────────│                    │                    │
 │──确认支付────────────►│──回调 paid────────►│──入工单池 pending   │
 │                       │                    │──规则派单──────────►│
 │                       │                    │    dispatched      │
 │◄──推送已派单──────────│                    │                    │──接单 accepted
 │                       │                    │                    │──出发 serving
 │                       │                    │                    │──完工 done
 │──评价 rated──────────►│                    │◄──评价回流──────────│
 │                       │                    │──信用引擎计分       │
```

---

## 4. 页面流转

### 4.1 C 端

```
juzhu-channel-v3-grid.html#家政
  → juzhu-jiazheng-list.html?type={category}
  → juzhu-jiazheng-detail.html?sku={slug}
  → [确认订单] → lvju-app-pay.html?order={id}
  → lvju-app-paid.html（支付成功）
  → repair.html?tab=progress&order={id}（进度查询）
  → lvju-app-review.html?order={id}（待评价时入口）
```

### 4.2 P 端

```
p-service-demand.html（工单池）
  → p-transaction.html（派单 + 分账预览）
  → s-orders.html（查看服务者侧状态）
  → p-service-review.html（评价回流后）
```

### 4.3 S 端

```
s-orders.html
  ├── 新单推送（dispatched）→ 接单 / 拒单
  ├── accepted → 出发
  ├── serving → 完工
  └── done → 等待客户评价
```

---

## 5. 中台认证体系

### 5.1 六步入驻（服务者）

来源：`p-onboarding-review.html`

| 步骤 | 名称 | 中台页面 | 输出 |
|------|------|----------|------|
| 1 | 在线提交 | `s-cert.html` 申请入口 | 申请单 |
| 2 | 实名核验 | `p-onboarding-review.html` | 人脸 + 人社库比对 |
| 3 | 资质审核 | `p-onboarding-review.html` | 证书/执照真伪 |
| 4 | 建档 | 中台自动 | 服务者档案 ID |
| 5 | 转培训 | `p-training-center.html` | 学习任务 |
| 6 | 颁证上岗 | `p-cert-issue.html` | L 级证书 + 上链 |

### 5.2 住建白名单（G 端）

`g-whitelist-service.html`：

- 服务者须通过住建厅 + P 中台双审
- 二维码验真（`portal-verify.html`）
- 工种标签：家政/保洁/维修/搬家/护理等

### 5.3 接单门禁规则

派单前中台校验（`p-traffic-policy.html` + 合规引擎）：

| 规则 ID | 条件 | 动作 |
|---------|------|------|
| R-101 | 无有效证书 | 不可派单 |
| R-102 | 不在白名单 | 不可派单 |
| R-103 | 未投保 | 不可派单 |
| R-107 | 社保断缴 | 不可派单（`v-team.html` 示例） |
| R-201 | 信用分 < 60 | 降权派单 |
| R-202 | 距离 > 15km | 不自动派单 |

### 5.4 评价回流

`p-service-review.html` → `p-credit-engine.html`：

- 客户评价：星级 + 标签 + 文字 + 晒图
- 差评（≤2 星）进入待处置队列
- 信用规则 R-001~R-218 自动计分
- 影响：派单权重、等级晋升、收入分成（`p-transaction.html` L 级分账表）

---

## 6. 数据字段（通用订单）

| 字段 | 类型 | 必填 | 来源 |
|------|------|------|------|
| `id` | string | ✓ | 系统 `WO-2026-xxxxx` |
| `category` | enum | ✓ | cleaning/repair/moving/nanny |
| `sku_id` | int | ✓ | jz_skus |
| `type` | string | ✓ | 中文品类名 |
| `desc` | string | | 用户备注 |
| `house` | string | ✓ | 房源地址（可关联 unit_id） |
| `phone` | string | ✓ | 联系电话 |
| `expectTime` | datetime | ✓ | 期望上门时间 |
| `fee` | int | ✓ | 订单金额（元） |
| `pay_status` | enum | ✓ | unpaid/paid/settled/refunded |
| `pay_method` | string | | 贝壳支付/微信/… |
| `status` | enum | ✓ | 状态机 |
| `worker` | object | | `{name, level, tags, cert_no}` |
| `rating` | object | | `{stars, tags[], text, images[]}` |
| `source` | string | | 旅居客 App / 房源运营方 / … |
| `log` | array | ✓ | 状态变更审计 |

---

## 7. API（本地 + Key）

详见 `DESIGN-新居住家政服务频道.md` §6。

**创建订单示例：**

```http
POST /api/juzhu/jiazheng/orders
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "sku_id": 12,
  "category": "cleaning",
  "house": "东博人才公寓 2-1503",
  "phone": "13800138000",
  "expectTime": "2026-07-10 14:00",
  "desc": "厨房油污重，需深度清洁"
}
```

---

## 8. 非功能需求

| 项 | 要求 |
|----|------|
| 部署 | 本地 `python3 juzhu/server.py`，端口 8765 |
| 鉴权 | Admin/写接口 API Key |
| 原型联动 | 静态演示可用 `_orderbus.js` localStorage |
| 风格 | `lvju-app.css` 品牌色，430px 移动端壳 |
| 参考图 | 布局可参考，字段/色板不变 |

---

## 9. 验收用例

| # | 场景 | 预期 |
|---|------|------|
| 1 | C 端任一品类的 SKU 下单并支付 | 工单池出现 pending 单 |
| 2 | P 端派单给 L3 持证服务者 | S 端收到推送，状态 dispatched |
| 3 | 派单给未持证人员 | 中台拦截并提示 R-101 |
| 4 | S 端完整推进到 done | C 端显示待评价 |
| 5 | C 端提交 5 星评价 | P 端评价回流，信用分变动 |
| 6 | 全流程本地 server 重启 | 落库订单不丢失（API 模式） |
