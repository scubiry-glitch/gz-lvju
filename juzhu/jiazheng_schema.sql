-- 居住服务·家政频道 数据表
-- v1.0 schema（2026-07-09）
-- 执行：sqlite3 juzhu.db < jiazheng_schema.sql

-- 1. 商家表
CREATE TABLE IF NOT EXISTS jz_vendors (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                    -- cleaning/repair/moving/nanny
  name TEXT NOT NULL,
  logo TEXT,                             -- emoji 或 URL
  address TEXT, district_id INTEGER, phone TEXT,
  rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  rank_type TEXT,                        -- city/district/platform
  rank_label TEXT,
  badges TEXT,                           -- JSON array: ['whitelist','backcheck','top10','commitment']
  live INTEGER DEFAULT 0,
  start_price REAL,                      -- 起步价（元）
  unit TEXT,                             -- 小时/次/车次/月
  fulfillment TEXT DEFAULT 'to_home',   -- to_home/in_shop
  hours TEXT,                            -- 营业时间
  vendor_no TEXT,                        -- 中台商家编号
  whitelist_id INTEGER,                  -- 关联 G 端白名单 vendor
  platform_certs TEXT,                   -- JSON: [{code,name,issuer,valid_until,status}]
  status TEXT DEFAULT 'active',          -- active/paused/offline
  sort_order INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);

-- 2. 商品 SKU 表
CREATE TABLE IF NOT EXISTS jz_products (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  category TEXT,                         -- 日常保洁/深度清洁/...
  duration_hours REAL,                   -- 服务时长（小时）
  area_range TEXT,                       -- ≤50㎡
  unit TEXT,                             -- 小时/次
  price REAL NOT NULL,
  original_price REAL,                   -- 划线原价
  discount_label TEXT,                   -- 4折/3.3折
  earliest_time TEXT,                    -- 今天 18:00
  advance_booking_hours INTEGER DEFAULT 0,
  sales_count INTEGER DEFAULT 0,
  rating REAL DEFAULT 0,
  service_tags TEXT,                     -- JSON array
  status TEXT DEFAULT 'on',              -- on/off/sold_out
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (vendor_id) REFERENCES jz_vendors(id)
);

-- 3. 服务者表
CREATE TABLE IF NOT EXISTS jz_workers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  level TEXT DEFAULT 'L3',               -- L1-L7
  credit_score INTEGER DEFAULT 70,       -- 信用分 0-100
  tags TEXT,                             -- JSON array
  certs TEXT,                            -- JSON array: ['id_card','health','skill','insurance']
  is_whitelisted INTEGER DEFAULT 0,
  rating REAL DEFAULT 0,
  completed_orders INTEGER DEFAULT 0,
  years_experience INTEGER DEFAULT 0,
  online INTEGER DEFAULT 0,              -- 在线状态
  distance_km REAL,                      -- 距离用户（动态）
  vendor_id INTEGER,
  whitelist_id INTEGER,                  -- 关联 G 端白名单 service
  platform_certs TEXT,                   -- JSON: [{code,name,issuer,valid_until,status}]
  status TEXT DEFAULT 'active',
  FOREIGN KEY (vendor_id) REFERENCES jz_vendors(id)
);

-- 4. 子类目表
CREATE TABLE IF NOT EXISTS jz_categories (
  id INTEGER PRIMARY KEY,
  parent_type TEXT NOT NULL,             -- cleaning/repair/moving/nanny
  name TEXT NOT NULL,
  icon TEXT,                             -- emoji
  sort_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'on'
);

-- 5. 贝壳活动缓存表
CREATE TABLE IF NOT EXISTS jz_activities (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER UNIQUE NOT NULL,    -- 贝壳原始 activityId
  name TEXT, unit TEXT,
  cover_path TEXT,                        -- 本地路径（已下载）
  cover_remote TEXT,                      -- 贝壳原始 URL
  banner_paths TEXT,                      -- 本地路径（多张，JSON array）
  detail TEXT,
  price INTEGER,                          -- 贝壳原始价格（分）
  tag_id INTEGER,
  fetched_at TEXT
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_jz_vendors_type ON jz_vendors(type, status);
CREATE INDEX IF NOT EXISTS idx_jz_products_vendor ON jz_products(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_jz_workers_vendor ON jz_workers(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_jz_workers_online ON jz_workers(online, status);
CREATE INDEX IF NOT EXISTS idx_jz_categories_parent ON jz_categories(parent_type, status);

-- 6. 订单表
CREATE TABLE IF NOT EXISTS jz_orders (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  vendor_id INTEGER, product_id INTEGER,
  vendor_name TEXT, vendor_logo TEXT,
  product_title TEXT, product_sub TEXT, product_price REAL,
  address TEXT, phone TEXT,
  scheduled_at TEXT,
  fee REAL,
  status TEXT DEFAULT 'pending',     -- pending/dispatched/accepted/serving/done/rated/cancelled
  worker_id INTEGER,
  rating TEXT,                       -- JSON: {score, tags, text, created_at}
  source TEXT DEFAULT 'jz',
  created_at TEXT, updated_at TEXT,
  FOREIGN KEY (vendor_id) REFERENCES jz_vendors(id),
  FOREIGN KEY (product_id) REFERENCES jz_products(id),
  FOREIGN KEY (worker_id) REFERENCES jz_workers(id)
);
CREATE INDEX IF NOT EXISTS idx_jz_orders_status ON jz_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jz_orders_vendor ON jz_orders(vendor_id, created_at);

-- 订单序号表
CREATE TABLE IF NOT EXISTS jz_order_seq (
  id INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO jz_order_seq(id, seq) VALUES (1, 0);
