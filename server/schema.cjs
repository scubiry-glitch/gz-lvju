/**
 * MySQL schema bootstrap（从 app.js 拆出）.
 * CREATE IF NOT EXISTS + extraCols ALTER + 种子灌入。
 * 对外：ensureSchema()（幂等，只跑一次）.
 */
'use strict';

const { getMysql, getDbConfig } = require('./db.cjs');

/**
 * @param {object} deps
 * @param {object} deps.authCenter
 * @param {object} [deps.channelBrand]
 * @param {function} [deps.housingSeedAll]
 * @param {function} [deps.housingBackfillPhotos]
 * @param {function} [deps.juzhuImportAll]
 * @param {function} [deps.jzSeedAll]
 * @param {function} [deps.staffSeedAll]
 */
function createSchema(deps) {
  const mysql2 = getMysql();
  const {
    authCenter,
    channelBrand,
    housingSeedAll,
    housingBackfillPhotos,
    juzhuImportAll,
    jzSeedAll,
    staffSeedAll,
  } = deps;

  async function ensureGrOrdersShape(conn) {
    let cols = [];
    try {
      const [rows] = await conn.execute('SHOW COLUMNS FROM gr_orders');
      cols = rows.map((r) => r.Field);
    } catch (_) {
      return;
    }
    if (!cols.includes('order_ref')) {
      await conn.execute('DROP TABLE gr_orders');
      await conn.execute(`CREATE TABLE gr_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_ref VARCHAR(64) NOT NULL,
        vendor_id INT,
        vendor_oid VARCHAR(64),
        user_id VARCHAR(64),
        sku VARCHAR(128),
        city VARCHAR(32) DEFAULT '沈阳',
        status VARCHAR(20) DEFAULT 'pending',
        fee INT,
        worker_name VARCHAR(128),
        worker_phone VARCHAR(32),
        eta VARCHAR(32),
        cancel_reason TEXT,
        paid_at VARCHAR(32),
        serving_at VARCHAR(32),
        completed_at VARCHAR(32),
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32),
        UNIQUE KEY uk_order_ref (order_ref),
        KEY idx_gr_orders_vendor (vendor_id),
        KEY idx_gr_orders_user (user_id)
      ) CHARSET=utf8mb4`);
      return;
    }
    const extra = [
      ['user_id', 'VARCHAR(64)'],
      ['vendor_id', 'INT'],
      ['vendor_oid', 'VARCHAR(64)'],
      ['sku', 'VARCHAR(128)'],
      ['city', "VARCHAR(32) DEFAULT '沈阳'"],
      ['fee', 'INT'],
      ['worker_name', 'VARCHAR(128)'],
      ['worker_phone', 'VARCHAR(32)'],
      ['eta', 'VARCHAR(32)'],
      ['cancel_reason', 'TEXT'],
      ['paid_at', 'VARCHAR(32)'],
      ['serving_at', 'VARCHAR(32)'],
      ['completed_at', 'VARCHAR(32)'],
    ];
    for (const [name, ddl] of extra) {
      if (!cols.includes(name)) {
        try { await conn.execute(`ALTER TABLE gr_orders ADD COLUMN ${name} ${ddl}`); } catch (_) { /* ignore */ }
      }
    }
  }

  async function ensureJzSkusIncludesColumn(conn) {
    let cols = [];
    try {
      const [rows] = await conn.execute('SHOW COLUMNS FROM jz_skus');
      cols = rows.map((r) => r.Field);
    } catch (_) {
      return;
    }
    const hasIncludes = cols.includes('includes');
    const hasJson = cols.includes('includes_json');
    try {
      if (hasJson && !hasIncludes) {
        await conn.execute('ALTER TABLE jz_skus CHANGE COLUMN includes_json includes TEXT');
        console.log('jz_skus: renamed includes_json → includes');
      } else if (hasJson && hasIncludes) {
        await conn.execute('UPDATE jz_skus SET includes=includes_json WHERE includes IS NULL AND includes_json IS NOT NULL');
        await conn.execute('ALTER TABLE jz_skus DROP COLUMN includes_json');
        console.log('jz_skus: merged includes_json into includes');
      } else if (!hasIncludes) {
        await conn.execute('ALTER TABLE jz_skus ADD COLUMN includes TEXT');
      }
    } catch (e) {
      console.warn('jz_skus includes 列对齐失败:', e.message);
    }
  }

  let schemaEnsured = false;
  let schemaPromise = null;
  async function ensureSchema() {
    if (schemaEnsured || !mysql2) return;
    if (schemaPromise) return schemaPromise;
    schemaPromise = ensureSchemaRun().catch(function (err) {
      schemaPromise = null;
      throw err;
    });
    return schemaPromise;
  }
  async function ensureSchemaRun() {
    const conn = await mysql2.createConnection(getDbConfig());
    try {
      const ddls = [
        `CREATE TABLE IF NOT EXISTS cities (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          slug VARCHAR(100) NOT NULL,
          booking_phone VARCHAR(50),
          hero_bg_image VARCHAR(500),
          hidden_home_tabs TEXT,
          UNIQUE KEY uk_name (name),
          UNIQUE KEY uk_slug (slug)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS channels (
          id VARCHAR(50) PRIMARY KEY,
          label VARCHAR(100) NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          enabled TINYINT NOT NULL DEFAULT 1,
          hidden_cities TEXT NULL,
          note TEXT
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS settings (
          \`key\` VARCHAR(100) PRIMARY KEY,
          value TEXT
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS districts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          city_id INT NOT NULL,
          name VARCHAR(100) NOT NULL,
          slug VARCHAR(100) NOT NULL,
          note TEXT,
          has_projects TINYINT NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          cover_image VARCHAR(500),
          project_count INT NOT NULL DEFAULT 0,
          unit_count INT NOT NULL DEFAULT 0,
          vacant_count INT,
          managed_unit_count INT,
          avg_price INT,
          is_hot TINYINT NOT NULL DEFAULT 0,
          layout_tall TINYINT NOT NULL DEFAULT 0,
          layout_wide TINYINT NOT NULL DEFAULT 0,
          bg_class VARCHAR(50),
          UNIQUE KEY uk_city_slug (city_id, slug)
        ) CHARSET=utf8mb4`,
        // 周边玩法维度（规则 17）：商圈/景区字典 + 项目绑定。city_id NULL = 全省通用（跨市目的地）；
        // slug 全局唯一（uk_spot_slug），是 C 端深链词汇（lvju-app-spot-detail.html?spot=）。
        `CREATE TABLE IF NOT EXISTS spots (
          id INT AUTO_INCREMENT PRIMARY KEY,
          city_id INT NULL,
          type VARCHAR(20) NOT NULL DEFAULT 'scenic',
          name VARCHAR(100) NOT NULL,
          slug VARCHAR(100) NOT NULL,
          icon VARCHAR(16),
          cover_image VARCHAR(500),
          summary TEXT,
          body TEXT,
          photos TEXT,
          address VARCHAR(200),
          duration VARCHAR(40),
          ticket VARCHAR(40),
          tags TEXT,
          link VARCHAR(500),
          sort_order INT NOT NULL DEFAULT 0,
          enabled TINYINT NOT NULL DEFAULT 1,
          UNIQUE KEY uk_spot_slug (slug),
          KEY idx_spot_city (city_id, type, sort_order)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS project_spots (
          id INT AUTO_INCREMENT PRIMARY KEY,
          project_id INT NOT NULL,
          spot_id INT NOT NULL,
          note VARCHAR(120),
          sort_order INT NOT NULL DEFAULT 0,
          UNIQUE KEY uk_proj_spot (project_id, spot_id),
          KEY idx_ps_spot (spot_id)
        ) CHARSET=utf8mb4`,
        // 内容编排（旅游路线）：spots 的有序串联。stops 为 JSON [{spot_id, note}]，站点内容仍在 spots
        // 单一数据源里（规则 17）；city_id NULL = 全省通用，与 spots 同口径。
        `CREATE TABLE IF NOT EXISTS routes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          city_id INT NULL,
          slug VARCHAR(100) NOT NULL,
          name VARCHAR(100) NOT NULL,
          summary TEXT,
          cover_image VARCHAR(500),
          days INT NOT NULL DEFAULT 1,
          stops TEXT,
          sort_order INT NOT NULL DEFAULT 0,
          enabled TINYINT NOT NULL DEFAULT 1,
          UNIQUE KEY uk_route_slug (slug),
          KEY idx_route_city (city_id, sort_order)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS projects (
          id INT AUTO_INCREMENT PRIMARY KEY,
          city_id INT NOT NULL,
          district_id INT,
          channel VARCHAR(20) NOT NULL,
          name VARCHAR(200) NOT NULL,
          slug VARCHAR(200) NOT NULL,
          cover_image VARCHAR(500),
          address VARCHAR(300),
          tags TEXT,
          sort_order INT NOT NULL DEFAULT 0,
          unit_count INT NOT NULL DEFAULT 0,
          managed_unit_count INT,
          price_from INT,
          is_featured TINYINT NOT NULL DEFAULT 0,
          featured_rank INT,
          old_house_hint TEXT,
          rating_status VARCHAR(20) NOT NULL DEFAULT 'draft',
          rating TEXT,
          rating_submitted_at VARCHAR(30),
          rating_reviewed_at VARCHAR(30),
          rating_note TEXT,
          status VARCHAR(20) NOT NULL DEFAULT 'draft',
          owner_vendor_id INT,
          ext TEXT,
          UNIQUE KEY uk_channel_slug (channel, slug)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS units (
          id INT AUTO_INCREMENT PRIMARY KEY,
          project_id INT NOT NULL,
          name VARCHAR(200) NOT NULL,
          slug VARCHAR(200) NOT NULL,
          area_sqm DECIMAL(8,2),
          layout_label VARCHAR(50),
          rent_monthly INT,
          price_total INT,
          tags TEXT,
          unit_spec VARCHAR(200),
          promo_price INT,
          total_qty INT NOT NULL DEFAULT 1,
          amenities TEXT,
          keeper TEXT,
          rent_detail TEXT,
          sort_order INT NOT NULL DEFAULT 0,
          cover_image VARCHAR(500),
          ext TEXT,
          UNIQUE KEY uk_project_slug (project_id, slug)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS booking_contacts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          name VARCHAR(64) NOT NULL,
          phone VARCHAR(32) NOT NULL,
          created_at VARCHAR(32) NOT NULL,
          KEY idx_bc_user (user_id),
          UNIQUE KEY uk_bc_user_phone (user_id, phone)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS booking_orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_no VARCHAR(32) NOT NULL,
          project_id INT NOT NULL,
          unit_id INT,
          channel VARCHAR(16) NOT NULL,
          city_id INT,
          owner_vendor_id INT NOT NULL,
          user_id VARCHAR(64),
          contact_name VARCHAR(64) NOT NULL,
          contact_phone VARCHAR(32) NOT NULL,
          checkin VARCHAR(10) NOT NULL,
          checkout VARCHAR(10) NOT NULL,
          nights INT NOT NULL,
          rooms INT NOT NULL DEFAULT 1,
          price_total INT NOT NULL,
          commission_rate DECIMAL(5,2),
          commission_fee DECIMAL(10,2),
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          pay_status VARCHAR(20),
          pay_method VARCHAR(50),
          pay_at VARCHAR(30),
          idempotency_key VARCHAR(100),
          payment_expires_at VARCHAR(32),
          created_at VARCHAR(32) NOT NULL,
          updated_at VARCHAR(32) NOT NULL,
          UNIQUE KEY uk_order_no (order_no),
          KEY idx_bo_vendor (owner_vendor_id, status),
          KEY idx_bo_project (project_id),
          KEY idx_bo_user (user_id)
          ,UNIQUE KEY uk_bo_idempotency (idempotency_key)
        ) CHARSET=utf8mb4`,
        // 房态日历：只存差异行（关房/夜价/放出间数覆盖 + 占用计数），无行 = 可订（放出间数 = units.total_qty）；
        // unit_id=0 为项目级（整栋/不限房型，容量恒 1）。stored status 只写 open/blocked（商家闸门），
        // booked 是 remaining<=0 的派生态不落库（多间库存口径，2026-09-10，docs/stay-multi-qty-design.md）
        `CREATE TABLE IF NOT EXISTS stay_calendar (
          id INT AUTO_INCREMENT PRIMARY KEY,
          project_id INT NOT NULL,
          unit_id INT NOT NULL DEFAULT 0,
          stay_date VARCHAR(10) NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'open',
          price_night INT,
          qty INT,
          booked_qty INT NOT NULL DEFAULT 0,
          source VARCHAR(16) NOT NULL DEFAULT 'vendor',
          booking_id INT,
          updated_at VARCHAR(32),
          UNIQUE KEY uk_sc (project_id, unit_id, stay_date),
          KEY idx_sc_range (project_id, stay_date)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS photos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          entity_type VARCHAR(20) NOT NULL,
          entity_id INT NOT NULL,
          file_path VARCHAR(500) NOT NULL,
          source_path VARCHAR(500),
          is_cover TINYINT NOT NULL DEFAULT 0,
          sort_order INT NOT NULL DEFAULT 0,
          category VARCHAR(20),
          external_id VARCHAR(120),
          KEY idx_entity (entity_type, entity_id)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_categories (
          id VARCHAR(50) PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          icon VARCHAR(500),
          sort_order INT NOT NULL DEFAULT 0,
          enabled TINYINT NOT NULL DEFAULT 1,
          note TEXT
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_skus (
          id INT AUTO_INCREMENT PRIMARY KEY,
          category_id VARCHAR(50) NOT NULL,
          name VARCHAR(200) NOT NULL,
          slug VARCHAR(200) NOT NULL UNIQUE,
          spec TEXT,
          price_from INT,
          price_unit VARCHAR(50),
          duration_min INT,
          tags TEXT,
          badges TEXT,
          sales_text VARCHAR(200),
          rating_score DECIMAL(3,2),
          worker_min_level VARCHAR(20),
          cover_image VARCHAR(500),
          gallery TEXT,
          includes TEXT,
          service_flow TEXT,
          service_notice TEXT,
          sort_order INT NOT NULL DEFAULT 0,
          enabled TINYINT NOT NULL DEFAULT 1
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_vendors (
          id INT AUTO_INCREMENT PRIMARY KEY,
          type VARCHAR(50) NOT NULL,
          name VARCHAR(200) NOT NULL,
          logo VARCHAR(500),
          address TEXT,
          district_id INT,
          city_ids TEXT,
          phone VARCHAR(50),
          rating DECIMAL(3,2) DEFAULT 0,
          review_count INT DEFAULT 0,
          rank_type VARCHAR(50),
          rank_label VARCHAR(100),
          badges TEXT,
          live TINYINT DEFAULT 0,
          start_price DECIMAL(10,2),
          unit VARCHAR(50),
          fulfillment VARCHAR(50) DEFAULT 'to_home',
          hours VARCHAR(200),
          vendor_no VARCHAR(100),
          whitelist_id INT,
          status VARCHAR(20) DEFAULT 'active',
          sort_order INT DEFAULT 0,
          created_at VARCHAR(30),
          updated_at VARCHAR(30)
          ,login_name VARCHAR(120)
          ,password_hash VARCHAR(255)
          ,review_status VARCHAR(20) NOT NULL DEFAULT 'pending'
          ,review_note TEXT
          ,reviewed_at VARCHAR(30)
          ,commission_housing DECIMAL(5,2) DEFAULT NULL
          ,commission_jiazheng DECIMAL(5,2) DEFAULT NULL
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_products (
          id INT AUTO_INCREMENT PRIMARY KEY,
          vendor_id INT NOT NULL,
          title VARCHAR(200) NOT NULL,
          subtitle VARCHAR(200),
          category VARCHAR(50),
          duration_hours DECIMAL(4,1),
          area_range VARCHAR(100),
          unit VARCHAR(50),
          price DECIMAL(10,2) NOT NULL,
          original_price DECIMAL(10,2),
          discount_label VARCHAR(100),
          earliest_time VARCHAR(100),
          advance_booking_hours INT DEFAULT 0,
          sales_count INT DEFAULT 0,
          rating DECIMAL(3,2) DEFAULT 0,
          service_tags TEXT,
          channel_sku_id INT,
          city_id INT,
          path VARCHAR(500),
          query VARCHAR(500),
          status VARCHAR(20) DEFAULT 'on',
          sort_order INT DEFAULT 0
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_workers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          avatar VARCHAR(500),
          level VARCHAR(20) DEFAULT 'L3',
          credit_score INT DEFAULT 70,
          tags TEXT,
          certs TEXT,
          is_whitelisted TINYINT DEFAULT 0,
          rating DECIMAL(3,2) DEFAULT 0,
          completed_orders INT DEFAULT 0,
          years_experience INT DEFAULT 0,
          online TINYINT DEFAULT 0,
          distance_km DECIMAL(6,2),
          vendor_id INT,
          whitelist_id INT,
          status VARCHAR(20) DEFAULT 'active'
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_orders (
          id VARCHAR(50) PRIMARY KEY,
          sku_id INT,
          category_id VARCHAR(50) NOT NULL,
          type VARCHAR(50) NOT NULL,
          house TEXT NOT NULL,
          phone VARCHAR(50) NOT NULL,
          expect_time VARCHAR(100) NOT NULL,
          \`desc\` TEXT,
          fee INT NOT NULL,
          pay_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
          pay_method VARCHAR(50),
          pay_at VARCHAR(30),
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          slot_id INT,
          worker_json TEXT,
          rating_json TEXT,
          source VARCHAR(100),
          created_at VARCHAR(30) NOT NULL,
          updated_at VARCHAR(30) NOT NULL,
          log_json TEXT
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_sku_slots (
          id INT AUTO_INCREMENT PRIMARY KEY,
          product_id INT NOT NULL,
          slot_date VARCHAR(20) NOT NULL,
          start_time VARCHAR(20) NOT NULL,
          end_time VARCHAR(20),
          capacity INT NOT NULL DEFAULT 1,
          booked INT NOT NULL DEFAULT 0,
          worker_id INT,
          status VARCHAR(20) NOT NULL DEFAULT 'open',
          note TEXT,
          KEY idx_product_date (product_id, slot_date, status)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_subcategories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          parent_type VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL,
          icon VARCHAR(500),
          sort_order INT NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'on',
          KEY idx_parent (parent_type, sort_order)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_sku_workers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          product_id INT NOT NULL,
          worker_id INT NOT NULL,
          UNIQUE KEY uk_prod_worker (product_id, worker_id)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS jz_activities (
          id INT AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(200) NOT NULL,
          type VARCHAR(50) NOT NULL DEFAULT 'coupon',
          category_id VARCHAR(50),
          sku_ids TEXT,
          discount_type VARCHAR(50) DEFAULT 'percent',
          discount_value DECIMAL(10,2),
          threshold DECIMAL(10,2) DEFAULT 0,
          start_at VARCHAR(30),
          end_at VARCHAR(30),
          enabled TINYINT NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_at VARCHAR(30),
          updated_at VARCHAR(30)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS gr_orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_ref VARCHAR(64) NOT NULL,
          vendor_id INT,
          vendor_oid VARCHAR(64),
          user_id VARCHAR(64),
          sku VARCHAR(128),
          city VARCHAR(32) DEFAULT '沈阳',
          status VARCHAR(20) DEFAULT 'pending',
          fee INT,
          worker_name VARCHAR(128),
          worker_phone VARCHAR(32),
          eta VARCHAR(32),
          cancel_reason TEXT,
          paid_at VARCHAR(32),
          serving_at VARCHAR(32),
          completed_at VARCHAR(32),
          created_at VARCHAR(32) NOT NULL,
          updated_at VARCHAR(32),
          UNIQUE KEY uk_order_ref (order_ref),
          KEY idx_gr_orders_vendor (vendor_id),
          KEY idx_gr_orders_user (user_id)
        ) CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS operator_staff (
          id INT AUTO_INCREMENT PRIMARY KEY,
          emp_no VARCHAR(30) NULL,
          name VARCHAR(100) NOT NULL,
          phone VARCHAR(20) NULL,
          level VARCHAR(10) DEFAULT 'L2',
          \`role\` VARCHAR(50) NULL,
          station VARCHAR(100) NULL,
          month_orders INT DEFAULT 0,
          rating DECIMAL(3,2) DEFAULT 0,
          contract_type VARCHAR(10) DEFAULT '正式',
          contract_end VARCHAR(10) NULL,
          status VARCHAR(20) DEFAULT 'active',
          can_extra TINYINT DEFAULT 0,
          note VARCHAR(200) NULL,
          org_id INT NULL,                       -- 归属机构（scope 行级过滤用；NULL=平台级，全员可见）
          vendor_id INT NULL,                    -- 归属运营商（同上）
          created_at VARCHAR(30),
          updated_at VARCHAR(30),
          UNIQUE KEY uk_staff_emp_no (emp_no)
        ) CHARSET=utf8mb4`,
        // 商家入驻申请单（服务认证中台受理；真实流程：申请落库 → 受理 → 通过/驳回）
        `CREATE TABLE IF NOT EXISTS vendor_onboarding (
          id INT AUTO_INCREMENT PRIMARY KEY,
          apply_no VARCHAR(32) NOT NULL,
          company VARCHAR(160) NOT NULL,
          contact VARCHAR(64) NOT NULL,
          phone VARCHAR(32) NOT NULL,
          license_no VARCHAR(64) DEFAULT '',
          license_valid VARCHAR(32) DEFAULT '',
          permit_type VARCHAR(32) DEFAULT '',
          channels VARCHAR(64) DEFAULT 'rental',
          category_scope VARCHAR(255) DEFAULT '',
          house_count INT DEFAULT 0,
          settle_bank VARCHAR(120) DEFAULT '',
          settle_account VARCHAR(64) DEFAULT '',
          deposit_tier VARCHAR(32) DEFAULT '',
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          rate_base DECIMAL(5,2) NOT NULL DEFAULT 10.00,
          rate_discount DECIMAL(5,2) DEFAULT NULL,
          approved_vendor_id INT DEFAULT NULL,
          checklist_json TEXT,
          review_note VARCHAR(500) DEFAULT '',
          reviewer VARCHAR(64) DEFAULT '',
          reviewed_at DATETIME DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_vo_status (status),
          INDEX idx_vo_no (apply_no),
          INDEX idx_vo_phone (phone),
          INDEX idx_vo_vendor (approved_vendor_id)
        ) CHARSET=utf8mb4`,
      ];
      for (const ddl of ddls) {
        await conn.execute(ddl);
      }
      // 初始化 jz_categories 种子数据（到家 4 类 + 本地生活 7 频道，同 Tab 并列）
      const jzCatSeeds = [
        ['cleaning', '保洁', '🧹', 1],
        ['repair',   '维修', '🔧', 2],
        ['moving',   '搬家', '📦', 3],
        ['nanny',    '保姆', '👶', 4],
        ['telecom', '电讯服务', '📱', 5],
        ['insurance', '财险服务', '🛡', 6],
        ['consumer_finance', '消费金融', '💳', 7],
        ['health_care', '健康养老', '🏥', 8],
        ['home_maintain', '居家维护', '🏠', 9],
        ['asset', '资产服务', '🏦', 10],
        ['recycle', '二手回收', '♻️', 11],
        ['community', '社区服务', '🏘', 12],
      ];
      for (const [catId, catName, catIcon, catOrder] of jzCatSeeds) {
        await conn.execute(
          'INSERT IGNORE INTO jz_categories(id, name, icon, sort_order, enabled) VALUES (?, ?, ?, ?, 1)',
          [catId, catName, catIcon, catOrder]
        );
      }
      // 本地生活频道演示 SKU / 商家 / 商品（INSERT IGNORE，存量库可增量补齐）
      const lifeSkuSeeds = [
        [25,'telecom','宽带新装 · 千兆','telecom-broadband','装维上门 · 当周开通',99,'起',120,1],
        [26,'telecom','号码携转 · 套餐','telecom-portability','携号转网 · 套餐对比',0,'咨询',30,2],
        [27,'insurance','家财险 · 基础版','insurance-home-basic','漏水/火灾/盗抢',128,'/年',0,1],
        [28,'insurance','租客责任险','insurance-tenant','第三者责任 · 押金替代',68,'/年',0,2],
        [29,'consumer_finance','分期免息 · 租住','finance-rent-installment','首付灵活 · 信用评估',0,'咨询',0,1],
        [30,'consumer_finance','消费贷 · 额度查询','finance-credit-limit','额度秒批 · 随借随还',0,'咨询',0,2],
        [31,'health_care','养老陪护 · 日间','health-elder-day','持证护理 · 日间到岗',280,'/天',480,1],
        [32,'health_care','体检套餐 · 基础','health-checkup-basic','三甲对接 · 报告解读',299,'起',0,2],
        [33,'home_maintain','管道养护 · 季度','maintain-pipe-quarter','疏通+防堵养护',198,'/季',90,1],
        [34,'home_maintain','家电保养 · 套餐','maintain-appliance','空调/冰箱/洗衣机',159,'起',120,2],
        [35,'asset','资产评估 · 房产','asset-appraisal','持证评估师上门',500,'起',0,1],
        [36,'asset','托管运营 · 咨询','asset-custody','租金托管 · 报表透明',0,'咨询',0,2],
        [37,'recycle','旧家电回收','recycle-appliance','上门估价 · 当日清运',0,'估价',60,1],
        [38,'recycle','家具回收 · 套装','recycle-furniture','大件拆装 · 环保处置',0,'估价',90,2],
        [39,'community','社区团购 · 日配','community-groupbuy','生鲜果蔬 · 次日达',0,'咨询',0,1],
        [40,'community','便民代办 · 跑腿','community-errand','取送件 · 代缴代办',29,'起',60,2],
      ];
      for (const [id, cat, name, slug, spec, price, unit, dur, ord] of lifeSkuSeeds) {
        await conn.execute(
          `INSERT IGNORE INTO jz_skus(id,category_id,name,slug,spec,price_from,price_unit,duration_min,
            tags,badges,sales_text,rating_score,worker_min_level,includes,service_flow,service_notice,sort_order,enabled)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          [id, cat, name, slug, spec, price, unit, dur,
            JSON.stringify(['本地生活']), JSON.stringify(['精选']), '试点开放', 4.7, 'L2',
            JSON.stringify(['在线预约', '认证服务商', '进度可查']),
            JSON.stringify(['选择服务', '提交需求', '服务商确认', '履约完成']),
            JSON.stringify(['价格以实际报价为准', '部分服务需资质核验']), ord]
        );
      }
      // 本地生活商家用 141+，避免撞本地已有 cleaning/moving 演示商家 41/42
      const lifeVendors = [
        [141,'telecom','联通装维优选','📶','全市覆盖',4.6,1200],
        [142,'insurance','安居财险专区','🛡','全国',4.8,5600],
        [143,'consumer_finance','江苏银行消费金融','💳','本地',4.7,3200],
        [144,'health_care','康养到家','🏥','全市',4.8,2100],
        [145,'home_maintain','安居养护','🔧','全市',4.6,1800],
        [146,'asset','贝壳资产顾问','🏦','本地',4.7,900],
        [147,'recycle','绿色回收站','♻️','全市',4.5,4400],
        [148,'community','邻里便民站','🏘','全市',4.6,2600],
        [151,'moving','蓝犀牛搬家','🚚','全市覆盖',4.6,2400],
        [152,'nanny','阿姨来了','👶','全市覆盖',4.8,8800],
      ];
      const nowLife = new Date().toISOString().slice(0, 19);
      for (const [id, type, name, logo, address, rating, reviews] of lifeVendors) {
        await conn.execute(
          `INSERT IGNORE INTO jz_vendors(id,type,name,logo,address,rating,review_count,badges,live,start_price,unit,hours,status,review_status,sort_order,created_at,updated_at,city_ids)
           VALUES(?,?,?,?,?,?,?,?,0,0,'起','09:00-21:00','active','approved',?,?,?,NULL)`,
          [id, type, name, logo, address, rating, reviews, JSON.stringify(['whitelist']), id, nowLife, nowLife]
        );
      }
      const lifeProducts = [
        [5101,141,25,'宽带新装 · 千兆','装维上门',99],
        [5102,141,26,'号码携转 · 套餐','携号转网',0],
        [5103,142,27,'家财险 · 基础版','漏水火灾盗抢',128],
        [5104,142,28,'租客责任险','押金替代方案',68],
        [5105,143,29,'分期免息 · 租住','信用评估',0],
        [5106,143,30,'消费贷 · 额度查询','随借随还',0],
        [5107,144,31,'养老陪护 · 日间','持证护理',280],
        [5108,144,32,'体检套餐 · 基础','三甲对接',299],
        [5109,145,33,'管道养护 · 季度','疏通养护',198],
        [5110,145,34,'家电保养 · 套餐','多品类保养',159],
        [5111,146,35,'资产评估 · 房产','持证上门',500],
        [5112,146,36,'托管运营 · 咨询','租金托管',0],
        [5113,147,37,'旧家电回收','上门估价',0],
        [5114,147,38,'家具回收 · 套装','大件清运',0],
        [5115,148,39,'社区团购 · 日配','生鲜果蔬',0],
        [5116,148,40,'便民代办 · 跑腿','取送代缴',29],
        // 保姆：保证城市过滤后类目仍可见（搬家用蓝犀牛 v42 联调商品，不再内置 seed）
        [5251,152,8,'钟点工 · 3小时','做饭保洁',128],
        [5252,152,9,'育儿嫂 · 住家','持证育儿',8800],
        [5253,152,21,'住家保姆 · 全职','做饭保洁照护',6800],
        [5254,152,23,'月嫂 · 26天','三甲护理',12800],
      ];
      for (const [pid, vid, skuId, title, sub, price] of lifeProducts) {
        await conn.execute(
          `INSERT IGNORE INTO jz_products(id,vendor_id,title,subtitle,category,duration_hours,area_range,unit,
            price,original_price,discount_label,earliest_time,advance_booking_hours,sales_count,rating,
            service_tags,channel_sku_id,status,sort_order)
           VALUES(?,?,?,?,?,1,'','起',?,?,NULL,'今天 18:00',2,100,4.7,?,?,'on',?)`,
          [pid, vid, title, sub, title.split('·')[0].trim(), price, price ? Math.round(price * 1.5) : null,
            JSON.stringify(['本地生活', '可预约']), skuId, pid]
        );
      }
      // 初始化 channels 种子数据（bzf 已转为 topic，不再作为 channel —— 见 CLAUDE.md 房源库通用化）
      const channelSeeds = [
        ['rental', '长租', 0],
        ['trade', '卖旧买新专区', 2],
        ['jiazheng', '生活服务专区', 3],
        ['minsu', '民宿', 4],
        ['newhouse', '新房', 5],
        ['resale', '二手', 6],
      ];
      for (const [id, label, order] of channelSeeds) {
        await conn.execute(
          'INSERT IGNORE INTO channels(id, label, sort_order, enabled) VALUES (?, ?, ?, 1)',
          [id, label, order]
        );
      }
      // 初始化 settings 种子数据
      const settingSeeds = [
        ['show_city_switcher', '1'],
        ['show_life_service', '1'],
        ['channel_name', (channelBrand && channelBrand.DEFAULT_CHANNEL_NAME) || '新居住频道'],
        ['commission_housing_default', '10.00'],   // 抽佣全局基准·房源预订（0903 纪要，规则 20）
        ['commission_jiazheng_default', '10.00'],  // 抽佣全局基准·家政
      ];
      for (const [k, v] of settingSeeds) {
        await conn.execute(
          'INSERT IGNORE INTO settings(`key`, value) VALUES (?, ?)',
          [k, v]
        );
      }
      // 旧库 CREATE TABLE IF NOT EXISTS 不会补列；导入/查询前先对齐
      const extraCols = [
        ['cities', 'hidden_home_tabs TEXT'],
        ['projects', "status VARCHAR(20) NOT NULL DEFAULT 'draft'"],
        ['projects', 'owner_vendor_id INT'],
        ['projects', 'ext TEXT'],
        ['units', 'ext TEXT'],
        ['units', 'total_qty INT NOT NULL DEFAULT 1'],        // 总间数（多间库存 2026-09-10，缺省 1 = 旧行为）
        ['booking_orders', 'idempotency_key VARCHAR(100)'],
        ['booking_orders', 'payment_expires_at VARCHAR(32)'],
        ['booking_orders', 'commission_rate DECIMAL(5,2)'],   // 下单锁定的商家生效费率快照（规则 20，调价不追溯）
        ['booking_orders', 'commission_fee DECIMAL(10,2)'],
        ['booking_orders', 'rooms INT NOT NULL DEFAULT 1'],   // 订购间数（整栋单恒 1）
        ['stay_calendar', 'qty INT'],                         // 该晚放出间数覆盖（NULL = units.total_qty；项目级恒 1）
        ['stay_calendar', 'booked_qty INT NOT NULL DEFAULT 0'],  // 该晚已订间数（占用计数，释放时递减）
        ['stay_calendar', 'qty_base INT'],                       // 净可售基线（2026-09 方案 B）：available_qty 推送时的已订数；NULL = 旧「放出总量」口径
        ['jz_vendors', 'login_name VARCHAR(120)'],
        ['jz_vendors', 'password_hash VARCHAR(255)'],
        ['jz_vendors', "review_status VARCHAR(20) NOT NULL DEFAULT 'pending'"],   // 2026-09-22 从严：新建档默认待审（存量行不动；种子/流程内建档显式写 'approved'）
        ['jz_vendors', 'review_note TEXT'],
        ['jz_vendors', 'reviewed_at VARCHAR(30)'],
        ['jz_vendors', 'city_ids TEXT'],
        ['jz_vendors', 'district_id INT'],
        ['jz_vendors', 'phone VARCHAR(50)'],
        ['jz_vendors', 'fulfillment VARCHAR(50) DEFAULT \'to_home\''],
        ['jz_vendors', 'vendor_no VARCHAR(100)'],
        ['jz_vendors', 'whitelist_id INT'],
        ['jz_vendors', 'platform_certs TEXT'],
        ['jz_vendors', 'webhook_url VARCHAR(500)'],
        ['jz_vendors', "consult_mode VARCHAR(20) DEFAULT 'consultant'"],   // 商家维度咨询优先展示：consultant=咨询顾问(400) / ai=AI 咨询（未上线）
        ['jz_vendors', 'commission_housing DECIMAL(5,2)'],   // 抽佣·房源预订档（%，NULL=按全局基准，规则 20）
        ['jz_vendors', 'commission_jiazheng DECIMAL(5,2)'],  // 抽佣·家政档（本期仅配置，消费在家政结算）
        ['jz_vendors', 'intro TEXT'],                        // 品牌简介（C 端「商家介绍」整段展示；NULL = 该块不渲染）
        ['jz_vendors', 'banner_url VARCHAR(500)'],           // 频道级横幅（列表页 hero；NULL = 回落渐变 hero）
        ['photos', 'category VARCHAR(20)'],                      // 图片分类（2026-09，取值见 photo_config.PHOTO_CATEGORIES）
        ['photos', 'external_id VARCHAR(120)'],                  // 商家侧稳定图 id（2026-09）：全量覆盖的匹配键（URL 带签名会变，不能只靠 URL）
        ['jz_products', 'city_id INT'],
        ['jz_products', 'channel_sku_id INT'],
        ['jz_products', 'path VARCHAR(500)'],
        ['jz_products', 'query VARCHAR(500)'],
        ['vendor_onboarding', 'approved_vendor_id INT'],   // 受理台 ↔ 商家档案互通（2026-09-22）：approve 按 phone 单命中时记录关联商家
        ['channels', 'hidden_cities TEXT NULL'],  // 按城市隐藏 tab（JSON 数组，如 ["shenyang"]）
      ];
      for (const [table, ddl] of extraCols) {
        try { await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); } catch (_) { /* 列已存在 */ }
      }
      // 商家资质复审默认从严（2026-09-22）：旧库列已存在，ADD COLUMN 不换默认值，这里显式对齐——
      // 新建档不再「生而 approved」（252 青屿民宿教训：脚本直插商家自证通过、零审计留痕），进待审视野。
      // 只改列默认值，存量行原值不动；幂等可重跑。
      try { await conn.execute("ALTER TABLE jz_vendors ALTER COLUMN review_status SET DEFAULT 'pending'"); } catch (_) { /* 表未就绪 */ }
      await ensureJzSkusIncludesColumn(conn);
      // 图集分类回填（2026-09 商家反馈点 4）：存量图无分类 → 'other'，幂等（只碰 NULL/空串行）
      try { await conn.execute("UPDATE photos SET category='other' WHERE category IS NULL OR category=''"); } catch (_) { /* 表未就绪 */ }
      // 保租房/卖旧买新种子（projects 为空时从 juzhu/data*.json 灌入）
      if (housingSeedAll) {
        try {
          const hs = await housingSeedAll(conn);
          if (hs && !hs.skipped) console.log('housingSeedAll', JSON.stringify(hs.inserted || {}));
        } catch (e) { console.warn('housingSeedAll warn:', e.message); }
      }
      if (housingBackfillPhotos) {
        try {
          const bf = await housingBackfillPhotos(conn);
          if (bf && (bf.inserted || bf.covers || bf.units)) console.log('housingBackfillPhotos', JSON.stringify(bf));
        } catch (e) { console.warn('housingBackfillPhotos warn:', e.message); }
      }
      // 源 MySQL juzhu 快照（商家/SKU/订单）；文件缺失则跳过
      if (juzhuImportAll) {
        try {
          const imp = await juzhuImportAll(conn);
          if (imp && !imp.skipped) console.log('juzhuImportAll', JSON.stringify(imp.inserted || {}));
        } catch (e) { console.warn('juzhuImportAll warn:', e.message); }
      }
      // 家政全量种子数据（对应表仍为空时补 demo）
      if (jzSeedAll) {
        try { await jzSeedAll(conn); } catch (e) { console.warn('jzSeedAll warn:', e.message); }
      }
      // 运营商员工花名册种子（INSERT IGNORE + uk_staff_emp_no 幂等，多实例并发安全）
      if (staffSeedAll) {
        try { await staffSeedAll(conn); } catch (e) { console.warn('staffSeedAll warn:', e.message); }
      }
      await ensureGrOrdersShape(conn);
      try {
        await conn.execute('ALTER TABLE gr_orders CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
      } catch (_) { /* 5.7 无 0900 或已是该 collation */ }
      // 迁移：补充可能缺失的列（ALTER TABLE ... ADD COLUMN IF NOT EXISTS 在 MySQL 8.0 不支持，用 try/catch 忽略重复列错误）
      const migrations = [
        "ALTER TABLE projects ADD COLUMN contact_phone VARCHAR(50)",
        "ALTER TABLE booking_orders ADD UNIQUE KEY uk_bo_idempotency (idempotency_key)",
        // 旧版种子在 status=online 时尚未落 rating_status；仅回填历史在线数据，新建房源仍默认为 draft。
        "UPDATE projects SET rating_status='passed' WHERE status='online' AND (rating_status IS NULL OR rating_status='draft')",
        // 周边玩法笔记化（2026-09-06）：正文/图集/攻略信息（旧库 spots 补列，新库 DDL 已含）
        "ALTER TABLE spots ADD COLUMN body TEXT",
        "ALTER TABLE spots ADD COLUMN photos TEXT",
        "ALTER TABLE spots ADD COLUMN address VARCHAR(200)",
        "ALTER TABLE spots ADD COLUMN duration VARCHAR(40)",
        "ALTER TABLE spots ADD COLUMN ticket VARCHAR(40)",
        // 预订订单归属（登录用户；未登录下单 user_id 为空，不进 /booking/my）
        "ALTER TABLE booking_orders ADD COLUMN user_id VARCHAR(64)",
        "ALTER TABLE booking_orders ADD KEY idx_bo_user (user_id)",
        // 支付（阶段3 旅居收银台）：在线支付单=unpaid/paid/refunded；在线预订单为 NULL
        "ALTER TABLE booking_orders ADD COLUMN pay_status VARCHAR(20)",
        "ALTER TABLE booking_orders ADD COLUMN pay_method VARCHAR(50)",
        "ALTER TABLE booking_orders ADD COLUMN pay_at VARCHAR(30)",
        "ALTER TABLE booking_orders ADD KEY idx_bo_pay (pay_status)",
        // 多间库存（2026-09-10）：stored status 收敛为 open/blocked，booked 降级为 remaining<=0 派生态——
        // 旧「整行 booked」占用行转为 booked_qty=1 计数（幂等：仅 booked 行受影响；备份走 scripts/stay-qty-init.cjs）
        "UPDATE stay_calendar SET booked_qty=1 WHERE status='booked' AND booked_qty=0",
        "UPDATE stay_calendar SET status='open' WHERE status='booked'",
        // 区级「房源量」= 下属租赁住宿项目 managed_unit_count 加总（勿用户型×40 覆盖真实在管套数）
        `UPDATE districts d
           SET managed_unit_count = (
             SELECT COALESCE(SUM(COALESCE(p.managed_unit_count, p.unit_count)), 0)
             FROM projects p WHERE p.district_id = d.id AND p.channel = 'rental'
           ),
           unit_count = (
             SELECT COALESCE(SUM(p.unit_count), 0)
             FROM projects p WHERE p.district_id = d.id AND p.channel = 'rental'
           ),
           project_count = (
             SELECT COUNT(*) FROM projects p WHERE p.district_id = d.id AND p.channel = 'rental'
           ),
           has_projects = CASE WHEN (
             SELECT COUNT(*) FROM projects p WHERE p.district_id = d.id AND p.channel = 'rental'
           ) > 0 THEN 1 ELSE 0 END`,
      ];
      for (const sql of migrations) {
        try { await conn.execute(sql); } catch (_) { /* 列已存在，忽略 */ }
      }
      // 花名册归属列（scope 行级过滤；NULL=平台级）——存量表渐进补列
      try { await conn.execute('ALTER TABLE operator_staff ADD COLUMN org_id INT NULL'); } catch (_) {}
      try { await conn.execute('ALTER TABLE operator_staff ADD COLUMN vendor_id INT NULL'); } catch (_) {}
      // 账号与权限中心：orgs/accounts/roles/account_roles/sessions/audit_log + 角色种子 + platform_admin 引导
      await authCenter.ensureAuthSchema(conn);
      // 审计留存（默认 180 天，AUDIT_RETENTION_DAYS 可调）
      await authCenter.cleanupAudit().catch((e) => console.warn('cleanupAudit warn:', e.message));
      // 支付中台一期迁移：新表可 CREATE；存量表字段变更只在迁移末尾追加 ALTER。
      await conn.execute(`CREATE TABLE IF NOT EXISTS payment_orders (
        id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '本地支付记录主键',
        biz_order_no VARCHAR(32) NOT NULL COMMENT '关联 booking_orders.order_no',
        app_order_id VARCHAR(28) NOT NULL COMMENT '支付中台业务支付单号及幂等键',
        amount DECIMAL(12,2) NOT NULL COMMENT '本次支付应付金额',
        payer_ucid VARCHAR(64) NOT NULL COMMENT '支付用户 UCID 快照',
        payer_user_type VARCHAR(8) NOT NULL COMMENT '支付用户类型快照',
        merchant_no VARCHAR(64) NOT NULL COMMENT '收款商户号快照',
        share_biz_code VARCHAR(64) NOT NULL COMMENT '统一业务码快照',
        cashier_type VARCHAR(8) NOT NULL COMMENT '收银台类型',
        pay_method VARCHAR(50) NULL COMMENT '实际支付方式',
        pay_status VARCHAR(24) NOT NULL COMMENT '本地支付状态',
        gateway_order_status VARCHAR(8) NULL COMMENT '中台原始订单状态',
        pay_no VARCHAR(64) NULL COMMENT '支付流水号',
        cashier_url TEXT NULL COMMENT '收银台地址',
        callback_url VARCHAR(500) NOT NULL COMMENT '异步通知地址',
        cashier_expires_at DATETIME NULL COMMENT '收银台失效时间',
        paid_at DATETIME NULL COMMENT '支付确认成功时间',
        closed_at DATETIME NULL COMMENT '关单确认时间',
        close_reason VARCHAR(32) NULL COMMENT '关单原因',
        query_retry_count INT NOT NULL DEFAULT 0 COMMENT '查询补偿次数',
        next_query_at DATETIME NULL COMMENT '下次查询时间',
        version INT NOT NULL DEFAULT 0 COMMENT '乐观锁版本',
        created_at DATETIME NOT NULL COMMENT '创建时间',
        updated_at DATETIME NOT NULL COMMENT '更新时间',
        UNIQUE KEY uk_po_app_order (app_order_id),
        KEY idx_po_biz_order_id (biz_order_no, id),
        KEY idx_po_biz_order_status (biz_order_no, pay_status),
        KEY idx_po_status_retry (pay_status, next_query_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单支付表'`);
      await conn.execute(`CREATE TABLE IF NOT EXISTS payment_refunds (
        id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '本地退款单主键',
        payment_order_id BIGINT NOT NULL COMMENT '关联支付记录 ID',
        biz_order_no VARCHAR(32) NOT NULL COMMENT '关联 booking_orders.order_no',
        app_order_id VARCHAR(28) NOT NULL COMMENT '退款业务单号及幂等键',
        idempotency_key VARCHAR(128) NOT NULL COMMENT '退款幂等键',
        refund_reason_type VARCHAR(32) NOT NULL COMMENT '退款原因',
        trigger_source VARCHAR(32) NOT NULL COMMENT '触发来源',
        refund_amount DECIMAL(12,2) NOT NULL COMMENT '退款金额',
        payer_ucid VARCHAR(64) NOT NULL COMMENT '原支付用户 UCID 快照',
        merchant_no VARCHAR(64) NOT NULL COMMENT '原支付商户号快照',
        refund_status VARCHAR(24) NOT NULL COMMENT '退款状态',
        refunded_at DATETIME NULL COMMENT '退款成功时间',
        retry_count INT NOT NULL DEFAULT 0 COMMENT '查询补偿次数',
        next_retry_at DATETIME NULL COMMENT '下次查询时间',
        version INT NOT NULL DEFAULT 0 COMMENT '乐观锁版本',
        created_at DATETIME NOT NULL COMMENT '创建时间',
        updated_at DATETIME NOT NULL COMMENT '更新时间',
        UNIQUE KEY uk_pr_app_order (app_order_id),
        UNIQUE KEY uk_pr_idempotency (idempotency_key),
        KEY idx_pr_biz_order (biz_order_no),
        KEY idx_pr_payment (payment_order_id),
        KEY idx_pr_status_retry (refund_status, next_retry_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单退款表'`);
      await conn.execute(`CREATE TABLE IF NOT EXISTS payment_gateway_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '网关调用日志主键',
        payment_order_id BIGINT NULL COMMENT '关联支付记录 ID',
        payment_refund_id BIGINT NULL COMMENT '关联退款记录 ID',
        app_order_id VARCHAR(28) NOT NULL COMMENT '业务单号',
        operation_type VARCHAR(24) NOT NULL COMMENT '调用类型',
        request_no VARCHAR(64) NOT NULL COMMENT '调用请求号',
        http_status INT NULL COMMENT 'HTTP 状态',
        business_code VARCHAR(64) NULL COMMENT '中台业务码',
        trace_id VARCHAR(128) NULL COMMENT '网关链路 ID',
        success_flag TINYINT NOT NULL DEFAULT 0 COMMENT '是否成功',
        request_json LONGTEXT NULL COMMENT '脱敏请求',
        response_json LONGTEXT NULL COMMENT '脱敏响应',
        error_message VARCHAR(500) NULL COMMENT '异常摘要',
        started_at DATETIME NOT NULL COMMENT '开始时间',
        finished_at DATETIME NULL COMMENT '结束时间',
        UNIQUE KEY uk_pgl_request_no (request_no),
        KEY idx_pgl_payment (payment_order_id, operation_type),
        KEY idx_pgl_refund (payment_refund_id, operation_type),
        KEY idx_pgl_app_order (app_order_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付中台出站调用日志'`);
      await conn.execute(`CREATE TABLE IF NOT EXISTS payment_notify_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '中台通知日志主键',
        notify_key VARCHAR(191) NOT NULL COMMENT '通知幂等键',
        notify_type VARCHAR(16) NOT NULL COMMENT 'pay 或 refund',
        app_order_id VARCHAR(28) NULL COMMENT '业务单号',
        order_status VARCHAR(8) NULL COMMENT '中台状态',
        payload_json LONGTEXT NOT NULL COMMENT '脱敏通知原文',
        handle_result VARCHAR(16) NOT NULL COMMENT '处理结果',
        handle_message VARCHAR(500) NULL COMMENT '处理说明',
        received_at DATETIME NOT NULL COMMENT '接收时间',
        handled_at DATETIME NULL COMMENT '处理完成时间',
        UNIQUE KEY uk_pnl_notify_key (notify_key),
        KEY idx_pnl_app_order (app_order_id),
        KEY idx_pnl_received (received_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付中台异步通知日志'`);
      try { await conn.execute('ALTER TABLE jz_vendors ADD COLUMN pay_merchant_no VARCHAR(64)'); } catch (_) {}
      try { await conn.execute('ALTER TABLE booking_orders ADD COLUMN paid_payment_order_id BIGINT NULL'); } catch (_) {}
      try { await conn.execute('ALTER TABLE booking_orders ADD COLUMN latest_refund_id BIGINT NULL'); } catch (_) {}
      try { await conn.execute('ALTER TABLE booking_orders ADD COLUMN refund_status VARCHAR(24) NULL'); } catch (_) {}
      try { await conn.execute('ALTER TABLE booking_orders ADD COLUMN refunded_at DATETIME NULL'); } catch (_) {}
      try { await conn.execute('ALTER TABLE booking_orders ADD KEY idx_bo_paid_payment (paid_payment_order_id)'); } catch (_) {}
      try { await conn.execute('ALTER TABLE booking_orders ADD KEY idx_bo_latest_refund (latest_refund_id)'); } catch (_) {}
      try { await conn.execute('ALTER TABLE booking_orders ADD KEY idx_bo_refund_status (refund_status)'); } catch (_) {}
      // Versioned shared-payment migrations fail explicitly; no blanket ALTER
      // suppression is allowed for the cashier's concurrency guarantees.
      await require('./payment/migrate.cjs').migrate(conn);
      schemaEnsured = true;
    } finally {
      await conn.end();
    }
  }

  return { ensureSchema, ensureSchemaRun, ensureGrOrdersShape, ensureJzSkusIncludesColumn };
}

module.exports = { createSchema };
