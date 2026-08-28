#!/usr/bin/env python3
# 复刻 jz_seed.cjs 的 12 频道增量种子（INSERT IGNORE 幂等，存量库安全）
import json, sys
sys.path.insert(0, '/proweb/run/gz-lvju/juzhu')
import pymysql

cfg = dict(
    host='127.0.0.1', port=3306, user='juzhu', password='jz_juzhu_2026',
    database='juzhu', charset='utf8mb4', autocommit=False,
)
conn = pymysql.connect(**cfg)
cur = conn.cursor()
jd = lambda v: json.dumps(v, ensure_ascii=False)
now = '2026-08-29 00:00:00'

# 1. 12 频道类目（8 新 + 4 旧 icon 补齐）
life_cats = [
    ('telecom','电讯服务','📱',5),('insurance','财险服务','🛡',6),
    ('consumer_finance','消费金融','💳',7),('health_care','健康养老','🏥',8),
    ('home_maintain','居家维护','🏠',9),('asset','资产服务','🏦',10),
    ('recycle','二手回收','♻️',11),('community','社区服务','🏘',12),
    ('cleaning','保洁','🧹',1),('repair','维修','🔧',2),
    ('moving','搬家','📦',3),('nanny','保姆','👶',4),
]
for cid, name, icon, ord_ in life_cats:
    cur.execute(
        "INSERT IGNORE INTO jz_categories(id,name,icon,sort_order,enabled) VALUES(%s,%s,%s,%s,1)",
        (cid, name, icon, ord_))
print("类目 12 个就绪")

# 2. 8 新频道 16 个 SKU
life_skus = [
    (25,'telecom','宽带新装 · 千兆','telecom-broadband','装维上门 · 当周开通',99,'起',120,1),
    (26,'telecom','号码携转 · 套餐','telecom-portability','携号转网 · 套餐对比',0,'咨询',30,2),
    (27,'insurance','家财险 · 基础版','insurance-home-basic','漏水/火灾/盗抢',128,'/年',0,1),
    (28,'insurance','租客责任险','insurance-tenant','第三者责任 · 押金替代',68,'/年',0,2),
    (29,'consumer_finance','分期免息 · 租住','finance-rent-installment','首付灵活 · 信用评估',0,'咨询',0,1),
    (30,'consumer_finance','消费贷 · 额度查询','finance-credit-limit','额度秒批 · 随借随还',0,'咨询',0,2),
    (31,'health_care','养老陪护 · 日间','health-elder-day','持证护理 · 日间到岗',280,'/天',480,1),
    (32,'health_care','体检套餐 · 基础','health-checkup-basic','三甲对接 · 报告解读',299,'起',0,2),
    (33,'home_maintain','管道养护 · 季度','maintain-pipe-quarter','疏通+防堵养护',198,'/季',90,1),
    (34,'home_maintain','家电保养 · 套餐','maintain-appliance','空调/冰箱/洗衣机',159,'起',120,2),
    (35,'asset','资产评估 · 房产','asset-appraisal','持证评估师上门',500,'起',0,1),
    (36,'asset','托管运营 · 咨询','asset-custody','租金托管 · 报表透明',0,'咨询',0,2),
    (37,'recycle','旧家电回收','recycle-appliance','上门估价 · 当日清运',0,'估价',60,1),
    (38,'recycle','家具回收 · 套装','recycle-furniture','大件拆装 · 环保处置',0,'估价',90,2),
    (39,'community','社区团购 · 日配','community-groupbuy','生鲜果蔬 · 次日达',0,'咨询',0,1),
    (40,'community','便民代办 · 跑腿','community-errand','取送件 · 代缴代办',29,'起',60,2),
]
for sid, cat, name, slug, spec, price, unit, dur, ord_ in life_skus:
    cur.execute(
        """INSERT IGNORE INTO jz_skus(id,category_id,name,slug,spec,price_from,price_unit,duration_min,
           tags,badges,sales_text,rating_score,worker_min_level,includes,service_flow,service_notice,sort_order,enabled)
           VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)""",
        (sid, cat, name, slug, spec, price, unit, dur,
         jd(['本地生活']), jd(['精选']), '试点开放', 4.7, 'L2',
         jd(['在线预约','认证服务商','进度可查']),
         jd(['选择服务','提交需求','服务商确认','履约完成']),
         jd(['价格以实际报价为准','部分服务需资质核验']), ord_))
print("SKU 16 个（8 新频道）就绪")

# 3. 8 家新商家（city_ids NULL = 全省可约）
life_vendors = [
    (41,'telecom','联通装维优选','📶','全市覆盖',4.6,1200),
    (42,'insurance','安居财险专区','🛡','全国',4.8,5600),
    (43,'consumer_finance','江苏银行消费金融','💳','本地',4.7,3200),
    (44,'health_care','康养到家','🏥','全市',4.8,2100),
    (45,'home_maintain','安居养护','🔧','全市',4.6,1800),
    (46,'asset','贝壳资产顾问','🏦','本地',4.7,900),
    (47,'recycle','绿色回收站','♻️','全市',4.5,4400),
    (48,'community','邻里便民站','🏘','全市',4.6,2600),
]
for vid, vtype, name, logo, addr, rating, reviews in life_vendors:
    cur.execute(
        """INSERT IGNORE INTO jz_vendors(id,type,name,logo,address,rating,review_count,badges,live,
           start_price,unit,hours,status,sort_order,created_at,updated_at,city_ids)
           VALUES(%s,%s,%s,%s,%s,%s,%s,%s,0,0,'起','09:00-21:00','active',%s,%s,%s,NULL)""",
        (vid, vtype, name, logo, addr, rating, reviews, jd(['whitelist']), vid, now, now))
print("商家 8 家就绪")

# 4. 16 个新商品（city_id NULL = 全省可约，配合已修复的 C 端 SQL）
life_products = [
    (4101,41,25,'宽带新装 · 千兆','装维上门',99),
    (4102,41,26,'号码携转 · 套餐','携号转网',0),
    (4103,42,27,'家财险 · 基础版','漏水火灾盗抢',128),
    (4104,42,28,'租客责任险','押金替代方案',68),
    (4105,43,29,'分期免息 · 租住','信用评估',0),
    (4106,43,30,'消费贷 · 额度查询','随借随还',0),
    (4107,44,31,'养老陪护 · 日间','持证护理',280),
    (4108,44,32,'体检套餐 · 基础','三甲对接',299),
    (4109,45,33,'管道养护 · 季度','疏通养护',198),
    (4110,45,34,'家电保养 · 套餐','多品类保养',159),
    (4111,46,35,'资产评估 · 房产','持证上门',500),
    (4112,46,36,'托管运营 · 咨询','租金托管',0),
    (4113,47,37,'旧家电回收','上门估价',0),
    (4114,47,38,'家具回收 · 套装','大件清运',0),
    (4115,48,39,'社区团购 · 日配','生鲜果蔬',0),
    (4116,48,40,'便民代办 · 跑腿','取送代缴',29),
]
for pid, vid, sku_id, title, sub, price in life_products:
    cur.execute(
        """INSERT IGNORE INTO jz_products(id,vendor_id,title,subtitle,category,duration_hours,area_range,unit,
           price,original_price,discount_label,earliest_time,advance_booking_hours,sales_count,rating,
           service_tags,channel_sku_id,status,sort_order)
           VALUES(%s,%s,%s,%s,%s,1,'','起',%s,%s,NULL,'今天 18:00',2,100,4.7,%s,%s,'on',%s)""",
        (pid, vid, title, sub, title.split('·')[0].strip(), price,
         price and round(price * 1.5) or None, jd(['本地生活','可预约']), sku_id, pid))
print("商品 16 个就绪")

conn.commit()
conn.close()
print("✅ 12 频道增量种子完成")
