# 演示数据清单（批次 hotel-exchange-demo-v1）

来源：《门店长租价格建议及报名表 - 上线名单.xlsx》（2026-09-16 版，1809 家）→ `commerce/hotel-roster.json`。
**全部实体 payload 带 `initialization:{batch:'hotel-exchange-demo-v1',mode:'demo'}`**（演示资金隔离标记），文案带「试点名单演示」限定。

| 实体 | 数量 | 说明 |
|---|---|---|
| 事业群商家（jz_vendors+merchants） | 8 | 样本覆盖的事业群（柏曼/城市便捷/宜尚/怡程等，酒店通兑试点演示），vendor_no 前缀 `hotel-exchange-demo-v1:` |
| 抽样酒店门店（stores） | 48 | 每档 8 家：**贵阳（17 家）与沈阳（9 家）名单门店全量入围**（演示城市+试点口径），其余名额按品牌分层 + hotel_code 字典序轮转补足，确定性可复算；payload：`kind:'hotel'` + `exchange_tier/hotel_code/hotel_brand/hotel_region/hotel_branch/hotel_war_zone`；city 挂贵阳（名单为全国门店，通兑跨城属预期）；capacity 3 |
| 档位锚点虚拟门店（stores） | 6 | 每档 1 个（capacity 0，不可直接预约），承载发券时的 store_id NOT NULL |
| 通兑券 SKU | 6 | 「酒店通兑 · {档}元档（试点名单任选，演示）」，`redeem_channel:'offline'` + `exchange_tier/exchange_tier_minor`，零售价=档位价（演示展示口径） |
| 景点门票演示 | 1 商户+1 店+1 SKU | 线下单店绑定（scenic_ticket） |
| 餐饮演示 | 1 商户+1 店+1 SKU | 线下单店绑定（dining） |
| 线上核销演示 | 1 商户+1 线上服务台+1 SKU | `redeem_channel:'online'` + `service_channel:'online'`（online_service） |
| 分配规则 | 9 | 每商户 1 条全 0 bps（演示无佣金） |
| 组合券包 | 1 | 「本地生活 · 酒店通兑体验包（演示）」= t120 通兑 + 门票 + 餐饮 |

名单分档（全量 1809）：80 元档 229 家 · 100 元档 476 家 · 120 元档 427 家 · 160 元档 296 家 · 180 元档 263 家 · 200 元档 118 家。
品牌 11 个：城市便捷 930 / 柏曼 355 / 宜尚 344 / 铂顿 54 / 怡程 32 / 城市精选 30 / 精途 21 / 隐沫 21 / 宜尚Plus 16 / 瑾程 3 / 臻程 3。

抽样示例（t80，贵阳 1 家全量入围 + 7 家品牌轮转）：城市精选贵阳高铁东站店（入围）、城市便捷郑州巩义火车站康百万庄园店、城市精选孝感安陆东大时代广场店、宜尚滨州博兴银座店、柏曼上海虹桥火车站国展中心店、精途武汉长丰大道园博园店、城市便捷禹州大禹像胖东来店、宜尚东营东城南一路店。完整抽样可由 `require('commerce/hotel-exchange-demo.cjs').sampleHotels()` 复算。

清理：`node scripts/commerce/seed-hotel-exchange-demo.cjs --apply --clean` 按收据反查删除本批次实体；存在演示订单/卡券时拒绝（先清演示购买数据）。贵阳既有演示批次（guiyang-life-demo-v1）不受影响。
