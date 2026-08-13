"""新居住频道 · MySQL 读写 + 导出 data.json"""
import json
import threading
from pathlib import Path

import dbconn

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(__file__).resolve().parent / "juzhu.db"  # 历史 SQLite 库（迁移源，不再读写）
JSON_PATH = Path(__file__).resolve().parent / "data.json"
SCHEMA_PATH = Path(__file__).resolve().parent / "mysql_schema.sql"

JZ_WORKERS = [
    {"name": "陈建国", "level": "L4", "tags": ["细致", "主动"]},
    {"name": "杨秀芳", "level": "L4", "tags": ["准时", "周到"]},
    {"name": "王志强", "level": "L3", "tags": ["专业", "稳重"]},
    {"name": "刘海燕", "level": "L3", "tags": ["热情", "耐心"]},
]

JZ_CATEGORY_LABELS = {
    "cleaning": "保洁",
    "repair": "维修",
    "moving": "搬家",
    "nanny": "保姆",
}

JZ_CATEGORY_ICONS = {
    "cleaning": "🧹",
    "repair": "🔧",
    "moving": "📦",
    "nanny": "👶",
}

JZ_STATUS_ORDER = ["pending", "dispatched", "accepted", "serving", "done", "rated"]

JZ_DEFAULT_CATEGORIES = [
    ("cleaning", "保洁", "🧹", 1, "日常清洁、深度清洁、家电清洗"),
    ("repair", "维修", "🔧", 2, "家电维修、管道疏通、门窗灯具"),
    ("moving", "搬家", "📦", 3, "居民搬家、长途搬家、企业搬迁"),
    ("nanny", "保姆", "👶", 4, "住家保姆、育儿嫂、月嫂、护理"),
]

JZ_DEFAULT_SKUS = [
    {
        "id": 1, "category_id": "cleaning", "name": "日常保洁 · 2小时", "slug": "cleaning-daily-2h",
        "spec": "1人上门 · 全屋除尘整理", "price_from": 128, "price_unit": "/次", "duration_min": 120,
        "tags": ["热门", "最快2小时上门"], "badges": ["神券", "全程保"], "sales_text": "已订 5.3万+",
        "rating_score": 4.8, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["客厅卧室除尘", "地面清洁", "台面整理", "基础厨卫擦拭"],
        "service_flow": ["确认地址与面积", "匹配保洁员", "按约上门", "完工验收"],
        "service_notice": ["服务前2小时可免费取消", "标准耗材已含", "超时按30分钟补差价"], "sort_order": 1,
    },
    {
        "id": 2, "category_id": "cleaning", "name": "深度清洁 · 4小时", "slug": "deep-clean-4h",
        "spec": "3人团队 · 含厨卫去污", "price_from": 268, "price_unit": "起", "duration_min": 240,
        "tags": ["爆款", "死角焕新"], "badges": ["团购爆品", "立减10"], "sales_text": "已订 1.6万+",
        "rating_score": 4.9, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["厨房油污处理", "卫生间除垢", "踢脚线与缝隙除尘", "家具表面深擦"],
        "service_flow": ["客服确认房型", "分配L3保洁员", "上门深度清洁", "拍照回传与验收"],
        "service_notice": ["50㎡以内标准价", "特殊药剂需二次确认", "完工后可申请复洁"], "sort_order": 2,
    },
    {
        "id": 3, "category_id": "cleaning", "name": "空调清洗 · 挂机", "slug": "ac-clean-wall",
        "spec": "高温蒸汽 · 拆装深度", "price_from": 89, "price_unit": "/台", "duration_min": 90,
        "tags": ["当天上门", "除菌除味"], "badges": ["会员价", "平台保障"], "sales_text": "近期好评 1000+",
        "rating_score": 4.7, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["滤网拆洗", "蒸汽除菌", "出风口清洁", "基础功能检测"],
        "service_flow": ["确认机型", "预约时段", "工程师上门", "清洗验收"],
        "service_notice": ["柜机另计", "高空外机不含", "服务后24小时内可追评"], "sort_order": 3,
    },
    {
        "id": 4, "category_id": "repair", "name": "管道疏通 · 当天", "slug": "pipe-unclog-fast",
        "spec": "30分钟响应 · 不通不收费", "price_from": 99, "price_unit": "起", "duration_min": 60,
        "tags": ["应急维修", "最快30分钟"], "badges": ["应急", "全天候"], "sales_text": "年售 2.4万+",
        "rating_score": 4.8, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["厨房下水疏通", "卫生间地漏疏通", "基础堵点判断", "作业区清洁恢复"],
        "service_flow": ["提交故障", "派发就近技师", "上门检测疏通", "完工确认"],
        "service_notice": ["超技能范围可重派", "配件费另计", "30天同故障质保"], "sort_order": 1,
    },
    {
        "id": 5, "category_id": "repair", "name": "灯具安装 · 吸顶灯", "slug": "light-install-ceiling",
        "spec": "电工持证 · 高空作业规范", "price_from": 59, "price_unit": "/盏", "duration_min": 45,
        "tags": ["持证上岗"], "badges": ["全程保"], "sales_text": "年售 6000+",
        "rating_score": 4.6, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["拆旧装新", "电路检测", "基础调试", "现场清理"],
        "service_flow": ["确认灯型", "预约上门", "安装调试", "拍照回传"],
        "service_notice": ["复杂吊灯另报价", "不含灯具材料", "电路改造需二次确认"], "sort_order": 2,
    },
    {
        "id": 6, "category_id": "moving", "name": "居民搬家 · 同城", "slug": "moving-city-standard",
        "spec": "金杯车 · 2名师傅", "price_from": 398, "price_unit": "起", "duration_min": 180,
        "tags": ["同城精选", "可加购打包"], "badges": ["省心搬", "平台保障"], "sales_text": "已搬 7800+",
        "rating_score": 4.7, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["基础搬运", "车辆运输", "大件保护包裹", "楼道清运"],
        "service_flow": ["提交清单", "客服估价", "确认车辆与人员", "按时搬运"],
        "service_notice": ["楼层费按现场核算", "超距单独计费", "贵重物品建议保价"], "sort_order": 1,
    },
    {
        "id": 7, "category_id": "moving", "name": "日式搬家 · 全包", "slug": "moving-japanese-full",
        "spec": "打包收纳 + 还原归位", "price_from": 1680, "price_unit": "起", "duration_min": 480,
        "tags": ["高端服务", "全程无忧"], "badges": ["PRO"], "sales_text": "企业家庭双适用",
        "rating_score": 4.9, "worker_min_level": "L4", "cover_image": None,
        "gallery": [], "includes": ["分类打包", "上门收纳", "新居归位", "垃圾清运"],
        "service_flow": ["顾问勘察", "确认方案", "分工搬运", "到家复原"],
        "service_notice": ["需提前1天预约", "贵重柜体单独报价", "默认含基础耗材"], "sort_order": 2,
    },
    {
        "id": 8, "category_id": "nanny", "name": "钟点工 · 3小时", "slug": "nanny-hourly-3h",
        "spec": "做饭保洁 · 灵活预约", "price_from": 128, "price_unit": "/次", "duration_min": 180,
        "tags": ["灵活用工", "做饭保洁"], "badges": ["热门"], "sales_text": "年售 1.2万+",
        "rating_score": 4.8, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["一餐制作", "基础保洁", "衣物整理", "简单采购代办"],
        "service_flow": ["选时段", "匹配阿姨", "上门服务", "结束评价"],
        "service_notice": ["食材默认用户提供", "需提前确认菜谱", "节假日价格浮动"], "sort_order": 1,
    },
    {
        "id": 9, "category_id": "nanny", "name": "育儿嫂 · 住家", "slug": "nanny-livein-babycare",
        "spec": "3年以上经验 · 持证", "price_from": 8800, "price_unit": "/月", "duration_min": 43200,
        "tags": ["住家服务", "持证育儿"], "badges": ["严选"], "sales_text": "月签 300+",
        "rating_score": 4.9, "worker_min_level": "L4", "cover_image": None,
        "gallery": [], "includes": ["婴幼儿照护", "喂养作息", "辅食制作", "成长记录"],
        "service_flow": ["顾问面谈", "筛选候选人", "试工确认", "月度服务"],
        "service_notice": ["支持视频面试", "可加购体检背调", "签约后7天可换人"], "sort_order": 2,
    },
    # ===== 扩充 SPU（每个类目补齐至 6 个标准品，2026-07 迭代）=====
    {
        "id": 10, "category_id": "cleaning", "name": "开荒保洁 · 新居", "slug": "raw-clean-new",
        "spec": "新房装修后 · 全屋开荒", "price_from": 398, "price_unit": "起", "duration_min": 360,
        "tags": ["装修后必做", "3-5人团队"], "badges": ["团购爆品", "全程保"], "sales_text": "已订 8000+",
        "rating_score": 4.8, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["水泥漆点清理", "全屋除尘除胶", "门窗轨道清洁", "地面打蜡养护"],
        "service_flow": ["确认房型面积", "分配开荒团队", "上门开荒清洁", "拍照回传验收"],
        "service_notice": ["按建筑面积计价", "高空外窗不含", "顽固污渍需二次确认"], "sort_order": 4,
    },
    {
        "id": 11, "category_id": "cleaning", "name": "玻璃清洗 · 高层", "slug": "glass-clean-highrise",
        "spec": "内外双面 · 无痕清洁", "price_from": 108, "price_unit": "起", "duration_min": 90,
        "tags": ["无水痕", "高层可做"], "badges": ["会员价"], "sales_text": "近期好评 2000+",
        "rating_score": 4.6, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["玻璃内外擦拭", "窗框清洁", "轨道除尘", "纱窗拆洗"],
        "service_flow": ["确认窗户数量", "预约时段", "上门清洗", "验收"],
        "service_notice": ["高空外墙需评估", "落地窗按面积计", "破损玻璃不承保"], "sort_order": 5,
    },
    {
        "id": 12, "category_id": "cleaning", "name": "油烟机清洗 · 深度", "slug": "hood-clean-deep",
        "spec": "拆洗深度 · 除重油", "price_from": 128, "price_unit": "/台", "duration_min": 60,
        "tags": ["拆洗深度", "除重油"], "badges": ["神券", "平台保障"], "sales_text": "已订 1.1万+",
        "rating_score": 4.7, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["油烟机拆洗", "扇叶除油", "机身内壁清洁", "功能复检"],
        "service_flow": ["确认机型", "预约上门", "拆洗清洁", "复装验收"],
        "service_notice": ["集成灶另计", "老旧机型谨慎拆", "服务后24h可追评"], "sort_order": 6,
    },
    {
        "id": 13, "category_id": "repair", "name": "家电维修 · 上门", "slug": "appliance-repair",
        "spec": "冰箱/洗衣机/热水器", "price_from": 89, "price_unit": "起", "duration_min": 60,
        "tags": ["多品类可修", "30分钟响应"], "badges": ["应急", "90天质保"], "sales_text": "年售 8000+",
        "rating_score": 4.6, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["故障检测", "配件更换", "功能调试", "作业清洁"],
        "service_flow": ["提交故障", "派发就近技师", "上门检修", "完工确认"],
        "service_notice": ["配件费另计", "超范围可重派", "30天同故障质保"], "sort_order": 3,
    },
    {
        "id": 14, "category_id": "repair", "name": "空调维修 · 加氟", "slug": "ac-repair-refill",
        "spec": "不制冷/漏氟/异响", "price_from": 159, "price_unit": "起", "duration_min": 90,
        "tags": ["加氟清洗", "持证上岗"], "badges": ["全程保"], "sales_text": "年售 5600+",
        "rating_score": 4.7, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["制冷检测", "加氟补漏", "管路检查", "运行测试"],
        "service_flow": ["确认机型故障", "预约上门", "检修加氟", "验收"],
        "service_notice": ["加氟量按现场计", "外机高空另议", "90天质保"], "sort_order": 4,
    },
    {
        "id": 15, "category_id": "repair", "name": "门窗维修 · 锁具", "slug": "door-window-repair",
        "spec": "门窗变形/锁具损坏", "price_from": 89, "price_unit": "起", "duration_min": 60,
        "tags": ["锁具更换", "门窗校正"], "badges": ["品牌锁具"], "sales_text": "年售 2100+",
        "rating_score": 4.4, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["门窗校正", "五金更换", "锁芯升级", "密封处理"],
        "service_flow": ["确认门窗类型", "预约上门", "维修更换", "验收"],
        "service_notice": ["锁具材料另计", "断桥铝另议", "90天质保"], "sort_order": 5,
    },
    {
        "id": 16, "category_id": "repair", "name": "水管维修 · 应急", "slug": "waterpipe-repair",
        "spec": "渗漏/爆裂 应急处理", "price_from": 99, "price_unit": "起", "duration_min": 60,
        "tags": ["应急抢修", "持证水工"], "badges": ["应急", "全天候"], "sales_text": "年售 2800+",
        "rating_score": 4.5, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["漏点排查", "管路修复", "接口更换", "通水测试"],
        "service_flow": ["提交故障", "派发就近水工", "上门抢修", "完工确认"],
        "service_notice": ["配件费另计", "暗埋管评估后作业", "30天质保"], "sort_order": 6,
    },
    {
        "id": 17, "category_id": "moving", "name": "长途搬家 · 跨城", "slug": "moving-longhaul",
        "spec": "厢式货车 · 300km+", "price_from": 1200, "price_unit": "起", "duration_min": 600,
        "tags": ["跨城直达", "全程跟踪"], "badges": ["省心搬", "平台保障"], "sales_text": "已搬 3200+",
        "rating_score": 4.6, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["打包搬运", "长途运输", "大件保护", "到点卸货"],
        "service_flow": ["提交清单里程", "顾问估价", "确认车型人员", "跨城运输"],
        "service_notice": ["里程按实结算", "贵重物品建议保价", "偏远地区加收"], "sort_order": 3,
    },
    {
        "id": 18, "category_id": "moving", "name": "钢琴搬运 · 专业", "slug": "moving-piano",
        "spec": "立式/三角钢琴 可接", "price_from": 800, "price_unit": "/次", "duration_min": 120,
        "tags": ["专业防护", "保价运输"], "badges": ["PRO", "保险"], "sales_text": "已搬 1200+",
        "rating_score": 4.9, "worker_min_level": "L4", "cover_image": None,
        "gallery": [], "includes": ["专业包装", "楼梯搬运", "水平运输", "就位摆放"],
        "service_flow": ["确认琴型楼层", "预约上门", "专业搬运", "就位验收"],
        "service_notice": ["超高楼层加收", "默认含保价", "调律需另约"], "sort_order": 4,
    },
    {
        "id": 19, "category_id": "moving", "name": "企业搬迁 · 整体", "slug": "moving-office",
        "spec": "办公整体搬迁方案", "price_from": 2800, "price_unit": "起", "duration_min": 720,
        "tags": ["整体方案", "夜间可搬"], "badges": ["企业优选"], "sales_text": "服务企业 300+",
        "rating_score": 4.8, "worker_min_level": "L4", "cover_image": None,
        "gallery": [], "includes": ["工位打包", "设备防护", "分批运输", "新址复位"],
        "service_flow": ["现场勘察", "定制方案", "分批搬迁", "复位交付"],
        "service_notice": ["按规模报价", "精密设备单独议", "支持夜间作业"], "sort_order": 5,
    },
    {
        "id": 20, "category_id": "moving", "name": "搬货上下楼 · 计件", "slug": "moving-updown",
        "spec": "无电梯搬运 · 计件", "price_from": 200, "price_unit": "起", "duration_min": 120,
        "tags": ["纯人力", "灵活计件"], "badges": ["省心搬"], "sales_text": "已搬 4600+",
        "rating_score": 4.5, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["大件上下楼", "人力搬运", "轻拿轻放", "楼道清运"],
        "service_flow": ["提交物品楼层", "客服估价", "上门搬运", "验收"],
        "service_notice": ["按件与楼层计", "超重物品加收", "贵重物品建议保价"], "sort_order": 6,
    },
    {
        "id": 21, "category_id": "nanny", "name": "住家保姆 · 全职", "slug": "nanny-livein-full",
        "spec": "做饭/保洁/照护 全包", "price_from": 6800, "price_unit": "/月", "duration_min": 43200,
        "tags": ["住家全职", "一岗多能"], "badges": ["严选", "健康证"], "sales_text": "月签 500+",
        "rating_score": 4.7, "worker_min_level": "L3", "cover_image": None,
        "gallery": [], "includes": ["一日三餐", "全屋保洁", "衣物洗护", "日常采买"],
        "service_flow": ["顾问面谈", "筛选候选人", "试工确认", "月度服务"],
        "service_notice": ["签约含体检", "试工3天可换人", "节假日另议"], "sort_order": 3,
    },
    {
        "id": 22, "category_id": "nanny", "name": "白班保姆 · 日间", "slug": "nanny-dayshift",
        "spec": "日间到岗 · 不住家", "price_from": 5200, "price_unit": "/月", "duration_min": 21600,
        "tags": ["日间到岗", "灵活时段"], "badges": ["严选"], "sales_text": "月签 320+",
        "rating_score": 4.6, "worker_min_level": "L2", "cover_image": None,
        "gallery": [], "includes": ["三餐制作", "日常保洁", "衣物整理", "老人陪伴"],
        "service_flow": ["顾问面谈", "匹配阿姨", "试工确认", "月度服务"],
        "service_notice": ["按到岗时长计", "含基础体检", "可周末排班"], "sort_order": 4,
    },
    {
        "id": 23, "category_id": "nanny", "name": "月嫂 · 26天", "slug": "yuesao-26d",
        "spec": "5年经验 · 三甲护理", "price_from": 12800, "price_unit": "/月", "duration_min": 43200,
        "tags": ["金牌月嫂", "三甲护"], "badges": ["严选", "持证"], "sales_text": "月签 210+",
        "rating_score": 4.9, "worker_min_level": "L4", "cover_image": None,
        "gallery": [], "includes": ["新生儿护理", "产妇护理", "月子餐", "催乳指导"],
        "service_flow": ["顾问面谈", "筛选候选人", "视频面试", "到岗服务"],
        "service_notice": ["签约含体检背调", "提前30天预约", "可加购催乳"], "sort_order": 5,
    },
    {
        "id": 24, "category_id": "nanny", "name": "养老护理 · 陪护", "slug": "elder-care",
        "spec": "失能/半失能 专业陪护", "price_from": 6000, "price_unit": "/月", "duration_min": 43200,
        "tags": ["专业护理", "持证上岗"], "badges": ["严选", "健康证"], "sales_text": "月签 180+",
        "rating_score": 4.8, "worker_min_level": "L4", "cover_image": None,
        "gallery": [], "includes": ["生活照护", "翻身拍背", "康复陪护", "用药提醒"],
        "service_flow": ["评估老人情况", "匹配护理员", "试工确认", "月度陪护"],
        "service_notice": ["按护理等级计价", "医疗操作不含", "可加购夜间陪护"], "sort_order": 6,
    },
]


_SCHEMA_LOCK = threading.Lock()
_SCHEMA_READY = False


def connect():
    """MySQL 连接（dbconn 兼容层）。schema 自愈每个进程只跑一次：
    远程 MySQL 下逐请求重放 DDL + 种子 upsert 成本高，且无本地文件自愈场景。"""
    global _SCHEMA_READY
    conn = dbconn.connect()
    if not _SCHEMA_READY:
        with _SCHEMA_LOCK:
            if not _SCHEMA_READY:
                ensure_schema(conn)
                _SCHEMA_READY = True
    return conn


def ensure_schema(conn):
    # 全量 DDL 幂等重放：CREATE TABLE IF NOT EXISTS + 内联索引（MySQL 5.7 无
    # CREATE INDEX IF NOT EXISTS），可安全反复执行。列级迁移守卫保留以支持演进。
    if SCHEMA_PATH.exists():
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    project_cols = {r[1] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
    if project_cols:
        migrations = [
            ("rating_status", "ALTER TABLE projects ADD COLUMN rating_status TEXT NOT NULL DEFAULT 'draft'"),
            ("rating", "ALTER TABLE projects ADD COLUMN rating TEXT"),
            ("rating_submitted_at", "ALTER TABLE projects ADD COLUMN rating_submitted_at TEXT"),
            ("rating_reviewed_at", "ALTER TABLE projects ADD COLUMN rating_reviewed_at TEXT"),
            ("rating_note", "ALTER TABLE projects ADD COLUMN rating_note TEXT"),
            ("contact_phone", "ALTER TABLE projects ADD COLUMN contact_phone TEXT"),
        ]
        for col, sql in migrations:
            if col not in project_cols:
                conn.execute(sql)
    city_cols = {r[1] for r in conn.execute("PRAGMA table_info(cities)").fetchall()}
    if city_cols and "booking_phone" not in city_cols:
        conn.execute("ALTER TABLE cities ADD COLUMN booking_phone TEXT")
    if city_cols and "hero_bg_image" not in city_cols:
        conn.execute("ALTER TABLE cities ADD COLUMN hero_bg_image TEXT")
    district_cols = {r[1] for r in conn.execute("PRAGMA table_info(districts)").fetchall()}
    if district_cols and "managed_unit_count" not in district_cols:
        conn.execute("ALTER TABLE districts ADD COLUMN managed_unit_count INTEGER")
    if project_cols and "managed_unit_count" not in project_cols:
        conn.execute("ALTER TABLE projects ADD COLUMN managed_unit_count INTEGER")
        conn.execute(
            """UPDATE projects SET managed_unit_count=unit_count
               WHERE channel='bzf' AND managed_unit_count IS NULL"""
        )
    unit_cols = {r[1] for r in conn.execute("PRAGMA table_info(units)").fetchall()}
    if unit_cols:
        unit_migrations = [
            ("unit_spec", "ALTER TABLE units ADD COLUMN unit_spec TEXT"),
            ("promo_price", "ALTER TABLE units ADD COLUMN promo_price INTEGER"),
            ("amenities", "ALTER TABLE units ADD COLUMN amenities TEXT"),
            ("keeper", "ALTER TABLE units ADD COLUMN keeper TEXT"),
            ("rent_detail", "ALTER TABLE units ADD COLUMN rent_detail TEXT"),
        ]
        for col, sql in unit_migrations:
            if col not in unit_cols:
                conn.execute(sql)
        ensure_unit_amenities(conn)
        # NOTE: ensure_unit_tags removed from here - it was overwriting
        # user-edited tags on every connect(). Tags are now only set during
        # initial seed or explicit admin edit.
    ensure_channels(conn)
    ensure_jiazheng_schema(conn)
    ensure_jz_vendor_schema(conn)
    gr_order_cols = {r[1] for r in conn.execute("PRAGMA table_info(gr_orders)").fetchall()}
    if gr_order_cols and "vendor_id" not in gr_order_cols:
        conn.execute("ALTER TABLE gr_orders ADD COLUMN vendor_id INT")
    if gr_order_cols and "user_id" not in gr_order_cols:
        conn.execute("ALTER TABLE gr_orders ADD COLUMN user_id TEXT")
    ensure_settings(conn)
    conn.commit()


def ensure_jz_vendor_schema(conn):
    """P/B 管理台：商家/产品/服务者/子类目（表结构由 mysql_schema.sql 统一建）。"""
    product_cols = {r[1] for r in conn.execute("PRAGMA table_info(jz_products)").fetchall()}

    if product_cols:
        if "channel_sku_id" not in product_cols:
            conn.execute("ALTER TABLE jz_products ADD COLUMN channel_sku_id INTEGER")
        if "path" not in product_cols:
            conn.execute("ALTER TABLE jz_products ADD COLUMN path TEXT")
        if "query" not in product_cols:
            conn.execute("ALTER TABLE jz_products ADD COLUMN query TEXT")
        # 刷新列集合，供后续逻辑使用
        product_cols = {r[1] for r in conn.execute("PRAGMA table_info(jz_products)").fetchall()}
    # 旧库 jz_vendors 可能缺 city_ids / platform_certs（CREATE IF NOT EXISTS 不会补列）
    vendor_cols = {r[1] for r in conn.execute("PRAGMA table_info(jz_vendors)").fetchall()}
    if vendor_cols:
        if "city_ids" not in vendor_cols:
            conn.execute("ALTER TABLE jz_vendors ADD COLUMN city_ids TEXT")
        if "platform_certs" not in vendor_cols:
            conn.execute("ALTER TABLE jz_vendors ADD COLUMN platform_certs TEXT")
        # 演示数据：未标注服务城市的商家视为全省可约，避免 C 端带 ?city= 后列表为空
        city_ids = [
            str(r[0])
            for r in conn.execute("SELECT id FROM cities ORDER BY id").fetchall()
        ]
        if city_ids:
            joined = ",".join(city_ids)
            conn.execute(
                "UPDATE jz_vendors SET city_ids=? WHERE city_ids IS NULL OR TRIM(city_ids)=''",
                (joined,),
            )
    # 自愈：旧 seed 未写入 channel_sku_id 时，C 端 /jiazheng/skus 会因 EXISTS 过滤得到空列表
    null_channel = conn.execute(
        "SELECT COUNT(*) FROM jz_products WHERE status='on' AND channel_sku_id IS NULL"
    ).fetchone()[0]
    if null_channel:
        # product_id → C 端 jz_skus.id（与 seed_jiazheng.CHANNEL_SKU 对齐）
        channel_sku = {
            101: 1, 201: 1, 301: 1, 401: 1, 501: 1, 103: 1,
            102: 2, 202: 2,
            1105: 3,
            1102: 4,
            1103: 5,
            2101: 6,
            2104: 7,
            3103: 8,
            3101: 9,
            111: 10, 502: 10,
            112: 11, 302: 11,
            203: 12, 402: 12,
            1107: 13, 1201: 13,
            1101: 14, 1108: 14, 1301: 14,
            1104: 15, 1202: 15,
            1106: 16, 1302: 16, 1109: 16,
            2102: 17, 2105: 17, 2201: 17,
            2103: 18, 2202: 18,
            2301: 19, 2106: 19,
            2302: 20,
            3104: 21, 3201: 21,
            3202: 22,
            3102: 23, 3105: 23, 3301: 23,
            3302: 24,
        }
        for pid, sku_id in channel_sku.items():
            conn.execute(
                "UPDATE jz_products SET channel_sku_id=? WHERE id=? AND channel_sku_id IS NULL",
                (sku_id, pid),
            )

def ensure_settings(conn):
    """全局设置默认值（表结构由 mysql_schema.sql 统一建）。"""
    defaults = {
        'show_city_switcher': '1',
        'show_life_service': '1',
    }
    for k, v in defaults.items():
        conn.execute("INSERT IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))


def ensure_channels(conn):
    """频道默认行（表结构由 mysql_schema.sql 统一建）。"""
    defaults = [("bzf", "保租房专区", 1), ("trade", "卖旧买新专区", 2), ("jiazheng", "生活服务专区", 3)]
    for cid, label, order in defaults:
        conn.execute(
            "INSERT IGNORE INTO channels(id, label, sort_order, enabled) VALUES (?, ?, ?, 1)",
            (cid, label, order),
        )
        row = conn.execute("SELECT label FROM channels WHERE id=?", (cid,)).fetchone()
        if row and row[0] in ("保租房", "卖旧买新", "生活服务"):
            # 旧短 label 统一补「专区」，与首页 tab 文案对齐
            conn.execute("UPDATE channels SET label=? WHERE id=?", (label, cid))


def ensure_jiazheng_schema(conn):
    # 表结构（jz_categories/jz_skus/jz_orders）由 mysql_schema.sql 统一建。
    # 仅当 id 为 VARCHAR（C 端四大类；SQLite 下为 TEXT）时写入默认类目/SKU；
    # 子类目表（INT 自增 id）被排除。
    cat_id_type = None
    for r in conn.execute("PRAGMA table_info(jz_categories)").fetchall():
        if r[1] == "id":
            cat_id_type = (r[2] or "").upper()
            break
    if cat_id_type and "INT" in cat_id_type:
        conn.commit()
        return

    for cid, name, icon, order, note in JZ_DEFAULT_CATEGORIES:
        conn.execute(
            """INSERT INTO jz_categories(id, name, icon, sort_order, enabled, note)
               VALUES (?, ?, ?, ?, 1, ?)
               ON DUPLICATE KEY UPDATE
                 name=VALUES(name),
                 icon=VALUES(icon),
                 sort_order=VALUES(sort_order),
                 note=VALUES(note)""",
            (cid, name, icon, order, note),
        )
    for sku in JZ_DEFAULT_SKUS:
        conn.execute(
            """INSERT INTO jz_skus(
                 id, category_id, name, slug, spec, price_from, price_unit, duration_min,
                 tags, badges, sales_text, rating_score, worker_min_level, cover_image,
                 gallery, includes, service_flow, service_notice, sort_order, enabled
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
               ON DUPLICATE KEY UPDATE
                 category_id=VALUES(category_id),
                 name=VALUES(name),
                 slug=VALUES(slug),
                 spec=VALUES(spec),
                 price_from=VALUES(price_from),
                 price_unit=VALUES(price_unit),
                 duration_min=VALUES(duration_min),
                 tags=VALUES(tags),
                 badges=VALUES(badges),
                 sales_text=VALUES(sales_text),
                 rating_score=VALUES(rating_score),
                 worker_min_level=VALUES(worker_min_level),
                 cover_image=VALUES(cover_image),
                 gallery=VALUES(gallery),
                 includes=VALUES(includes),
                 service_flow=VALUES(service_flow),
                 service_notice=VALUES(service_notice),
                 sort_order=VALUES(sort_order)"""
            ,
            (
                sku["id"], sku["category_id"], sku["name"], sku["slug"], sku["spec"],
                sku["price_from"], sku["price_unit"], sku["duration_min"],
                json.dumps(sku["tags"], ensure_ascii=False),
                json.dumps(sku["badges"], ensure_ascii=False),
                sku["sales_text"], sku["rating_score"], sku["worker_min_level"], sku["cover_image"],
                json.dumps(sku["gallery"], ensure_ascii=False),
                json.dumps(sku["includes"], ensure_ascii=False),
                json.dumps(sku["service_flow"], ensure_ascii=False),
                json.dumps(sku["service_notice"], ensure_ascii=False),
                sku["sort_order"],
            ),
        )


DEFAULT_AMENITY_IDS = [
    "ac", "washer", "fridge", "heater", "lock", "wifi", "tv", "hood", "microwave", "induction"
]


def default_amenities_db():
    return json.dumps(DEFAULT_AMENITY_IDS, ensure_ascii=False)


def ensure_unit_amenities(conn):
    """空设施列表的房源默认勾选全部设施"""
    default = default_amenities_db()
    conn.execute(
        """UPDATE units SET amenities=?
           WHERE amenities IS NULL OR TRIM(amenities)='' OR amenities='[]'""",
        (default,),
    )


def _tags_list(raw):
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if isinstance(raw, str):
        try:
            val = json.loads(raw)
            return _tags_list(val)
        except json.JSONDecodeError:
            return [raw.strip()] if raw.strip() else []
    return []


def build_default_unit_tags(unit, project):
    """按项目/户型生成默认房源标签（保租房演示）"""
    tags = ["政府保租房"]
    pname = (project.get("name") or project.get("project_name") or "").strip()
    addr = ((project.get("address") or "") + " " + pname).strip()

    for t in _tags_list(project.get("project_tags") or project.get("tags")):
        if t not in tags:
            tags.append(t)

    brand_rules = [
        ("建融", "建融家园"), ("CCB", "建融家园"), ("逸居", "逸居"),
        ("人才", "人才公寓"), ("龙湖", "龙湖"), ("中海", "中海"),
        ("华润", "华润"), ("惠民", "惠民保租"), ("地铁", "地铁上盖"),
    ]
    for key, label in brand_rules:
        if key in pname and label not in tags:
            tags.append(label)
            break

    subway_keys = ("地铁", "青年大街", "中街", "奥体", "北站", "沈阳站", "新市府", "工业展览", "怀远门", "铁西广场")
    if any(k in addr for k in subway_keys) and "近地铁" not in tags:
        tags.append("近地铁")

    layout = unit.get("layout_label")
    if layout and layout not in tags:
        tags.append(layout)
    else:
        area = unit.get("area_sqm")
        if area is not None:
            if area <= 35 and "精致小户型" not in tags:
                tags.append("精致小户型")
            elif area >= 80 and "宽敞大户型" not in tags:
                tags.append("宽敞大户型")

    for t in ("押一付一", "租金受控", "拎包入住"):
        if t not in tags:
            tags.append(t)

    rating = parse_rating_value(project.get("rating"))
    if project.get("rating_status") == "passed" and rating and rating.get("stars"):
        star_tag = f"好房子{rating['stars']}星"
        if star_tag not in tags:
            tags.append(star_tag)
    elif project.get("rating_status") in ("passed", "pending") and rating and rating.get("stars", 0) >= 4:
        star_tag = f"好房子{rating['stars']}星"
        if star_tag not in tags:
            tags.append(star_tag)

    if unit.get("promo_price") and "首月特惠" not in tags:
        tags.append("首月特惠")

    seen = set()
    out = []
    for t in tags:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out[:8]


def _needs_tag_refresh(existing, project_row):
    if not existing:
        return True
    if len(existing) < 4:
        return True
    pname = (project_row.get("project_name") or project_row.get("name") or "")
    if "建融" in pname and "建融家园" not in existing:
        return True
    if "逸居" in pname and not any("逸居" in t for t in existing):
        return True
    if "人才" in pname and "人才公寓" not in existing:
        return True
    return False


def ensure_unit_tags(conn):
    """保租房房源写入/刷新默认标签"""
    rows = conn.execute(
        """SELECT u.id, u.layout_label, u.area_sqm, u.promo_price, u.tags,
                  p.name AS project_name, p.address, p.tags AS project_tags,
                  p.channel, p.rating, p.rating_status
           FROM units u JOIN projects p ON p.id=u.project_id"""
    ).fetchall()
    for row in rows:
        d = dict(row)
        existing = _tags_list(d.get("tags"))
        if d.get("channel") == "trade":
            if existing:
                continue
            tags = ["卖旧买新", "以旧换新", "试点房源"]
        else:
            if not _needs_tag_refresh(existing, d):
                continue
            tags = build_default_unit_tags(d, d)
        conn.execute(
            "UPDATE units SET tags=? WHERE id=?",
            (json.dumps(tags, ensure_ascii=False), d["id"]),
        )


def rating_code(project_id):
    return "SY-BZF-" + str(project_id).zfill(5)


STAR_LABELS = ["", "基础型", "达标型", "优质型", "精品型", "示范型"]


def parse_rating_value(raw):
    if raw is None:
        return None
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return None


def rating_to_db(rating):
    if rating is None:
        return None
    if isinstance(rating, str):
        return rating
    return json.dumps(rating, ensure_ascii=False)


def summarize_rating(dims):
    vals = [dims.get(k) for k in ("comfort", "green", "tech", "safety") if dims.get(k) is not None]
    if not vals:
        return {"stars": 3, "star_label": "达标型", "score": 60}
    avg = sum(float(v) for v in vals) / len(vals)
    stars = min(5, max(1, round(avg)))
    return {
        "stars": stars,
        "star_label": STAR_LABELS[stars],
        "score": int(round(avg / 5 * 100)),
    }


def normalize_project_row(d, *, include_contact_phone=False):
    if not d:
        return d
    d = row_to_dict(d) if not isinstance(d, dict) else dict(d)
    d["rating"] = parse_rating_value(d.get("rating"))
    d.setdefault("rating_status", "draft")
    if not include_contact_phone:
        d.pop("contact_phone", None)
    return d


def strip_contact_phone(d):
    """公开 API / 静态导出：去掉项目真实号。"""
    if not d:
        return d
    out = dict(d) if isinstance(d, dict) else row_to_dict(d)
    out.pop("contact_phone", None)
    return out


def row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    if d.get("tags") and isinstance(d["tags"], str):
        try:
            d["tags"] = json.loads(d["tags"])
        except json.JSONDecodeError:
            d["tags"] = [d["tags"]] if d["tags"] else []
    return d


def rows_to_list(rows):
    return [row_to_dict(r) for r in rows]


def parse_json_field(val, default=None):
    if default is None:
        default = None
    if val is None or val == "":
        return default
    if isinstance(val, (dict, list)):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except json.JSONDecodeError:
            return default
    return default


def normalize_unit_row(d):
    if not d:
        return d
    d = row_to_dict(d) if not isinstance(d, dict) else dict(d)
    d["amenities"] = parse_json_field(d.get("amenities"), []) or []
    if not d["amenities"]:
        d["amenities"] = DEFAULT_AMENITY_IDS.copy()
    d["keeper"] = parse_json_field(d.get("keeper"), None)
    d["rent_detail"] = parse_json_field(d.get("rent_detail"), None)
    return d


def parse_tags(items, json_keys=None):
    json_keys = json_keys or ()
    for r in items:
        t = r.get("tags")
        if t is None:
            r["tags"] = []
        elif isinstance(t, str):
            try:
                r["tags"] = json.loads(t)
            except json.JSONDecodeError:
                r["tags"] = [t] if t else []
        elif not isinstance(t, list):
            r["tags"] = []
        for key in json_keys:
            default = DEFAULT_AMENITY_IDS.copy() if key == "amenities" else None
            r[key] = parse_json_field(r.get(key), default if key == "amenities" else None)
            if key == "amenities" and not r[key]:
                r[key] = DEFAULT_AMENITY_IDS.copy()
    return items


def normalize_jz_sku_row(d):
    if not d:
        return d
    d = row_to_dict(d) if not isinstance(d, dict) else dict(d)
    for key in ("tags", "badges", "gallery", "includes", "service_flow", "service_notice"):
        d[key] = parse_json_field(d.get(key), []) or []
    return d


def normalize_jz_order_row(d):
    if not d:
        return d
    d = row_to_dict(d) if not isinstance(d, dict) else dict(d)
    for key in ("worker_json", "rating_json", "log_json"):
        d[key] = parse_json_field(d.get(key), [] if key == "log_json" else None)
    return d


def jz_order_view(row, sku_name=None):
    """API / 前端统一视图（前后端分离 JSON 契约）。"""
    d = normalize_jz_order_row(row)
    if not d:
        return d
    cat_id = d.get("category_id") or ""
    worker = d.get("worker_json")
    rating = d.get("rating_json")
    name = sku_name or d.get("sku_name") or d.get("type") or "家政服务"
    created = d.get("created_at") or ""
    created_label = created.replace("T", " ").replace("Z", "")[:16] if created else ""
    return {
        "id": d["id"],
        "sku_id": d.get("sku_id"),
        "category_id": cat_id,
        "category": name,
        "type": JZ_CATEGORY_LABELS.get(cat_id, d.get("type") or "家政"),
        "icon": JZ_CATEGORY_ICONS.get(cat_id, "✨"),
        "house": d.get("house") or "",
        "phone": d.get("phone") or "",
        "expect_time": d.get("expect_time") or "",
        "expectTime": d.get("expect_time") or "",
        "desc": d.get("desc") or "",
        "fee": int(d.get("fee") or 0),
        "pay_status": d.get("pay_status") or "unpaid",
        "pay_method": d.get("pay_method"),
        "pay_at": d.get("pay_at"),
        "status": d.get("status") or "pending",
        "worker": worker,
        "rating": rating,
        "source": d.get("source") or "新居住频道",
        "created_at": created,
        "createdAt": created,
        "createdLabel": created_label,
        "updated_at": d.get("updated_at"),
        "log": d.get("log_json") or [],
        "live": True,
    }


def tags_to_db(tags):
    if tags is None:
        return json.dumps([], ensure_ascii=False)
    if isinstance(tags, str):
        tags = [x.strip() for x in tags.split(",") if x.strip()]
    return json.dumps(list(tags), ensure_ascii=False)


def json_to_db(val):
    if val is None:
        return None
    if isinstance(val, str):
        return val
    return json.dumps(val, ensure_ascii=False)


def sync_district_stats(conn, district_id=None):
    where = "WHERE id=?" if district_id else ""
    params = (district_id,) if district_id else ()
    districts = conn.execute(f"SELECT id FROM districts {where}", params).fetchall()
    for (did,) in districts:
        pc = conn.execute(
            "SELECT COUNT(*) FROM projects WHERE district_id=? AND channel='bzf'", (did,)
        ).fetchone()[0]
        uc = conn.execute(
            """SELECT COUNT(*) FROM units u
               JOIN projects p ON p.id=u.project_id
               WHERE p.district_id=? AND p.channel='bzf'""",
            (did,),
        ).fetchone()[0]
        avg = conn.execute(
            """SELECT AVG(u.rent_monthly) FROM units u
               JOIN projects p ON p.id=u.project_id
               WHERE p.district_id=? AND p.channel='bzf' AND u.rent_monthly IS NOT NULL""",
            (did,),
        ).fetchone()[0]
        managed = conn.execute(
            """SELECT COALESCE(SUM(COALESCE(managed_unit_count, unit_count)), 0)
               FROM projects WHERE district_id=? AND channel='bzf'""",
            (did,),
        ).fetchone()[0]
        conn.execute(
            """UPDATE districts SET project_count=?, unit_count=?, vacant_count=?,
               managed_unit_count=?, avg_price=?, has_projects=? WHERE id=?""",
            (pc, uc, uc, int(managed), int(avg) if avg else None, 1 if pc else 0, did),
        )
    conn.commit()


def sync_unit_cover(conn, unit_id):
    row = conn.execute(
        """SELECT file_path FROM photos WHERE entity_type='unit' AND entity_id=?
           ORDER BY is_cover DESC, sort_order, id LIMIT 1""",
        (unit_id,),
    ).fetchone()
    cover = row[0] if row else None
    conn.execute("UPDATE units SET cover_image=? WHERE id=?", (cover, unit_id))


def sync_project_unit_count(conn, project_id):
    n = conn.execute("SELECT COUNT(*) FROM units WHERE project_id=?", (project_id,)).fetchone()[0]
    rents = conn.execute(
        "SELECT MIN(rent_monthly), MIN(price_total) FROM units WHERE project_id=?",
        (project_id,),
    ).fetchone()
    # 取最低租金（保租）否则最低总价（置换）。用 is None 判断而非 or，避免 MIN==0 误落到
    # price_total；直接赋值而非 COALESCE，使删掉最便宜/删光户型后 price_from 能回落/清空
    # （旧逻辑 COALESCE(NULL, price_from) 会保留已不存在户型的陈旧最低价）。
    price_from = rents[0] if rents[0] is not None else rents[1]
    conn.execute(
        "UPDATE projects SET unit_count=?, price_from=? WHERE id=?",
        (n, price_from, project_id),
    )
    proj = conn.execute("SELECT district_id FROM projects WHERE id=?", (project_id,)).fetchone()
    if proj and proj[0]:
        sync_district_stats(conn, proj[0])


def export_json(conn=None):
    close = False
    if conn is None:
        conn = connect()
        close = True
    try:
        def rows(q, params=()):
            return [dict(r) for r in conn.execute(q, params).fetchall()]

        cities = rows("SELECT * FROM cities ORDER BY id")
        # 非城市维度的通用数据（频道 / 家政目录 / 全局设置）
        common = {
            "channels": rows("SELECT * FROM channels ORDER BY sort_order, id"),
            "jiazheng_categories": rows("SELECT * FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id"),
            "jiazheng_skus": [
                normalize_jz_sku_row(r)
                for r in rows("SELECT * FROM jz_skus WHERE enabled=1 ORDER BY category_id, sort_order, id")
            ],
            "settings": {r["key"]: r["value"] for r in rows("SELECT key, value FROM settings")},
        }

        def export_city(city):
            """导出单个城市的完整数据集（区/项目/户型/图片均按城市过滤）"""
            cid = city["id"]
            districts = parse_tags(rows("SELECT * FROM districts WHERE city_id=? ORDER BY sort_order", (cid,)))
            projects = parse_tags(rows("SELECT * FROM projects WHERE city_id=? ORDER BY channel, sort_order", (cid,)))
            pids = [p["id"] for p in projects]
            units, photos = [], []
            if pids:
                ph = ",".join("?" * len(pids))
                units = parse_tags(
                    rows(f"SELECT * FROM units WHERE project_id IN ({ph}) ORDER BY project_id, sort_order", pids),
                    json_keys=("amenities", "keeper", "rent_detail"),
                )
                photos += rows(f"SELECT * FROM photos WHERE entity_type='project' AND entity_id IN ({ph}) ORDER BY entity_id, sort_order", pids)
                dids = [d["id"] for d in districts]
                if dids:
                    dh = ",".join("?" * len(dids))
                    photos += rows(f"SELECT * FROM photos WHERE entity_type='district' AND entity_id IN ({dh}) ORDER BY entity_id, sort_order", dids)
                uids = [u["id"] for u in units]
                if uids:
                    uh = ",".join("?" * len(uids))
                    photos += rows(f"SELECT * FROM photos WHERE entity_type='unit' AND entity_id IN ({uh}) ORDER BY entity_id, sort_order", uids)
            data = dict(common)
            data["city"] = city
            data["stats"] = {
                "district_count": len(districts),
                "project_count_bzf": sum(1 for p in projects if p["channel"] == "bzf"),
                "project_count_trade": sum(1 for p in projects if p["channel"] == "trade"),
                "unit_count": sum(p["managed_unit_count"] or 0 for p in projects if p["channel"] == "bzf"),
            }
            data["districts"] = districts
            # 真实号仅存 DB，不进 data.json / data-<slug>.json
            data["projects"] = [normalize_project_row(p, include_contact_phone=False) for p in projects]
            data["units"] = units
            data["photos"] = photos
            return data

        # 城市清单（前端按 ?city= 城市名解析 slug → data-<slug>.json）
        CITIES_PATH = JSON_PATH.with_name("cities.json")
        CITIES_PATH.write_text(json.dumps(cities, ensure_ascii=False, indent=2), encoding="utf-8")

        # 每城一文件：data.json = 第一个城市（向后兼容），同时每个城市都写 data-<slug>.json
        # 空城市（无区/无项目）不写数据文件，仅保留在 cities.json（前端会回退到默认数据）
        first = None
        for idx, city in enumerate(cities):
            data = export_city(city)
            if idx == 0:
                first = data
                JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            if data["districts"] or data["projects"]:
                JSON_PATH.with_name(f"data-{city['slug']}.json").write_text(
                    json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
                )
        return first
    finally:
        if close:
            conn.close()
