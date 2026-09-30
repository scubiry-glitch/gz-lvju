'use strict';
/**
 * 家政 C 端路由 /api/juzhu/jiazheng/*（从 app.js 拆出；不含 /api/juzhu/jz/* 管理台）。
 * 调用：
 *   const handle = createJiazhengRouter(deps);
 *   if (urlPath.startsWith('/api/juzhu/jiazheng') && (await handle(urlPath, qs, req, res)) !== false) return;
 */
function createJiazhengRouter(deps) {
  return async function handleJiazhengRoutes(urlPath, qs, req, res) {
    const {
      queryRows, jsonReply, readBody, mysql2, getDbConfig,
      cityMatchTokens, cityIdsClause,
      composeRank, merchantIntroOf, maskPhone, maskPhoneStd,
      parseSkuJsonFields, parseJsonFields, vendorAuthBadges, workerAuthBadges, reviewReply,
      requireCEndWrite, restrictOrdersRead, requireDispatchPerm, requireApiKey,
      authCenter, auditIfAccount,
      getVendorConfig, hmacAuth, grOrders, outboundJson, stripVendorSecrets,
    } = deps;

    // --- extracted from app.js L4345-4710 ---
    // ===== jiazheng 公开 C 端接口（Node.js 直连 MySQL 实现）=====

    // GET /api/juzhu/jiazheng/categories
    if (urlPath === '/api/juzhu/jiazheng/categories' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const cityName = (qp.get('city') || '').trim();
      let rows;
      if (cityName) {
        const tokens = await cityMatchTokens(cityName);
        rows = await queryRows(
          `SELECT DISTINCT c.* FROM jz_categories c
           WHERE c.enabled=1
             AND EXISTS (
               SELECT 1 FROM jz_skus s
               JOIN jz_products p ON p.channel_sku_id=s.id AND p.status='on'
               JOIN jz_vendors v ON v.id=p.vendor_id AND v.status='active'
               WHERE s.category_id=c.id
                 AND ${cityIdsClause('v', tokens)}
             )
           ORDER BY c.sort_order, c.id`,
          tokens
        );
      } else {
        rows = await queryRows('SELECT * FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id');
      }
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/skus
    if (urlPath === '/api/juzhu/jiazheng/skus' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const cityName = (qp.get('city') || '').trim();
      const categoryId = (qp.get('category') || '').trim();
      const q = (qp.get('q') || '').trim();
      const params = [];
      // 城市口径（双维度，与详情接口 /skus/:slug 完全对齐）：商品 p.city_id 归属当前城市 + 商家 active 且 city_ids 命中。
      // 只按 vendor 维度过滤会把全国投放商家（city_ids 空）其他城市的商品混进最低价，
      // 造成列表价（如 96）与详情页实际可选商品价（106）不一致。
      let priceAggJoin = '';
      let cityExists = '';
      if (cityName) {
        const tokens = await cityMatchTokens(cityName);
        const cityRows = await queryRows('SELECT id FROM cities WHERE name=? OR slug=? LIMIT 1', [cityName, cityName]);
        const cityId = cityRows.length ? cityRows[0].id : null;
        if (cityId !== null) {
          priceAggJoin = `JOIN jz_vendors v ON v.id=p.vendor_id AND v.status='active' AND p.city_id=${Number(cityId)} AND ${cityIdsClause('v', tokens)}`;
          cityExists = ` AND EXISTS (
                  SELECT 1 FROM jz_products p2
                  JOIN jz_vendors v2 ON v2.id=p2.vendor_id
                  WHERE p2.channel_sku_id=s.id AND p2.status='on'
                    AND v2.status='active' AND p2.city_id=${Number(cityId)}
                    AND ${cityIdsClause('v2', tokens)}
                )`;
        }
      }
      // 每 SKU 的当前城市代表商品（最低价优先）派生列。注意两条硬约束：
      // ① 括号里不得引用 `v.` 别名 —— `v` 只在 cityId 解析成功时才由 priceAggJoin 引入，
      //    传省名/未知城市时 priceAggJoin 为空串，`v.name` 会直接报 Unknown column。
      //    取商家字段一律用自包子查询 (SELECT v2.x FROM jz_vendors v2 WHERE v2.id=p.vendor_id)。
      // ② tokens 的绑定份数在下面按 priceAggJoin 的实际出现次数自动算，不要手工计数
      //    （手工少 push 一份会静默查空：列表从 6 条变 0 条）。
      let sql = `SELECT s.*, c.name AS category_name, c.icon AS category_icon,
                   (SELECT MIN(p.price) FROM jz_products p ${priceAggJoin}
                    WHERE p.channel_sku_id=s.id AND p.status='on') AS product_min_price,
                   (SELECT (SELECT v2.name FROM jz_vendors v2 WHERE v2.id=p.vendor_id)
                    FROM jz_products p ${priceAggJoin}
                    WHERE p.channel_sku_id=s.id AND p.status='on'
                    ORDER BY p.price ASC, p.id ASC LIMIT 1) AS vendor_name,
                   (SELECT NULLIF(p.subtitle,'') FROM jz_products p ${priceAggJoin}
                    WHERE p.channel_sku_id=s.id AND p.status='on'
                    ORDER BY p.price ASC, p.id ASC LIMIT 1) AS list_desc,
                   (SELECT (SELECT v2.banner_url FROM jz_vendors v2 WHERE v2.id=p.vendor_id)
                    FROM jz_products p ${priceAggJoin}
                    WHERE p.channel_sku_id=s.id AND p.status='on'
                    ORDER BY p.price ASC, p.id ASC LIMIT 1) AS vendor_banner
                 FROM jz_skus s JOIN jz_categories c ON c.id=s.category_id
                 WHERE s.enabled=1 AND c.enabled=1
                   AND EXISTS (SELECT 1 FROM jz_products p WHERE p.channel_sku_id=s.id AND p.status='on')${cityExists}`;
      if (priceAggJoin) {
        // priceAggJoin 在 SELECT 里出现几次就绑几份 tokens（按实际出现次数，不手工数），
        // 末尾再加 cityExists 里的一份；顺序与 SQL 中出现顺序一致。
        const uses = sql.split(priceAggJoin).length - 1;
        const tokens = await cityMatchTokens(cityName);
        for (let i = 0; i < uses + 1; i++) params.push(...tokens);
      }
      if (categoryId) { sql += ' AND s.category_id=?'; params.push(categoryId); }
      if (q) {
        sql += ' AND (s.name LIKE ? OR s.spec LIKE ?)';
        params.push('%' + q + '%', '%' + q + '%');
      }
      sql += ' ORDER BY s.category_id, s.sort_order, s.id';
      const rows = await queryRows(sql, params);
      rows.forEach(r => parseSkuJsonFields(r));
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/skus/:slug（C 端详情：对齐 Python 版字段契约）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const qp = new URLSearchParams(qs);
        const vendorId = qp.get('vendor') ? parseInt(qp.get('vendor')) : null;
        const cityName = (qp.get('city') || '').trim();
        let cityId = null;
        if (cityName) {
          const cityRows = await queryRows('SELECT id FROM cities WHERE name=? OR slug=? LIMIT 1', [cityName, cityName]);
          if (cityRows.length) cityId = cityRows[0].id;
        }
        // product_min_price 与列表接口 /skus 同口径（双维度城市过滤），
        // 避免对外契约字段返回跨城市价格
        let minPriceJoin = '';
        const minPriceParams = [];
        if (cityId !== null) {
          const tokens = await cityMatchTokens(cityName);
          minPriceJoin = `JOIN jz_vendors v ON v.id=p.vendor_id AND v.status='active' AND p.city_id=${Number(cityId)} AND ${cityIdsClause('v', tokens)}`;
          minPriceParams.push(...tokens);
        }
        const skus = await queryRows(
          `SELECT s.*, c.name AS category_name, c.icon AS category_icon,
                  (SELECT MIN(p.price) FROM jz_products p ${minPriceJoin}
                   WHERE p.channel_sku_id=s.id AND p.status='on') AS product_min_price
           FROM jz_skus s JOIN jz_categories c ON c.id=s.category_id
           WHERE s.slug=? AND s.enabled=1 AND c.enabled=1`,
          [...minPriceParams, slug]
        );
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        const item = skus[0];
        parseSkuJsonFields(item);

        // products：同 SPU 全部上架商品（双维度城市过滤，对齐 Python list_channel_sku_products）
        let prodSql = `SELECT p.*, v.name AS vendor_name, v.logo AS vendor_logo,
                         v.rating AS vendor_rating, v.review_count AS vendor_review_count,
                         v.type AS vendor_type
                       FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
                       WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const prodParams = [item.id];
        if (vendorId) { prodSql += ' AND p.vendor_id=?'; prodParams.push(vendorId); }
        if (cityId !== null) {
          prodSql += ` AND p.city_id=? AND (v.city_ids IS NULL OR TRIM(v.city_ids)='' OR CONCAT(',', v.city_ids, ',') LIKE CONCAT('%,', ?, ',%'))`;
          prodParams.push(cityId, String(cityId));
        }
        prodSql += ' ORDER BY p.rating DESC, p.sales_count DESC, p.id';
        const products = await queryRows(prodSql, prodParams);
        products.forEach(p => parseJsonFields(p, ['service_tags']));

        // vendor：默认商品对应的商家（剥离密钥 + auth_badges）
        let product = null;
        let vendor = null;
        let workers = [];
        let reviews = [];
        if (products.length) {
          product = products[0];
          const vrows = await queryRows('SELECT * FROM jz_vendors WHERE id=?', [product.vendor_id]);
          if (vrows.length) {
            vendor = vrows[0];
            for (const f of ['hmac_key', 'url_link', 'order_detail_url']) delete vendor[f];
            parseJsonFields(vendor, ['badges']);
            composeRank(vendor);
            vendor.auth_badges = vendorAuthBadges(vendor);
            // workers：默认商品绑定的服务者优先，无绑定回退商家全员，取前 4
            workers = await queryRows(
              `SELECT w.* FROM jz_sku_workers sw JOIN jz_workers w ON w.id=sw.worker_id
               WHERE sw.product_id=? ORDER BY w.level DESC, w.rating DESC`, [product.id]
            );
            if (!workers.length) {
              workers = await queryRows(
                `SELECT * FROM jz_workers WHERE vendor_id=? AND status='active' ORDER BY level DESC, rating DESC LIMIT 4`, [vendor.id]
              );
            }
            workers = workers.slice(0, 4);
            workers.forEach(w => { parseJsonFields(w, ['certs', 'tags']); w.auth_badges = workerAuthBadges(w); });
          }
        }

        // vendors：多商家同款（比价/切换，对齐 Python list_channel_sku_vendors）
        let vendorSql = `SELECT p.id AS product_id, p.price, p.original_price, p.discount_label,
                           p.rating AS product_rating, p.sales_count,
                           v.id AS vendor_id, v.name AS vendor_name, v.logo AS vendor_logo,
                           v.rating AS vendor_rating, v.review_count, v.rank_label, v.badges
                         FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
                         WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const vParams = [item.id];
        if (cityId !== null) {
          vendorSql += ` AND p.city_id=? AND (v.city_ids IS NULL OR TRIM(v.city_ids)='' OR CONCAT(',', v.city_ids, ',') LIKE CONCAT('%,', ?, ',%'))`;
          vParams.push(cityId, String(cityId));
        }
        vendorSql += ' ORDER BY p.rating DESC, p.sales_count DESC, p.id';
        const vendorRows = await queryRows(vendorSql, vParams);
        const vendors = [];
        const seenVendor = new Set();
        for (const row of vendorRows) {
          if (seenVendor.has(row.vendor_id)) continue;  // 一商家一行：同 vendor 多 product 取评分最高的
          seenVendor.add(row.vendor_id);
          parseJsonFields(row, ['badges']);
          row.auth_badges = vendorAuthBadges(row);
          vendors.push(row);
        }

        // related：同 category 的 4 个 SPU
        const related = await queryRows(
          `SELECT id, name, slug, cover_image, price_from, price_unit, rating_score, category_id
           FROM jz_skus WHERE enabled=1 AND category_id=? AND slug<>? ORDER BY sort_order, id LIMIT 4`,
          [item.category_id, item.slug]
        );
        related.forEach(r => parseSkuJsonFields(r));

        // reviews：真实评价优先，不足 3 条补类目 fallback（对齐 Python _review_rows/_fallback_reviews）
        if (products.length) {
          const ids = products.slice(0, 8).map(p => p.id);
          const ph = ids.map(() => '?').join(',');
          const orderRows = await queryRows(
            `SELECT o.*, s.name AS sku_name FROM jz_orders o
             LEFT JOIN jz_products p ON p.id=o.sku_id
             LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
             WHERE o.rating_json IS NOT NULL AND o.rating_json<>'' AND o.sku_id IN (${ph})
             ORDER BY COALESCE(o.updated_at, o.created_at) DESC LIMIT 6`,
            ids
          );
          for (const row of orderRows) {
            let rating = null;
            try { rating = JSON.parse(row.rating_json); } catch (e) { /* 非法 JSON 跳过 */ }
            if (!rating || !rating.score) continue;
            const score = parseFloat(rating.score) || 0;
            reviews.push({
              name: maskPhone(row.phone),
              score,
              tags: rating.tags || [],
              text: rating.text || ((row.sku_name || '本次服务') + '整体完成较稳定。'),
              created_at: (rating.created_at || row.updated_at || row.created_at || '').replace('T', ' ').replace('Z', '').slice(0, 16),
              reply: reviewReply(vendor && vendor.name, score),
            });
          }
          if (reviews.length < 3 && vendor) {
            const fallback = CATEGORY_REVIEW_FALLBACKS[item.category_id] || CATEGORY_REVIEW_FALLBACKS[vendor.type] || CATEGORY_REVIEW_FALLBACKS.cleaning;
            for (const f of fallback) {
              if (reviews.length >= 4) break;
              reviews.push(Object.assign({}, f, { reply: reviewReply(vendor.name, f.score || 0) }));
            }
          }
        }

        // merchant_intro（对齐 Python _merchant_intro）
        const merchant_intro = merchantIntroOf(vendor, product);

        return jsonReply(res, { item, related, product, products, vendor, vendors, workers, reviews, merchant_intro });
      }
    }

    // GET /api/juzhu/jiazheng/workers
    if (urlPath === '/api/juzhu/jiazheng/workers' && req.method === 'GET') {
      const rows = await queryRows(
        'SELECT * FROM jz_workers WHERE status=? ORDER BY credit_score DESC, completed_orders DESC LIMIT 20',
        ['active']
      );
      rows.forEach(r => parseJsonFields(r, ['tags']));
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/orders （须 API Key；phone 仅作过滤）
    if (urlPath === '/api/juzhu/jiazheng/orders' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const workerFilter = await restrictOrdersRead(req, res);
      if (workerFilter === null) return;
      const phone = (qp.get('phone') || '').trim();
      // type_label：产品化下单路径 type=category_id（英文 key），join 出中文名；
      // 存量中文 type（保洁…）与权益售后（type≠category_id）原样保留
      let sql = `SELECT o.*, s.name AS sku_name, c.name AS category_name,
                        CASE WHEN o.type=o.category_id AND c.name IS NOT NULL THEN c.name ELSE o.type END AS type_label
                 FROM jz_orders o
                 LEFT JOIN jz_skus s ON s.id=o.sku_id
                 LEFT JOIN jz_categories c ON c.id=o.category_id WHERE 1=1`;
      const params = [];
      if (workerFilter) { sql += " AND o.worker_json IS NOT NULL AND JSON_VALID(o.worker_json) AND JSON_UNQUOTE(JSON_EXTRACT(o.worker_json, '$.id'))=?"; params.push(workerFilter); }
      if (phone) { sql += ' AND o.phone=?'; params.push(phone); }
      if (qp.get('status')) {
        const statuses = qp.get('status').split(',').filter(Boolean);
        if (statuses.length) {
          sql += ' AND o.status IN (' + statuses.map(() => '?').join(',') + ')';
          params.push(...statuses);
        }
      }
      if(qp.get('pay_status')){const states=qp.get('pay_status').split(',').filter(s=>['paid','unpaid','not_required'].includes(s));if(!states.length)return jsonReply(res,{error:'无效支付状态'},400);sql+=' AND o.pay_status IN ('+states.map(()=>'?').join(',')+')';params.push(...states);}
      const limit = Math.min(parseInt(qp.get('limit') || '100'), 200);
      sql += ' ORDER BY o.created_at DESC LIMIT ' + limit; // limit 已 parseInt+封顶，内联（mysql2 预处理不接受 LIMIT 绑定）
      const rows = await queryRows(sql, params);
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/orders/stats （需 API Key，必须在 orders/:id 之前）
    if (urlPath === '/api/juzhu/jiazheng/orders/stats' && req.method === 'GET') {
      if (!(await requireApiKey(req, res))) return;
      const wf = await restrictOrdersRead(req, res);
      if (wf !== undefined) return jsonReply(res, { error: 'forbidden', message: '统计仅管理账号可见' }, 403);
      const [pendingR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE status='pending'");
      const [dispatchedR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE status='dispatched'");
      const [doneR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE status='done' OR status='rated'");
      const [unpaidR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE pay_status='unpaid'");
      const [poolR] = await queryRows("SELECT COUNT(*) AS c FROM jz_orders WHERE status IN ('pending','dispatched','accepted','serving')");
      return jsonReply(res, {
        pending: pendingR.c, dispatched: dispatchedR.c, done: doneR.c, unpaid: unpaidR.c, pool:poolR.c,
      });
    }

    // ===== 报修单（旅居客 App 提交，sku-less，写入同一张 jz_orders）=====
    // 读接口凭据 + phone 必填 + source 限定三重收口：不存在匿名全表视图（规则 9）。
    // 不套 restrictOrdersRead——user 角色会话会被行级闸 403，这里以 phone 归属替代。
    const REPAIR_SELECT = `SELECT o.*, c2.name AS category_name,
              CASE WHEN o.type=o.category_id AND c2.name IS NOT NULL THEN c2.name ELSE o.type END AS type_label
           FROM jz_orders o
           LEFT JOIN jz_categories c2 ON c2.id=o.category_id`;
    const REPAIR_SOURCE_SQL = "o.source LIKE '旅居客 App%'";

    // GET /api/juzhu/jiazheng/repairs?phone=（我的报修列表）
    if (urlPath === '/api/juzhu/jiazheng/repairs' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const phone = (qp.get('phone') || '').trim();
      if (!phone) return jsonReply(res, { error: 'phone 必填' }, 400);
      const rows = await queryRows(
        `${REPAIR_SELECT} WHERE ${REPAIR_SOURCE_SQL} AND o.phone=? ORDER BY o.created_at DESC LIMIT 50`,
        [phone]
      );
      return jsonReply(res, { items: rows });
    }

    // GET /api/juzhu/jiazheng/repairs/:id?phone=（详情，id+phone 双因子）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/repairs\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        const phone = (qp.get('phone') || '').trim();
        if (!phone) return jsonReply(res, { error: 'phone 必填' }, 400);
        const rows = await queryRows(
          `${REPAIR_SELECT} WHERE ${REPAIR_SOURCE_SQL} AND o.id=? AND o.phone=?`,
          [m[1], phone]
        );
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, { order: rows[0] });
      }
    }

    // GET /api/juzhu/jiazheng/orders/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if(req.principal?.account?.principal_type==='user'&&/^[a-f0-9-]{36}$/.test(m[1])){const owned=await queryRows('SELECT w.* FROM jz_orders w JOIN commerce_cases c ON BINARY c.id=BINARY w.id WHERE w.id=? AND c.account_id=?',[m[1],req.principal.account.id]);if(owned.length)return jsonReply(res,{order:owned[0]});}
        const workerFilter = await restrictOrdersRead(req, res);
        if (workerFilter === null) return;
        const orderId = m[1];
        const rows = await queryRows(
          `SELECT o.*, s.name AS sku_name, c.name AS category_name,
                  CASE WHEN o.type=o.category_id AND c.name IS NOT NULL THEN c.name ELSE o.type END AS type_label
           FROM jz_orders o
           LEFT JOIN jz_skus s ON s.id=o.sku_id
           LEFT JOIN jz_categories c ON c.id=o.category_id WHERE o.id=?`,
          [orderId]
        );
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        if (workerFilter) {
          let mine = false;
          try { mine = rows[0].worker_json && String(JSON.parse(rows[0].worker_json).id) === workerFilter; } catch (_) {}
          if (!mine) return jsonReply(res, { error: 'forbidden', message: '非派给你的工单' }, 403);
        }
        return jsonReply(res, rows[0]);
      }
    }
    // --- extracted from app.js L6364-6691 ---
    // ===== 家政 C 端写接口 =====

    // POST /api/juzhu/jiazheng/orders（下单）
    if (urlPath === '/api/juzhu/jiazheng/orders' && req.method === 'POST') {
      if (!(await requireCEndWrite(req, res, authCenter.P.ORDER_CREATE))) return;
      const body = await readBody(req);
      const productId = body.product_id || body.sku_id;
      if (!productId) return jsonReply(res, { error: 'product_id 必填' }, 400);
      if (!body.house) return jsonReply(res, { error: 'house 必填' }, 400);
      if (!body.phone) return jsonReply(res, { error: 'phone 必填' }, 400);
      if (!body.expectTime) return jsonReply(res, { error: 'expectTime 必填' }, 400);

      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [prods] = await conn.execute(
          `SELECT p.*, s.category_id, s.name AS sku_name, c.name AS category_name
           FROM jz_products p
           JOIN jz_skus s ON s.id=p.channel_sku_id
           JOIN jz_categories c ON c.id=s.category_id
           WHERE p.id=? AND p.status='on' AND s.enabled=1 AND c.enabled=1`,
          [productId]
        );
        if (!prods.length) { conn.end(); return jsonReply(res, { error: '商品不存在或已下架' }, 400); }
        const prod = prods[0];

        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        const orderId = 'WO-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        const fee = body.fee != null ? parseInt(body.fee) : Math.round((prod.price || 0) * 100);
        const log = [{ at: now, action: 'created', note: `来源: ${body.source || 'c_web'}` }];

        await conn.execute(
          `INSERT INTO jz_orders(id,sku_id,category_id,type,house,phone,expect_time,\`desc\`,fee,pay_status,status,slot_id,source,created_at,updated_at,log_json)
           VALUES (?,?,?,?,?,?,?,?,?,'unpaid','pending',?,?,?,?,?)`,
          [orderId, prod.channel_sku_id || null, prod.category_id, prod.category_id,
           body.house, body.phone, body.expectTime, body.desc || null,
           fee, body.slot_id || null, body.source || 'c_web', now, now, JSON.stringify(log)]
        );
        await conn.commit();
        const [orders] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
        return jsonReply(res, { ok: true, order: orders[0] }, 201);
      } finally { await conn.end(); }
    }

    // POST /api/juzhu/jiazheng/repairs（旅居客报修下单：sku-less 免支付，口径同 commerce/main-system.cjs linkCase 先例）
    if (urlPath === '/api/juzhu/jiazheng/repairs' && req.method === 'POST') {
      if (!(await requireCEndWrite(req, res, authCenter.P.ORDER_CREATE))) return;
      const body = await readBody(req);
      if (!body.type) return jsonReply(res, { error: 'type 必填' }, 400);
      if (!body.house) return jsonReply(res, { error: 'house 必填' }, 400);
      if (!body.phone) return jsonReply(res, { error: 'phone 必填' }, 400);
      if (!body.expectTime) return jsonReply(res, { error: 'expectTime 必填' }, 400);
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const orderId = 'WO-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      const source = String(body.source || '旅居客 App').slice(0, 100);
      if (!source.startsWith('旅居客 App')) return jsonReply(res, { error: 'source 须以「旅居客 App」开头' }, 400);
      const log = [{ at: now, action: 'created', note: `来源: ${source}` }];
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        await conn.execute(
          `INSERT INTO jz_orders(id,sku_id,category_id,type,house,phone,expect_time,\`desc\`,fee,pay_status,status,source,created_at,updated_at,log_json)
           VALUES (?, NULL, 'repair', ?, ?, ?, ?, ?, 0, 'not_required', 'pending', ?, ?, ?, ?)`,
          [orderId, String(body.type).slice(0, 50), body.house, body.phone, body.expectTime,
           body.desc || null, source, now, now, JSON.stringify(log)]
        );
        await conn.commit();
        const [orders] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
        return jsonReply(res, { ok: true, order: orders[0] }, 201);
      } finally { await conn.end(); }
    }

    // DELETE /api/juzhu/jiazheng/repairs/:id?phone=（待派取消=条件硬 DELETE，复刻原 _orderbus 语义；不引入 cancelled 态）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/repairs\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        if (!(await requireCEndWrite(req, res, authCenter.P.ORDER_CREATE))) return;
        const qp = new URLSearchParams(qs);
        const phone = (qp.get('phone') || '').trim();
        if (!phone) return jsonReply(res, { error: 'phone 必填' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute(
            "SELECT id,status,worker_json FROM jz_orders WHERE id=? AND phone=? AND source LIKE '旅居客 App%'",
            [m[1], phone]
          );
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          if (rows[0].status !== 'pending' || rows[0].worker_json) {
            conn.end(); return jsonReply(res, { error: '已派单，请联系 400 客服取消' }, 409);
          }
          await conn.execute('DELETE FROM jz_orders WHERE id=?', [m[1]]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/pay
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/pay$/);
      if (m && req.method === 'POST') {
        if (!(await requireCEndWrite(req, res, authCenter.P.ORDER_CREATE))) return;
        const orderId = m[1];
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          if (order.pay_status === 'paid') { conn.end(); return jsonReply(res, { ok: true, order }); }
          if(order.pay_status==='not_required')return jsonReply(res,{error:'售后工单无需支付'},409);
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          if (order.slot_id) {
            const [slotRes] = await conn.execute(
              'UPDATE jz_sku_slots SET booked=booked+1 WHERE id=? AND status=? AND booked<capacity',
              [order.slot_id, 'open']
            );
            if (slotRes.affectedRows === 0) { conn.end(); return jsonReply(res, { error: '档期已满，请重新选择' }, 400); }
          }
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'paid', pay_method: body.pay_method || 'online' });
          await conn.execute(
            "UPDATE jz_orders SET pay_status='paid', pay_method=?, pay_at=?, updated_at=?, log_json=? WHERE id=?",
            [body.pay_method || 'online', now, now, JSON.stringify(log), orderId]
          );
          await conn.commit();
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/dispatch（派单）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/dispatch$/);
      if (m && req.method === 'POST') {
        if (!(await requireDispatchPerm(req, res))) return;
        const orderId = m[1];
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          if (!(['paid','not_required'].includes(order.pay_status)) || order.status !== 'pending') {
            conn.end(); return jsonReply(res, { error: '订单须已支付且为待派单状态' }, 400);
          }
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          // 规则派单兜底：未显式指派（B 端快速派/裸派单）时按 信用分↓ 完单量↓ 择优分配，
          // 不再落 worker_json=NULL 的幽灵单（服务者端按 worker 过滤，幽灵单无人可见、闭环断）
          let worker = body.worker || null;
          if (!worker) {
            const [cands] = await conn.execute(
              "SELECT id,name,level FROM jz_workers WHERE status='active' ORDER BY credit_score DESC, completed_orders DESC LIMIT 1"
            );
            if (!cands.length) { conn.end(); return jsonReply(res, { error: '暂无可派服务者，请先在主站维护服务者名单' }, 400); }
            worker = { id: cands[0].id, name: cands[0].name, level: cands[0].level, auto: true };
          }
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'dispatched', worker });
          await conn.execute(
            "UPDATE jz_orders SET status='dispatched', worker_json=?, updated_at=?, log_json=? WHERE id=?",
            [worker ? JSON.stringify(worker) : null, now, JSON.stringify(log), orderId]
          );
          await conn.commit();
          await auditIfAccount(req, 'order.dispatch', 'jz_orders', String(orderId), { worker });
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/advance（推进状态）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/advance$/);
      if (m && req.method === 'POST') {
        if (!(await requireDispatchPerm(req, res))) return;
        const orderId = m[1];
        const STATUS_ORDER = ['pending', 'dispatched', 'accepted', 'serving', 'done'];
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          await conn.beginTransaction();
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=? FOR UPDATE', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          const curIdx = STATUS_ORDER.indexOf(order.status);
          if (curIdx === -1) { conn.end(); return jsonReply(res, { error: `当前状态 ${order.status} 不可推进` }, 400); }
          if (order.status === 'pending') { conn.end(); return jsonReply(res, { error: '请先派单再推进状态' }, 400); }
          if (curIdx >= STATUS_ORDER.length - 1) { conn.end(); return jsonReply(res, { error: '已是最终状态' }, 400); }
          const nextStatus = STATUS_ORDER[curIdx + 1];
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'advance', from: order.status, to: nextStatus });
          await conn.execute(
            'UPDATE jz_orders SET status=?, updated_at=?, log_json=? WHERE id=?',
            [nextStatus, now, JSON.stringify(log), orderId]
          );
          if(nextStatus==='done')await require('./commerce/main-system.cjs').workCompleted(conn,order);
          await conn.commit();
          await auditIfAccount(req, 'order.advance', 'jz_orders', String(orderId), { from: order.status, to: nextStatus });
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // POST /api/juzhu/jiazheng/orders/:id/rate（须 API Key）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/orders\/([^/]+)\/rate$/);
      if (m && req.method === 'POST') {
        if (!(await requireCEndWrite(req, res, authCenter.P.RATING_WRITE))) return;
        const orderId = m[1];
        const body = await readBody(req);
        const score = parseInt(body.score);
        if (!score || score < 1 || score > 5) return jsonReply(res, { error: 'score 须为 1-5' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const order = rows[0];
          if (order.status !== 'done') { conn.end(); return jsonReply(res, { error: '仅已完成订单可评价' }, 400); }
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          const rating = { score, tags: body.tags || [], text: body.text || '' };
          let log = [];
          try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
          log.push({ at: now, action: 'rated', score });
          await conn.execute(
            "UPDATE jz_orders SET status='rated', rating_json=?, updated_at=?, log_json=? WHERE id=?",
            [JSON.stringify(rating), now, JSON.stringify(log), orderId]
          );
          await conn.commit();
          const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
          return jsonReply(res, { ok: true, order: updated[0] });
        } finally { await conn.end(); }
      }
    }

    // GET /api/juzhu/jiazheng/skus/:slug/slots（可约档期）
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)\/slots$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const qp = new URLSearchParams(qs);
        const vendorId = qp.get('vendor') ? parseInt(qp.get('vendor')) : null;
        const skus = await queryRows('SELECT id FROM jz_skus WHERE slug=? AND enabled=1', [slug]);
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        const skuId = skus[0].id;
        let prodSql = `SELECT p.id FROM jz_products p JOIN jz_vendors v ON v.id=p.vendor_id
                       WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const prodParams = [skuId];
        if (vendorId) { prodSql += ' AND p.vendor_id=?'; prodParams.push(vendorId); }
        prodSql += ' ORDER BY p.rating DESC, p.sales_count DESC, p.id LIMIT 1';
        const prods = await queryRows(prodSql, prodParams);
        if (!prods.length) return jsonReply(res, { slots: [] });
        const productId = prods[0].id;
        const today = new Date().toISOString().slice(0, 10);
        const slots = await queryRows(
          `SELECT s.*, w.name AS worker_name, w.level AS worker_level, w.avatar AS worker_avatar
           FROM jz_sku_slots s LEFT JOIN jz_workers w ON w.id=s.worker_id
           WHERE s.product_id=? AND s.status='open' AND s.booked<s.capacity AND s.slot_date>=?
           ORDER BY s.slot_date, s.start_time, s.id`,
          [productId, today]
        );
        const result = slots.map(s => ({ ...s, remaining: (s.capacity || 1) - (s.booked || 0) }));
        return jsonReply(res, { slots: result });
      }
    }

    // POST /api/juzhu/jiazheng/wechat-link（C 端匿名预约）
    if (urlPath === '/api/juzhu/jiazheng/wechat-link' && req.method === 'POST') {
      if (!grOrders) return jsonReply(res, { ok: false, error: 'gr_orders module missing' }, 500);
      const body = await readBody(req);
      const parsed = grOrders.validateWechatLinkBody(body);
      if (!parsed.ok) return jsonReply(res, { ok: false, error: parsed.error }, parsed.status);
      const products = await queryRows(
        `SELECT p.*, s.slug AS sku_slug FROM jz_products p
         LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
         WHERE p.id=? AND p.status='on'`,
        [parsed.productId]
      );
      if (!products.length) return jsonReply(res, { ok: false, error: '产品未找到' }, 404);
      const product = products[0];
      if(String(product.query||'').startsWith('guiyang-life-demo-v1:'))return jsonReply(res,{ok:false,error:'演示商品请前往生活权益体验，不生成真实服务商预约链接'},409);
      const pagePath = product.path || 'pages-sub/goods/goods';
      const productQuery = product.query || '';
      const vendorId = String(product.vendor_id || '');
      const vendors = await getVendorConfig();
      const vendor = vendors[vendorId];
      if (!vendor || !vendor.url_link) {
        return jsonReply(res, {
          ok: false,
          error: `vendor_id=${vendorId} 未配置 url_link，请检查 jz_vendors 表配置`,
        }, 500);
      }
      if (!hmacAuth || !vendor.key) {
        return jsonReply(res, {
          ok: false,
          error: `vendor_id=${vendorId} 未配置 hmac_key，无法按文档带签名调用 url_link`,
        }, 500);
      }
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const orderRef = await grOrders.generateOrderRef(conn);
        // 平台 → 商家 urllink：按 api_doc.md 加 HMAC-SHA256 签名（vendor_id 必带）
        const linkBody = hmacAuth.generateSignature(vendor.key, {
          vendor_id: Number(vendorId),
          path: pagePath,
          query: productQuery,
          order_ref: orderRef,
        });
        const outbound = await outboundJson('POST', vendor.url_link, linkBody, 10000);
        if (!outbound.json || outbound.json.code !== 200) {
          return jsonReply(res, { ok: false, error: (outbound.json && outbound.json.msg) || 'URL Link 生成失败' }, 502);
        }
        await grOrders.createOrder(conn, orderRef, String(parsed.productId), {
          vendor_id: product.vendor_id,
          user_id: parsed.userId,
        });
        return jsonReply(res, {
          ok: true,
          url_link: outbound.json.data || '',
          order_ref: orderRef,
        });
      } finally {
        await conn.end();
      }
    }
    // --- extracted from app.js L7018-7061 ---
    // GET /api/juzhu/jiazheng/skus/:slug/detail
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)\/detail$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const skus = await queryRows(
          `SELECT s.*, c.name AS category_name FROM jz_skus s
           JOIN jz_categories c ON c.id=s.category_id
           WHERE s.slug=? AND s.enabled=1`,
          [slug]
        );
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        return jsonReply(res, skus[0]);
      }
    }

    // GET /api/juzhu/jiazheng/skus/:slug/vendors
    {
      const m = urlPath.match(/^\/api\/juzhu\/jiazheng\/skus\/([^/]+)\/vendors$/);
      if (m && req.method === 'GET') {
        const slug = decodeURIComponent(m[1]);
        const skus = await queryRows('SELECT id FROM jz_skus WHERE slug=? AND enabled=1', [slug]);
        if (!skus.length) return jsonReply(res, { error: 'not found' }, 404);
        const skuId = skus[0].id;
        const qp = new URLSearchParams(qs);
        const cityName = (qp.get('city') || '').trim();
        let sql = `SELECT v.*, p.id AS product_id, p.price, p.original_price,
                     p.title, p.subtitle, p.sales_count, p.rating AS product_rating,
                     p.service_tags, p.advance_booking_hours
                   FROM jz_vendors v
                   JOIN jz_products p ON p.vendor_id=v.id
                   WHERE p.channel_sku_id=? AND p.status='on' AND v.status='active'`;
        const params = [skuId];
        if (cityName) {
          const tokens = await cityMatchTokens(cityName);
          sql += ` AND ${cityIdsClause('v', tokens)}`;
          params.push(...tokens);
        }
        sql += ' ORDER BY v.sort_order, v.id LIMIT 20';
        const vendors = await queryRows(sql, params);
        vendors.forEach(stripVendorSecrets);
        return jsonReply(res, { vendors });
      }
    }

    return false;
  };
}

module.exports = { createJiazhengRouter };
