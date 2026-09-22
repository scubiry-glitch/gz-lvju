# M1-A4 异常处理手册（Runbook）

告警实时视图：运营统计页「运行告警」卡（`GET /api/commerce/v1/admin/settlement/alerts`，需 `commerce.fund.read`）。
探活：`GET /api/commerce/v1/healthz`（匿名）。责任角色：**系统负责人**（服务/任务/数据）、**平台运营**（业务受理/积压/对账指派）、**资金复核**（资金指令/赔付/差异关闭）。

| 告警 | 级别 | 触发阈值 | 处理步骤 | 责任 |
|---|---|---|---|---|
| 服务不可用 service_unavailable | 严重 | healthz 连续失败（外部探活 30s×3） | ① `systemctl status sy-commerce-preview` 看退出原因 ② `journalctl -u sy-commerce-preview -n 100` 定位（DB 连接/迁移校验） ③ 修复或按 RECOVERY.md 回退上一已验证版本 ④ healthz + 运营统计页复核 | 系统负责人 |
| 发放/预占积压 grant_backlog | 严重 | 过期 reserved 订单 >0 | ① 记录滞留订单号（`commerce_orders status='reserved' AND expires_at<NOW()`）② 检查定时任务日志（Commerce expiry failed）③ 重启服务触发一轮 expire ④ 仍不释放则查库存行锁/事务失败 | 平台运营 |
| 到期处理滞留 expiry_pending | 警告 | 已过期仍 available 的券 >50 | ① 定位阻塞扫描的损坏券数据（服务日志） ② 修复该行后任务自动续跑 ③ 禁止批量改库，到期券逐单建原路退款 case | 平台运营 |
| 退款滞留 refund_stuck | 警告 | 退款单 pending/submitted 超 24h >0 | ① 退款执行页查 fail_reason 与 retry_count ② pending 可执行/作废 ③ submitted 超 24h 走查单 ④ 主动与用户沟通到账时限 | 平台运营 + 资金复核 |
| 结算结果未知 instrument_unknown | 严重 | payout/refund unknown >0（即时） | **只能对原请求查单**（结算页「查原指令」/退款页「查原指令」）；禁止重试、禁止换号重付；查实后按回执推进；仍未知联系机构核实 | 资金复核 |
| 重试达上限 retry_exhausted | 严重 | failed 且 retry_count≥3 | **转人工**：① 与机构人工核实原请求最终状态 ② 机构已付→登记对账差异处理，禁止改单 ③ 确认失败→机构侧修正后人工放行重试 ④ 全程留痕 | 资金复核 |
| 付款指令无回执 payout_stuck | 警告 | submitted 超 24h 无回执 | 查单；机构侧无记录则生成对账差异并跟进 | 资金复核 |
| 对账差异未闭环 recon_diff_open | 警告 | open/processing >0 | 平台运营指派责任人→处理并记录→资金复核（非责任人）关闭；关账前差异须全部关闭 | 运营+资金复核 |
| 业务失败突增 operation_failures | 警告 | 近 1h operation.failed >50 | 运营统计页「近期失败记录」聚合原因；区分用户误操作与系统性故障；系统性按对应条目处理 | 系统负责人 |
| 赔付复核滞留 compensation_pending | 警告 | pending 超 24h | 24h 内完成赔付复核（同意/拒绝）；超 SLA 上报升级 | 资金复核 |
| 账务不变量异常 invariant_broken | 严重 | I1–I8 任一失败（即时） | **停手排查**：① 停止生成新账单/执行资金指令 ② 按失败项定位（I2 守恒/I3 重复/I4 镜像/I8 赔付联动）③ 排查结论与修复留档 | 系统负责人+资金复核 |
| 到期退回预告 expiring_soon | 信息 | 未来 7 天到期券数 | 关注退回量、备好客服口径；不要求处理 | 平台运营 |

## 常用命令

```bash
systemctl status sy-commerce-preview juzhu-api     # 服务状态
curl -s http://127.0.0.1:38780/api/commerce/v1/healthz   # 探活
journalctl -u sy-commerce-preview -n 200           # 服务日志
node scripts/commerce/m1a4-ops-test.cjs            # 异常恢复回归（隔离库）
mysql> SELECT version FROM commerce_migrations     # 迁移版本
```

## 处置红线

- 结果未知的资金指令：**不重试、不换号、不凭猜测标记成功**。
- 账务不一致：先停资金操作，再排查；已记账务不可删改，纠偏走冲回/追偿。
- 演示卡券（is_demo）不进入资金域；任何补偿/退款操作前先核对。
