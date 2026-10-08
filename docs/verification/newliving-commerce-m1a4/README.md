# M1-A4 运行验收报告：新居住权益系统

日期：2026-09-20。分支：`plan/newliving-coupons-membership-v1.9`。
范围依据：[整体实施计划](../../prd/ROADMAP-新居住权益运营与结算闭环-20260920.md) M1-A4——异常任务查询和受控重试、监控、性能测试、备份恢复、发布回退、操作手册。
目标：验证系统在正常运行、并发操作、网络异常、服务中断及恢复后的正确性，达到可持续开展**无资金试运营**的标准。

**结论：8 项执行任务全部完成，无未解决的阻断缺陷。全部结论附可重跑测试（本目录与各 results.json）或实际操作证据。**

---

## 1. M1-A2 / M1-A3 交付状态核对（先决条件）

| 阶段 | 范围 | 核对结论 | 证据 |
|---|---|---|---|
| M1-A2 运营闭环 | 卡券筛选与批次、会员续购、兑换码批量、商户预约与核销预览、订单售后联动、推广归属与统计 | **PASS（本轮补齐 1 处缺口）** | [贵阳闭环验收](../guiyang-closed-loop/RESULTS.md)（49 项+IAM 136+线上 16）；缺口=会员续购有效期不顺延，本轮已修（`fulfillPaidOrder` 自原到期日叠加，SC12 断言） |
| M1-A3 结算业务闭环 | 结算规则版本、逐券计算、追加账务、账期批次、复核执行、退款冲回、追偿、对账差异、四端查询 | **PASS（本轮补齐 1 处缺口）** | [结算闭环验收](../newliving-commerce-settlement/README.md)（17 项+I1–I7）；缺口=已核销服务失败的先行赔付未实现，本轮补齐（`005_compensation` 迁移 + 申请/独立复核/过账/应收代偿联动 + I8 不变量，SC13 断言） |

**缺失能力依赖清单**：除上述两项（已修复并回归）外无缺失。赔付追偿的**真实资金**侧与机构通道归属 M1-B1/M1-B2，不在本阶段。

## 2. 验收基线（任务 1）

**服务与进程**

| 组件 | 入口 | 端口 | 说明 |
|---|---|---|---|
| 权益 API（M1-A 域） | `commerce/app.cjs`（systemd `sy-commerce-preview.service`） | 127.0.0.1:38780 | `/api/commerce/v1/*`；支付关闭（`payment_enabled:false`） |
| 主站 API | `app.js`（systemd `juzhu-api.service`） | 8766 | 账号中心/家政/房源；commerce 身份经账号中心会话 |
| Nginx | sytest.meizu.life | 443 | `/api/commerce/v1/` → 38780，其余 → 8766；静态白名单 |
| 探活 | `GET /api/commerce/v1/healthz` | — | 匿名可用；返回 DB 可达性与迁移版本（本轮新增） |

**定时任务**：`service.expire()` 每 30s（app.cjs 主进程 setInterval）——预占超时释放、到期卡券自动建原路退款 case；逐单独立事务、幂等可重入（ENV-4/ENV-5 验证）。

**数据库迁移**（`commerce/migrations`，执行入口 `commerce/migrate.cjs`）：`001_m1a`（业务底座 21 表）→ `002/003`（兑换码及管理）→ `004_settlement`（结算域 12 表 + redemptions 撤销语义）→ `005_compensation`（先行赔付）。幂等、带校验和、支持旧库无损升级（REC-3 实测）。

**关键接口**：catalog/referral（匿名只读）、me/my/orders/appointments/cases/token（本人）、merchant redeem（门店授权）、admin 配置与结算（`commerce.admin.*` / `commerce.fund.*` 权限点，全部登记 `perm_registry.cjs` ROUTES）。

**外部依赖**：仅 MySQL（本机 8.0.45）。无资金模式无支付机构依赖；持牌机构沙箱与真实资金属 M1-B1/B2。

## 3. 验收清单与证据索引（任务 2–7）

| 功能域 | 异常场景 | 预期结果 | 证据 |
|---|---|---|---|
| 幂等与重复提交 | 同键同内容重放 / 同键异内容 / 失败后重试 | 回放原结果；409；失败事务不留键可安全重试 | ops ENV-1 |
| 网络异常 | 客户端断连/超时中断 | 服务端事务完整，无半状态；幂等键重放安全 | ops ENV-2 |
| 数据库事务失败 | 核销事务中途注入失败 | 订单/券/库存/账务计数与失败前完全一致；随后真实核销恰好一次 | ops ENV-3 |
| 服务中断 | 服务重启 | 状态零丢失；healthz 恢复；定时任务幂等续跑 | ops ENV-4 |
| 任务中断 | 到期扫描遇单条脏数据 | 报错可见不静默；修复后不丢不重（每券恰好一个退款单） | ops ENV-5 |
| 回执异常 | 重复成功回执 / 乱序失败与未知回执 | 不重复入账；状态反转 409 | ops ENV-6、结算 SC3/SC5 |
| 结算未知 | UNKNOWN 指令 | 只能查原指令；重试被拒；不换号重付 | 结算 SC5、ops ALERT-2 |
| 失败任务 | 重试达上限 | 保持 failed 可查可解释；持续告警转人工不静默丢弃 | ops ALERT-3 |
| 监控告警 | 12 条规则（服务不可用/发放积压/到期滞留/退款滞留/结算未知/重试达限/付款无回执/对账差异/失败突增/赔付滞留/到期预告/不变量异常） | 每项含阈值、查看入口、处理步骤、责任角色；注入触发→处理→恢复全链实测 | ops ALERT-1/2、浏览器 08/09 截图 |
| 并发正确性 | 200 并发兑换抢 100 库存；50 并发预约抢 10 名额；30 路并发核销同一券 | 恰好 100/10/1 成功；零超卖、零超额、零重复 | perf PERF-2/3/4 |
| 性能 | 商品浏览、本人权益、兑换、预约、核销 P95；万级结算明细 | P95≤1s 全部满足（最大 455ms）；万级批次生成 3.9s/执行 345ms/内存 139MB、金额精确 | [PERFORMANCE.md](PERFORMANCE.md) |
| 备份恢复 | 全库损坏后还原 | 逐表行数/金额/账务合计一致；不变量全绿；RTO 实测记录 | [RECOVERY.md](RECOVERY.md) REC-1/2 |
| 迁移升级 | 001-003 旧库 → 005 | 业务数据零变化；ALTER 幂等 | RECOVERY REC-3 |
| 发布回退 | 回退到上一已验收版本代码 | 服务可启动、接口可用；业务历史与已记账务零变化 | RECOVERY REC-4 |
| 四端回归 | 用户/商户/运营/推广端核心路径；正常/空/失败/无权/登录失效；390px 移动端 | 全部可用；会话撤销后回登录引导 | M1-A 49 项 + 结算 6 项 + 本轮 5 项浏览器检查（11-session-revoked 截图）+ 线上只读冒烟 |
| 账务一致性 | 每阶段收口 | I1–I8 不变量全绿（借贷平衡/订单守恒/不重复入账/无重复付款/计算可复算/未核销不确认佣金/退款一致/赔付联动代偿） | `verifyInvariants`（结算 SC10、ops 各阶段断言） |

## 4. 本轮修复的缺陷（发现于验收过程中）

| 缺陷 | 影响 | 修复 |
|---|---|---|
| 并发预约死锁（ER_LOCK_DEADLOCK） | 高并发改期/首订时部分请求 500 | 容量行改"先 UPDATE 缺行才 INSERT"+事务层死锁自动重试（≤3 次） |
| 会员续购有效期不顺延（A2 缺口） | 续费重叠损失有效期 | 自原到期日叠加，`extends_from` 留痕 |
| 已核销赔付缺失（A3 缺口） | 服务失败无先行赔付闭环 | 005 迁移 + 双控赔付 + 应收代偿联动追偿 + I8 不变量 |
| I4a 口径过严 | 重复成功回执（不同 payload）误报 | 改为账务口径：每笔指令最多一次出金过账 |

## 5. 命令汇总（全部可重跑）

```bash
node scripts/commerce/m1a4-ops-test.cjs --browser      # 异常恢复+告警实测+浏览器 14 项
node scripts/commerce/m1a4-perf.cjs                    # 性能 13 项（含万级结算）
node scripts/commerce/m1a4-backup-restore.cjs          # 备份恢复/升级/回退 8 项
node scripts/commerce/m1a-test.cjs                     # M1-A 回归 19 项
node scripts/commerce/settlement-test.cjs --browser    # 结算闭环 19 项
node scripts/commerce/m1a-iam-regressions.cjs          # IAM 136 项
node test_static_guard.js && node test_index_boot.js   # 静态防护/首页启动
```

配套文档：[PERFORMANCE.md](PERFORMANCE.md) · [RECOVERY.md](RECOVERY.md) · [RUNBOOK.md](RUNBOOK.md)（异常处理手册） · [DAILY-CHECK.md](DAILY-CHECK.md) · [KNOWN-ISSUES.md](KNOWN-ISSUES.md)

## 6. 边界与披露

- 全程无资金模式：沙箱机构回执不标注为真实到账；演示卡券游离于资金域外。
- 持牌机构沙箱联调（M1-B1）与小范围真实资金试点（M1-B2）为后续独立阶段，本报告不覆盖。
- 线上（sytest 预览域名）为演示环境：不承载真实商户签约数据；性能数字为该环境实测（2 vCPU 容器），生产容量规划需另测。
