# 民宿预订结算：真实接口与浏览器验收

2026-10-02（UTC+8）测试站走查通过。使用真实账号、后台权限、持久化结算数据和报表任务；机构为测试专用 `SYTEST_MOCK`，本次走查只读取资金与审批状态，仅为本批账单创建三种格式的导出任务，未提交付款、改单、规则变更或审批。本版在原六场景之上幂等补齐账单日与长租品类场景后复跑。

- [完整走查结果](results.json)：7 组检查，33 个业务接口请求，9 张截图，3 份实际下载。
- [最终只读复查](../booking-readonly/results.json)：6 组检查，15 个 GET 请求，8 张截图；明确核对 N=3 筛选及渠道已付 `996` 分。
- [场景清单](../booking-seed.json)：7 个场景、12 条应结、3 份账单（demo-stay 为含账单日场景的 v2）、3 条已发布规则。
- [资金与日期核对](../booking-verification.json)、[账务不变量](../booking-invariants.json)、[种子幂等记录](../booking-idempotency.json)。

完整走查保留首次截图；最终页面以 `booking-readonly` 截图为准，已补齐自动结算无需人工审批的展示，并核对待付推广款也具有离店后 N 天的时间下限。共享脚本缓存版本为 `20261002-7`。

## 验收口径

民宿/长租按下单时锁定的离店日期及结算规则 `booking_checkout_delay_days` 计算付款资格。N 必须为 0 至 3650 的整数，可选择自动结算或审核后结算；审核不会绕过到期时间。规则可另配 `billing_day`（每月 1–28 日）启用账单日模式：资格日后统一等到最近账单日随账单批量结算，出账周期由结算规则派生。本轮示例 N=3，无客户点击确认步骤。

| 场景 | 已核对结果 |
| --- | --- |
| `DEMO-STAY-PAID` | 商户已结 448.20 元；平台佣金划转 49.80 元；推广款已付 9.96 元 |
| `DEMO-STAY-REVIEW` | 商户 1,708.20 元应结待独立审核；仅查看审批详情 |
| `DEMO-STAY-WAITING` | 订单离店日为 2026-10-01，全部待付款项不得早于 2026-10-04 00:00（UTC+8） |
| `DEMO-STAY-STAYING` | 未离店，仅有订单对账记录，无可执行应付 |
| `DEMO-STAY-OFFLINE` | 线下房费仅用于对账，不生成站内付款明细 |
| `DEMO-STAY-CANCELLED` | 保留取消订单的历史对账资料，不生成可执行应付 |
| `DEMO-STAY-BILLDAY`（长租品类） | 商户 4,482.00 元应结：N=3 资格日 2026-10-04 后保持待结算，等到 2026-10-25 账单日随账单批量结算；小额平台/渠道佣金仍按逐笔规则到期结算 |

已付示例的推广款：`498.00 × 10% × 20% = 9.96 元`。订单房费、锁定佣金与实际资金流水分别列示，`BOOKING_ORDER.amount_minor=null` 显示为订单记录，不当成零元支付或缺失支付。

六个既有 `settlement_demo_*` 账号按原身份登录；财务和商家新增民宿主体权限，推广与平台继续读取自己的主体。商家、推广、平台访问其他主体账单均被拒绝，推广账号也不能读取商家导出任务。

## 最终页面及下载

- [民宿应结列表](../booking-readonly/01-booking-items.png)、[N=3 规则](../booking-readonly/02-booking-policies-N3.png)、[独立审批详情](../booking-readonly/03-booking-independent-review.png)。
- [商家账单](../booking-readonly/04-booking-statement-merchant.png)、[订单日期与锁定金额](../booking-readonly/04-booking-order-facts.png)、[推广已结 9.96 元](../booking-readonly/04-booking-statement-promoter.png)、[平台账单](../booking-readonly/04-booking-statement-platform.png)、[手机页面](../booking-readonly/06-booking-mobile.png)。
- 实际下载：[CSV](booking-statement.csv)、[XLSX](booking-statement.xlsx)、[PDF](booking-statement.pdf)。文件长度及 SHA-256 见完整结果。

手机页面未出现整页横向溢出；宽表在内部滚动。原有与新增页面本地接口回归共 33 项通过，包含 N 必填、整数范围、账单日 1–28 校验与展示、线上/线下渠道、独立协议与主体绑定、线下无付款入口、订单快照展示及原有鉴权/错误处理。

## 复查命令

在仓库根目录运行；凭据仅由宿主私有文件读取，不记录到报告或仓库。

```sh
node scripts/settlement/booking-live-walkthrough.cjs \
  --origin https://sytest.meizu.life \
  --manifest docs/verification/settlement-walkthrough/booking-seed.json \
  --base-manifest docs/verification/settlement-walkthrough/seed.json \
  --credentials /root/.config/sy-settlement-walkthrough/credentials.json \
  --output /root/.config/sy-settlement-walkthrough/booking-readonly \
  --read-only
```

去掉 `--read-only` 并使用独立输出目录可验证三种导出。脚本只允许清单内账单的导出 POST；同一导出请求沿用幂等键，过期文件使用新代际键重建，仍由后端校验原账单权限。不允许资金或规则写入。场景状态为各报告时间的快照，后续真实操作会改变状态，重复种子不会重置它们。
