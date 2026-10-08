# M1-A4 日常检查清单（无资金试运营）

## 每日（约 5 分钟）

- [ ] `curl -s http://127.0.0.1:38780/api/commerce/v1/healthz` 返回 `status:"ok"` 且迁移版本符合预期
- [ ] 运营统计页「运行告警」卡：触发数与级别；**严重项立即按 RUNBOOK 处理**
- [ ] 运营统计页六组 KPI 无异常跳变（卡券/订单/预约/核销/兑换码/售后）
- [ ] 结算账单页：资金不变量显示「✓ 全绿」
- [ ] 退款执行页无超 24h 待处理单；对账中心无未闭环差异（关账前必须清零）

## 每周

- [ ] 跑一次全量回归：`m1a-test` / `settlement-test --browser` / `m1a4-ops-test --browser`（各隔离库，约 10 分钟）
- [ ] 对当期账期跑一次对账（对账中心 → 新建对账），确认差异为 0 或已闭环
- [ ] 追偿与赔付滞留复核（对账中心两个分区）

## 每月

- [ ] 备份恢复演练：`node scripts/commerce/m1a4-backup-restore.cjs`（隔离库），确认 RTO 与指纹一致方法仍有效
- [ ] 检查 `commerce_audit` 审计规模与失败记录趋势
- [ ] 复核权限：账号中心内 `commerce.fund.*` 持有人名单与业务实际一致

## 发布前（每次部署）

- [ ] `node scripts/commerce/m1a-test.cjs` + `node scripts/commerce/settlement-test.cjs --browser` 全绿
- [ ] `node scripts/commerce/install-preview.cjs`（自带 healthz 校验与 nginx 配置备份）
- [ ] 部署后：healthz + 线上只读冒烟 `node scripts/commerce/m1a-public-smoke.cjs`
- [ ] 回退预案确认：上一已验收版本提交号已知；**不回滚数据库、不删业务表**
