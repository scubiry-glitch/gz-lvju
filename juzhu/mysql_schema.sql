-- 新居住频道 · MySQL 5.7 schema（utf8mb4）
-- 由 juzhu/dbconn.py + db.ensure_schema 启动时重放，全部语句幂等：
--   - CREATE TABLE IF NOT EXISTS 幂等
--   - 索引一律内联在 CREATE TABLE 内（MySQL 5.7 不支持 CREATE INDEX IF NOT EXISTS）
-- 类型约定：
--   - SQLite INTEGER PRIMARY KEY → INT AUTO_INCREMENT PRIMARY KEY
--   - 文本主键/被索引列 → VARCHAR（TEXT 不能做键/索引需前缀长度）
--   - 其余 TEXT / REAL→DOUBLE / INTEGER→INT
-- 保留字列名 key / desc 建表时用反引号（运行时由 dbconn 自动加反引号）
-- 注意：jz_orders.sku_id 语义为多态引用（jz_skus.id 或 jz_products.id），不建外键。

-- ===== 房源频道 =====

CREATE TABLE IF NOT EXISTS cities (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL UNIQUE,
  slug            VARCHAR(128) NOT NULL UNIQUE,
  booking_phone   VARCHAR(32),
  hero_bg_image   TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS districts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  city_id       INT NOT NULL,
  name          VARCHAR(128) NOT NULL,
  slug          VARCHAR(128) NOT NULL,
  note          TEXT,
  has_projects  INT NOT NULL DEFAULT 1,
  sort_order    INT NOT NULL DEFAULT 0,
  cover_image   TEXT,
  project_count INT NOT NULL DEFAULT 0,
  unit_count    INT NOT NULL DEFAULT 0,
  vacant_count  INT,
  managed_unit_count INT,
  avg_price     INT,
  is_hot        INT NOT NULL DEFAULT 0,
  layout_tall   INT NOT NULL DEFAULT 0,
  layout_wide   INT NOT NULL DEFAULT 0,
  bg_class      TEXT,
  UNIQUE KEY uq_districts_city_slug (city_id, slug),
  CONSTRAINT fk_districts_city FOREIGN KEY (city_id) REFERENCES cities(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS projects (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  city_id       INT NOT NULL,
  district_id   INT,
  channel       VARCHAR(16) NOT NULL,
  name          VARCHAR(128) NOT NULL,
  slug          VARCHAR(128) NOT NULL,
  cover_image   TEXT,
  address       TEXT,
  tags          TEXT,
  sort_order    INT NOT NULL DEFAULT 0,
  unit_count    INT NOT NULL DEFAULT 0,
  managed_unit_count INT,
  price_from    INT,
  is_featured   INT NOT NULL DEFAULT 0,
  featured_rank INT,
  old_house_hint TEXT,
  contact_phone TEXT,
  rating_status VARCHAR(16) NOT NULL DEFAULT 'draft',
  rating        TEXT,
  rating_submitted_at TEXT,
  rating_reviewed_at  TEXT,
  rating_note   TEXT,
  UNIQUE KEY uq_projects_channel_slug (channel, slug),
  KEY idx_projects_district (district_id, channel),
  KEY idx_projects_city (city_id),
  CONSTRAINT fk_projects_city FOREIGN KEY (city_id) REFERENCES cities(id),
  CONSTRAINT fk_projects_district FOREIGN KEY (district_id) REFERENCES districts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS units (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  project_id    INT NOT NULL,
  name          VARCHAR(128) NOT NULL,
  slug          VARCHAR(128) NOT NULL,
  area_sqm      DOUBLE,
  layout_label  TEXT,
  rent_monthly  INT,
  price_total   INT,
  tags          TEXT,
  unit_spec     TEXT,
  promo_price   INT,
  amenities     TEXT,
  keeper        TEXT,
  rent_detail   TEXT,
  sort_order    INT NOT NULL DEFAULT 0,
  cover_image   TEXT,
  UNIQUE KEY uq_units_project_slug (project_id, slug),
  KEY idx_units_project (project_id),
  CONSTRAINT fk_units_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS photos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  entity_type   VARCHAR(16) NOT NULL,
  entity_id     INT NOT NULL,
  file_path     TEXT NOT NULL,
  source_path   TEXT,
  is_cover      INT NOT NULL DEFAULT 0,
  sort_order    INT NOT NULL DEFAULT 0,
  KEY idx_photos_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS channels (
  id          VARCHAR(32) PRIMARY KEY,
  label       VARCHAR(64) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  enabled     INT NOT NULL DEFAULT 1,
  note        TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  `key`   VARCHAR(64) PRIMARY KEY,
  `value` TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== 生活服务专区（C 端四大类 + SPU + 工单） =====

CREATE TABLE IF NOT EXISTS jz_categories (
  id          VARCHAR(32) PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  icon        VARCHAR(32),
  sort_order  INT NOT NULL DEFAULT 0,
  enabled     INT NOT NULL DEFAULT 1,
  note        TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jz_skus (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  category_id       VARCHAR(32) NOT NULL,
  name              VARCHAR(128) NOT NULL,
  slug              VARCHAR(128) NOT NULL UNIQUE,
  spec              TEXT,
  price_from        INT,
  price_unit        VARCHAR(16),
  duration_min      INT,
  tags              TEXT,
  badges            TEXT,
  sales_text        TEXT,
  rating_score      DOUBLE,
  worker_min_level  VARCHAR(8),
  cover_image       TEXT,
  gallery           TEXT,
  includes          TEXT,
  service_flow      TEXT,
  service_notice    TEXT,
  sort_order        INT NOT NULL DEFAULT 0,
  enabled           INT NOT NULL DEFAULT 1,
  KEY idx_jz_skus_category (category_id, enabled, sort_order),
  CONSTRAINT fk_jz_skus_category FOREIGN KEY (category_id) REFERENCES jz_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jz_orders (
  id            VARCHAR(64) PRIMARY KEY,
  sku_id        INT,
  category_id   VARCHAR(32) NOT NULL,
  type          VARCHAR(32) NOT NULL,
  house         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  expect_time   TEXT NOT NULL,
  `desc`        TEXT,
  fee           INT NOT NULL,
  pay_status    VARCHAR(16) NOT NULL DEFAULT 'unpaid',
  pay_method    VARCHAR(32),
  pay_at        TEXT,
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',
  slot_id       INT,
  worker_json   TEXT,
  rating_json   TEXT,
  source        TEXT,
  created_at    VARCHAR(32) NOT NULL,
  updated_at    VARCHAR(32) NOT NULL,
  log_json      TEXT,
  KEY idx_jz_orders_status (status, pay_status, created_at),
  CONSTRAINT fk_jz_orders_category FOREIGN KEY (category_id) REFERENCES jz_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== 商家 / 产品 / 服务者（P/B 管理台） =====

CREATE TABLE IF NOT EXISTS jz_vendors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  logo TEXT,
  address TEXT,
  district_id INT,
  city_ids TEXT,
  phone VARCHAR(32),
  rating DOUBLE DEFAULT 0,
  review_count INT DEFAULT 0,
  rank_type VARCHAR(32),
  rank_label VARCHAR(32),
  badges TEXT,
  live INT DEFAULT 0,
  start_price DOUBLE,
  unit VARCHAR(16),
  fulfillment VARCHAR(16) DEFAULT 'to_home',
  hours VARCHAR(64),
  vendor_no VARCHAR(64),
  whitelist_id INT,
  status VARCHAR(16) DEFAULT 'active',
  sort_order INT DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  KEY idx_jz_vendors_type (type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jz_products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vendor_id INT NOT NULL,
  city_id INT NULL,
  title VARCHAR(256) NOT NULL,
  subtitle TEXT,
  category VARCHAR(32),
  duration_hours DOUBLE,
  area_range TEXT,
  unit VARCHAR(16),
  price DOUBLE NOT NULL,
  original_price DOUBLE,
  discount_label TEXT,
  earliest_time TEXT,
  advance_booking_hours INT DEFAULT 0,
  sales_count INT DEFAULT 0,
  rating DOUBLE DEFAULT 0,
  service_tags TEXT,
  channel_sku_id INT,
  path TEXT,
  query TEXT,
  status VARCHAR(16) DEFAULT 'on',
  sort_order INT DEFAULT 0,
  KEY idx_jz_products_vendor (vendor_id, status),
  KEY idx_jz_products_city (city_id),
  CONSTRAINT fk_jz_products_vendor FOREIGN KEY (vendor_id) REFERENCES jz_vendors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jz_workers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  avatar TEXT,
  level VARCHAR(8) DEFAULT 'L3',
  credit_score INT DEFAULT 70,
  tags TEXT,
  certs TEXT,
  is_whitelisted INT DEFAULT 0,
  rating DOUBLE DEFAULT 0,
  completed_orders INT DEFAULT 0,
  years_experience INT DEFAULT 0,
  online INT DEFAULT 0,
  distance_km DOUBLE,
  vendor_id INT,
  whitelist_id INT,
  status VARCHAR(16) DEFAULT 'active',
  KEY idx_jz_workers_vendor (vendor_id, status),
  KEY idx_jz_workers_online (online, status),
  CONSTRAINT fk_jz_workers_vendor FOREIGN KEY (vendor_id) REFERENCES jz_vendors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jz_subcategories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parent_type VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  icon VARCHAR(32),
  sort_order INT DEFAULT 0,
  status VARCHAR(16) DEFAULT 'on',
  KEY idx_jz_subcategories_parent (parent_type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jz_activities (
  id INT AUTO_INCREMENT PRIMARY KEY,
  activity_id INT NOT NULL UNIQUE,
  name VARCHAR(128),
  unit VARCHAR(32),
  cover_path TEXT,
  cover_remote TEXT,
  banner_paths TEXT,
  detail TEXT,
  price INT,
  tag_id INT,
  fetched_at TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jz_sku_workers (
  product_id INT NOT NULL,
  worker_id  INT NOT NULL,
  PRIMARY KEY (product_id, worker_id),
  CONSTRAINT fk_sku_workers_product FOREIGN KEY (product_id) REFERENCES jz_products(id),
  CONSTRAINT fk_sku_workers_worker FOREIGN KEY (worker_id) REFERENCES jz_workers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jz_sku_slots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  worker_id  INT,
  slot_date  VARCHAR(10) NOT NULL,
  start_time VARCHAR(5) NOT NULL,
  end_time   VARCHAR(5),
  capacity   INT NOT NULL DEFAULT 1,
  booked     INT NOT NULL DEFAULT 0,
  status     VARCHAR(16) NOT NULL DEFAULT 'open',
  KEY idx_jz_sku_slots_product (product_id, slot_date, start_time),
  CONSTRAINT fk_sku_slots_product FOREIGN KEY (product_id) REFERENCES jz_products(id),
  CONSTRAINT fk_sku_slots_worker FOREIGN KEY (worker_id) REFERENCES jz_workers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===== GR 侧预约订单（跳转第三方小程序时生成） =====

CREATE TABLE IF NOT EXISTS gr_orders (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_ref       VARCHAR(64) NOT NULL UNIQUE,
  vendor_id       INT,
  vendor_oid      VARCHAR(64),
  user_id         VARCHAR(64),                -- 下单用户 id（C 端模拟，后期接真实登录）
  sku             VARCHAR(128),
  city            VARCHAR(32) DEFAULT '沈阳',
  status          VARCHAR(16) DEFAULT 'pending',
  fee             INT,
  worker_name     VARCHAR(128),
  worker_phone    VARCHAR(32),
  eta             VARCHAR(32),
  cancel_reason   TEXT,
  paid_at         VARCHAR(32),
  serving_at      VARCHAR(32),
  completed_at    VARCHAR(32),
  created_at      VARCHAR(32) NOT NULL,
  updated_at      VARCHAR(32),
  KEY idx_gr_orders_vendor (vendor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
