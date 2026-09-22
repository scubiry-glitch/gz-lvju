# M1-B 结算闭环：验收与说明

本轮范围：新居住权益**结算系统闭环**（逐券计算 → 结算账单 → 复核执行 → 异常处理 → 逆向处理 → 对账闭环 → 四端可查 → 专项验收）。需求基线为[开发计划](../../prd/PLAN-新居住券包与会员卡-v1.9.md) §5 D4/W4 与目标文档第 2–8 条完成标准。代码位于分支 `plan/newliving-coupons-membership-v1.9`，M1-A 业务底座之上。

## 交付口径（四态）

- **代码已实现 + 验证已通过**：逐券结算计算与账务、按商户/渠道/账期的账单（防重复入账）、复核与执行（申请审批分离）、失败受控重试、UNKNOWN 查原指令、重复回执幂等、部分退款/到期退款执行、误核销撤销冲回与追偿（含下期抵扣）、对账差异（责任人/处理/关闭）、四端视图、金额守恒不变量。专项验收 11 场景 + 浏览器 6 检查全绿（见 [results.json](results.json) 与截图）。
- **外部仍依赖**：`commerce_provider_requests` 是**沙箱机构镜像**，不是持牌机构。真实支付/代发/退款通道、双周批付、机构账单文件接入属 M1-B 真实资金范围；接入时仅需替换 `commerce/settlement.cjs` 的 `sandboxSubmit/sandboxQuery/sandboxSimulate` 三个薄壳为机构适配器，账务与状态机不动。
- **明确不做**：不把沙箱回执表述为真实到账；演示卡券（`is_demo`）整体游离于资金域外，不进结算。

## 数据模型（迁移 `004_settlement`，权威定义 `juzhu/mysql_schema.sql`）

| 表 | 作用 | 防重/约束 |
|---|---|---|
| `commerce_ledger_entries` | 追加式借贷分组账（funding/redemption/reversal/payout/refund/recovery） | 写入时断言每组借贷平衡；I1 复核 |
| `commerce_settlement_batches` | 商户/渠道 × 账期账单，状态 `draft→submitted→approved→executing→completed/closed`（+`frozen`） | `uk_batch_period` 同收款方同账期唯一 |
| `commerce_settlement_items` | 逐券结算明细（携带 `rule_ref` 规则版本、`basis/payable`） | **`uk_settle_once(redemption_id,line_kind)` 跨批次防重复入账** |
| `commerce_payout_instructions` | 付款/代发指令（`request_no` 唯一，重试沿用原号） | `batch_id` 唯一；UNKNOWN 只能查单 |
| `commerce_refund_orders` | 原路退款指令（case 建档、执行、回执） | `case_id`/`request_no` 唯一 |
| `commerce_receipts` | 机构回执（paid/failed/unknown） | `uk_receipt(request_no,digest)` 重复回执幂等去重 |
| `commerce_recovery_cases` | 追偿（撤销已结算核销产生；抵扣/到账/核销关闭） | 关闭必须写依据；全部过账 |
| `commerce_redemption_reversals` | 误核销撤销（申请-复核双控） | `redemption_id` 唯一，保留历史 |
| `commerce_recon_batches` / `commerce_recon_diffs` | 对账批次与差异（missing_local/missing_external/amount_mismatch/status_mismatch） | 差异关闭需非责任人复核 + 依据 |
| `commerce_provider_requests` | 沙箱机构镜像（submit/query/simulate） | `request_no` 主键，防重复付款 |

同时 `commerce_redemptions` 增加 `status/reversed_at`（撤销语义）；`coupon_id` 唯一索引改为普通索引（撤销保留历史后同券可再核销，改由核销事务在券行锁内防重，M1-A 行为不变）。

## 逐券计算口径（单一数据源在核销时刻锁定）

核销时按**订单锁定的规则快照**（`coupon.snapshot.rule`，来自购买时的 order item 版本）计算：
`beike = floor(分配×beike_bps/10000)`，`supplier = 分配 − beike`，`channel = 有推广归属 ? floor(beike×channel_bps/10000) : 0`，`retained = beike − channel`。未核销不产生核销记录与结算明细（I6）；金额可由快照复算（I5）。

## 权限（登记于 `perm_registry.cjs`）

- `commerce.fund.read` 只读总览/批次/指令/差异；`commerce.fund.write` 生成/提审/冻结/执行/重试/查单/回执/建档/抵扣/到账/对账/撤销申请；`commerce.fund.review` 批次复核、撤销复核、坏账核销、差异关闭。
- **申请与审批分离**：批次复核、误核销撤销复核、差异关闭均校验 `提交人 ≠ 复核人`（服务端闸，浏览器验证 reviewer 无生成/执行按钮）。
- 商户视角走 `commerce.merchant.read` + vendor 绑定（`GET /merchant/settlement`）；推广员/用户走本人账号（`/promotion`、`/my`）。

## 可重复验收

```bash
node scripts/commerce/settlement-test.cjs --browser   # 独立临时库，含浏览器阶段
node scripts/commerce/m1a-test.cjs                    # M1-A 回归 19 项
node scripts/perm_registry_snapshot.cjs               # 权限基线不漂移
node test_static_guard.js && node test_index_boot.js
```

专项场景与目标完成标准对应：SC1 部分核销、SC2 复核执行与冻结、SC3 重复回执、SC4 失败重试（上限 3 次、不换号）、SC5 超时未知查原指令、SC6 部分退款、SC7 到期退款、SC8 跨账期 + 已结算后冲回/追偿/抵扣、SC9 对账差异闭环、SC10 金额守恒不变量（I1 借贷平衡 / I2 订单守恒 / I3 不重复入账 / I4 回执与镜像无重复付款 / I5 计算可复算 / I6 未核销不确认佣金 / I7 退款结单一致）、SC11 权限闸与四端可查。

截图 `01–07`：运营结算页、批次详情（规则版本可追溯）、对账中心、退款执行、商户应结与到账、用户退款进度（390px）、推广员结算（390px）。

## 与目标的差异披露

- 机构能力矩阵（W0-02 的持牌机构实测）仍属外部依赖；本轮以确定性沙箱覆盖全部异常路径（失败/未知/重复回执/超时），接口形状即未来适配器契约。
- 「四端可查」中商户端不含自助提现申请（提现属 M1-B 资金通道），当前呈现应结/账单/到账/追偿。
- 试点正式资料、真实费率与账期参数（双周起算日、复核窗口、到账 SLA）待业务审批后配置，页面按账期显式输入，不内置推广性假设。
