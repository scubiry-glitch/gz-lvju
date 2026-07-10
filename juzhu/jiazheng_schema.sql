-- 居住服务·家政频道 · P/B 管理台数据表（与 C 端 jz_categories/jz_skus/jz_orders 并存）
-- v1.1：子类目表改名 jz_subcategories，订单统一走 C 端 jz_orders

CREATE TABLE IF NOT EXISTS jz_vendors (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  logo TEXT,
  address TEXT, district_id INTEGER, phone TEXT,
  rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  rank_type TEXT,
  rank_label TEXT,
  badges TEXT,
  live INTEGER DEFAULT 0,
  start_price REAL,
  unit TEXT,
  fulfillment TEXT DEFAULT 'to_home',
  hours TEXT,
  vendor_no TEXT,
  whitelist_id INTEGER,
  status TEXT DEFAULT 'active',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS jz_products (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  category TEXT,
  duration_hours REAL,
  area_range TEXT,
  unit TEXT,
  price REAL NOT NULL,
  original_price REAL,
  discount_label TEXT,
  earliest_time TEXT,
  advance_booking_hours INTEGER DEFAULT 0,
  sales_count INTEGER DEFAULT 0,
  rating REAL DEFAULT 0,
  service_tags TEXT,
  channel_sku_id INTEGER,
  status TEXT DEFAULT 'on',
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (vendor_id) REFERENCES jz_vendors(id)
);

CREATE TABLE IF NOT EXISTS jz_workers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  level TEXT DEFAULT 'L3',
  credit_score INTEGER DEFAULT 70,
  tags TEXT,
  certs TEXT,
  is_whitelisted INTEGER DEFAULT 0,
  rating REAL DEFAULT 0,
  completed_orders INTEGER DEFAULT 0,
  years_experience INTEGER DEFAULT 0,
  online INTEGER DEFAULT 0,
  distance_km REAL,
  vendor_id INTEGER,
  whitelist_id INTEGER,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (vendor_id) REFERENCES jz_vendors(id)
);

CREATE TABLE IF NOT EXISTS jz_subcategories (
  id INTEGER PRIMARY KEY,
  parent_type TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'on'
);

CREATE TABLE IF NOT EXISTS jz_activities (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER UNIQUE NOT NULL,
  name TEXT, unit TEXT,
  cover_path TEXT,
  cover_remote TEXT,
  banner_paths TEXT,
  detail TEXT,
  price INTEGER,
  tag_id INTEGER,
  fetched_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jz_vendors_type ON jz_vendors(type, status);
CREATE INDEX IF NOT EXISTS idx_jz_products_vendor ON jz_products(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_jz_workers_vendor ON jz_workers(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_jz_workers_online ON jz_workers(online, status);
CREATE INDEX IF NOT EXISTS idx_jz_subcategories_parent ON jz_subcategories(parent_type, status);
