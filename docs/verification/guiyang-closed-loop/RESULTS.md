# 贵阳生活服务频道 · 权益四端闭环验收报告

日期：2026-09-20。分支：`plan/newliving-coupons-membership-v1.9`。
范围：以贵阳生活服务频道为试点的**单品券、券包、会员**从购买/兑换、权益到账、预约、核销到售后的四端业务闭环（无资金联调版）。订单与售后复用主站 `gr_orders` / `jz_orders`。
目标与验收标准来源：会话 Goal（2026-09-19 设定）；总纲见 [GOAL 文档](../../prd/GOAL-新居住权益闭环验收.md)。

**结论：六项工作项全部 PASS，完成门槛五条全部满足，线上（sytest 预览域名）验证通过。全程实际支付与佣金为零。**

## 1. 证据等级说明

- **隔离数据库验收**：`node scripts/commerce/m1a-test.cjs --guiyang-demo --browser` 每次运行创建独立临时 MySQL 库（含主站订单/工单表结构），结束删除。共 **49 项**（服务端 34 + 浏览器 15）全部 PASS，结果写入 `../newliving-commerce-m1a/results.json`。
- **线上验收**：sytest 预览域名（`https://sytest.meizu.life`，commerce 服务 127.0.0.1:38780，已加载本轮代码并应用迁移 `003_exchange_code_admin`）。只读 + 可逆操作（发码后全部停用），10/10 PASS，见 [live-check.json](live-check.json)。
- **权限与主站复用回归**：IAM 五套件（权限注册 2 + 权限闸 67 + 登录安全 25 + 数据范围 20 + 账号中心 22）与主站复用回归 5 项全部 PASS。
- 本报告不证明真实支付、正式 SSO 之外的机构级资金能力；该边界见 GOAL 文档第 5 节（M1 附加验收）。

## 2. 六项工作项验收

| 工作项 | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 会员与卡券 | 可按可用、已使用、已过期筛选；会员与赠券期限分别展示；多次购买的权益批次可追溯 | PASS | C 端「我的卡券」新增 全部/可用/已使用/已过期 筛选 chips（含计数与空态，浏览器验证 `Browser coupon wallet filters…`）；会员页「会员有效期至 X」与赠券「领券后 N 天有效 / 到期日以我的卡券为准」分开展示（`member-pass` / `member-validity-note`）；每张券落 `commerce_coupons(order_id,item_id,unit_no)`，券详情与会员记录可跳转所属订单，续费/重复购买产生独立订单批次 |
| 兑换码管理 | 批量生成、查询、停用、兑换记录；已兑换码不可再次使用；库存不足不吞码 | PASS | `POST /admin/exchange-codes` 支持 `quantity`（1–200）一次发放、码各自独立 128bit；`GET /admin/exchange-codes?state=unused/redeemed/expired/disabled&kind=&q=` 分页查询 + 汇总，兑换记录含兑换账号与到账订单（明文码仅生成时展示一次，哈希不落接口出参）；`POST /admin/exchange-codes/{id}/disable` 停用（已兑换 409、重复停用幂等、审计留痕）；隔离库用例 `Batch issuance…`、`Code list…`、`Disable keeps…`、`Insufficient stock rolls back the code claim…`（事务回滚后码保持未兑换、库存恢复后可再次兑换）；新管理页 `screens/commerce-admin-exchanges.html`（浏览器验证批量发码→停用→兑换记录查询） |
| 商户履约 | 商户查看当日预约、预览待核销服务、确认核销；二维码及手动方式都跑通，失败原因明确 | PASS | 商户「预约管理」默认按当日过滤（可改日期），商户视图每条预约带服务项目与客户（服务端水合）；`POST /merchant/redeem/preview` 与正式核销同一套校验但零副作用（不写核销、不消费令牌、不改变券状态，隔离库 `Redemption preview shows the service without any side effect…`）；核销对话框两段式：扫码枪/摄像头/手动录入 → 「核对服务（不核销）」→ 确认核销；二维码 `NLV1:<券编号>:<动态码>` 真实解码回归 + 手动录入同一接口；失败带结构化错误码与中文原因：`no_redeem_auth` 未授权门店 / `coupon_unavailable` 已使用或冻结 / `token_invalid` 动态码失效 / `no_appointment` 未预约 / `not_service_date` 非当日（HTTP 错误体断言 `coupon_unavailable`） |
| 订单与售后 | 主站订单可追踪到账、预约、核销；售后工单受理、派单、处理结果同步回用户端 | PASS | 演示购买/兑换在同一事务写主站 `gr_orders`（同号复用）；新接口 `GET /my/orders/{id}` 返回逐券「到账→预约→核销」链（仅本人，他人 404），主站订单详情页对权益订单渲染「履约进度」区块；售后同事务写主站 `jz_orders`（`pay_status=not_required`，无付款入口），主站派单/处理完成后回写权益侧状态；主站复用回归 4 项 + 浏览器页面检查 PASS（`Main order centre…`、`Main dispatch and processing…` 等） |
| 推广闭环 | 分享、登录回跳、演示下单的归属可追踪；篡改来源无效；演示统计与真实佣金分开 | PASS | 分享链接 HMAC-SHA256 签名（7 天有效），篡改/过期/版本不符/跨商品均拒绝（`Signed single-level referrals…` + `Demo orders record signed referral attribution…`）；演示购买现携带 `ref` 并落 `commerce_orders.source_account_id`（无归属为 NULL）；推广员统计只见本人归因，并拆分 `demo_orders` / 真实订单，`demo_note` 明示分开呈现；演示商品规则 `beike_bps=0,channel_bps=0`，核销后各分账恒为 0；真实购买接口保持 409 关闭 |
| 运营与异常 | 展示发放、预约、核销、兑换及售后统计；失败记录可定位，允许重试的操作不会重复发放 | PASS | 新接口 `GET /admin/stats` + 新管理页 `screens/commerce-admin-stats.html`：发放（可用/核销/冻结）、订单（演示/真实）、预约（今日待履约）、核销（各分账）、兑换码（四态汇总）、售后（八态）六组 KPI；失败记录：业务失败（403/404/409/422 的 POST）在事务外落 `commerce_audit(action='operation.failed')`，统计页展示累计数与最近 20 条（接口+原因），隔离库断言失败行存在且原因可读；所有写操作经 `commerce_idempotency`（同键同内容返回原结果、异内容 409），连点/重试不重复发券、不重复核销、不超卖（`Concurrent stock reservation…`、`Concurrent appointments…`、`Verified internal fulfillment once…`、兑换竞态用例） |

## 3. 完成门槛逐条

| 门槛 | 结果 | 证据 |
|---|---|---|
| 覆盖三类商品（单品券/券包/会员）、两种领取方式（演示购买/兑换码）、两种核销方式（二维码/手动录入），以及改期、取消、过期、售后场景，关键路径全部通过 | PASS | 三类商品兑换与购买分别到账（`Single, package and membership codes…`、`Demo package and member issue…`）；QR 真实解码+手动录入同接口（浏览器 `Browser QR round-trip…`）；改期失败保留原预约、取消释放名额（`Concurrent appointments…` + `Demo coupon appointment and refund…`）；到期自动冻结并建原路退款待处理单、演示单标记无实际退款（`Unused expiry queues one original-source refund…`）；退款冻结与核销互斥、受理/派单/结单同步（主站复用回归） |
| 至少两个用户、三家演示商户完成交叉验收，跨用户、跨商户访问被拒绝 | PASS | 隔离库用例 `Two customers and three demo merchants reject every cross-account access`：客户 A 兑换 3 家演示商户各 1 张券，客户 B 取 token/追踪订单被拒（403/404）；每家商户核销员对他人商户的券 preview 被拒（403），对本商户 preview→核销成功，重复核销被拒；另有既有跨推广员明细隔离、商户只见本商户应结等断言 |
| 重复提交、并发操作、服务重启后，无重复发券、重复核销、库存超卖或记录丢失 | PASS | 并发：6 并发下单仅 2 单成功、并发预约满额第 2 单失败、兑换码并发竞态仅 1 人得券、核销与退款并发恰好一方成功；重复：同幂等键重试返回原订单/原结果，重复支付事件只发一批券，到期任务重复执行只退一次；重启：状态全部落 MySQL（M1-A 持久化），定时任务（预占超时/到期扫描）30 秒周期幂等，线上服务本轮已实际重启并复验（`sy-commerce-preview.service` restart → live-check 全绿） |
| 手机端各页面的正常、空白、失败、无权限状态均可用 | PASS | 浏览器断言 320/390/430/1440 无横向溢出；正常（卡券/会员/选券）、空白（空城市/空筛选/无记录）、失败（接口 503 → 「暂时无法加载」+ 重载按钮；preview 失败原因内联展示）、无权限（匿名登录引导、无权限角色提示页）均有浏览器检查与截图（`Browser anonymous, permission denial, server failure and retry states`、`coupons-filter-empty-390.png` 等） |
| 交付验收报告、操作说明和演示数据清单；实际支付与佣金保持为零 | PASS | 本报告 + [操作说明](OPERATION.md) + [演示数据清单](DEMO-DATA.md)；全部订单 `amount_minor=0`、`paid_minor=0`，分账字段恒 0（服务端逐单断言），`POST /orders` 真实购买保持 409，`payment_enabled:false`（线上 meta 实测） |

## 4. 测试命令与结果汇总

| 命令 | 结果 |
|---|---|
| `node scripts/commerce/m1a-test.cjs --guiyang-demo --browser` | 49/49 PASS（服务端 34 + 浏览器 15；含幂等/并发/库存回滚/兑换码管理/交叉矩阵/会员生命周期/推广归属/结构化错误码/统计与失败审计） |
| `node scripts/commerce/m1a-iam-regressions.cjs` | 权限注册 2、权限闸 67、认证安全 25、数据范围 20、账号中心 22 全 PASS |
| `node scripts/commerce/m1a-iam-regressions.cjs --main-reuse` | 5/5 PASS（主站订单幂等关联、售后入池、派单处理回写、页面渲染） |
| `node scripts/commerce/m1a-public-smoke.cjs` | 16/16 PASS（线上只读：目录、页面、匿名 401、管理页可达、无脚本错误） |
| `node --test scripts/commerce/domain.test.cjs scripts/commerce/http.test.cjs` | 18/18 PASS（M0 域模型回归保持绿） |
| `node test_index_boot.js` / `node test_static_guard.js` | PASS（首页启动、commerce 源码目录静态拦截） |
| `node scripts/commerce/live-closed-loop-check.cjs` | 线上 10/10 PASS（登录态：统计聚合、兑换记录空态、批量发码、停用、停用可审计；所发验证码已全部停用，无遗留活码） |
| `node scripts/commerce/live-console-screens.cjs` | 线上管理页/卡券筛选页截图 0 脚本错误（见本目录 PNG） |

截图：[live-exchange-console-1440.png](live-exchange-console-1440.png)（线上兑换码管理页：筛选/汇总/停用）、[live-stats-1440.png](live-stats-1440.png)（线上运营统计）、[live-coupons-filter-390.png](live-coupons-filter-390.png)（390px 卡券筛选）；隔离库过程截图见 `../newliving-commerce-m1a/`、`../member-wallet/`、`../guiyang-life-demo/`。

## 5. 边界与遗留

- 本轮为**无资金联调版**：不发生真实扣款、结算、提现与退款到账；「待退款通道」单据不标注已退款。真实交易放行须另过 GOAL 文档第 5 节 M1 附加验收，不继承本报告 PASS。
- 工作区同时包含其他会话的结算（commerce.fund.*）相关改动；本报告数字以当前工作区整体回归（49 项 + IAM + 复用 + 线上）为准。
- 线上预览库中的真实兑换记录为空属预期（演示站点尚无真实访客兑换）；兑换记录能力由隔离库用例覆盖，线上接口空态已验证。
- `composer` 页面缓存版本号已提升（`?v=20260919-5`），线上服务已重启加载迁移 `003_exchange_code_admin`。
