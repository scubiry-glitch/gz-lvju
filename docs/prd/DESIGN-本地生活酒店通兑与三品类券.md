# DESIGN · 本地生活券：酒店通兑与三品类（线上/线下核销）

日期：2026-09-20。状态：已按本文实施并通过验收（[验收记录](../verification/hotel-exchange-closed-loop/RESULTS.md)）。归属 ROADMAP M2「一期完善与扩展」的商品范围扩展，不改动 M1-A/M1-A3 已验收口径。

## 1. 背景与需求

业务方提供《门店长租价格建议及报名表 - 上线名单.xlsx》：**1809 家酒店**（战区/分公司/区域/酒店名称/酒店编码/酒店品牌/**最终报名价格档位(OTA)**），按 OTA 挂牌分 6 档。需求：

1. 名单匹配到本地生活的券：酒店设计为**通兑券——同价格档位任选酒店入住**（预约选店制）；
2. **所有类目的券创建时区分「线上 / 线下」核销**：线下券必须选到具体门店，线上券免预约；门店支持商家自行创建；
3. 新增**景点门票、餐饮**两个线下品类。

试点限定（CLAUDE.md 规则 5）：名单是真实报名数据；演示环境只抽样接入；**全量上线、真实入住与真实资金均属后续阶段**，不把推广性数字当承诺。

## 2. 名单口径与抽样

全量名单一次性转为 `commerce/hotel-roster.json`（`scripts/commerce/hotel-roster-build.cjs`，unzip+Node 解析；校验 1809 行、6 档枚举、编码唯一；转换可重跑）。分档统计：

| 档位 | 80元 | 100元 | 120元 | 160元 | 180元 | 200元 | 合计 |
|---|---|---|---|---|---|---|---|
| 家数 | 229 | 476 | 427 | 296 | 263 | 118 | **1809** |

品牌 11 个：城市便捷 930 / 柏曼 355 / 宜尚 344 / 铂顿 54 / 怡程 32 / 城市精选 30 / 精途 21 / 隐沫 21 / 宜尚Plus 16 / 瑾程 3 / 臻程 3。事业群 5 个：城市便捷 958 / 柏曼 375 / 宜尚 363 / 怡程 59 / 中寓(铂顿) 54。

**确定性抽样**：`sampleHotels(roster, perTier=8)` —— 档位升序 → 档内按品牌分层 → 各品牌队列按 hotel_code 字典序轮转取 8 家/档 = 48 家。可重跑、可复算（隔离库断言），保证演示直链不失效。

## 3. 数据模型（零迁移）

迁移 checksum 锁死旧 statements 且 `commerce_coupons/order_items/redemptions.store_id` 均 NOT NULL → **不新增迁移版本**，用「虚拟门店」承载两类非物理门店：

```
sku.payload:  redeem_channel:'offline'|'online'（缺省 offline）
              exchange_tier:'t80'…'t200'（仅线下）+ exchange_tier_minor（档位展示价）
store.payload:service_channel:'store'|'online'（缺省线下，online=线上服务台）
              kind:'hotel' + exchange_tier + hotel_code/brand/region/branch/war_zone（酒店）
```

| 券形态 | 门店绑定 | 预约 | 核销授权 |
|---|---|---|---|
| 线下普通（门票/餐饮等） | 绑 1 个具体门店（商家自建或 seed） | 需要（既有链路） | 该店 staff |
| 线下通兑 | 绑该档**锚点虚拟门店**（capacity 0，不可直接预约） | **预约时选档内具体酒店**，`appointments.store_id`=所选酒店 | 所选酒店 staff（授权按实际履约门店商户） |
| 线上 | 绑商户「线上服务台」虚拟门店 | **免预约** | 线上服务台 staff |

档位枚举/中文名/展示价单一数据源：`commerce/configuration.cjs` 的 `EXCHANGE_TIERS`（管理台表单、catalog、/hotels、C 端都只消费它）。

**商户组织**：名单战区 → 5 个事业群 vendor/merchant 各挂各的店；通兑 SKU 归「通兑运营（演示）」商户（锚点属它）；门票/餐饮/线上各 1 个演示商户。**核销归集**：`redemptions.merchant_id/store_id` 取预约行 → 结算账单（`merchant_payable:<merchant>`）自然按事业群分商户，settlement.cjs 零改动。

**校验链**（configuration.cjs validate + service.references）：
- 通兑档位仅限线下券；选档必须填档位价；
- 线下券不能绑线上服务台；线上券必须绑本商户线上服务台；
- 通兑 SKU 绑定的锚点门店 `exchange_tier` 必须一致；
- 预约时（service.appointment）：通兑券必传 `store_id` 且目标店 `kind==='hotel'`、`exchange_tier` 同档，否则 422 `tier_mismatch`。

## 4. 域改动（commerce/service.cjs，5 个函数）

- `appointment()`：可选 `input.store_id`（通兑必填）；同日换店放行（比 store+date 二元组）；产能 UPDATE→INSERT IGNORE 兜底沿旧路径，全部落在所选店；改期/取消沿用 `old.store_id` 对称释放。
- `checkRedeemable()`：先取预约行，核销门店 = `appointment.store_id || coupon.store_id`（线上=线上服务台）；**授权归属按实际履约门店的商户**（通兑券发在运营商户名下、核销人是酒店商户员工）；线上券跳过预约/当日断言。
- `redeem()`：`merchant_id` 取预约行商户 → 结算归集；线上券无预约状态更新。
- `catalog()` / `my()`：透出 `redeem_channel`、`exchange_tier(+label/minor)`。
- `hotels()` + `GET /api/commerce/v1/hotels`：公开名录（session 前，与 /catalog 同形态，无需 perm 登记），输出 tiers facets + 公开字段（name/brand/region/tier/hotel_code/store_id），不暴露内部标识。

**isDemo 泛化**（前置提交）：`guiyang-demo.cjs isDemo()` 由「batch===guiyang」改为 `initialization.mode==='demo'`——资金隔离本就只认 `snapshot.is_demo`（demo-order 打标、settlement 全链 `NOT (JSON_EXTRACT(snapshot,'$.is_demo') <=> TRUE)`），批次名只用于 seed 收据归属；沈阳 initialization 批次不带 mode，仍判非 demo。

## 5. C 端与管理台

- 新页 `juzhu-hotels.html`（generate-pages 从 consumer-page 模板生成）：6 档 chips + 品牌/关键词筛选 + 名录卡；消费 `/hotels`。
- 券详情按渠道分流：通兑=「选酒店预约」两步弹窗（档内酒店下拉+日期）；普通线下=日期预约；线上=直接出示核销码。
- 选券页分类枚举补 酒店通兑/景点门票/餐饮/线上权益，`?category=` 直达；首页领券中心三张新卡。
- 管理台券商品表单：核销方式 select 联动过滤门店下拉（线下→具体门店/档位锚点；线上→线上服务台）并显隐通兑字段；门店类型（线下门店/线上服务台）进门店管理表单——**商家自建门店即建即选**。
- 导航三同步：`_nav.js` commerce 业务入口、`overview.html`、`index.html` 领券中心（规则 1）。

## 6. 资金边界与上线路径

- 演示期全部走 demo-orders（零资金、`is_demo` 隔离、结算批次不含）；真实购买仍在 M1-B（POST /orders 封禁）。
- 上线清单：① 支付适配器准入；② 档位定价/供货价/佣金按 v1.9 §18.1 逐券审批；③ roster 全量导入（放开 perTier 或全量循环，域逻辑无差异）；④ 酒店房态与 commerce 预约打通（stay_calendar 逐晚库存/多间），当前通兑按「晚·间」预约占用门店名额的简化口径；⑤ 酒店商户合同、核销人员授权批量导入。
