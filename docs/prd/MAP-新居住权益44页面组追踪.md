# 新居住权益 · 44 页面组追踪表

> 依据 [PLAN-新居住券包与会员卡-v1.9](PLAN-新居住券包与会员卡-v1.9.md) §10 QA-01（"44页面组矩阵"）
> 建账。**编号语义限制**：v1.9 的 C01–C11 / B01–B10 / A01–A14 / Q01–Q09 完整编号表在仓库外需求文档中，
> 本表先按「端 × 职责」逐页建账并标注实现状态；拿到编号表后在「组号」列回填即可机械对账。
> 状态口径：✅ 可用 · ⚠️ 受限（写明原因）· ❌ 未实现。所有「可用」均指无资金演示口径。

## 1. C 端 · 消费者（组号段 C01–C11，物理 4 页 + 2 个入口模块）

| 页面组（职责） | 组号 | 物理页面 / 入口 | 状态 | 备注 |
|---|---|---|---|---|
| 生活权益首页（卡券/会员/快捷入口/专题） | C01 | `juzhu-commerce.html` | ✅ | 演示购买受 `JUZHU_ENV==='test'` 闸 |
| 选券列表（搜索/分类筛选） | C02 | `juzhu-vouchers.html` | ✅ | |
| 单品/券包/会员详情（购买决策页） | C03 | `juzhu-voucher.html?kind=&id=` | ✅ | 真实购买 CTA 随支付中台接入（支付会话） |
| 我的卡券（状态筛选/核销码） | C04 | `juzhu-commerce.html?view=coupons` | ✅ | 120s 动态码 |
| 服务预约 / 改期 / 取消（含通兑选店） | C05 | `?view=appointments` | ✅ | 产能条件更新防超卖 |
| 我的订单（主站订单中心承接） | C06 | `juzhu-jiazheng-orders.html`（`is_commerce` 分支） | ✅ | |
| 售后申请 + 退款/赔付进度 | C07 | `?view=cases` | ✅ | 退款"已到账"为沙箱口径 |
| 酒店通兑名录与选店 | C08 | `juzhu-hotels.html` | ✅ | 演示抽样 48 家 |
| 会员开通与我的会员 | C09 | `?view=memberships` | ✅ | 续费顺延 |
| 兑换码兑换 | C10 | `?view=account` 兑换入口 | ⚠️ | 仅 test 环境开放（演示闸） |
| 首页领券中心 rail | C11 | `index.html` + `screens/_commerce-entry.js` | ⚠️ | 探活失败时首页无权益入口（优化清单 1.2-#6 返回路径加固待做） |

## 2. B 端 · 商户（组号段 B01–B10，物理 15 页）

| 页面组（职责） | 组号 | 物理页面 | 状态 | 备注 |
|---|---|---|---|---|
| 商户经营概览 | B01 | `screens/commerce-merchant.html` | ✅ | |
| 本商户档案 | B02 | `screens/commerce-merchant-merchants.html` | ✅ | 商户自助编辑属 M2 |
| 门店管理 / 核销人员 | B03 | `-stores.html` / `-staff.html` | ✅ | |
| 券商品（核销方式/通兑档/价格） | B04 | `-skus.html` | ✅ | 商户建草稿→平台复核发布 |
| 库存 / 预约产能 | B05 | `-inventory.html` / `-capacity.html` | ✅ | |
| 订单（本商户范围） | B06 | `-orders.html` | ⚠️ | 真实订单随支付接入（支付会话） |
| 预约管理（默认当日） | B07 | `-appointments.html` | ✅ | |
| 核销（preview+confirm 两段式/扫码） | B08 | `-redemptions.html` | ✅ | 误核销撤销走 P 端双控 |
| 卡券台账 | B09 | `-coupons.html` | ✅ | 剥离 token/佣金字段 |
| 售后回复 | B10 | `-cases.html` | ✅ | 商户只能回复，退款由平台执行 |
| （多余页）商户态「退款执行」「对账中心」 | — | `-refunds.html` / `-reconciliation.html` | ❌ | **死页**：后端无 `/merchant/refunds|reconciliation` 路由，商户点开 404；商户态 tab 已列入优化清单 1.2-#1 待修（`_commerce-management.js` 归支付会话修改集，本轮避让） |

## 3. P 端 · 运营（组号段 A01–A14，物理 22 页）

| 页面组（职责） | 组号 | 物理页面 | 状态 | 备注 |
|---|---|---|---|---|
| 运营概览 / 开售状态披露 | A01 | `screens/commerce-admin.html` | ✅ | 文案动态化随支付接入 |
| 商户/门店/人员管理 | A02 | `-merchants/-stores/-staff.html` | ✅ | |
| 券商品/报价与分配规则/券包/会员方案 | A03 | `-skus/-rules/-packages/-plans.html` | ✅ | 提审→独立复核→发布 |
| 库存 / 产能 | A04 | `-inventory/-capacity.html` | ✅ | |
| 订单与发放 | A05 | `-orders.html` | ⚠️ | 真实订单随支付接入 |
| 预约 / 核销记录 | A06 | `-appointments/-redemptions.html` | ✅ | 核销后确认逐券分配 |
| 卡券 / 会员 / 售后工单 | A07 | `-coupons/-memberships/-cases.html` | ✅ | |
| 兑换码批量管理 | A08 | `-exchanges.html` | ⚠️ | 仅 test 环境（演示闸） |
| 运营统计 + 运行告警 | A09 | `-stats.html` | ✅ | KPI 排除演示核销 |
| 操作审计 | A10 | `-audit.html` | ✅ | |
| 结算账单（批次/指令/回执/沙箱） | A11 | `-settlement.html` | ✅ | 沙箱机构，不代表真实资金 |
| 退款执行 | A12 | `-refunds.html` | ✅ | UNKNOWN 不重付；真实通道随 M1-B |
| 对账中心（差异/撤销/赔付/追偿） | A13 | `-reconciliation.html` | ✅ | 提交人≠复核人 |
| 演示账号与一条龙路径 | A14 | `screens/commerce-demo-accounts.html` | ✅ | 仅 sytest |

## 4. 推广员端（组号段 Q01–Q09，物理 1 页 2 tab）

| 页面组（职责） | 组号 | 物理页面 | 状态 | 备注 |
|---|---|---|---|---|
| 推广选品（佣金预估/筛选排序） | Q01–Q03 | `juzhu-promoter.html`（catalog tab） | ✅ | 演示商品恒 0 佣金 |
| 分享链接（HMAC 签名 7 天）+ 点击埋点 | Q04 | 同上 | ✅ | `promoter_gate` 缺省演示期开放 |
| 提现及记录 | Q05 | — | ❌ | `withdrawal_enabled:false`；属 M1-B 资金通道，**v1.9 范围需显式裁决**（优化清单 1.1-#4） |
| 推广 KPI + 逐券明细/归因订单/代发抽屉 | Q06–Q08 | 同上（promotion tab） | ✅ | 已到账为沙箱代发口径 |
| 资格状态横幅 | Q09 | 同上 | ✅ | share_qualified 三态 |

## 5. 对账要点

- 物理计数：C 端 4 页 + 推广员 1 页 + B 端 15 页 + P 端 22 页 + 演示账号 1 页 = **43 页** + `index.html` 入口模块 = 44 个可指认单元，与「44 页面组」数字巧合来自「合并（C/Q 端一页多组）+ 拆分（B/P 端一组多页）」的双向偏离。
- M1-A 验收文档写「运营中心 16 个管理页面」，实际 P 端 21 子页——勘误随本表落地（优化清单 1.4）。
- 导航自含（2026-10-02）：38 个工作台/演示页挂 `screens/_commerce-nav.js`，跨端总图以 `overview.html` 为准（已补登商户子页与 `juzhu-voucher.html`）。
