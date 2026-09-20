# 本地生活券 · 酒店通兑与三品类闭环验收

日期：2026-09-20 · 分支 `plan/newliving-coupons-membership-v1.9`（通兑系列提交 b567237…8e4c671）。

## 0. 结论

**线上 19/19 项、隔离库 47/47 项全部通过。** 酒店通兑券（同档任选、预约选店制）、线上/线下核销渠道、景点门票与餐饮品类已在 sytest 预览环境贯通：买券 → 档内选酒店 → 预约 → 当日动态码 → 商户核销（隔离库验证）→ 演示资金零分录。名单来自《门店长租价格建议及报名表-上线名单》（1809 家，6 档），演示按确定性算法抽样 48 家（每档 8 家）。

## 1. 证据等级

| 等级 | 范围 | 说明 |
|---|---|---|
| 线上验收 | sytest 预览（`GET /hotels`、catalog、demo-orders、appointments、coupons/token、页面渲染） | 全部为零资金演示动作；预约可取消释放，不产生任何资金与真实履约 |
| 隔离库验收 | `commerce_m1a_test_*` 临时库（自动删除） | 商户侧酒店核销授权/归集、跨档拒绝、产能对称释放、资金隔离等写路径断言 |
| 回归 | m1a-test 全量 47 项 + domain/http 18 项 + settlement-test 19 项（含浏览器） | isDemo 泛化与域改动不破坏既有结算闭环 |

## 2. 工作项验收

| 工作项 | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 名单转换 | Excel 1809 家全量转 roster.json；6 档枚举；编码唯一 | ✅ 1809 家 / 80:229 100:476 120:427 160:296 180:263 200:118 | `commerce/hotel-roster.json`（meta.tiers） |
| 确定性抽样 | 每档 8 家、品牌分层、可重跑同结果 | ✅ 48 家；t120-t200 覆盖 8 品牌、t80 5 品牌 | hotel-exchange-test「sampling is deterministic」 |
| 通兑演示数据 | 5 事业群商户各挂各店；每档锚点虚拟门店（capacity 0）+ 通兑 SKU；门票/餐饮/线上演示 SKU；三品类组合券包 | ✅ 9 商户 / 57 店 / 9 SKU / 1 券包 | seed-*.json；`/catalog?city=贵阳` |
| 线上/线下渠道 | SKU 创建区分 redeem_channel；线上=线上服务台虚拟门店；线下必须绑具体门店（管理台表单联动过滤） | ✅ | live-check「Admin SKU form …」两条 + 截图 admin-sku-form-*.png |
| 档内任选预约 | 通兑券预约必选档内酒店；锚点/跨档/名录外拒绝；同日换店放行 | ✅ 422 tier_mismatch / store_required | 隔离库 + live-check「Cross-tier booking …」 |
| 产能与释放 | 预约占所选酒店当日名额；取消/换店对称释放 | ✅ capA=0、capB=1 断言 | hotel-exchange-test |
| 线上直核 | 线上券禁预约（409）；免预约取动态码；线上服务台 staff 核销 | ✅ | live-check + 隔离库 |
| 核销归集 | redemption.merchant_id = 所选酒店商户（结算账单按事业群自然分商户） | ✅ | hotel-exchange-test「attributes the chosen hotel merchant」 |
| 演示资金隔离 | 通兑/线上演示单零资金分录；结算批次不受影响 | ✅ ledger 0 行；settlement-test 19 项全绿 | 隔离库断言 + settlement 回归 |
| 幂等与防重 | 重复预约/核销幂等；clean 有业务单据拒删 | ✅ | hotel-exchange-test 两断言 |
| 公开名录接口 | GET /hotels 输出 facets 与公开字段，不暴露内部标识 | ✅ 48 家 6 档 | live-check 前两条 |
| C 端页面 | 名录页/选券筛选/卡券详情/选店弹窗按预期渲染且无脚本错误 | ✅ | 7 张截图 + 「No page script errors」 |
| 导航三同步 | 页面 + `_nav.js` + `overview.html` 同 commit | ✅ acc8d4f | commit 记录 |

## 3. 完成门槛

| 门槛 | 状态 |
|---|---|
| 每类目券可配置线上/线下，线下选到具体门店（商家可自建门店） | ✅（configuration.cjs enum + 管理台联动；商户中心门店管理为既有能力） |
| 酒店通兑同档任选 | ✅（预约选店制） |
| 门票、餐饮品类上线（演示） | ✅（线下单店绑定，走既有链路） |
| 演示与资金域隔离 | ✅（is_demo 快照标记 + isDemo 泛化） |
| 不破坏已验收结算闭环 | ✅（settlement.cjs 零改动，19 项回归全绿） |

## 4. 测试命令与截图

```bash
# 隔离库全量（临时库自动清理）
node scripts/commerce/m1a-test.cjs --guiyang-demo --initialization --hotel-exchange   # 47 passed
node --test scripts/commerce/domain.test.cjs scripts/commerce/http.test.cjs           # 18 pass
node scripts/commerce/settlement-test.cjs --browser                                    # 19 passed
# 线上（sytest，零资金演示动作；重复运行安全：预约后即取消）
node scripts/commerce/live-hotel-check.cjs                                             # 19/19 passed
# 数据（幂等）
node scripts/commerce/seed-hotel-exchange-demo.cjs --apply [--clean]
```

截图：`hotel-directory-1440/390.png`（名录页）、`hotel-shop-390.png`（通兑选券）、`hotel-coupon-detail-390.png`（卡券档位）、`hotel-pick-dialog-390.png`（选店弹窗 8 家）、`admin-sku-form-online-1440.png` / `admin-sku-form-exchange-1440.png`（线上线下联动）。

## 5. 边界与遗留

- **商户侧酒店核销在线上未走浏览器**：线上环境没有绑定酒店商户的员工账号（核销人员需经账号中心+商户中心授权）；该能力由隔离库套件覆盖（他店 staff 403、所选店 staff 可核、归集正确）。演示时按 OPERATION.md §3 绑定即可点亮。
- **名单为试点演示抽样**：48/1809 家接入演示；全量导入只需 `sampleHotels(perTier)` 参数放开或按 roster 全量循环，域逻辑无差异。真实入住/房态/结算属 M1-B 真实资金范围，与规则 5 的试点限定一致。
- **价格口径**：档位价（80–200 元）为 OTA 报名档，通兑券展示价=档位价仅演示；真实定价、供货价与佣金须按 v1.9 §18.1 逐券审批。
- **通兑券当前按「晚」预约**：逐晚房态/多间库存（stay_calendar 体系）未与 commerce 打通，属后续两域联动工作。
