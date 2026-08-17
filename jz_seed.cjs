// jz_seed.cjs — 家政频道全量种子数据（MySQL 版）
// 仅在对应表为空时写入，幂等安全。
'use strict';

const JZ_SUBCATS = [
  ['cleaning','日常保洁','🧹',1],['cleaning','深度清洁','✨',2],
  ['cleaning','开荒保洁','🏠',3],['cleaning','玻璃清洗','🪟',4],
  ['cleaning','油烟机清洗','💨',5],['cleaning','收纳整理','📦',6],
  ['repair','家电维修','🔌',7],['repair','管道疏通','🚿',8],
  ['repair','灯具电路','💡',9],['repair','门窗维修','🚪',10],
  ['repair','空调维修','❄',11],['repair','水管维修','💧',12],
  ['moving','居民搬家','🚚',13],['moving','长途搬家','🛣',14],
  ['moving','钢琴搬运','🎹',15],['moving','企业搬迁','🏢',16],
  ['moving','日式搬家','🍱',17],['moving','搬货上下楼','📦',18],
  ['nanny','住家保姆','🏡',19],['nanny','白班保姆','☀',20],
  ['nanny','钟点工','⏱',21],['nanny','月嫂','🤱',22],
  ['nanny','住家育儿嫂','👶',23],['nanny','养老护理','🧓',24],
];

const JZ_DEFAULT_SKUS = [
  {id:1,category_id:'cleaning',name:'日常保洁 · 2小时',slug:'cleaning-daily-2h',spec:'1人上门 · 全屋除尘整理',price_from:128,price_unit:'/次',duration_min:120,tags:['热门','最快2小时上门'],badges:['神券','全程保'],sales_text:'已订 5.3万+',rating_score:4.8,worker_min_level:'L2',includes:['客厅卧室除尘','地面清洁','台面整理','基础厨卫擦拭'],service_flow:['确认地址与面积','匹配保洁员','按约上门','完工验收'],service_notice:['服务前2小时可免费取消','标准耗材已含','超时按30分钟补差价'],sort_order:1},
  {id:2,category_id:'cleaning',name:'深度清洁 · 4小时',slug:'deep-clean-4h',spec:'3人团队 · 含厨卫去污',price_from:268,price_unit:'起',duration_min:240,tags:['爆款','死角焕新'],badges:['团购爆品','立减10'],sales_text:'已订 1.6万+',rating_score:4.9,worker_min_level:'L3',includes:['厨房油污处理','卫生间除垢','踢脚线与缝隙除尘','家具表面深擦'],service_flow:['客服确认房型','分配L3保洁员','上门深度清洁','拍照回传与验收'],service_notice:['50㎡以内标准价','特殊药剂需二次确认','完工后可申请复洁'],sort_order:2},
  {id:3,category_id:'cleaning',name:'空调清洗 · 挂机',slug:'ac-clean-wall',spec:'高温蒸汽 · 拆装深度',price_from:89,price_unit:'/台',duration_min:90,tags:['当天上门','除菌除味'],badges:['会员价','平台保障'],sales_text:'近期好评 1000+',rating_score:4.7,worker_min_level:'L2',includes:['滤网拆洗','蒸汽除菌','出风口清洁','基础功能检测'],service_flow:['确认机型','预约时段','工程师上门','清洗验收'],service_notice:['柜机另计','高空外机不含','服务后24小时内可追评'],sort_order:3},
  {id:4,category_id:'repair',name:'管道疏通 · 当天',slug:'pipe-unclog-fast',spec:'30分钟响应 · 不通不收费',price_from:99,price_unit:'起',duration_min:60,tags:['应急维修','最快30分钟'],badges:['应急','全天候'],sales_text:'年售 2.4万+',rating_score:4.8,worker_min_level:'L3',includes:['厨房下水疏通','卫生间地漏疏通','基础堵点判断','作业区清洁恢复'],service_flow:['提交故障','派发就近技师','上门检测疏通','完工确认'],service_notice:['超技能范围可重派','配件费另计','30天同故障质保'],sort_order:1},
  {id:5,category_id:'repair',name:'灯具安装 · 吸顶灯',slug:'light-install-ceiling',spec:'电工持证 · 高空作业规范',price_from:59,price_unit:'/盏',duration_min:45,tags:['持证上岗'],badges:['全程保'],sales_text:'年售 6000+',rating_score:4.6,worker_min_level:'L2',includes:['拆旧装新','电路检测','基础调试','现场清理'],service_flow:['确认灯型','预约上门','安装调试','拍照回传'],service_notice:['复杂吊灯另报价','不含灯具材料','电路改造需二次确认'],sort_order:2},
  {id:6,category_id:'moving',name:'居民搬家 · 同城',slug:'moving-city-standard',spec:'金杯车 · 2名师傅',price_from:398,price_unit:'起',duration_min:180,tags:['同城精选','可加购打包'],badges:['省心搬','平台保障'],sales_text:'已搬 7800+',rating_score:4.7,worker_min_level:'L2',includes:['基础搬运','车辆运输','大件保护包裹','楼道清运'],service_flow:['提交清单','客服估价','确认车辆与人员','按时搬运'],service_notice:['楼层费按现场核算','超距单独计费','贵重物品建议保价'],sort_order:1},
  {id:7,category_id:'moving',name:'日式搬家 · 全包',slug:'moving-japanese-full',spec:'打包收纳 + 还原归位',price_from:1680,price_unit:'起',duration_min:480,tags:['高端服务','全程无忧'],badges:['PRO'],sales_text:'企业家庭双适用',rating_score:4.9,worker_min_level:'L4',includes:['分类打包','上门收纳','新居归位','垃圾清运'],service_flow:['顾问勘察','确认方案','分工搬运','到家复原'],service_notice:['需提前1天预约','贵重柜体单独报价','默认含基础耗材'],sort_order:2},
  {id:8,category_id:'nanny',name:'钟点工 · 3小时',slug:'nanny-hourly-3h',spec:'做饭保洁 · 灵活预约',price_from:128,price_unit:'/次',duration_min:180,tags:['灵活用工','做饭保洁'],badges:['热门'],sales_text:'年售 1.2万+',rating_score:4.8,worker_min_level:'L2',includes:['一餐制作','基础保洁','衣物整理','简单采购代办'],service_flow:['选时段','匹配阿姨','上门服务','结束评价'],service_notice:['食材默认用户提供','需提前确认菜谱','节假日价格浮动'],sort_order:1},
  {id:9,category_id:'nanny',name:'育儿嫂 · 住家',slug:'nanny-livein-babycare',spec:'3年以上经验 · 持证',price_from:8800,price_unit:'/月',duration_min:43200,tags:['住家服务','持证育儿'],badges:['严选'],sales_text:'月签 300+',rating_score:4.9,worker_min_level:'L4',includes:['婴幼儿照护','喂养作息','辅食制作','成长记录'],service_flow:['顾问面谈','筛选候选人','试工确认','月度服务'],service_notice:['支持视频面试','可加购体检背调','签约后7天可换人'],sort_order:2},
  {id:10,category_id:'cleaning',name:'开荒保洁 · 新居',slug:'raw-clean-new',spec:'新房装修后 · 全屋开荒',price_from:398,price_unit:'起',duration_min:360,tags:['装修后必做','3-5人团队'],badges:['团购爆品','全程保'],sales_text:'已订 8000+',rating_score:4.8,worker_min_level:'L3',includes:['水泥漆点清理','全屋除尘除胶','门窗轨道清洁','地面打蜡养护'],service_flow:['确认房型面积','分配开荒团队','上门开荒清洁','拍照回传验收'],service_notice:['按建筑面积计价','高空外窗不含','顽固污渍需二次确认'],sort_order:4},
  {id:11,category_id:'cleaning',name:'玻璃清洗 · 高层',slug:'glass-clean-highrise',spec:'内外双面 · 无痕清洁',price_from:108,price_unit:'起',duration_min:90,tags:['无水痕','高层可做'],badges:['会员价'],sales_text:'近期好评 2000+',rating_score:4.6,worker_min_level:'L2',includes:['玻璃内外擦拭','窗框清洁','轨道除尘','纱窗拆洗'],service_flow:['确认窗户数量','预约时段','上门清洗','验收'],service_notice:['高空外墙需评估','落地窗按面积计','破损玻璃不承保'],sort_order:5},
  {id:12,category_id:'cleaning',name:'油烟机清洗 · 深度',slug:'hood-clean-deep',spec:'拆洗深度 · 除重油',price_from:128,price_unit:'/台',duration_min:60,tags:['拆洗深度','除重油'],badges:['神券','平台保障'],sales_text:'已订 1.1万+',rating_score:4.7,worker_min_level:'L2',includes:['油烟机拆洗','扇叶除油','机身内壁清洁','功能复检'],service_flow:['确认机型','预约上门','拆洗清洁','复装验收'],service_notice:['集成灶另计','老旧机型谨慎拆','服务后24h可追评'],sort_order:6},
  {id:13,category_id:'repair',name:'家电维修 · 上门',slug:'appliance-repair',spec:'冰箱/洗衣机/热水器',price_from:89,price_unit:'起',duration_min:60,tags:['多品类可修','30分钟响应'],badges:['应急','90天质保'],sales_text:'年售 8000+',rating_score:4.6,worker_min_level:'L3',includes:['故障检测','配件更换','功能调试','作业清洁'],service_flow:['提交故障','派发就近技师','上门检修','完工确认'],service_notice:['配件费另计','超范围可重派','30天同故障质保'],sort_order:3},
  {id:14,category_id:'repair',name:'空调维修 · 加氟',slug:'ac-repair-refill',spec:'不制冷/漏氟/异响',price_from:159,price_unit:'起',duration_min:90,tags:['加氟清洗','持证上岗'],badges:['全程保'],sales_text:'年售 5600+',rating_score:4.7,worker_min_level:'L3',includes:['制冷检测','加氟补漏','管路检查','运行测试'],service_flow:['确认机型故障','预约上门','检修加氟','验收'],service_notice:['加氟量按现场计','外机高空另议','90天质保'],sort_order:4},
  {id:15,category_id:'repair',name:'门窗维修 · 锁具',slug:'door-window-repair',spec:'门窗变形/锁具损坏',price_from:89,price_unit:'起',duration_min:60,tags:['锁具更换','门窗校正'],badges:['品牌锁具'],sales_text:'年售 2100+',rating_score:4.4,worker_min_level:'L2',includes:['门窗校正','五金更换','锁芯升级','密封处理'],service_flow:['确认门窗类型','预约上门','维修更换','验收'],service_notice:['锁具材料另计','断桥铝另议','90天质保'],sort_order:5},
  {id:16,category_id:'repair',name:'水管维修 · 应急',slug:'waterpipe-repair',spec:'渗漏/爆裂 应急处理',price_from:99,price_unit:'起',duration_min:60,tags:['应急抢修','持证水工'],badges:['应急','全天候'],sales_text:'年售 2800+',rating_score:4.5,worker_min_level:'L3',includes:['漏点排查','管路修复','接口更换','通水测试'],service_flow:['提交故障','派发就近水工','上门抢修','完工确认'],service_notice:['配件费另计','暗埋管评估后作业','30天质保'],sort_order:6},
  {id:17,category_id:'moving',name:'长途搬家 · 跨城',slug:'moving-longhaul',spec:'厢式货车 · 300km+',price_from:1200,price_unit:'起',duration_min:600,tags:['跨城直达','全程跟踪'],badges:['省心搬','平台保障'],sales_text:'已搬 3200+',rating_score:4.6,worker_min_level:'L3',includes:['打包搬运','长途运输','大件保护','到点卸货'],service_flow:['提交清单里程','顾问估价','确认车型人员','跨城运输'],service_notice:['里程按实结算','贵重物品建议保价','偏远地区加收'],sort_order:3},
  {id:18,category_id:'moving',name:'钢琴搬运 · 专业',slug:'moving-piano',spec:'立式/三角钢琴 可接',price_from:800,price_unit:'/次',duration_min:120,tags:['专业防护','保价运输'],badges:['PRO','保险'],sales_text:'已搬 1200+',rating_score:4.9,worker_min_level:'L4',includes:['专业包装','楼梯搬运','水平运输','就位摆放'],service_flow:['确认琴型楼层','预约上门','专业搬运','就位验收'],service_notice:['超高楼层加收','默认含保价','调律需另约'],sort_order:4},
  {id:19,category_id:'moving',name:'企业搬迁 · 整体',slug:'moving-office',spec:'办公整体搬迁方案',price_from:2800,price_unit:'起',duration_min:720,tags:['整体方案','夜间可搬'],badges:['企业优选'],sales_text:'服务企业 300+',rating_score:4.8,worker_min_level:'L4',includes:['工位打包','设备防护','分批运输','新址复位'],service_flow:['现场勘察','定制方案','分批搬迁','复位交付'],service_notice:['按规模报价','精密设备单独议','支持夜间作业'],sort_order:5},
  {id:20,category_id:'moving',name:'搬货上下楼 · 计件',slug:'moving-updown',spec:'无电梯搬运 · 计件',price_from:200,price_unit:'起',duration_min:120,tags:['纯人力','灵活计件'],badges:['省心搬'],sales_text:'已搬 4600+',rating_score:4.5,worker_min_level:'L2',includes:['大件上下楼','人力搬运','轻拿轻放','楼道清运'],service_flow:['提交物品楼层','客服估价','上门搬运','验收'],service_notice:['按件与楼层计','超重物品加收','贵重物品建议保价'],sort_order:6},
  {id:21,category_id:'nanny',name:'住家保姆 · 全职',slug:'nanny-livein-full',spec:'做饭/保洁/照护 全包',price_from:6800,price_unit:'/月',duration_min:43200,tags:['住家全职','一岗多能'],badges:['严选','健康证'],sales_text:'月签 500+',rating_score:4.7,worker_min_level:'L3',includes:['一日三餐','全屋保洁','衣物洗护','日常采买'],service_flow:['顾问面谈','筛选候选人','试工确认','月度服务'],service_notice:['签约含体检','试工3天可换人','节假日另议'],sort_order:3},
  {id:22,category_id:'nanny',name:'白班保姆 · 日间',slug:'nanny-dayshift',spec:'日间到岗 · 不住家',price_from:5200,price_unit:'/月',duration_min:21600,tags:['日间到岗','灵活时段'],badges:['严选'],sales_text:'月签 320+',rating_score:4.6,worker_min_level:'L2',includes:['三餐制作','日常保洁','衣物整理','老人陪伴'],service_flow:['顾问面谈','匹配阿姨','试工确认','月度服务'],service_notice:['按到岗时长计','含基础体检','可周末排班'],sort_order:4},
  {id:23,category_id:'nanny',name:'月嫂 · 26天',slug:'yuesao-26d',spec:'5年经验 · 三甲护理',price_from:12800,price_unit:'/月',duration_min:43200,tags:['金牌月嫂','三甲护'],badges:['严选','持证'],sales_text:'月签 210+',rating_score:4.9,worker_min_level:'L4',includes:['新生儿护理','产妇护理','月子餐','催乳指导'],service_flow:['顾问面谈','筛选候选人','视频面试','到岗服务'],service_notice:['签约含体检背调','提前30天预约','可加购催乳'],sort_order:5},
  {id:24,category_id:'nanny',name:'养老护理 · 陪护',slug:'elder-care',spec:'失能/半失能 专业陪护',price_from:6000,price_unit:'/月',duration_min:43200,tags:['专业护理','持证上岗'],badges:['严选','健康证'],sales_text:'月签 180+',rating_score:4.8,worker_min_level:'L4',includes:['生活照护','翻身拍背','康复陪护','用药提醒'],service_flow:['评估老人情况','匹配护理员','试工确认','月度陪护'],service_notice:['按护理等级计价','医疗操作不含','可加购夜间陪护'],sort_order:6},
];

const JZ_VENDORS = [
  {id:1,type:'cleaning',name:'春晖家政',logo:'🏠',address:'西湖区文三路',rating:4.6,review_count:3566,rank_type:'city',rank_label:'同城销量榜第 8',badges:['whitelist','backcheck','top10'],live:0,start_price:79.8,unit:'2小时',hours:'08:00-22:00',sort_order:1},
  {id:2,type:'cleaning',name:'平台优选·保洁',logo:'🛡',address:'全国连锁',rating:4.8,review_count:12800,rank_type:'platform',rank_label:'平台自营',badges:['whitelist','insurance','commitment'],live:1,start_price:59.8,unit:'2小时',hours:'07:00-23:00',sort_order:2},
  {id:3,type:'cleaning',name:'杭州鑫禧',logo:'🏡',address:'拱墅区运河路',rating:4.5,review_count:2180,rank_type:null,rank_label:null,badges:['backcheck','commitment'],live:0,start_price:69.8,unit:'2小时',hours:'09:00-21:00',sort_order:3},
  {id:4,type:'cleaning',name:'洁先锋',logo:'🧼',address:'滨江区江南大道',rating:4.3,review_count:980,rank_type:null,rank_label:null,badges:['whitelist'],live:0,start_price:49.8,unit:'2小时',hours:'08:00-20:00',sort_order:4},
  {id:5,type:'cleaning',name:'永盛家政',logo:'🏆',address:'滨江区星耀城',rating:4.7,review_count:5420,rank_type:'district',rank_label:'滨江销量榜第 1',badges:['whitelist','backcheck','top10'],live:0,start_price:89.8,unit:'2小时',hours:'07:00-22:00',sort_order:5},
  {id:11,type:'repair',name:'快修家电',logo:'🔌',address:'上城区庆春路',rating:4.6,review_count:2300,rank_type:'district',rank_label:'家电维修口碑第 1',badges:['whitelist','backcheck'],live:0,start_price:89,unit:'次',hours:'07:00-22:00',sort_order:11},
  {id:12,type:'repair',name:'万师傅维修',logo:'🔧',address:'江干区凤起东路',rating:4.5,review_count:1680,rank_type:null,rank_label:null,badges:['whitelist','backcheck'],live:0,start_price:79,unit:'次',hours:'07:00-22:00',sort_order:12},
  {id:13,type:'repair',name:'邻家快修',logo:'🛠',address:'西湖区古翠路',rating:4.4,review_count:920,rank_type:null,rank_label:null,badges:['backcheck'],live:0,start_price:69,unit:'次',hours:'08:00-21:00',sort_order:13},
  {id:21,type:'moving',name:'蚂蚁搬家',logo:'🚚',address:'下城区东新路',rating:4.7,review_count:5600,rank_type:'city',rank_label:'同城销量榜第 2',badges:['whitelist','backcheck','top10'],live:0,start_price:398,unit:'车次',hours:'06:00-22:00',sort_order:21},
  {id:22,type:'moving',name:'大众搬家',logo:'🚛',address:'余杭区文一西路',rating:4.5,review_count:3200,rank_type:'district',rank_label:'余杭销量榜第 2',badges:['whitelist','backcheck'],live:0,start_price:358,unit:'车次',hours:'06:00-22:00',sort_order:22},
  {id:23,type:'moving',name:'蓝犀牛搬家',logo:'🦏',address:'萧山区市心中路',rating:4.6,review_count:2400,rank_type:null,rank_label:null,badges:['whitelist'],live:0,start_price:428,unit:'车次',hours:'07:00-21:00',sort_order:23},
  {id:31,type:'nanny',name:'阿姨来了',logo:'👶',address:'全国连锁',rating:4.8,review_count:8800,rank_type:'city',rank_label:'同城口碑第 1',badges:['whitelist','backcheck','insurance'],live:0,start_price:8800,unit:'月',hours:'住家',sort_order:31},
  {id:32,type:'nanny',name:'好孕到家',logo:'🤱',address:'全国连锁',rating:4.7,review_count:4200,rank_type:'city',rank_label:'月嫂口碑第 2',badges:['whitelist','backcheck','insurance'],live:0,start_price:12800,unit:'月',hours:'住家',sort_order:32},
  {id:33,type:'nanny',name:'松鹤养老',logo:'🧓',address:'上城区清波街道',rating:4.6,review_count:1600,rank_type:null,rank_label:null,badges:['whitelist','backcheck'],live:0,start_price:6000,unit:'月',hours:'住家',sort_order:33},
];

const JZ_WORKERS = [
  {id:1,name:'陈建国',avatar:'👨',level:'L4',credit_score:88,tags:['细致','主动','准时'],rating:4.9,completed_orders:2317,years_experience:5,online:1,distance_km:2.4,vendor_id:1},
  {id:2,name:'杨秀芳',avatar:'👩',level:'L4',credit_score:92,tags:['准时','周到','经验丰富'],rating:4.8,completed_orders:1820,years_experience:6,online:1,distance_km:3.1,vendor_id:5},
  {id:3,name:'王志强',avatar:'👨',level:'L3',credit_score:78,tags:['专业','稳重'],rating:4.6,completed_orders:920,years_experience:3,online:1,distance_km:1.8,vendor_id:1},
  {id:4,name:'刘海燕',avatar:'👩',level:'L3',credit_score:80,tags:['热情','耐心'],rating:4.7,completed_orders:1280,years_experience:4,online:0,distance_km:5.2,vendor_id:2},
  {id:11,name:'赵国栋',avatar:'👨',level:'L4',credit_score:90,tags:['技术好','快修','讲解清晰'],rating:4.8,completed_orders:1560,years_experience:8,online:1,distance_km:1.5,vendor_id:11},
  {id:12,name:'孙志明',avatar:'👨',level:'L3',credit_score:82,tags:['准时','耐心'],rating:4.6,completed_orders:640,years_experience:4,online:1,distance_km:2.2,vendor_id:11},
  {id:13,name:'钱大勇',avatar:'👨',level:'L4',credit_score:88,tags:['技术过硬','响应快'],rating:4.7,completed_orders:1180,years_experience:7,online:1,distance_km:2.6,vendor_id:12},
  {id:14,name:'冯建',avatar:'👨',level:'L3',credit_score:80,tags:['耐心','细致'],rating:4.5,completed_orders:520,years_experience:4,online:1,distance_km:3.4,vendor_id:13},
  {id:21,name:'李强',avatar:'👨',level:'L4',credit_score:87,tags:['力气大','麻利','轻拿轻放'],rating:4.7,completed_orders:2040,years_experience:6,online:1,distance_km:3.0,vendor_id:21},
  {id:22,name:'周斌',avatar:'👨',level:'L3',credit_score:79,tags:['细心','不磕碰'],rating:4.5,completed_orders:880,years_experience:3,online:0,distance_km:4.1,vendor_id:21},
  {id:23,name:'郑涛',avatar:'👨',level:'L4',credit_score:86,tags:['力气大','稳妥'],rating:4.6,completed_orders:1420,years_experience:6,online:1,distance_km:4.2,vendor_id:22},
  {id:24,name:'秦勇',avatar:'👨',level:'L3',credit_score:79,tags:['麻利','轻放'],rating:4.5,completed_orders:660,years_experience:3,online:1,distance_km:5.5,vendor_id:23},
  {id:31,name:'陈丽娟',avatar:'👩',level:'L5',credit_score:95,tags:['有爱心','经验丰富','持证'],rating:4.9,completed_orders:3200,years_experience:10,online:1,distance_km:2.8,vendor_id:31},
  {id:32,name:'吴桂英',avatar:'👩',level:'L4',credit_score:89,tags:['细心','耐心','会做月子餐'],rating:4.8,completed_orders:1450,years_experience:7,online:1,distance_km:3.6,vendor_id:31},
  {id:33,name:'何美玲',avatar:'👩',level:'L5',credit_score:94,tags:['金牌月嫂','三甲护','持证'],rating:4.9,completed_orders:2100,years_experience:9,online:1,distance_km:2.5,vendor_id:32},
  {id:34,name:'许秀兰',avatar:'👩',level:'L4',credit_score:88,tags:['专业护理','有耐心','持证'],rating:4.7,completed_orders:980,years_experience:6,online:1,distance_km:3.0,vendor_id:33},
];

const CHANNEL_SKU_MAP = {
  101:1,201:1,301:1,401:1,501:1,103:1,102:2,202:2,
  1105:3,1102:4,1103:5,2101:6,2104:7,3103:8,3101:9,
  111:10,502:10,112:11,302:11,203:12,402:12,
  1107:13,1201:13,1108:14,1301:14,1202:15,1302:16,1109:16,
  2105:17,2201:17,2202:18,2301:19,2106:19,2302:20,
  3104:21,3201:21,3202:22,3105:23,3301:23,3302:24,
  1101:14,1104:15,1106:16,2102:17,2103:18,3102:23,
};

// [pid,vid,title,sub,cat,dur,area,unit,price,orig,disc,earliest,adv,sales,rating,tags]
const JZ_PRODUCTS = [
  [101,1,'日常保洁 2小时','上门除尘·死无死角','日常保洁',2,'≤50㎡','2小时',79.8,200,'4折','今天 18:00',2,53000,4.7,['每个角落都仔细清洁','死无死角','专业工具']],
  [102,1,'深度清洁 2小时','3人团队·含厨卫去污','深度清洁',2,'≤50㎡','2小时',99.8,200,'5折','明天 09:00',2,16000,4.8,['专业团队','深度去污','含厨卫']],
  [103,1,'日常保洁 3小时','含厨房/卫生间','日常保洁',3,'51-90㎡','3小时',139.8,300,'4.6折','今天 19:00',2,8000,4.6,['三小时更彻底','含厨卫']],
  [201,2,'日常保洁 2小时','平台优选·急速上门','日常保洁',2,'≤60㎡','2小时',59.8,180,'3.3折','今天 18:00',1,128000,4.8,['急速上门','不满意重做','百万保障']],
  [202,2,'深度清洁 3小时','3人组·含玻璃/油烟机','深度清洁',3,'≤80㎡','3小时',159.8,380,'4.2折','明天 08:00',2,42000,4.9,['3人组','含玻璃']],
  [203,2,'油烟机清洗·深度','平台优选·拆洗','油烟机清洗',1,'','台',128,260,'4.9折','今天 18:00',1,9100,4.8,['拆洗深度','除重油','百万保障']],
  [301,3,'日常保洁 2小时','本地团队','日常保洁',2,'≤50㎡','2小时',69.8,160,'4.3折','明天 09:00',4,15000,4.5,['本地团队']],
  [302,3,'玻璃清洗·家庭','本地团队·快速','玻璃清洗',2,'','起',108,220,'4.9折','明天 10:00',2,1500,4.5,['本地团队','快速上门']],
  [401,4,'日常保洁 2小时','经济实惠','日常保洁',2,'≤50㎡','2小时',49.8,150,'3.3折','今天 19:00',2,6800,4.3,['经济实惠']],
  [402,4,'油烟机清洗·经济','实惠·快速拆洗','油烟机清洗',1,'','台',108,220,'4.9折','今天 19:00',2,3600,4.3,['经济实惠','快速拆洗']],
  [501,5,'日常保洁 2小时','金牌服务者','日常保洁',2,'≤60㎡','2小时',89.8,240,'3.7折','今天 18:00',2,31000,4.7,['金牌服务者','专业工具']],
  [502,5,'开荒保洁·精细','金牌团队·逐项验收','开荒保洁',6,'≤120㎡','起',468,880,'5.3折','明天 08:00',12,3100,4.9,['金牌团队','逐项验收']],
  [111,1,'开荒保洁·新居','3-5人团队·全屋开荒','开荒保洁',6,'≤90㎡','起',428,800,'5.3折','明天 09:00',12,6200,4.8,['装修后必做','3-5人团队','全屋开荒']],
  [112,1,'玻璃清洗·高层','内外双面·无痕','玻璃清洗',2,'','起',118,240,'4.9折','今天 19:00',2,2400,4.6,['无水痕','高层可做']],
  [1101,11,'空调维修','不制冷/漏水/异响','家电维修',1,'','次',89,200,'4.5折','30分钟内',0,8200,4.6,['30分钟上门','原厂配件','90天质保']],
  [1102,11,'管道疏通','30分钟上门·不通不收费','管道疏通',1,'','次',99,220,'4.5折','30分钟内',0,5600,4.7,['30分钟上门','不通不收费','原厂配件']],
  [1103,11,'灯具电路','断路/短路/跳闸维修','灯具电路',1,'','次',79,180,'4.4折','30分钟内',0,3200,4.5,['30分钟上门','持证电工','原厂配件']],
  [1104,11,'门窗维修','门窗变形/锁具损坏','门窗维修',1,'','次',89,200,'4.5折','30分钟内',0,2100,4.4,['30分钟上门','品牌锁具','90天质保']],
  [1105,11,'空调清洗','挂机/柜机拆装深度','空调维修',1,'','台',89,200,'4.5折','今天 19:00',0,9100,4.6,['拆装深度','高温蒸汽','30分钟上门']],
  [1106,11,'水管维修','水管渗漏/爆裂应急','水管维修',1,'','次',99,240,'4.1折','30分钟内',0,2800,4.5,['30分钟上门','原厂配件','持证水工']],
  [1107,11,'家电维修·上门','冰箱/洗衣机/热水器','家电维修',1,'','起',89,200,'4.5折','30分钟内',0,4200,4.6,['多品类可修','30分钟上门','90天质保']],
  [1108,11,'空调维修·加氟','不制冷/漏氟/异响','空调维修',1,'','起',159,320,'5折','30分钟内',0,5600,4.7,['加氟清洗','持证上岗','90天质保']],
  [1109,11,'水管维修·快修','快修家电·持证水工','水管维修',1,'','起',109,240,'4.5折','30分钟内',0,1600,4.6,['持证水工','原厂配件']],
  [1201,12,'家电维修·全屋','万师傅·持证检修','家电维修',1,'','起',79,180,'4.4折','30分钟内',0,1680,4.5,['持证检修','配件齐全']],
  [1202,12,'门窗维修·锁具','门窗校正·锁具更换','门窗维修',1,'','起',89,200,'4.5折','30分钟内',0,2100,4.4,['锁具更换','门窗校正','品牌锁具']],
  [1301,13,'空调维修·快修','邻家快修·当天','空调维修',1,'','起',149,300,'5折','今天 19:00',0,920,4.4,['当天上门','邻里口碑']],
  [1302,13,'水管维修·应急','渗漏爆裂·抢修','水管维修',1,'','起',99,220,'4.5折','30分钟内',0,2800,4.5,['应急抢修','持证水工','30天质保']],
  [2101,21,'居民搬家同城','金杯车·2名师傅','居民搬家',1,'','车次',398,680,'5.8折','今天 19:00',4,23000,4.7,['金杯车','2名师傅']],
  [2102,21,'居民搬家跨城','厢式车·3名师傅','长途搬家',1,'','车次',1200,2200,'5.5折','明天 09:00',24,8200,4.6,['厢式车','3名师傅','300km+']],
  [2103,21,'钢琴搬运','专业·三角钢琴可接','钢琴搬运',1,'','次',800,1500,'5.3折','明天 14:00',48,1200,4.9,['专业团队','原厂包装','保险']],
  [2104,21,'日式搬家','全包服务·不动手','日式搬家',1,'','次',1580,2800,'5.6折','明天 08:00',48,3100,4.8,['全包服务','不动手','100%还原']],
  [2105,21,'长途搬家·跨城','厢式车·3名师傅','长途搬家',10,'','起',1280,2400,'5.3折','明天 09:00',24,3200,4.6,['跨城直达','全程跟踪','厢式车']],
  [2106,21,'企业搬迁·标准','蚂蚁搬家·分批运输','企业搬迁',12,'','起',2800,5200,'5.4折','3日内',48,210,4.7,['分批运输','新址复位']],
  [2201,22,'长途搬家·经济','大众搬家·拼车可选','长途搬家',10,'','起',1180,2200,'5.4折','明天 08:00',24,1600,4.5,['拼车可选','经济实惠']],
  [2202,22,'钢琴搬运·专业','立式/三角可接','钢琴搬运',2,'','次',820,1600,'5.1折','明天 14:00',48,680,4.9,['专业防护','保价运输']],
  [2301,23,'企业搬迁·整体','蓝犀牛·夜间可搬','企业搬迁',12,'','起',2980,5600,'5.3折','3日内',48,320,4.8,['整体方案','夜间可搬']],
  [2302,23,'搬货上下楼·计件','无电梯·纯人力','搬货上下楼',2,'','起',200,420,'4.8折','今天 19:00',4,4600,4.5,['纯人力','灵活计件']],
  [3101,31,'住家育儿嫂','3年以上经验·持证','住家育儿嫂',24,'','月',8800,12000,'7.3折','5日内',120,5200,4.8,['持证','3年经验','健康证']],
  [3102,31,'月嫂26天','5年以上经验·三甲护','月嫂',24,'','月',12800,18000,'7.1折','30日内',720,2100,4.9,['持证','三甲护','5年经验']],
  [3103,31,'钟点工3小时','做饭保洁·灵活预约','钟点工',3,'','次',128,220,'5.8折','今天 18:00',4,12800,4.7,['做饭保洁','灵活预约','3小时']],
  [3104,31,'住家保姆·全职','做饭/保洁/照护全包','住家保姆',24,'','月',6800,10000,'6.8折','5日内',120,3200,4.7,['住家全职','一岗多能','健康证']],
  [3105,31,'月嫂·26天','5年经验·三甲护','月嫂',24,'','月',12800,18000,'7.1折','30日内',720,2100,4.9,['金牌月嫂','三甲护','持证']],
  [3201,32,'住家保姆·严选','好孕到家·体检背调','住家保姆',24,'','月',7200,11000,'6.5折','5日内',120,1800,4.7,['体检背调','严选阿姨']],
  [3202,32,'白班保姆·日间','日间到岗·不住家','白班保姆',12,'','月',5200,8000,'6.5折','5日内',72,2100,4.6,['日间到岗','灵活时段']],
  [3301,33,'月嫂·金牌','松鹤·三甲护理','月嫂',24,'','月',13800,19800,'7折','30日内',720,800,4.9,['金牌月嫂','三甲护理']],
  [3302,33,'养老护理·陪护','失能/半失能陪护','养老护理',24,'','月',6000,9000,'6.7折','5日内',120,980,4.8,['专业护理','持证上岗','健康证']],
];

async function seedAll(conn) {
  const jd = (v) => JSON.stringify(v);
  const now = new Date().toISOString().slice(0, 19);

  const [[sc]] = await conn.execute('SELECT COUNT(*) AS c FROM jz_subcategories');
  if (sc.c === 0) {
    for (const [pt, name, icon, ord] of JZ_SUBCATS) {
      await conn.execute(
        "INSERT INTO jz_subcategories(parent_type,name,icon,sort_order,status) VALUES(?,?,?,?,'on')",
        [pt, name, icon, ord]
      );
    }
  }

  const [[skuC]] = await conn.execute('SELECT COUNT(*) AS c FROM jz_skus');
  if (skuC.c === 0) {
    for (const s of JZ_DEFAULT_SKUS) {
      await conn.execute(
        `INSERT INTO jz_skus(id,category_id,name,slug,spec,price_from,price_unit,duration_min,
          tags,badges,sales_text,rating_score,worker_min_level,includes,service_flow,service_notice,sort_order,enabled)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        [s.id,s.category_id,s.name,s.slug,s.spec,s.price_from,s.price_unit,s.duration_min,
         jd(s.tags),jd(s.badges),s.sales_text,s.rating_score,s.worker_min_level,
         jd(s.includes),jd(s.service_flow),jd(s.service_notice),s.sort_order]
      );
    }
  }

  const [[vC]] = await conn.execute('SELECT COUNT(*) AS c FROM jz_vendors');
  if (vC.c === 0) {
    for (const v of JZ_VENDORS) {
      await conn.execute(
        `INSERT INTO jz_vendors(id,type,name,logo,address,rating,review_count,rank_type,rank_label,
          badges,live,start_price,unit,hours,status,sort_order,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
        [v.id,v.type,v.name,v.logo,v.address,v.rating,v.review_count,v.rank_type,v.rank_label,
         jd(v.badges),v.live,v.start_price,v.unit,v.hours,v.sort_order,now,now]
      );
    }
  }

  const [[wC]] = await conn.execute('SELECT COUNT(*) AS c FROM jz_workers');
  if (wC.c === 0) {
    for (const w of JZ_WORKERS) {
      const certs = jd(['id_card','health','skill'].concat(['L4','L5'].includes(w.level)?['insurance']:[]));
      await conn.execute(
        `INSERT INTO jz_workers(id,name,avatar,level,credit_score,tags,certs,is_whitelisted,
          rating,completed_orders,years_experience,online,distance_km,vendor_id,status)
         VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,'active')`,
        [w.id,w.name,w.avatar,w.level,w.credit_score,jd(w.tags),certs,
         w.rating,w.completed_orders,w.years_experience,w.online,w.distance_km,w.vendor_id]
      );
    }
  }

  const [[pC]] = await conn.execute('SELECT COUNT(*) AS c FROM jz_products');
  if (pC.c === 0) {
    for (const p of JZ_PRODUCTS) {
      const [pid,vid,title,subtitle,category,dur,area,unit,price,orig,disc,earliest,adv,sales,rating,tags] = p;
      await conn.execute(
        `INSERT INTO jz_products(id,vendor_id,title,subtitle,category,duration_hours,area_range,unit,
          price,original_price,discount_label,earliest_time,advance_booking_hours,sales_count,rating,
          service_tags,channel_sku_id,status,sort_order)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'on',?)`,
        [pid,vid,title,subtitle,category,dur,area,unit,price,orig,disc,earliest,adv,sales,rating,
         jd(tags),CHANNEL_SKU_MAP[pid]||null,pid]
      );
    }
  }

  const [[swC]] = await conn.execute('SELECT COUNT(*) AS c FROM jz_sku_workers');
  if (swC.c === 0) {
    for (const [pid, vid] of JZ_PRODUCTS.map(p => [p[0], p[1]])) {
      const workers = JZ_WORKERS.filter(w => w.vendor_id === vid);
      for (const w of workers) {
        await conn.execute(
          'INSERT IGNORE INTO jz_sku_workers(product_id,worker_id) VALUES(?,?)',
          [pid, w.id]
        );
      }
    }
  }

  const [[slC]] = await conn.execute('SELECT COUNT(*) AS c FROM jz_sku_slots');
  if (slC.c === 0) {
    const TIMES = [['09:00','11:00'],['14:00','16:00'],['19:00','21:00']];
    const today = new Date();
    const DATES = [1,2,3,4,5].map(i => {
      const d = new Date(today); d.setDate(d.getDate()+i);
      return d.toISOString().slice(0,10);
    });
    const prodWorkerMap = {};
    for (const [pid, vid] of JZ_PRODUCTS.map(p => [p[0], p[1]])) {
      prodWorkerMap[pid] = JZ_WORKERS.filter(w => w.vendor_id === vid).map(w => w.id);
    }
    for (const [pid, wids] of Object.entries(prodWorkerMap)) {
      for (const wid of wids) {
        for (const d of DATES) {
          for (const [st, et] of TIMES) {
            await conn.execute(
              `INSERT INTO jz_sku_slots(product_id,worker_id,slot_date,start_time,end_time,capacity,booked,status)
               VALUES(?,?,?,?,?,2,0,'open')`,
              [parseInt(pid), wid, d, st, et]
            );
          }
        }
      }
    }
  }
}

module.exports = { seedAll };
