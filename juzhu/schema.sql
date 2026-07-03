-- 新居住频道 · SQLite  schema
-- 信息层级：频道(channel) → 行政区(district) → 项目(project) → 户型/房源(unit) → 图片(photo)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cities (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,          -- 沈阳
  slug            TEXT NOT NULL UNIQUE,          -- shenyang
  booking_phone   TEXT,                          -- 预约看房 / 咨询置换电话
  hero_bg_image   TEXT                           -- 频道首页头图（方案 C split-hd）
);

CREATE TABLE IF NOT EXISTS districts (
  id            INTEGER PRIMARY KEY,
  city_id       INTEGER NOT NULL REFERENCES cities(id),
  name          TEXT NOT NULL,               -- 沈河区
  slug          TEXT NOT NULL,
  note          TEXT,                        -- 暂无项目
  has_projects  INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  cover_image   TEXT,
  project_count INTEGER NOT NULL DEFAULT 0,
  unit_count    INTEGER NOT NULL DEFAULT 0,
  vacant_count  INTEGER,                     -- 可租/可售套数（演示可估算）
  managed_unit_count INTEGER,                -- 在管房源量（区级加总）
  avg_price     INTEGER,                     -- 保租=月均租金；置换=万起价
  is_hot        INTEGER NOT NULL DEFAULT 0,
  layout_tall   INTEGER NOT NULL DEFAULT 0,
  layout_wide   INTEGER NOT NULL DEFAULT 0,
  bg_class      TEXT,
  UNIQUE(city_id, slug)
);

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  city_id       INTEGER NOT NULL REFERENCES cities(id),
  district_id   INTEGER REFERENCES districts(id),  -- 卖旧买新可为 NULL
  channel       TEXT NOT NULL CHECK(channel IN ('bzf','trade')),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  cover_image   TEXT,
  address       TEXT,
  tags          TEXT,                        -- JSON array
  sort_order    INTEGER NOT NULL DEFAULT 0,
  unit_count    INTEGER NOT NULL DEFAULT 0,
  managed_unit_count INTEGER,                -- 在管房源量（保租项目，可后台编辑）
  price_from    INTEGER,                     -- 最低租金/售价
  is_featured   INTEGER NOT NULL DEFAULT 0,
  featured_rank INTEGER,
  old_house_hint TEXT,                       -- 卖旧买新：旧房估价提示
  rating_status TEXT NOT NULL DEFAULT 'draft',  -- draft|pending|passed|rejected
  rating        TEXT,                        -- JSON：好房子四维度 + 星级 + 编号
  rating_submitted_at TEXT,
  rating_reviewed_at  TEXT,
  rating_note   TEXT,                        -- 复核意见
  UNIQUE(channel, slug)
);

CREATE TABLE IF NOT EXISTS units (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,               -- 54平 / 惠民50_副本
  slug          TEXT NOT NULL,
  area_sqm      REAL,
  layout_label  TEXT,                        -- 一居/两居等（可后续补）
  rent_monthly  INTEGER,
  price_total   INTEGER,                     -- 卖旧买新总价（万）
  tags          TEXT,                        -- JSON array 房源标签
  unit_spec     TEXT,                        -- 1室1厅 | 100㎡ | 南/北 | 立即入住
  promo_price   INTEGER,                     -- 券后价/特惠价（元/月）
  amenities     TEXT,                        -- JSON array 房型设施 id
  keeper        TEXT,                        -- JSON {name, avatar, phone}
  rent_detail   TEXT,                        -- JSON 租金详情（房间费用+其他费用）
  sort_order    INTEGER NOT NULL DEFAULT 0,
  cover_image   TEXT,
  UNIQUE(project_id, slug)
);

CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY,
  entity_type   TEXT NOT NULL CHECK(entity_type IN ('district','project','unit')),
  entity_id     INTEGER NOT NULL,
  file_path     TEXT NOT NULL,               -- 站点内相对路径 assets/juzhu/sy/...
  source_path   TEXT,                        -- 原始绝对路径（备查）
  is_cover      INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_projects_district ON projects(district_id, channel);
CREATE INDEX IF NOT EXISTS idx_units_project ON units(project_id);
CREATE INDEX IF NOT EXISTS idx_photos_entity ON photos(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,                -- bzf / trade
  label       TEXT NOT NULL,                   -- 保租房
  sort_order  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  note        TEXT
);

INSERT OR IGNORE INTO channels(id, label, sort_order, enabled) VALUES ('bzf', '保租房', 1, 1);
INSERT OR IGNORE INTO channels(id, label, sort_order, enabled) VALUES ('trade', '卖旧买新', 2, 1);
